import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RelayState } from "../src/monitoring/relayState.js";
import { startRelay } from "../src/monitoring/relay.js";

/**
 * Cloud relay checks with a FAKE Redis and fake network: the snapshot builder,
 * the ingest/read endpoints (auth, validation, unconfigured), and the log
 * tailer (pushes on change, stays quiet when nothing changes). Proves the
 * plumbing; it doesn't prove your Upstash store/Vercel env vars are set.
 */

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { pass++; console.log(`  ok — ${name}`); } else { fail++; console.log(`  FAIL — ${name}`, detail ?? ""); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t = "2026-09-21T14:25:17.848Z";

function res() {
  const r: any = { code: 200, body: null, setHeader() {}, status(c: number) { r.code = c; return r; }, json(o: unknown) { r.body = o; return r; } };
  return r;
}

async function main() {
  console.log("1. Snapshot builder");
  {
    const s = new RelayState();
    s.handle({ event: "system", venue: "mexc", time: t });
    s.handle({ event: "system", venue: "mexc", time: t });
    s.handle({ event: "system", venue: "bybit", time: t });
    s.handle({ event: "opportunity_detected", assetId: "SOL", buyVenueId: "mexc", sellVenueId: "raydium", buyPrice: 100, sellPrice: 100.2, netSpreadBps: 9, detectedAt: 1, time: t });
    s.handle({ event: "opportunity_detected", assetId: "SOL", buyVenueId: "mexc", sellVenueId: "raydium", buyPrice: 100, sellPrice: 100.3, netSpreadBps: 19, detectedAt: 2, time: t });
    s.handle({ event: "paper_trade", assetId: "SOL", buyVenueId: "mexc", sellVenueId: "raydium", matchedQty: 1, realizedPnlUsd: -1.5, buyFill: { filledQty: 1 }, sellFill: { filledQty: 1 }, time: t });
    s.handle({ event: "unwind", actionTaken: "sold 1 SOL", fullyFlattened: false, time: t });
    s.handle({ event: "risk_event", event_type: "auto_kill", trigger: "session_loss_limit", realizedUsd: -100, time: t });
    const n = s.snapshot();
    check("counts polls per venue", n.polls === 3 && n.pollBy.mexc === 2 && n.pollBy.bybit === 1, n);
    check("keeps only the latest spread per route", n.opps.length === 1 && n.opps[0].netSpreadBps === 19 && n.oppCount === 2, n.opps);
    check("tracks trades and P&L", n.tradeCount === 1 && n.pnl === -1.5 && n.trades.length === 1);
    check("counts incomplete unwinds", n.unw === 1 && n.inc === 1);
    check("auto kill shows up in the log lines", n.lines.some((l) => /AUTO KILL: session_loss_limit/.test(l.m)), n.lines);
    check("snapshot stays small", JSON.stringify(n).length < 5000, JSON.stringify(n).length);
  }

  console.log("2. Ingest and read endpoints");
  {
    const store = new Map<string, string>();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_u: string, init: any) => {
      const [cmd, key, val] = JSON.parse(init.body);
      if (cmd === "SET") { store.set(key, val); return { json: async () => ({ result: "OK" }) } as Response; }
      if (cmd === "GET") return { json: async () => ({ result: store.get(key) ?? null }) } as Response;
      return { json: async () => ({ error: "unsupported" }) } as Response;
    }) as typeof fetch;

    const ingest = (await import("../api/ingest.js" as string)).default;
    const bot = (await import("../api/bot.js" as string)).default;
    const post = (auth: string | null, body: unknown) => { const r = res(); return ingest({ method: "POST", headers: auth ? { authorization: auth } : {}, body }, r).then(() => r); };

    delete process.env.KV_REST_API_URL; delete process.env.KV_REST_API_TOKEN; delete process.env.RELAY_TOKEN;
    let r = res(); await bot({ method: "GET" }, r);
    check("read says 'not configured' when no store is connected", r.body.configured === false, r.body);
    check("ingest refuses when RELAY_TOKEN isn't set on the server", (await post("Bearer x", {})).code === 503);

    process.env.RELAY_TOKEN = "secret"; process.env.KV_REST_API_URL = "http://fake"; process.env.KV_REST_API_TOKEN = "t";
    check("ingest rejects a wrong token", (await post("Bearer nope", { a: 1 })).code === 401);
    check("ingest rejects a missing token", (await post(null, { a: 1 })).code === 401);
    r = res(); await ingest({ method: "GET", headers: {} }, r);
    check("ingest is POST-only", r.code === 405);
    check("ingest rejects non-object bodies", (await post("Bearer secret", [1, 2])).code === 400);
    check("ingest rejects oversized bodies", (await post("Bearer secret", { big: "x".repeat(250_000) })).code === 413);

    r = res(); await bot({ method: "GET" }, r);
    check("read is empty before anything is pushed", r.body.configured === true && r.body.snapshot === null, r.body);
    const ok = await post("Bearer secret", { polls: 7, lastEventAt: 1 });
    check("a correct token stores the snapshot", ok.code === 200 && store.has("pc:state"), ok.body);
    r = res(); await bot({ method: "GET" }, r);
    check("read returns what was pushed", r.body.snapshot?.polls === 7 && typeof r.body.serverNow === "number", r.body);
    globalThis.fetch = realFetch;
  }

  console.log("3. Log tailer pushes on change and stays quiet otherwise");
  {
    const dir = mkdtempSync(join(tmpdir(), "relay-"));
    const file = join(dir, "events.jsonl");
    writeFileSync(file, JSON.stringify({ event: "system", venue: "mexc", time: t }) + "\n");
    const pushes: any[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_u: string, init: any) => { pushes.push({ auth: init.headers.Authorization, body: JSON.parse(init.body) }); return { ok: true } as Response; }) as typeof fetch;
    const log = console.log; console.log = () => {};
    startRelay({ logFile: file, url: "https://example.test/", token: "tok", intervalMs: 60 });
    console.log = log;
    await sleep(250);
    check("pushes the existing log on start, with the bearer token", pushes.length >= 1 && pushes[0].auth === "Bearer tok" && pushes[0].body.polls === 1, pushes[0]);
    const quiet = pushes.length;
    await sleep(250);
    check("sends nothing while the log is unchanged", pushes.length === quiet, { quiet, now: pushes.length });
    appendFileSync(file, JSON.stringify({ event: "system", venue: "bybit", time: t }) + "\n" + '{"event":"system","ve');
    await sleep(250);
    check("pushes again when new events arrive", pushes.length > quiet && pushes[pushes.length - 1].body.polls === 2, pushes.length);
    appendFileSync(file, 'nue":"raydium","time":"' + t + '"}\n');
    await sleep(250);
    check("a line split across writes is reassembled, not lost", pushes[pushes.length - 1].body.polls === 3, pushes[pushes.length - 1].body.polls);
    globalThis.fetch = realFetch;
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
main();
