import type { FillResult } from "../types/index.js";

/**
 * M2 (per your milestone plan): deliberately simulate leg failures in paper
 * mode to stress-test the unwind procedure, rather than relying only on the
 * rare, small mismatches that naturally occur from real order-book/pool
 * depth (M1's $500 trades barely dent the liquidity here, so natural
 * mismatches are uncommon — not enough to prove the unwind path reliably).
 *
 * Only active behind the explicit `--stress-test` CLI flag (see cli.ts) —
 * never runs during normal paper-mode operation, so it can't be mistaken
 * for real market behavior.
 */
export function maybeInjectFailure(fill: FillResult, rng: () => number = Math.random): FillResult {
  const roll = rng();
  if (roll < 0.4) {
    // Total failure: this leg fills 0% (e.g. order rejected, API error).
    return { ...fill, filledQty: 0, avgPrice: 0, fullyFilled: false };
  }
  if (roll < 0.8) {
    // Partial failure: fills some random fraction of what it otherwise would have.
    const frac = 0.1 + rng() * 0.6;
    return { ...fill, filledQty: fill.filledQty * frac, fullyFilled: false };
  }
  // Remaining 20% of rolls: no injected failure, fill stands as simulated.
  return fill;
}
