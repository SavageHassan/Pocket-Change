import http from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";

/**
 * Read-only bridge: serves the bot's structured event log (logs/events.jsonl)
 * over HTTP on localhost so the Pocket Change dashboard — including the
 * Vercel-hosted copy, which runs in YOUR browser — can show what your real
 * bot is doing. It only reads the log; it can't control the bot or place
 * anything. Bound to 127.0.0.1, so nothing outside this machine can reach it.
 *
 *   GET /health            -> { ok, total, lastEventAt, botActive }
 *   GET /events?since=N    -> { total, events: [...] } (events after line N, max 300)
 */

const LOG_FILE = "logs/events.jsonl";
const PORT = Number(process.env.BRIDGE_PORT ?? 8787);
const ACTIVE_WITHIN_MS = 15_000;

function readEvents(): Record<string, unknown>[] {
  if (!existsSync(LOG_FILE)) return [];
  const out: Record<string, unknown>[] = [];
  for (const line of readFileSync(LOG_FILE, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // partially written last line — skip, it'll be complete on the next poll
    }
  }
  return out;
}

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const events = readEvents();
  const last = events[events.length - 1];
  const lastEventAt = last?.time ? new Date(String(last.time)).getTime() : null;
  const mtime = existsSync(LOG_FILE) ? statSync(LOG_FILE).mtimeMs : 0;
  const botActive = Date.now() - Math.max(mtime, lastEventAt ?? 0) < ACTIVE_WITHIN_MS;

  res.setHeader("Content-Type", "application/json");
  if (url.pathname === "/health") {
    return res.end(JSON.stringify({ ok: true, total: events.length, lastEventAt, botActive }));
  }
  if (url.pathname === "/events") {
    let since = Number(url.searchParams.get("since") ?? 0);
    if (!Number.isFinite(since) || since < 0 || since > events.length) since = 0; // log was cleared/rotated
    return res.end(JSON.stringify({ total: events.length, botActive, events: events.slice(since, since + 300) }));
  }
  res.writeHead(404);
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`bridge listening on http://127.0.0.1:${PORT} (reading ${LOG_FILE})`);
  console.log("start the bot in another terminal: npm start -- --mode=paper");
});
