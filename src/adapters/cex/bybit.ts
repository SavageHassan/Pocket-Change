import type { Balance, FeeSchedule, Leg, LegSide, NormalizedQuote, Venue, VenueAdapter } from "../../types/index.js";
import { NotImplementedError } from "../../types/index.js";
import { ASSET_UNIVERSE } from "../../config/assets.js";
import { config } from "../../config/env.js";
import { logger } from "../../monitoring/logger.js";

const API_BASE = "https://api.bybit.com";
const DEPTH_LEVELS_SUMMED = 5;

interface BybitDepthResponse {
  retCode: number;
  retMsg: string;
  result: {
    s: string;
    a: [string, string][]; // asks
    b: [string, string][]; // bids
    ts: number;
  };
}

/**
 * CEX adapter #2 for M2 (FR-1.1 — adding a venue is a new file, not a core
 * change). REST polling, same rationale as MexcAdapter: Bybit's public WS
 * exists but REST keeps M2 consistent with the M0/M1 pattern; revisit
 * alongside the MEXC WS upgrade noted in the README.
 *
 * Only assets with a `bybit` mapping in ASSET_UNIVERSE are polled — RAY
 * isn't listed on Bybit, so it's simply skipped here (see config/assets.ts).
 */
export class BybitAdapter implements VenueAdapter {
  readonly venue: Venue = {
    id: "bybit",
    type: "CEX",
    name: "Bybit",
    riskTier: "medium",
  };

  private cache = new Map<string, NormalizedQuote>();
  private assets = ASSET_UNIVERSE.filter((a) => a.bybit !== undefined);

  async refresh(): Promise<void> {
    await Promise.all(
      this.assets.map(async (assetCfg) => {
        const symbol = assetCfg.bybit!.symbol;
        const url = `${API_BASE}/v5/market/orderbook?category=spot&symbol=${symbol}&limit=${DEPTH_LEVELS_SUMMED}`;
        const res = await fetch(url);
        if (!res.ok) {
          throw new Error(`Bybit API error for ${symbol}: ${res.status} ${res.statusText}`);
        }
        const body = (await res.json()) as BybitDepthResponse;
        if (body.retCode !== 0) {
          throw new Error(`Bybit API error for ${symbol}: retCode=${body.retCode} ${body.retMsg}`);
        }
        if (!body.result.b?.length || !body.result.a?.length) {
          throw new Error(`Bybit returned empty book for ${symbol}`);
        }
        const bestBid = Number(body.result.b[0][0]);
        const bestAsk = Number(body.result.a[0][0]);

        const quote: NormalizedQuote = {
          venueId: this.venue.id,
          assetId: assetCfg.canonicalAssetId,
          quoteAssetId: assetCfg.quoteAssetId,
          bestBid,
          bestAsk,
          bidDepth: sumNotional(body.result.b),
          askDepth: sumNotional(body.result.a),
          feeSchedule: this.getFeeSchedule(),
          fetchedAt: Date.now(), // local receipt time — see README deviation #4 on why not the venue's own timestamp
          raw: { bids: body.result.b, asks: body.result.a },
        };
        this.cache.set(assetCfg.canonicalAssetId, quote);
      }),
    );
    logger.system("bybit poll ok", { venue: this.venue.id, symbols: this.assets.length });
  }

  async getQuote(assetId: string): Promise<NormalizedQuote> {
    const q = this.cache.get(assetId);
    if (!q) throw new Error(`No cached Bybit quote for ${assetId} — has refresh() run yet, or is this asset not listed on Bybit?`);
    return q;
  }

  getFeeSchedule(): FeeSchedule {
    return { takerBps: config.bybitTakerFeeBps };
  }

  async getBalances(): Promise<Balance[]> {
    throw new NotImplementedError("BybitAdapter.getBalances (no API key wired until M3)");
  }

  async placeOrder(_assetId: string, _side: LegSide, _qty: number): Promise<Leg> {
    throw new NotImplementedError("BybitAdapter.placeOrder (execution not enabled before M3)");
  }

  async getOrderStatus(_legId: string): Promise<Leg> {
    throw new NotImplementedError("BybitAdapter.getOrderStatus (execution not enabled before M3)");
  }
}

function sumNotional(levels: [string, string][]): number {
  return levels.reduce((sum, [price, qty]) => sum + Number(price) * Number(qty), 0);
}
