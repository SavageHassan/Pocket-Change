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

  // M4 capital & risk controls (FR-6, FR-8.4/8.5). All paper-ledger only:
  // nothing here moves or spends real money.
  startCapitalUsdPerVenue: num("START_CAPITAL_USD_PER_VENUE", 5000), // USDT pre-positioned at each venue
  startAssetUsdPerVenue: num("START_ASSET_USD_PER_VENUE", 5000), // base-asset value pre-positioned per venue, per asset
  custodyCapPct: num("CUSTODY_CAP_PCT", 50), // FR-6.4: max share of total capital on any single CEX
  maxTradeUsd: num("MAX_TRADE_USD", 1000), // hard per-trade notional ceiling
  maxSessionLossUsd: num("MAX_SESSION_LOSS_USD", 100), // realized loss that trips the global kill switch
  unwindRateThreshold: num("UNWIND_RATE_THRESHOLD", 0.5), // FR-8.5: unwinds/trades over the window that trips the kill switch
  unwindRateWindow: num("UNWIND_RATE_WINDOW", 10), // trades in the rolling window
  venueErrorThreshold: num("VENUE_ERROR_THRESHOLD", 5), // FR-8.4: feed errors within the window that halt one venue
  venueErrorWindowMs: num("VENUE_ERROR_WINDOW_MS", 60000),
  venueRecoverySuccesses: num("VENUE_RECOVERY_SUCCESSES", 3), // clean polls before a halted venue resumes
  reconcileTolerancePct: num("RECONCILE_TOLERANCE_PCT", 0.5), // balance drift (% of venue value) that halts a venue

  // --live-demo: real orders on Bybit Demo Trading (play funds)
  demoTradeUsd: num("DEMO_TRADE_USD", 50),
  demoMaxOrdersPerMin: num("DEMO_MAX_ORDERS_PER_MIN", 6),

  // M3: Bybit Demo Trading (api-demo.bybit.com) — a real order-submission
  // sandbox with no real funds, NOT the same as a mainnet key. Absent by
  // default; execution scripts refuse to run without it rather than
  // silently falling back to anything mainnet-shaped.
  bybitApiKey: process.env.BYBIT_API_KEY,
  bybitApiSecret: process.env.BYBIT_API_SECRET,
};
