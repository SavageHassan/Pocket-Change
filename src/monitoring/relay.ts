import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { RelayState } from "./relayState.js";

/**
 * Cloud relay: tails the bot's event log, folds it into a small status
 * snapshot, and POSTs that snapshot to the Vercel-hosted dashboard's
 * /api/ingest so the public page can show your bot without reaching your
 * machine. Only paper-trading status leaves the computer: no keys, no raw logs.
 * Pushes only when something changed, to stay inside the free Redis limits.
 */

export interface RelayOptions {
  logFile?: string;
  url: string; // e.g. https://pocket-change-six.vercel.app
  token: string;
  intervalMs?: number;
}

export function startRelay(opts: RelayOptions): void {
  const logFile = opts.logFile ?? "logs/events.jsonl";
  const interval = opts.intervalMs ?? 8000;
  let state = new RelayState();
  let offset = 0;
  let partial = "";
  let dirty = false;
  let lastErrAt = 0;

  function readNew(): void {
    if (!existsSync(logFile)) return;
    const size = statSync(logFile).size;
    if (size < offset) { state = new RelayState(); offset = 0; partial = ""; dirty = true; } // log was cleared
    if (size === offset) return;
    const fd = openSync(logFile, "r");
    try {
      const buf = Buffer.alloc(size - offset);
      readSync(fd, buf, 0, buf.length, offset);
      offset = size;
      const text = partial + buf.toString("utf8");
      const lines = text.split("\n");
      partial = lines.pop() ?? "";
      for (const l of lines) {
        if (!l.trim()) continue;
        try { state.handle(JSON.parse(l)); dirty = true; } catch { /* skip a corrupt line */ }
      }
    } finally {
      closeSync(fd);
    }
  }

  async function push(): Promise<void> {
    readNew();
    if (!dirty) return;
    try {
      const res = await fetch(`${opts.url.replace(/\/$/, "")}/api/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.token}` },
        body: JSON.stringify(state.snapshot()),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) { dirty = false; return; }
      const body = await res.text();
      if (Date.now() - lastErrAt > 30_000) { lastErrAt = Date.now(); console.error(`relay: ${res.status} ${body.slice(0, 200)}`); }
    } catch (err) {
      if (Date.now() - lastErrAt > 30_000) { lastErrAt = Date.now(); console.error(`relay: push failed: ${err instanceof Error ? err.message : err}`); }
    }
  }

  console.log(`relay on: pushing bot status to ${opts.url}/api/ingest every ${interval / 1000}s when it changes`);
  void push();
  setInterval(push, interval);
}
