import type { NormalizedQuote, PaperTrade } from "../types/index.js";
import { config } from "../config/env.js";
import type { IngestionService } from "../ingestion/ingestionService.js";
import { logger } from "../monitoring/logger.js";
import type { PnLTracker } from "../monitoring/pnlTracker.js";
import type { UnwindTracker } from "../monitoring/unwindTracker.js";
import { scanForOpportunities } from "./opportunityDetector.js";
import { simulateCexFill, simulateDexFill } from "./fillSimulator.js";
import { simulateUnwind } from "./unwindSimulator.js";
import { maybeInjectFailure } from "./legFailureInjector.js";

/**
 * M1 (FR-9.1): for every opportunity that clears the profit threshold,
 * re-price it through realistic fill simulation instead of assuming full
 * fill at the quoted price.
 *
 * M2 adds: optional deliberate leg-failure injection (`options.injectFailures`,
 * wired to the `--stress-test` CLI flag — never on by default), and an
 * actual simulated unwind ACTION (FR-5.4) when the two legs mismatch —
 * not just a logged observation. The unwind's realized cost is folded into
 * the trade's P&L, since flattening a naked position isn't free.
 *
 * No orders are placed anywhere — this only reads public data and injected
 * synthetic failures, and does arithmetic on them.
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

export async function runPaperTradingCycle(
  ingestion: IngestionService,
  pnlTracker: PnLTracker,
  unwindTracker: UnwindTracker,
  options: PaperTradingOptions = {},
): Promise<PaperTrade[]> {
  const opportunities = await scanForOpportunities(ingestion); // already logs each candidate
  const trades: PaperTrade[] = [];

  for (const opp of opportunities) {
    const buyEntry = await ingestion.getQuote(opp.buyVenueId, opp.assetId);
    const sellEntry = await ingestion.getQuote(opp.sellVenueId, opp.assetId);
    if (!buyEntry || !sellEntry) continue;

    const qtyBase = config.paperTradeSizeUsd / opp.buyPrice;

    let buyFill = isDex(buyEntry.quote) ? simulateDexFill(buyEntry.quote, "buy", qtyBase) : simulateCexFill(buyEntry.quote, "buy", qtyBase);
    let sellFill = isDex(sellEntry.quote) ? simulateDexFill(sellEntry.quote, "sell", qtyBase) : simulateCexFill(sellEntry.quote, "sell", qtyBase);

    if (options.injectFailures) {
      // Corrupt exactly one side per trade — this is what forces the
      // one-leg-fills-one-doesn't scenario FR-5.4 exists for, deterministically
      // enough to actually exercise the unwind path (natural depth-driven
      // mismatches at $500 trade size are rare against these pools/books).
      if (Math.random() < 0.5) {
        buyFill = maybeInjectFailure(buyFill);
      } else {
        sellFill = maybeInjectFailure(sellFill);
      }
    }

    if (buyFill.filledQty <= 0 && sellFill.filledQty <= 0) continue; // nothing happened on either side — nothing to record

    const matchedQty = Math.min(buyFill.filledQty, sellFill.filledQty);
    const grossPnl = matchedQty * (sellFill.avgPrice - buyFill.avgPrice);
    const feesUsd = explicitFeeUsd(buyEntry.quote, buyFill.filledQty, buyFill.avgPrice) + explicitFeeUsd(sellEntry.quote, sellFill.filledQty, sellFill.avgPrice);

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
      realizedPnlUsd: 0, // filled in below, after any unwind cost is known
    };

    // FR-5.4: the legs mismatched (a total or partial single-leg failure) —
    // immediately flatten the resulting exposure rather than leave it naked.
    const unwind = simulateUnwind(trade.id, opp.assetId, buyEntry.quote, sellEntry.quote, buyFill, sellFill);
    let unwindLoss = 0;
    if (unwind) {
      unwindLoss = unwind.event.realizedLoss;
      unwindTracker.record(unwind.event, unwind.fullyFlattened);
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
  }

  return trades;
}
