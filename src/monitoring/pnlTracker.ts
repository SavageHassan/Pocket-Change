import type { PaperTrade } from "../types/index.js";

interface PairStats {
  key: string; // "ASSET:buyVenue->sellVenue"
  trades: number;
  theoreticalPnlUsd: number; // what the spread implied, ignoring slippage
  realizedPnlUsd: number; // what the fill simulation actually produced
}

/**
 * FR-7.6: track realized vs. theoretical profit per venue-pair over time.
 * In-memory for M1 — a venue/pair that consistently underperforms its
 * theoretical edge is exactly the signal FR-7.6 says should eventually
 * auto-deprioritize that route, though the auto-deprioritization itself is
 * M2+ scope (needs more history than a single local run accumulates).
 */
export class PnLTracker {
  private byPair = new Map<string, PairStats>();
  private allTrades: PaperTrade[] = [];

  record(trade: PaperTrade): void {
    this.allTrades.push(trade);
    const key = `${trade.assetId}:${trade.buyVenueId}->${trade.sellVenueId}`;
    const existing = this.byPair.get(key) ?? { key, trades: 0, theoreticalPnlUsd: 0, realizedPnlUsd: 0 };
    existing.trades += 1;
    existing.theoreticalPnlUsd += (trade.theoreticalNetSpreadBps / 10000) * trade.tradeSizeUsd;
    existing.realizedPnlUsd += trade.realizedPnlUsd;
    this.byPair.set(key, existing);
  }

  summary(): PairStats[] {
    return [...this.byPair.values()].sort((a, b) => b.trades - a.trades);
  }

  totalRealizedPnlUsd(): number {
    return this.allTrades.reduce((sum, t) => sum + t.realizedPnlUsd, 0);
  }

  tradeCount(): number {
    return this.allTrades.length;
  }
}
