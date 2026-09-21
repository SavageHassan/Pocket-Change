import type { Leg, LegSide } from "../types/index.js";
import { config } from "../config/env.js";
import { logger } from "../monitoring/logger.js";

/**
 * --live-demo: places REAL orders on Bybit Demo Trading (api-demo.bybit.com,
 * play funds) for the Bybit leg of a trade, waits for the fill, and reports
 * what actually happened. The BybitAdapter it wraps only knows the demo host,
 * so this class has no way to reach a real-money endpoint.
 *
 * Only the Bybit leg is real. The other venue's leg stays simulated — there is
 * no second sandbox to send it to (MEXC has none, Raydium's pools aren't on
 * devnet) — and the trade record says so.
 */

export interface OrderPlacer {
  placeOrder(assetId: string, side: LegSide, qty: number): Promise<Leg>;
  getOrderStatus(legId: string): Promise<Leg>;
}

export interface RealFill {
  orderId: string;
  status: "filled" | "partially_filled" | "failed" | "cancelled" | "timeout" | "skipped";
  filled: number;
  avg: number; // 0 when nothing filled or the venue didn't report a price
  error?: string;
}

const POLL_ATTEMPTS = 5;
const POLL_WAIT_MS = 1000;
const QTY_STEP = 0.001; // conservative lot step for the assets listed on Bybit here

export class BybitDemoExecutor {
  private orderTimes: number[] = [];

  constructor(
    private readonly adapter: OrderPlacer,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private readonly now: () => number = Date.now,
  ) {}

  /** Rate limit so a persistent spread can't spam the sandbox account. */
  canPlace(): boolean {
    const t = this.now();
    this.orderTimes = this.orderTimes.filter((x) => t - x < 60_000);
    return this.orderTimes.length < config.demoMaxOrdersPerMin;
  }

  static roundQty(qty: number): number {
    return Math.floor(qty / QTY_STEP) * QTY_STEP;
  }

  async placeAndAwait(assetId: string, side: LegSide, qty: number): Promise<RealFill> {
    const q = BybitDemoExecutor.roundQty(qty);
    if (q <= 0) return { orderId: "", status: "skipped", filled: 0, avg: 0, error: "quantity rounds to zero" };

    this.orderTimes.push(this.now());
    let leg: Leg;
    try {
      leg = await this.adapter.placeOrder(assetId, side, Number(q.toFixed(3)));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.failure({ venue: "bybit", stage: "demo_submit", message });
      return { orderId: "", status: "failed", filled: 0, avg: 0, error: message };
    }
    if (leg.status === "failed" || !leg.legId) {
      return { orderId: leg.legId, status: "failed", filled: 0, avg: 0, error: "order rejected by Bybit demo (see failure log for retCode)" };
    }

    let last: Leg = leg;
    for (let i = 0; i < POLL_ATTEMPTS; i++) {
      await this.sleep(POLL_WAIT_MS);
      try {
        last = await this.adapter.getOrderStatus(leg.legId);
      } catch (err) {
        logger.failure({ venue: "bybit", stage: "demo_status", orderId: leg.legId, message: err instanceof Error ? err.message : String(err) });
        continue;
      }
      if (last.status === "filled" || last.status === "cancelled" || last.status === "failed") break;
    }

    const status: RealFill["status"] = last.status === "pending" ? "timeout" : (last.status as RealFill["status"]);
    logger.tradeAttempt({ venue: "bybit", stage: "demo_result", orderId: leg.legId, status, filled: last.filledQty, avgPrice: last.avgPrice, sandbox: "demo-trading" });
    return { orderId: leg.legId, status, filled: last.filledQty, avg: last.avgPrice ?? 0 };
  }
}
