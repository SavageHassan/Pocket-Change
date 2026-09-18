// Public-data proxy for the Pocket Change live console. No keys, no trading —
// it only reads the same public Raydium / MEXC / Bybit endpoints the bot polls,
// server-side so the browser isn't blocked by CORS and viewers share one cache.

const ASSETS = [
  { id: "SOL", pool: "3nMFwZXwY1s1M5s8vYAHqd4wGs4iSxXE4LRoUMMYqEgF", mexc: "SOLUSDT", bybit: "SOLUSDT" },
  { id: "RAY", pool: "DVa7Qmb5ct9RCpaU7UTpSaf3GVMYz17vNVU67XpdCRut", mexc: "RAYUSDT", bybit: null },
];

const TIMEOUT_MS = 4000;

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const toLevels = (rows) => rows.map(([p, q]) => [Number(p), Number(q)]);

async function raydium() {
  const ids = ASSETS.map((a) => a.pool).join(",");
  const body = await getJson(`https://api-v3.raydium.io/pools/info/ids?ids=${ids}`);
  if (!body.success) throw new Error("success=false");
  const quotes = {};
  for (const pool of body.data) {
    const a = ASSETS.find((x) => x.pool === pool.id);
    if (a) quotes[a.id] = { price: pool.price, tvl: pool.tvl, feeBps: pool.feeRate * 10000 };
  }
  return quotes;
}

async function mexc() {
  const out = {};
  await Promise.all(
    ASSETS.filter((a) => a.mexc).map(async (a) => {
      const b = await getJson(`https://api.mexc.com/api/v3/depth?symbol=${a.mexc}&limit=20`);
      out[a.id] = { bids: toLevels(b.bids), asks: toLevels(b.asks), feeBps: 10 };
    }),
  );
  return out;
}

async function bybit() {
  const out = {};
  await Promise.all(
    ASSETS.filter((a) => a.bybit).map(async (a) => {
      const b = await getJson(`https://api.bybit.com/v5/market/orderbook?category=spot&symbol=${a.bybit}&limit=25`);
      if (b.retCode !== 0) throw new Error(b.retMsg);
      out[a.id] = { bids: toLevels(b.result.b), asks: toLevels(b.result.a), feeBps: 10 };
    }),
  );
  return out;
}

async function timed(fn) {
  const t0 = Date.now();
  try {
    const quotes = await fn();
    return { ok: true, latencyMs: Date.now() - t0, quotes };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - t0, error: String(err.message || err), quotes: {} };
  }
}

export default async function handler(req, res) {
  const [r, m, b] = await Promise.all([timed(raydium), timed(mexc), timed(bybit)]);
  res.setHeader("Cache-Control", "s-maxage=2, stale-while-revalidate=5");
  res.status(200).json({ ts: Date.now(), venues: { raydium: r, mexc: m, bybit: b } });
}
