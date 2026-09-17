import type { FillResult, LegSide, NormalizedQuote } from "../types/index.js";

/**
 * M1 (FR-9.1): realistic fill simulation instead of idealized full fills at
 * the quoted top-of-book/implied price. Two models, one per venue type —
 * see README "Deviations" for the CLMM approximation caveat on the DEX side.
 */

interface MexcRawBook {
  bids: [string, string][];
  asks: [string, string][];
}

/** Walk the order book levels, consuming liquidity until qtyBase is filled or the book runs out. */
export function simulateCexFill(quote: NormalizedQuote, side: LegSide, qtyBase: number): FillResult {
  const raw = quote.raw as MexcRawBook | undefined;
  const levels = side === "buy" ? raw?.asks : raw?.bids;
  if (!levels?.length) {
    // No book depth captured (shouldn't happen once refresh() has run) — fail closed to 0 fill rather than assume top-of-book.
    return { requestedQty: qtyBase, filledQty: 0, avgPrice: 0, fullyFilled: false };
  }

  let remaining = qtyBase;
  let notionalSpent = 0;
  for (const [priceStr, qtyStr] of levels) {
    if (remaining <= 0) break;
    const levelPrice = Number(priceStr);
    const levelQty = Number(qtyStr);
    const take = Math.min(remaining, levelQty);
    notionalSpent += take * levelPrice;
    remaining -= take;
  }

  const filledQty = qtyBase - remaining;
  return {
    requestedQty: qtyBase,
    filledQty,
    avgPrice: filledQty > 0 ? notionalSpent / filledQty : 0,
    fullyFilled: remaining <= 1e-12,
  };
}

/**
 * Constant-product (x*y=k) slippage model, using *virtual* reserves derived
 * from the pool's current price and TVL rather than its raw on-chain token
 * amounts.
 *
 * Why not the raw reserves: the configured Raydium pools are CLMM
 * (concentrated liquidity) pools. Their `mintAmountA`/`mintAmountB` are the
 * pool's total token holdings aggregated across the *entire* tick range the
 * pool has ever had liquidity in — not tokens deployed as a single
 * constant-product curve at the current price. Verified live during
 * testing: the SOL/USDT pool's raw reserve ratio implied a price ~27%
 * away from the pool's own quoted `price` field (which Raydium computes
 * tick-aware and which its own frontend uses). Treating the raw reserves
 * as literal x*y=k inputs produced a DEX leg priced 28% off the real
 * market — enough to fabricate a fake arbitrage profit in the P&L tracker.
 *
 * Instead: construct virtual reserves that are internally consistent with
 * the pool's real price (virtualBase * virtualQuote price ratio == the
 * quoted price) and sized by TVL as a depth proxy. This still
 * approximates a CLMM as a flat constant-product curve — real concentrated
 * liquidity near the current price would produce less slippage than this
 * model for the same trade size, so simulated DEX slippage here is
 * conservative (an overstatement), not exact — but it starts from the
 * correct price rather than a wrong one.
 */
export function simulateDexFill(quote: NormalizedQuote, side: LegSide, qtyBase: number): FillResult {
  const price = quote.impliedPrice;
  const tvl = quote.liquidityUsd;
  const feeRate = quote.feeSchedule.takerBps / 10000;
  if (!price || !tvl || price <= 0 || tvl <= 0) {
    return { requestedQty: qtyBase, filledQty: 0, avgPrice: 0, fullyFilled: false };
  }

  const virtualQuoteReserve = tvl / 2;
  const virtualBaseReserve = virtualQuoteReserve / price;
  const k = virtualBaseReserve * virtualQuoteReserve;

  if (side === "buy") {
    // Buying qtyBase of the base asset out of the pool.
    if (qtyBase >= virtualBaseReserve) {
      // Would drain the modeled liquidity — not fillable.
      return { requestedQty: qtyBase, filledQty: 0, avgPrice: 0, fullyFilled: false };
    }
    const newBase = virtualBaseReserve - qtyBase;
    const newQuote = k / newBase;
    const quoteInBeforeFee = newQuote - virtualQuoteReserve;
    const quoteIn = quoteInBeforeFee / (1 - feeRate);
    return { requestedQty: qtyBase, filledQty: qtyBase, avgPrice: quoteIn / qtyBase, fullyFilled: true };
  } else {
    // Selling qtyBase of the base asset into the pool.
    const newBase = virtualBaseReserve + qtyBase;
    const newQuote = k / newBase;
    const quoteOutBeforeFee = virtualQuoteReserve - newQuote;
    const quoteOut = quoteOutBeforeFee * (1 - feeRate);
    return { requestedQty: qtyBase, filledQty: qtyBase, avgPrice: quoteOut / qtyBase, fullyFilled: true };
  }
}
