// The bot (via `npm run relay` / `npm run bridge`) POSTs its status snapshot here.
// Protected by a shared secret: RELAY_TOKEN must be set on Vercel and in the bot's .env.
import { configured, redis } from "./_redis.js";

const MAX_BYTES = 200_000;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const secret = process.env.RELAY_TOKEN;
  if (!secret) return res.status(503).json({ error: "RELAY_TOKEN is not set on the server" });
  if (req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ error: "bad token" });
  if (!configured()) return res.status(503).json({ error: "no Redis store connected to this project" });

  const snap = req.body;
  if (!snap || typeof snap !== "object" || Array.isArray(snap)) return res.status(400).json({ error: "expected a JSON object" });
  const json = JSON.stringify(snap);
  if (json.length > MAX_BYTES) return res.status(413).json({ error: "snapshot too large" });

  try {
    await redis(["SET", "pc:state", json, "EX", "86400"]);
    return res.status(200).json({ ok: true, bytes: json.length });
  } catch (err) {
    return res.status(502).json({ error: String(err.message || err) });
  }
}
