import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const TOKEN = process.env.DISCORD_TOKEN || "";
const CHANNEL_ID = process.env.CHANNEL_ID || "";
const PORT = process.env.PORT || 5000;

const HEADERS = {
  Authorization: TOKEN,
  "User-Agent": "DiscordBot (https://example, v0.1)",
  "Content-Type": "application/json",
};

const EXPIRY_SECONDS = 600; // 10 minutos
const POLL_INTERVAL_MS = 2000;

const store = new Map(); // key -> item

function makeKey(item) {
  if (item.jobId) return "job:" + item.jobId;
  if (item.id) return "msg:" + item.id;
  return "ts:" + Date.now();
}

// parser money per sec, similar ao python
function parseMoneyPerSec(raw) {
  if (!raw) return 0;
  let s = raw.replace(/\*/g, "").replace(/\s/g, "").replace(/\/s|persec/gi, "");
  const m = s.match(/\$?([0-9]+(?:\.[0-9]+)?)([KkMmBbTt]?)/);
  if (!m) {
    const m2 = s.match(/([0-9]+(?:\.[0-9]+)?)/);
    if (!m2) return 0;
    return Math.floor(parseFloat(m2[1]));
  }
  const num = parseFloat(m[1]);
  const suf = m[2].toUpperCase();
  let mult = 1;
  if (suf === "K") mult = 1e3;
  else if (suf === "M") mult = 1e6;
  else if (suf === "B") mult = 1e9;
  else if (suf === "T") mult = 1e12;
  return Math.floor(num * mult);
}

function parseEmbedFields(msg) {
  const result = {
    serverName: null,
    moneyPerSec: 0,
    players: null,
    jobId: null,
  };

  const content = msg.content || "";
  if (content && content.trim().length > 0) {
    const candidate = content.replace(/`/g, "").trim();
    if (candidate.length >= 10 && (candidate.includes("-") || candidate.includes("/") || candidate.length > 8)) {
      result.jobId = candidate;
    }
  }

  for (const embed of msg.embeds || []) {
    for (const field of embed.fields || []) {
      const name = (field.name || "").trim();
      const value = (field.value || "").trim();

      if (name.includes("Name") || name === "🏷️ Name" || name.toLowerCase().startsWith("name")) {
        result.serverName = value;
        continue;
      }
      if (name.includes("Money") || name.includes("💰") || name.toLowerCase().includes("per sec")) {
        result.moneyPerSec = parseMoneyPerSec(value);
        continue;
      }
      if (name.includes("Players") || name.includes("👥") || name.toLowerCase().startsWith("players")) {
        result.players = value.replace(/\*/g, "");
        continue;
      }
      if (name.includes("Job ID") || name.includes("Jobid") || name.includes("Job")) {
        let clean = value.replace(/```|`/g, "").trim();
        if (clean) {
          const parts = clean.split(/\s+/);
          let found = null;
          for (const p of parts) {
            if (p.length > 8) {
              found = p;
              break;
            }
          }
          result.jobId = found || clean;
        }
        continue;
      }
    }

    if (!result.serverName) {
      if (embed.title) result.serverName = embed.title;
    }

    if (!result.jobId) {
      const desc = embed.description || "";
      const m = desc.match(/TeleportToPlaceInstance\([^)]+,\s*['"`]?([^'"`,)\s]+)/);
      if (m) {
        result.jobId = m[1];
      }
      const m2 = desc.match(/([0-9a-fA-F]{8}-[0-9a-fA-F-]{4,}-[0-9a-fA-F]{8,})/);
      if (m2) {
        result.jobId = m2[1];
      }
    }
  }

  return result;
}

async function sendToLocalhost(payload) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/receive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch (err) {
    console.error("Erro enviando para localhost:", err);
    return false;
  }
}

async function pollNewMessages() {
  let lastId = null;
  while (true) {
    try {
      let url = `https://discord.com/api/v9/channels/${CHANNEL_ID}/messages?limit=50`;
      if (lastId) url += `&after=${lastId}`;

      const res = await fetch(url, { headers: HEADERS });
      if (res.status === 200) {
        const msgs = await res.json();
        if (msgs.length) {
          msgs.reverse(); // do mais velho para o mais novo
          for (const m of msgs) {
            const parsed = parseEmbedFields(m);
            if (!parsed.jobId && !parsed.serverName) {
              lastId = m.id || lastId;
              continue;
            }

            const payload = {
              id: m.id,
              author: (m.author?.username) || "Unknown",
              serverName: parsed.serverName || "",
              moneyPerSec: parsed.moneyPerSec || 0,
              players: parsed.players || "",
              jobId: parsed.jobId || "",
            };

            const ok = await sendToLocalhost(payload);
            if (ok) {
              console.log("Enviado ao localhost:", payload);
            } else {
              console.log("Falha ao enviar payload:", payload);
            }
            lastId = m.id || lastId;
          }
        }
      } else {
        const text = await res.text();
        console.error("Erro ao buscar mensagens:", res.status, text);
      }
    } catch (err) {
      console.error("Exceção no poll:", err);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

// RECEBER POSTS e guardar em memória

app.post("/receive", (req, res) => {
  const data = req.body;
  const items = Array.isArray(data) ? data : [data];
  const now = Date.now() / 1000;

  for (const it of items) {
    const key = makeKey(it);
    if (store.has(key)) {
      const prev = store.get(key);
      store.set(key, {
        serverName: it.serverName || prev.serverName,
        moneyPerSec: it.moneyPerSec || prev.moneyPerSec,
        players: it.players || prev.players,
        author: it.author || prev.author,
        jobId: it.jobId || prev.jobId,
        firstSeen: prev.firstSeen,
        lastSeen: now,
        id: it.id || prev.id,
      });
    } else {
      store.set(key, {
        serverName: it.serverName || "",
        moneyPerSec: it.moneyPerSec || 0,
        players: it.players || "",
        author: it.author || "",
        jobId: it.jobId || "",
        firstSeen: now,
        lastSeen: now,
        id: it.id || "",
      });
    }
  }
  res.json({ status: "ok", count: store.size });
});

app.get("/messages", (req, res) => {
  const now = Date.now() / 1000;
  const arr = [...store.values()].filter((v) => now - v.lastSeen <= EXPIRY_SECONDS);
  arr.sort((a, b) => b.lastSeen - a.lastSeen);
  res.json(arr);
});

function cleanupLoop() {
  setInterval(() => {
    const now = Date.now() / 1000;
    for (const [k, v] of store.entries()) {
      if (now - v.lastSeen > EXPIRY_SECONDS) {
        store.delete(k);
      }
    }
  }, 30000);
}

app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
  cleanupLoop();
  pollNewMessages();
});
