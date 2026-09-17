import type { Balance, FeeSchedule, Leg, LegSide, NormalizedQuote, Venue, VenueAdapter } from "../../types/index.js";
import { NotImplementedError } from "../../types/index.js";
import { ASSET_UNIVERSE } from "../../config/assets.js";
import { logger } from "../../monitoring/logger.js";

const API_BASE = "https://api-v3.raydium.io";

interface RaydiumPoolResponse {
  success: boolean;
  data: Array<{
    id: string;
    price: number;
    tvl: number;
    feeRate: number;
    mintAmountA: number; // base-asset reserve
    mintAmountB: number; // quote-asset reserve
    mintA: { symbol: string; decimals: number };
    mintB: { symbol: string; decimals: number };
  }>;
}

/**
 * DEX adapter for Raydium (Solana). M0 uses REST polling of Raydium's public
 * v3 API rather than direct on-chain account subscription — see README
 * "Deviations from the SRS" for why (v1 SRS, which specifies the exact
 * on-chain ingestion pattern per FR-1.3, was unavailable for this build).
 */
export class RaydiumAdapter implements VenueAdapter {
  readonly venue: Venue = {
    id: "raydium",
    type: "DEX",
    name: "Raydium (Solana)",
    riskTier: "medium",
  };

  private cache = new Map<string, NormalizedQuote>();
  private poolIds: string[];

  constructor() {
    this.poolIds = ASSET_UNIVERSE.map((a) => a.raydium.poolId);
  }

  /** Poll all configured pools in a single batched request. Called on an interval by the ingestion service. */
  async refresh(): Promise<void> {
    const url = `${API_BASE}/pools/info/ids?ids=${this.poolIds.join(",")}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Raydium API error: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as RaydiumPoolResponse;
    if (!body.success) {
      throw new Error("Raydium API returned success=false");
    }
    const fetchedAt = Date.now();
    for (const pool of body.data) {
      const assetCfg = ASSET_UNIVERSE.find((a) => a.raydium.poolId === pool.id);
      if (!assetCfg) continue;
      const quote: NormalizedQuote = {
        venueId: this.venue.id,
        assetId: assetCfg.canonicalAssetId,
        quoteAssetId: assetCfg.quoteAssetId,
        impliedPrice: pool.price,
        liquidityUsd: pool.tvl,
        dexReserves: { base: pool.mintAmountA, quote: pool.mintAmountB },
        feeSchedule: { takerBps: pool.feeRate * 10000 },
        fetchedAt,
        raw: pool,
      };
      this.cache.set(assetCfg.canonicalAssetId, quote);
    }
    logger.system("raydium poll ok", { venue: this.venue.id, pools: body.data.length });
  }

  async getQuote(assetId: string): Promise<NormalizedQuote> {
    const q = this.cache.get(assetId);
    if (!q) throw new Error(`No cached Raydium quote for ${assetId} — has refresh() run yet?`);
    return q;
  }

  getFeeSchedule(): FeeSchedule {
    // Actual fee is per-pool and included in each quote; this is a coarse default.
    return { takerBps: 25 };
  }

  async getBalances(): Promise<Balance[]> {
    throw new NotImplementedError("RaydiumAdapter.getBalances (no wallet wired until M3)");
  }

  async placeOrder(_assetId: string, _side: LegSide, _qty: number): Promise<Leg> {
    throw new NotImplementedError("RaydiumAdapter.placeOrder (execution not enabled before M3)");
  }

  async getOrderStatus(_legId: string): Promise<Leg> {
    throw new NotImplementedError("RaydiumAdapter.getOrderStatus (execution not enabled before M3)");
  }
}
