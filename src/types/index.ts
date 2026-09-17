// Core data model — SRS v2 section 6, plus the ingestion/detection types
// needed to drive FR-1/FR-2 before execution-layer types (FR-4/FR-5) are wired up.

export type VenueType = "CEX" | "DEX";

export interface Venue {
  id: string; // e.g. "raydium", "mexc"
  type: VenueType;
  name: string;
  region?: string;
  riskTier: "low" | "medium" | "high";
}

export interface AssetMapping {
  canonicalAssetId: string; // e.g. "SOL", "USDC"
  venueId: string;
  venueTicker: string; // CEX symbol (e.g. "SOLUSDT") or DEX mint address
  decimals: number;
}

export interface Balance {
  venueId: string;
  assetId: string;
  available: number;
  locked: number;
  lastReconciledAt: number; // epoch ms
}

export type LegSide = "buy" | "sell";
export type LegStatus = "pending" | "filled" | "partially_filled" | "failed" | "cancelled";

export interface Leg {
  tradeId: string;
  legId: string;
  venueId: string;
  side: LegSide;
  requestedQty: number;
  filledQty: number;
  status: LegStatus;
  timestamp: number;
}

export interface UnwindEvent {
  id: string;
  tradeId: string;
  triggeringLegId: string;
  actionTaken: string;
  realizedLoss: number;
  timestamp: number;
}

// --- Ingestion layer types (FR-1) ---

export interface FeeSchedule {
  takerBps: number; // taker fee in basis points
  makerBps?: number;
  withdrawalFee?: number; // in asset units, CEX only
}

/**
 * Normalized market data for one (venue, asset) pair, per FR-1.4.
 * DEX venues populate impliedPrice (from pool reserves); CEX venues populate
 * bestBid/bestAsk (+ depth) from the order book.
 */
export interface NormalizedQuote {
  venueId: string;
  assetId: string; // canonical asset ID of the base asset
  quoteAssetId: string; // canonical asset ID it's priced against (e.g. "USDC", "USDT")
  impliedPrice?: number; // DEX pool-implied price
  bestBid?: number; // CEX
  bestAsk?: number; // CEX
  bidDepth?: number; // quote-asset notional available at bestBid (CEX)
  askDepth?: number; // quote-asset notional available at bestAsk (CEX)
  liquidityUsd?: number; // DEX pool TVL, used as a coarse depth proxy
  // Raw on-chain pool reserves, kept for diagnostics only — for a CLMM pool
  // (all Raydium pools configured here) these are aggregated across the
  // whole tick range and are NOT valid constant-product inputs at the
  // current price. Slippage simulation derives virtual reserves from
  // impliedPrice + liquidityUsd instead — see engine/fillSimulator.ts.
  dexReserves?: { base: number; quote: number };
  feeSchedule: FeeSchedule;
  fetchedAt: number; // epoch ms — used for FR-1.5 freshness tracking
  raw?: unknown;
}

// --- Detection layer types (FR-2) ---

export interface Opportunity {
  id: string;
  detectedAt: number;
  assetId: string;
  buyVenueId: string;
  sellVenueId: string;
  buyPrice: number;
  sellPrice: number;
  grossSpreadBps: number;
  estFeesBps: number;
  netSpreadBps: number;
  buyQuoteAgeMs: number;
  sellQuoteAgeMs: number;
  flaggedAnomalous: boolean;
  anomalyReason?: string;
}

// --- Venue adapter contract (FR-1.1) ---

/**
 * Common interface every venue (CEX or DEX) implements. The detection/risk
 * engine only ever talks to this interface, never to a venue-specific client,
 * so adding a venue later means writing an adapter, not touching core logic.
 */
export interface VenueAdapter {
  readonly venue: Venue;

  /** Fetch a normalized quote for one canonical asset against its configured quote asset. */
  getQuote(assetId: string): Promise<NormalizedQuote>;

  getFeeSchedule(): FeeSchedule;

  /** Read-only in M0/M1; live wallets/API keys required from M3 onward. */
  getBalances(): Promise<Balance[]>;

  /** DEX: build+submit an atomic tx. CEX: place an order. Not implemented before M3. */
  placeOrder(assetId: string, side: LegSide, qty: number): Promise<Leg>;

  getOrderStatus(legId: string): Promise<Leg>;
}

// --- Paper trading types (M1, FR-9.1) ---

export interface FillResult {
  requestedQty: number;
  filledQty: number;
  avgPrice: number;
  fullyFilled: boolean;
}

/**
 * A simulated two-leg trade: an Opportunity that cleared the profit
 * threshold, re-priced through realistic fill simulation (order-book walk
 * for CEX, constant-product slippage for DEX) instead of assuming full
 * fill at the quoted top-of-book/implied price. This is what turns a
 * theoretically-profitable spread into a realistic (possibly unprofitable)
 * one — the whole point of FR-9.1.
 */
export interface PaperTrade {
  id: string;
  timestamp: number;
  assetId: string;
  buyVenueId: string;
  sellVenueId: string;
  tradeSizeUsd: number;
  theoreticalNetSpreadBps: number; // from the underlying Opportunity, pre-slippage
  buyFill: FillResult;
  sellFill: FillResult;
  matchedQty: number; // min(buyFill.filledQty, sellFill.filledQty) — the unmatched remainder is a hypothetical FR-5.4 unwind case
  feesUsd: number;
  realizedPnlUsd: number;
}

export class NotImplementedError extends Error {
  constructor(feature: string) {
    super(`${feature} is not implemented in this milestone`);
    this.name = "NotImplementedError";
  }
}
