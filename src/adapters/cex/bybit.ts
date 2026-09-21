import type { Balance, FeeSchedule, Leg, LegSide, NormalizedQuote, Venue, VenueAdapter } from "../../types/index.js";
import { NotImplementedError } from "../../types/index.js";
import { ASSET_UNIVERSE } from "../../config/assets.js";
import { config } from "../../config/env.js";
import { logger } from "../../monitoring/logger.js";
import { DEMO_BASE_URL, signRequest } from "./bybitSigning.js";

const API_BASE = "https://api.bybit.com"; // public market data only — never used for signed/order requests
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

interface BybitV5Response<T> {
  retCode: number;
  retMsg: string;
  result: T;
}

interface BybitWalletBalanceResult {
  list: Array<{ coin: Array<{ coin: string; walletBalance: string; locked: string }> }>;
}

interface BybitOrderCreateResult {
  orderId: string;
}

interface BybitOrderRealtimeResult {
  list: Array<{ side: "Buy" | "Sell"; qty: string; cumExecQty: string; avgPrice?: string; orderStatus: string }>;
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

  private requireCreds(): { apiKey: string; apiSecret: string } {
    if (!config.bybitApiKey || !config.bybitApiSecret) {
      throw new NotImplementedError(
        "BybitAdapter execution (set BYBIT_API_KEY/BYBIT_API_SECRET in .env to a Demo Trading key — see README for how to create one; never a mainnet key)",
      );
    }
    return { apiKey: config.bybitApiKey, apiSecret: config.bybitApiSecret };
  }

  /** M3: real request against Bybit's Demo Trading sandbox (api-demo.bybit.com) — no real funds, but a real signed order. */
  async getBalances(): Promise<Balance[]> {
    const { apiKey, apiSecret } = this.requireCreds();
    const query = "accountType=UNIFIED";
    const headers = signRequest(apiKey, apiSecret, query);
    const res = await fetch(`${DEMO_BASE_URL}/v5/account/wallet-balance?${query}`, { headers });
    const body = (await res.json()) as BybitV5Response<BybitWalletBalanceResult>;
    if (body.retCode !== 0) {
      throw new Error(`Bybit demo wallet-balance error: retCode=${body.retCode} ${body.retMsg}`);
    }
    const coins = body.result?.list?.[0]?.coin ?? [];
    return coins.map((c: { coin: string; walletBalance: string; locked: string }) => ({
      venueId: this.venue.id,
      assetId: c.coin,
      available: Number(c.walletBalance) - Number(c.locked || 0),
      locked: Number(c.locked || 0),
      lastReconciledAt: Date.now(),
    }));
  }

  async placeOrder(assetId: string, side: LegSide, qty: number): Promise<Leg> {
    const { apiKey, apiSecret } = this.requireCreds();
    const assetCfg = ASSET_UNIVERSE.find((a) => a.canonicalAssetId === assetId && a.bybit);
    if (!assetCfg?.bybit) throw new Error(`${assetId} has no Bybit symbol configured`);

    const body = JSON.stringify({
      category: "spot",
      symbol: assetCfg.bybit.symbol,
      side: side === "buy" ? "Buy" : "Sell",
      orderType: "Market",
      qty: qty.toString(),
    });
    const headers = signRequest(apiKey, apiSecret, body);
    logger.tradeAttempt({ venue: this.venue.id, stage: "submit", assetId, side, qty, sandbox: "demo-trading" });

    const res = await fetch(`${DEMO_BASE_URL}/v5/order/create`, { method: "POST", headers, body });
    const result = (await res.json()) as BybitV5Response<BybitOrderCreateResult>;
    if (result.retCode !== 0) {
      logger.failure({ venue: this.venue.id, stage: "submit", retCode: result.retCode, retMsg: result.retMsg });
      return {
        tradeId: "",
        legId: "",
        venueId: this.venue.id,
        side,
        requestedQty: qty,
        filledQty: 0,
        status: "failed",
        timestamp: Date.now(),
      };
    }

    const orderId = result.result.orderId;
    logger.tradeAttempt({ venue: this.venue.id, stage: "accepted", orderId, sandbox: "demo-trading" });
    return {
      tradeId: orderId,
      legId: orderId,
      venueId: this.venue.id,
      side,
      requestedQty: qty,
      filledQty: 0, // unknown until getOrderStatus polls it
      status: "pending",
      timestamp: Date.now(),
    };
  }

  async getOrderStatus(legId: string): Promise<Leg> {
    const { apiKey, apiSecret } = this.requireCreds();
    const query = `category=spot&orderId=${legId}`;
    const headers = signRequest(apiKey, apiSecret, query);
    const res = await fetch(`${DEMO_BASE_URL}/v5/order/realtime?${query}`, { headers });
    const body = (await res.json()) as BybitV5Response<BybitOrderRealtimeResult>;
    if (body.retCode !== 0) {
      throw new Error(`Bybit demo order-status error: retCode=${body.retCode} ${body.retMsg}`);
    }
    const order = body.result?.list?.[0];
    if (!order) throw new Error(`No order found for ${legId}`);

    const statusMap: Record<string, Leg["status"]> = {
      New: "pending",
      PartiallyFilled: "partially_filled",
      Filled: "filled",
      Cancelled: "cancelled",
      Rejected: "failed",
    };

    return {
      tradeId: legId,
      legId,
      venueId: this.venue.id,
      side: order.side === "Buy" ? "buy" : "sell",
      requestedQty: Number(order.qty),
      filledQty: Number(order.cumExecQty ?? 0),
      avgPrice: order.avgPrice ? Number(order.avgPrice) : undefined,
      status: statusMap[order.orderStatus] ?? "pending",
      timestamp: Date.now(),
    };
  }
}

function sumNotional(levels: [string, string][]): number {
  return levels.reduce((sum, [price, qty]) => sum + Number(price) * Number(qty), 0);
}
