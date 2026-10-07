"use strict";

const crypto = require("crypto");
const express = require("express");
const { createMiddleware } = require("saweria-webhook-express");

// ===== Config (dari environment variable) =====
const PORT = process.env.PORT || 8080;
const STREAM_KEY = process.env.SAWERIA_STREAM_KEY;
const ROBLOX_API_KEY = process.env.ROBLOX_API_KEY;
const UNIVERSE_ID = process.env.UNIVERSE_ID;
const TOPIC = process.env.ROBLOX_TOPIC || "Donation"; // harus sama dengan TOPIC di DonationReceiver
const ADMIN_KEY = process.env.ADMIN_KEY || ""; // kosong = endpoint /test mati

if (!STREAM_KEY || !ROBLOX_API_KEY || !UNIVERSE_ID) {
  console.error("Env wajib belum lengkap: SAWERIA_STREAM_KEY, ROBLOX_API_KEY, UNIVERSE_ID");
  process.exit(1);
}

// ===== Helper =====
function sanitize(text, maxLen) {
  return String(text ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ") // karakter kontrol
    .replace(/(https?:\/\/|www\.)\S+/gi, "") // link
    .replace(/\b[\w-]+\.(com|id|net|org|io|co|me|gg|xyz|link|ly|tv|app)\b\S*/gi, "") // domain polos
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Dedupe donasi ganda (di memori, maksimal 1000 id terakhir)
const seen = new Set();
function isDuplicate(id) {
  if (seen.has(id)) return true;
  seen.add(id);
  if (seen.size > 1000) seen.delete(seen.values().next().value);
  return false;
}

// Rate limit sederhana per IP: 30 request / menit
const hits = new Map();
function rateLimit(req, res, next) {
  const now = Date.now();
  const ip = req.ip;
  const entry = hits.get(ip);
  if (!entry || now - entry.start > 60_000) {
    hits.set(ip, { start: now, count: 1 });
    return next();
  }
  entry.count += 1;
  if (entry.count > 30) return res.sendStatus(429);
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of hits) if (now - e.start > 60_000) hits.delete(ip);
}, 60_000).unref();

// Kirim ke Roblox MessagingService (retry 3x)
async function publishToRoblox(payload) {
  const url = `https://apis.roblox.com/messaging-service/v1/universes/${encodeURIComponent(
    UNIVERSE_ID
  )}/topics/${encodeURIComponent(TOPIC)}`;
  const body = JSON.stringify({ message: JSON.stringify(payload) });

  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "x-api-key": ROBLOX_API_KEY, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(8000),
      });
      if (r.ok) return true;
      lastErr = new Error(`Roblox HTTP ${r.status}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((res) => setTimeout(res, attempt * 1000));
  }
  throw lastErr;
}

// Bentuk data yang dikirim ke game (email donatur TIDAK diteruskan)
function buildPayload(id, name, amount, msg) {
  return {
    id: String(id).slice(0, 100),
    name: sanitize(name, 25) || "Anonim",
    amount: Math.floor(Number(amount)),
    msg: sanitize(msg, 150),
  };
}

// ===== App =====
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1); // di belakang proxy Render/Railway
app.use(rateLimit);
app.use(express.json({ limit: "10kb" }));

app.get("/", (req, res) => res.send("OK"));

// Webhook Saweria (signature diverifikasi pakai stream key)
app.post("/webhook", createMiddleware(STREAM_KEY), async (req, res) => {
  const d = req.body || {};
  if (d.type !== "donation") return res.sendStatus(200);

  const amount = Number(d.amount_raw);
  if (!d.id || !Number.isFinite(amount) || amount <= 0) return res.sendStatus(400);
  if (isDuplicate(d.id)) return res.sendStatus(200);

  const payload = buildPayload(d.id, d.donator_name, amount, d.message);
  try {
    await publishToRoblox(payload);
    console.log(`Donasi ${payload.id} diteruskan ke Roblox`);
    res.sendStatus(200);
  } catch (e) {
    seen.delete(d.id); // izinkan Saweria retry
    console.error("Gagal kirim ke Roblox:", e.message);
    res.sendStatus(502);
  }
});

// Donasi palsu untuk tes (aktif hanya kalau ADMIN_KEY diisi)
app.post("/test", async (req, res) => {
  if (!ADMIN_KEY) return res.sendStatus(404);
  if (!safeEqual(req.get("x-admin-key") || "", ADMIN_KEY)) return res.sendStatus(401);

  const { name = "Tester", amount = 10000, msg = "Tes donasi" } = req.body || {};
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0 || n > 1e9) return res.status(400).send("amount tidak valid");

  const payload = buildPayload(`test-${crypto.randomUUID()}`, name, n, msg);
  try {
    await publishToRoblox(payload);
    res.json({ ok: true, sent: payload });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => console.log(`Server jalan di port ${PORT}`));
