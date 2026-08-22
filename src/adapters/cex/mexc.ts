import type { Balance, FeeSchedule, Leg, LegSide, NormalizedQuote, Venue, VenueAdapter } from "../../types/index.js";
import { NotImplementedError } from "../../types/index.js";
import { ASSET_UNIVERSE } from "../../config/assets.js";
import { config } from "../../config/env.js";
import { logger } from "../../monitoring/logger.js";

const API_BASE = "https://api.mexc.com";
const DEPTH_LEVELS_SUMMED = 5; // how many book levels to sum for the depth estimate

interface MexcDepthResponse {
  lastUpdateId: number;
  bids: [string, string][];
  asks: [string, string][];
  timestamp: number;
}

/**
 * CEX adapter for MEXC. M0 uses REST polling of the public depth endpoint
 * rather than the WebSocket stream — MEXC's public market-data WS now pushes
 * protobuf-only payloads (no plain-JSON channel), which is real added
 * complexity beyond M0's scope. See README "Deviations" — this is the one
 * place FR-1.2 (WS primary, REST fallback) isn't met yet; recommended
 * upgrade before M2, where leg-pair timing starts to matter.
 */
export class MexcAdapter implements VenueAdapter {
  readonly venue: Venue = {
    id: "mexc",
    type: "CEX",
    name: "MEXC",
    riskTier: "medium",
  };

  private cache = new Map<string, NormalizedQuote>();

  /** Poll every configured symbol's depth. Called on an interval by the ingestion service. */
  async refresh(): Promise<void> {
    await Promise.all(
      ASSET_UNIVERSE.map(async (assetCfg) => {
        const url = `${API_BASE}/api/v3/depth?symbol=${assetCfg.mexc.symbol}&limit=${DEPTH_LEVELS_SUMMED}`;
        const res = await fetch(url);
        if (!res.ok) {
          throw new Error(`MEXC API error for ${assetCfg.mexc.symbol}: ${res.status} ${res.statusText}`);
        }
        const body = (await res.json()) as MexcDepthResponse;
        if (!body.bids?.length || !body.asks?.length) {
          throw new Error(`MEXC returned empty book for ${assetCfg.mexc.symbol}`);
        }
        const bestBid = Number(body.bids[0][0]);
        const bestAsk = Number(body.asks[0][0]);
        const bidDepth = sumNotional(body.bids);
        const askDepth = sumNotional(body.asks);

        // Freshness (FR-1.5) must be measured against our own clock, not the
        // venue's reported timestamp — trusting a remote clock for staleness
        // detection is exactly the clock-drift failure mode in scenario 28.
        // `raw` still carries the venue's own timestamp for drift monitoring.
        const quote: NormalizedQuote = {
          venueId: this.venue.id,
          assetId: assetCfg.canonicalAssetId,
          quoteAssetId: assetCfg.quoteAssetId,
          bestBid,
          bestAsk,
          bidDepth,
          askDepth,
          feeSchedule: this.getFeeSchedule(),
          fetchedAt: Date.now(),
          raw: body,
        };
        this.cache.set(assetCfg.canonicalAssetId, quote);
      }),
    );
    logger.system("mexc poll ok", { venue: this.venue.id, symbols: ASSET_UNIVERSE.length });
  }

  async getQuote(assetId: string): Promise<NormalizedQuote> {
    const q = this.cache.get(assetId);
    if (!q) throw new Error(`No cached MEXC quote for ${assetId} — has refresh() run yet?`);
    return q;
  }

  getFeeSchedule(): FeeSchedule {
    return { takerBps: config.mexcTakerFeeBps };
  }

  async getBalances(): Promise<Balance[]> {
    throw new NotImplementedError("MexcAdapter.getBalances (no API key wired until M3)");
  }

  async placeOrder(_assetId: string, _side: LegSide, _qty: number): Promise<Leg> {
    throw new NotImplementedError("MexcAdapter.placeOrder (execution not enabled before M3)");
  }

  async getOrderStatus(_legId: string): Promise<Leg> {
    throw new NotImplementedError("MexcAdapter.getOrderStatus (execution not enabled before M3)");
  }
}

function sumNotional(levels: [string, string][]): number {
  return levels.reduce((sum, [price, qty]) => sum + Number(price) * Number(qty), 0);
}
