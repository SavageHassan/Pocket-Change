import type { NormalizedQuote, PaperTrade } from "../types/index.js";
import { ASSET_UNIVERSE } from "../config/assets.js";
import { config } from "../config/env.js";
import type { IngestionService } from "../ingestion/ingestionService.js";
import { logger } from "../monitoring/logger.js";
import type { PnLTracker } from "../monitoring/pnlTracker.js";
import type { UnwindTracker } from "../monitoring/unwindTracker.js";
import type { KillSwitch } from "../monitoring/killswitch.js";
import type { RiskMonitor } from "../monitoring/riskMonitor.js";
import type { CapitalManager } from "../capital/capitalManager.js";
import { scanForOpportunities } from "./opportunityDetector.js";
import { simulateCexFill, simulateDexFill } from "./fillSimulator.js";
import { simulateUnwind } from "./unwindSimulator.js";
import { maybeInjectFailure } from "./legFailureInjector.js";

/**
 * M1 (FR-9.1): re-price every opportunity that clears the threshold through
 * realistic fills. M2: optional leg-failure injection + a real simulated
 * unwind action (FR-5.4). M4: every trade now passes through capital and
 * risk controls first — pre-positioned balance check (FR-3.7), per-trade
 * size ceiling, per-venue halts (FR-8.4), the global kill switch — and every
 * fill, including the unwind's offsetting order, updates the capital ledger.
 *
 * No orders are placed anywhere; this is arithmetic on public data.
 */

let counter = 0;
function nextId(): string {
  counter += 1;
  return `pt_${Date.now()}_${counter}`;
}

function isDex(quote: NormalizedQuote): boolean {
  return quote.dexReserves !== undefined;
}

/** Explicit fee in quote-asset units, on whatever the leg actually executed. DEX fees are already embedded in simulateDexFill's avgPrice, so they're 0 here to avoid double-counting. */
function explicitFeeUsd(quote: NormalizedQuote, filledQty: number, avgPrice: number): number {
  if (isDex(quote) || filledQty <= 0) return 0;
  return filledQty * avgPrice * (quote.feeSchedule.takerBps / 10000);
}

export interface PaperTradingOptions {
  injectFailures?: boolean;
}

export interface RiskContext {
  capital: CapitalManager;
  risk: RiskMonitor;
  kill: KillSwitch;
}

/** Keep the paper ledger seeded and marked from live quotes (pre-positioned capital per FR-6.1). */
export async function syncCapital(ingestion: IngestionService, capital: CapitalManager): Promise<void> {
  for (const asset of ASSET_UNIVERSE) {
    for (const venueId of ingestion.listVenueIds()) {
      const entry = await ingestion.getQuote(venueId, asset.canonicalAssetId);
      if (!entry) continue;
      const q = entry.quote;
      const mid = q.bestBid !== undefined && q.bestAsk !== undefined ? (q.bestBid + q.bestAsk) / 2 : q.impliedPrice;
      if (mid) {
        capital.seedIfNeeded(venueId, asset.canonicalAssetId, mid);
        capital.mark(asset.canonicalAssetId, mid);
      }
    }
  }
}

const lastRejectLog = new Map<string, number>();
function logReject(key: string, payload: Record<string, unknown>): void {
  const now = Date.now();
  if (now - (lastRejectLog.get(key) ?? 0) < 15000) return; // throttled so a sustained condition doesn't flood the log
  lastRejectLog.set(key, now);
  logger.risk({ event_type: "trade_rejected", ...payload });
}

export async function runPaperTradingCycle(
  ingestion: IngestionService,
  pnlTracker: PnLTracker,
  unwindTracker: UnwindTracker,
  ctx: RiskContext,
  options: PaperTradingOptions = {},
): Promise<PaperTrade[]> {
  const opportunities = await scanForOpportunities(ingestion); // already logs each candidate
  const trades: PaperTrade[] = [];
  await syncCapital(ingestion, ctx.capital);

  for (const opp of opportunities) {
    if (ctx.kill.isTripped()) break; // an automatic trip stops NEW trades; detection above keeps running

    if (ctx.kill.isVenueHalted(opp.buyVenueId) || ctx.kill.isVenueHalted(opp.sellVenueId)) {
      const halted = ctx.kill.isVenueHalted(opp.buyVenueId) ? opp.buyVenueId : opp.sellVenueId;
      logReject(`halt:${halted}`, { venue: halted, reason: "venue halted (FR-8.4), skipping routes through it" });
      continue;
    }

    const buyEntry = await ingestion.getQuote(opp.buyVenueId, opp.assetId);
    const sellEntry = await ingestion.getQuote(opp.sellVenueId, opp.assetId);
    if (!buyEntry || !sellEntry) continue;

    const sizeUsd = Math.min(config.paperTradeSizeUsd, config.maxTradeUsd);
    const qtyBase = sizeUsd / opp.buyPrice;

    const pre = ctx.capital.preTrade(opp.buyVenueId, opp.sellVenueId, opp.assetId, qtyBase, opp.buyPrice, buyEntry.quote.feeSchedule.takerBps);
    if (!pre.ok) {
      logReject(`pre:${opp.assetId}:${opp.buyVenueId}:${opp.sellVenueId}`, { route: `${opp.assetId} ${opp.buyVenueId}->${opp.sellVenueId}`, reason: pre.reason });
      continue;
    }

    let buyFill = isDex(buyEntry.quote) ? simulateDexFill(buyEntry.quote, "buy", qtyBase) : simulateCexFill(buyEntry.quote, "buy", qtyBase);
    let sellFill = isDex(sellEntry.quote) ? simulateDexFill(sellEntry.quote, "sell", qtyBase) : simulateCexFill(sellEntry.quote, "sell", qtyBase);

    if (options.injectFailures) {
      if (Math.random() < 0.5) {
        buyFill = maybeInjectFailure(buyFill);
      } else {
        sellFill = maybeInjectFailure(sellFill);
      }
    }

    if (buyFill.filledQty <= 0 && sellFill.filledQty <= 0) continue;

    const matchedQty = Math.min(buyFill.filledQty, sellFill.filledQty);
    const grossPnl = matchedQty * (sellFill.avgPrice - buyFill.avgPrice);
    const buyFeeUsd = explicitFeeUsd(buyEntry.quote, buyFill.filledQty, buyFill.avgPrice);
    const sellFeeUsd = explicitFeeUsd(sellEntry.quote, sellFill.filledQty, sellFill.avgPrice);
    const feesUsd = buyFeeUsd + sellFeeUsd;

    const trade: PaperTrade = {
      id: nextId(),
      timestamp: Date.now(),
      assetId: opp.assetId,
      buyVenueId: opp.buyVenueId,
      sellVenueId: opp.sellVenueId,
      tradeSizeUsd: sizeUsd,
      theoreticalNetSpreadBps: opp.netSpreadBps,
      buyFill,
      sellFill,
      matchedQty,
      feesUsd,
      realizedPnlUsd: 0,
    };

    ctx.capital.applyTrade(
      opp.buyVenueId,
      opp.sellVenueId,
      opp.assetId,
      { filled: buyFill.filledQty, avg: buyFill.avgPrice },
      { filled: sellFill.filledQty, avg: sellFill.avgPrice },
      buyFeeUsd,
      sellFeeUsd,
    );

    const unwind = simulateUnwind(trade.id, opp.assetId, buyEntry.quote, sellEntry.quote, buyFill, sellFill);
    let unwindLoss = 0;
    if (unwind) {
      unwindLoss = unwind.event.realizedLoss;
      unwindTracker.record(unwind.event, unwind.fullyFlattened);
      ctx.capital.applyUnwind(unwind.venueId, opp.assetId, unwind.side, unwind.unwindFill.filledQty, unwind.unwindFill.avgPrice);
      logger.unwind({
        ...unwind.event,
        fullyFlattened: unwind.fullyFlattened,
        buyFilledQty: buyFill.filledQty,
        sellFilledQty: sellFill.filledQty,
      });
    }

    trade.realizedPnlUsd = grossPnl - feesUsd - unwindLoss;

    logger.paperTrade(trade);
    pnlTracker.record(trade);
    trades.push(trade);

    ctx.risk.recordTrade(!!unwind);
    ctx.risk.recordSessionPnl(pnlTracker.totalRealizedPnlUsd());
  }

  ctx.risk.checkCustody();
  return trades;
}
