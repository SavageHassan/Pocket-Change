import type { FillResult, NormalizedQuote, UnwindEvent } from "../types/index.js";
import { simulateCexFill, simulateDexFill } from "./fillSimulator.js";

/**
 * FR-5.4 (critical, core of the non-atomic risk model): when one leg fills
 * more than the other, immediately place an offsetting order on the venue
 * where the (excess) fill happened to flatten the resulting directional
 * exposure — never leave a naked position. This simulates that action in
 * paper mode: an unmatched fill must never just sit there as an
 * unintended speculative position.
 */

const EPSILON = 1e-9;

function isDex(quote: NormalizedQuote): boolean {
  return quote.dexReserves !== undefined;
}

export interface UnwindResult {
  event: UnwindEvent;
  unwindFill: FillResult;
  fullyFlattened: boolean;
  venueId: string;
  side: "buy" | "sell";
}

/**
 * buyFill/sellFill are the (possibly mismatched) leg results. buyVenueQuote/
 * sellVenueQuote are the quotes for those venues, needed to simulate the
 * offsetting order. Returns null if the legs matched exactly — no unwind
 * needed.
 */
export function simulateUnwind(
  tradeId: string,
  assetId: string,
  buyVenueQuote: NormalizedQuote,
  sellVenueQuote: NormalizedQuote,
  buyFill: FillResult,
  sellFill: FillResult,
): UnwindResult | null {
  const netExposure = buyFill.filledQty - sellFill.filledQty;
  if (Math.abs(netExposure) < EPSILON) return null;

  let unwindFill: FillResult;
  let actionTaken: string;
  let realizedLoss: number;

  if (netExposure > 0) {
    // Bought more than we sold — naked LONG sitting on the buy venue.
    // Flatten it there: sell the excess immediately.
    const unwindQty = netExposure;
    unwindFill = isDex(buyVenueQuote) ? simulateDexFill(buyVenueQuote, "sell", unwindQty) : simulateCexFill(buyVenueQuote, "sell", unwindQty);
    actionTaken = `sold ${unwindQty.toFixed(6)} ${assetId} on ${buyVenueQuote.venueId} to flatten naked long exposure`;
    // Reference price is what the matched portion sold for — the unmatched
    // portion "should" have gotten the same price; the gap is the cost of
    // having to dump it urgently instead.
    const referencePrice = sellFill.avgPrice || buyFill.avgPrice;
    realizedLoss = unwindQty * (referencePrice - unwindFill.avgPrice);
  } else {
    // Sold more than we bought — naked SHORT sitting on the sell venue.
    // Flatten it there: buy back the excess immediately.
    const unwindQty = -netExposure;
    unwindFill = isDex(sellVenueQuote) ? simulateDexFill(sellVenueQuote, "buy", unwindQty) : simulateCexFill(sellVenueQuote, "buy", unwindQty);
    actionTaken = `bought back ${unwindQty.toFixed(6)} ${assetId} on ${sellVenueQuote.venueId} to flatten naked short exposure`;
    const referencePrice = buyFill.avgPrice || sellFill.avgPrice;
    realizedLoss = unwindQty * (unwindFill.avgPrice - referencePrice);
  }

  const unwindQty = Math.abs(netExposure);
  const fullyFlattened = unwindFill.filledQty >= unwindQty - EPSILON;

  const event: UnwindEvent = {
    id: `unwind_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
    tradeId,
    triggeringLegId: netExposure > 0 ? `${tradeId}:buy` : `${tradeId}:sell`,
    actionTaken: fullyFlattened ? actionTaken : `${actionTaken} — INCOMPLETE, only flattened ${unwindFill.filledQty.toFixed(6)} of ${unwindQty.toFixed(6)}`,
    realizedLoss,
    timestamp: Date.now(),
  };

  return {
    event,
    unwindFill,
    fullyFlattened,
    venueId: netExposure > 0 ? buyVenueQuote.venueId : sellVenueQuote.venueId,
    side: netExposure > 0 ? "sell" : "buy",
  };
}
