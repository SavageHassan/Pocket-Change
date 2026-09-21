import "dotenv/config";
import { startRelay } from "../src/monitoring/relay.js";

const url = process.env.RELAY_URL;
const token = process.env.RELAY_TOKEN;
if (!url || !token) {
  console.error("Set RELAY_URL (your Vercel site, e.g. https://pocket-change-six.vercel.app) and RELAY_TOKEN (any long random string, also set on Vercel) in .env. See README.");
  process.exit(1);
}
startRelay({ url, token, intervalMs: Number(process.env.RELAY_INTERVAL_MS ?? 8000) });
