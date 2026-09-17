import type { NormalizedQuote, PaperTrade } from "../types/index.js";
import { config } from "../config/env.js";
import type { IngestionService } from "../ingestion/ingestionService.js";
import { logger } from "../monitoring/logger.js";
import type { PnLTracker } from "../monitoring/pnlTracker.js";
import { scanForOpportunities } from "./opportunityDetector.js";
import { simulateCexFill, simulateDexFill } from "./fillSimulator.js";

/**
 * M1 paper trading (FR-9.1): for every opportunity that clears the profit
 * threshold, re-price it through realistic fill simulation instead of
 * assuming full fill at the quoted price, and record the hypothetical
 * result. No orders are placed anywhere — this only reads the same public
 * data M0 already polls and does arithmetic on it.
 */

let counter = 0;
function nextId(): string {
  counter += 1;
  return `pt_${Date.now()}_${counter}`;
}

function isDex(quote: NormalizedQuote): boolean {
  return quote.dexReserves !== undefined;
}

/** Explicit fee in quote-asset units. DEX fees are already embedded in simulateDexFill's avgPrice, so they're 0 here to avoid double-counting. */
function explicitFeeUsd(quote: NormalizedQuote, filledQty: number, avgPrice: number): number {
  if (isDex(quote)) return 0;
  return filledQty * avgPrice * (quote.feeSchedule.takerBps / 10000);
}

export async function runPaperTradingCycle(ingestion: IngestionService, pnlTracker: PnLTracker): Promise<PaperTrade[]> {
  const opportunities = await scanForOpportunities(ingestion); // already logs each candidate
  const trades: PaperTrade[] = [];

  for (const opp of opportunities) {
    const buyEntry = await ingestion.getQuote(opp.buyVenueId, opp.assetId);
    const sellEntry = await ingestion.getQuote(opp.sellVenueId, opp.assetId);
    if (!buyEntry || !sellEntry) continue;

    const qtyBase = config.paperTradeSizeUsd / opp.buyPrice;

    const buyFill = isDex(buyEntry.quote)
      ? simulateDexFill(buyEntry.quote, "buy", qtyBase)
      : simulateCexFill(buyEntry.quote, "buy", qtyBase);
    const sellFill = isDex(sellEntry.quote)
      ? simulateDexFill(sellEntry.quote, "sell", qtyBase)
      : simulateCexFill(sellEntry.quote, "sell", qtyBase);

    const matchedQty = Math.min(buyFill.filledQty, sellFill.filledQty);
    if (matchedQty <= 0) continue; // nothing fillable on one or both sides — no trade to record

    const grossPnl = matchedQty * (sellFill.avgPrice - buyFill.avgPrice);
    const feesUsd = explicitFeeUsd(buyEntry.quote, matchedQty, buyFill.avgPrice) + explicitFeeUsd(sellEntry.quote, matchedQty, sellFill.avgPrice);
    const realizedPnlUsd = grossPnl - feesUsd;

    const trade: PaperTrade = {
      id: nextId(),
      timestamp: Date.now(),
      assetId: opp.assetId,
      buyVenueId: opp.buyVenueId,
      sellVenueId: opp.sellVenueId,
      tradeSizeUsd: config.paperTradeSizeUsd,
      theoreticalNetSpreadBps: opp.netSpreadBps,
      buyFill,
      sellFill,
      matchedQty,
      feesUsd,
      realizedPnlUsd,
    };

    logger.paperTrade(trade);
    pnlTracker.record(trade);
    trades.push(trade);

    // Simulated fills mismatching in size is the paper-mode analog of FR-5.4's
    // trigger condition (one leg fills more than the other). M1 only detects
    // and logs it here; M2 is where leg failures are deliberately injected
    // and an actual unwind action is simulated per your milestone plan.
    if (Math.abs(buyFill.filledQty - sellFill.filledQty) > 1e-9) {
      logger.unwind({
        tradeId: trade.id,
        reason: "simulated leg fill mismatch",
        buyFilledQty: buyFill.filledQty,
        sellFilledQty: sellFill.filledQty,
        unmatchedQty: Math.abs(buyFill.filledQty - sellFill.filledQty),
      });
    }
  }

  return trades;
}
