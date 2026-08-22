import type { NormalizedQuote, Opportunity } from "../types/index.js";
import { ASSET_UNIVERSE } from "../config/assets.js";
import { config } from "../config/env.js";
import type { IngestionService } from "../ingestion/ingestionService.js";
import { logger } from "../monitoring/logger.js";

/**
 * FR-2: cross-venue opportunity detection. M0 scope only — this compares
 * fee-adjusted prices across the (currently two) configured venues per
 * asset and logs anything above the configured net-spread threshold. It
 * does NOT execute anything (M0 is detection-only) and does not yet model
 * DEX-side slippage or CEX partial fills — that's M1's paper-trading engine
 * (FR-9.1). With only two venues configured, this is effectively a 2-node
 * price graph rather than the general N-venue graph search FR-2.2 describes
 * (Bellman-Ford-style cycle detection); the pairwise comparison here is the
 * n=2 special case and will need to generalize once a third venue is added.
 */

function executionPrice(quote: NormalizedQuote, side: "buy" | "sell"): number | null {
  if (quote.bestBid !== undefined && quote.bestAsk !== undefined) {
    // CEX: buying costs the ask, selling receives the bid.
    return side === "buy" ? quote.bestAsk : quote.bestBid;
  }
  if (quote.impliedPrice !== undefined) {
    // DEX pool-implied mid price — no separate bid/ask from this API;
    // real slippage against pool depth is modeled starting in M1.
    return quote.impliedPrice;
  }
  return null;
}

let counter = 0;
function nextId(): string {
  counter += 1;
  return `opp_${Date.now()}_${counter}`;
}

export async function scanForOpportunities(ingestion: IngestionService): Promise<Opportunity[]> {
  const venueIds = ingestion.listVenueIds();
  const found: Opportunity[] = [];

  for (const asset of ASSET_UNIVERSE) {
    for (const buyVenueId of venueIds) {
      for (const sellVenueId of venueIds) {
        if (buyVenueId === sellVenueId) continue;

        const buyEntry = await ingestion.getQuote(buyVenueId, asset.canonicalAssetId);
        const sellEntry = await ingestion.getQuote(sellVenueId, asset.canonicalAssetId);
        if (!buyEntry || !sellEntry) continue;
        if (!buyEntry.isFresh || !sellEntry.isFresh) continue; // FR-1.5: never mix stale with fresh

        const buyPrice = executionPrice(buyEntry.quote, "buy");
        const sellPrice = executionPrice(sellEntry.quote, "sell");
        if (buyPrice === null || sellPrice === null || buyPrice <= 0) continue;

        const grossSpreadBps = ((sellPrice - buyPrice) / buyPrice) * 10000;
        const estFeesBps = buyEntry.quote.feeSchedule.takerBps + sellEntry.quote.feeSchedule.takerBps;
        const netSpreadBps = grossSpreadBps - estFeesBps;

        if (netSpreadBps < config.minNetSpreadBps) continue;

        const flaggedAnomalous = grossSpreadBps > config.anomalyThresholdBps;

        const opp: Opportunity = {
          id: nextId(),
          detectedAt: Date.now(),
          assetId: asset.canonicalAssetId,
          buyVenueId,
          sellVenueId,
          buyPrice,
          sellPrice,
          grossSpreadBps,
          estFeesBps,
          netSpreadBps,
          buyQuoteAgeMs: Date.now() - buyEntry.quote.fetchedAt,
          sellQuoteAgeMs: Date.now() - sellEntry.quote.fetchedAt,
          flaggedAnomalous,
          anomalyReason: flaggedAnomalous
            ? `gross spread ${grossSpreadBps.toFixed(1)}bps exceeds anomaly threshold ${config.anomalyThresholdBps}bps — likely stale/broken quote, not real profit (FR-2.5)`
            : undefined,
        };

        found.push(opp);
        logger.opportunity(opp);
      }
    }
  }

  return found;
}
