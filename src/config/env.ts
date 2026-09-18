import "dotenv/config";

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`Invalid number for env var ${name}: ${v}`);
  return n;
}

export const config = {
  // Polling intervals — see README for why REST polling is used in M0
  // instead of WS (Raydium has no public WS; MEXC's public WS is
  // protobuf-only, deferred past M0).
  raydiumPollMs: num("RAYDIUM_POLL_MS", 4000),
  mexcPollMs: num("MEXC_POLL_MS", 2000),
  bybitPollMs: num("BYBIT_POLL_MS", 2000),

  // Minimum net spread (after fees) to log as an opportunity, in bps.
  minNetSpreadBps: num("MIN_NET_SPREAD_BPS", 5),

  // Quotes older than this are considered stale and excluded from
  // cross-venue comparison (FR-1.5).
  maxQuoteAgeMs: num("MAX_QUOTE_AGE_MS", 15000),

  // MEXC default spot taker fee (0.1% = 10 bps); override per your account tier.
  mexcTakerFeeBps: num("MEXC_TAKER_FEE_BPS", 10),

  // Bybit default spot taker fee (0.1% = 10 bps); override per your account tier.
  bybitTakerFeeBps: num("BYBIT_TAKER_FEE_BPS", 10),

  // FR-2.5 / scenario 27: flag spreads implausibly large as likely stale/broken
  // data rather than real profit, pending independent confirmation.
  anomalyThresholdBps: num("ANOMALY_THRESHOLD_BPS", 500),

  // M1 (FR-9.1): hypothetical trade size used to simulate fills against
  // real order-book/pool depth. No real capital is ever at risk in --mode=paper.
  paperTradeSizeUsd: num("PAPER_TRADE_SIZE_USD", 500),

  // M3: Bybit Demo Trading (api-demo.bybit.com) — a real order-submission
  // sandbox with no real funds, NOT the same as a mainnet key. Absent by
  // default; execution scripts refuse to run without it rather than
  // silently falling back to anything mainnet-shaped.
  bybitApiKey: process.env.BYBIT_API_KEY,
  bybitApiSecret: process.env.BYBIT_API_SECRET,
};
