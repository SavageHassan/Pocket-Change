// The dashboard reads the latest bot snapshot from here. Read-only and paper-trading data only.
import { configured, redis } from "./_redis.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=3, stale-while-revalidate=5"); // viewers share one Redis read
  if (!configured()) return res.status(200).json({ configured: false });
  try {
    const raw = await redis(["GET", "pc:state"]);
    return res.status(200).json({ configured: true, snapshot: raw ? JSON.parse(raw) : null, serverNow: Date.now() });
  } catch (err) {
    return res.status(200).json({ configured: true, snapshot: null, error: String(err.message || err), serverNow: Date.now() });
  }
}
