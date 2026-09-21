import { config } from "../config/env.js";

/**
 * FR-6 / FR-3.7: capital allocation on a PAPER ledger. Cross-venue arbitrage
 * only works with pre-positioned capital on both sides — USDT on the venue
 * you buy at, the base asset on the venue you sell at — so before any trade
 * this checks both balances exist, and it enforces the hard per-venue
 * custody cap (FR-6.4) that bounds counterparty loss if an exchange freezes.
 *
 * Nothing here moves real money. Real rebalancing (FR-6.2) needs withdrawals,
 * which this codebase deliberately doesn't implement; `rebalanceSuggestions()`
 * only tells the operator what they'd need to move.
 */

export interface VenueLedger {
  usdt: number;
  assets: Map<string, number>; // base-asset units
}

export interface CapitalStatus {
  totalUsd: number;
  startUsd: number;
  venues: Array<{ venue: string; usdt: number; assetsUsd: number; valueUsd: number; sharePct: number; capped: boolean }>;
  custodyCapPct: number;
  breaches: Array<{ venue: string; sharePct: number }>;
  rebalance: string[];
}

export type PreTradeResult = { ok: true } | { ok: false; reason: string };

export interface Mismatch {
  venue: string;
  what: string;
  expected: number;
  actual: number;
  driftPctOfVenue: number;
}

export class CapitalManager {
  private ledgers = new Map<string, VenueLedger>();
  private prices = new Map<string, number>();
  private seeded = new Set<string>();
  private startUsd = 0;

  constructor(private readonly cappedVenues: Set<string>) {}

  seedIfNeeded(venueId: string, assetId: string, price: number): void {
    if (!this.ledgers.has(venueId)) {
      this.ledgers.set(venueId, { usdt: config.startCapitalUsdPerVenue, assets: new Map() });
      this.startUsd += config.startCapitalUsdPerVenue;
    }
    const key = `${venueId}|${assetId}`;
    if (this.seeded.has(key) || !(price > 0)) return;
    this.seeded.add(key);
    this.ledgers.get(venueId)!.assets.set(assetId, config.startAssetUsdPerVenue / price);
    this.startUsd += config.startAssetUsdPerVenue;
    this.prices.set(assetId, price);
  }

  mark(assetId: string, price: number): void {
    if (price > 0) this.prices.set(assetId, price);
  }

  private units(venueId: string, assetId: string): number {
    return this.ledgers.get(venueId)?.assets.get(assetId) ?? 0;
  }

  /** FR-3.7: both legs' capital must already be there before leg 1 starts. */
  preTrade(buyVenue: string, sellVenue: string, assetId: string, qty: number, buyPrice: number, buyFeeBps: number): PreTradeResult {
    const usdtNeeded = qty * buyPrice * (1 + buyFeeBps / 10000);
    const usdtHave = this.ledgers.get(buyVenue)?.usdt ?? 0;
    if (usdtHave < usdtNeeded) {
      return { ok: false, reason: `insufficient USDT on ${buyVenue}: need ${usdtNeeded.toFixed(2)}, have ${usdtHave.toFixed(2)}` };
    }
    const unitsHave = this.units(sellVenue, assetId);
    if (unitsHave < qty) {
      return { ok: false, reason: `insufficient ${assetId} on ${sellVenue}: need ${qty.toFixed(4)}, have ${unitsHave.toFixed(4)}` };
    }
    return { ok: true };
  }

  applyTrade(
    buyVenue: string,
    sellVenue: string,
    assetId: string,
    buy: { filled: number; avg: number },
    sell: { filled: number; avg: number },
    buyFeeUsd: number,
    sellFeeUsd: number,
  ): void {
    const b = this.ledgers.get(buyVenue);
    const s = this.ledgers.get(sellVenue);
    if (!b || !s) return;
    b.usdt -= buy.filled * buy.avg + buyFeeUsd;
    b.assets.set(assetId, this.units(buyVenue, assetId) + buy.filled);
    s.assets.set(assetId, this.units(sellVenue, assetId) - sell.filled);
    s.usdt += sell.filled * sell.avg - sellFeeUsd;
  }

  /** The offsetting order from FR-5.4 also moves real inventory — it has to hit the ledger too. */
  applyUnwind(venueId: string, assetId: string, side: "buy" | "sell", filled: number, avg: number): void {
    const l = this.ledgers.get(venueId);
    if (!l) return;
    if (side === "sell") {
      l.assets.set(assetId, this.units(venueId, assetId) - filled);
      l.usdt += filled * avg;
    } else {
      l.assets.set(assetId, this.units(venueId, assetId) + filled);
      l.usdt -= filled * avg;
    }
  }

  venueValueUsd(venueId: string): number {
    const l = this.ledgers.get(venueId);
    if (!l) return 0;
    let v = l.usdt;
    for (const [asset, units] of l.assets) v += units * (this.prices.get(asset) ?? 0);
    return v;
  }

  totalUsd(): number {
    let t = 0;
    for (const v of this.ledgers.keys()) t += this.venueValueUsd(v);
    return t;
  }

  /** FR-6.4: any capped venue holding more than its allowed share of total capital. */
  custodyBreaches(): Array<{ venue: string; sharePct: number }> {
    const total = this.totalUsd();
    if (total <= 0) return [];
    const out: Array<{ venue: string; sharePct: number }> = [];
    for (const v of this.cappedVenues) {
      const share = (this.venueValueUsd(v) / total) * 100;
      if (share > config.custodyCapPct) out.push({ venue: v, sharePct: share });
    }
    return out;
  }

  /** FR-6.3: flag venues drawn down toward the FR-3.7 minimum, and say what to move. */
  rebalanceSuggestions(): string[] {
    const out: string[] = [];
    for (const [venue, l] of this.ledgers) {
      if (l.usdt < config.startCapitalUsdPerVenue * 0.15) out.push(`${venue}: USDT down to ${l.usdt.toFixed(0)} (started ${config.startCapitalUsdPerVenue}) — can't buy here until topped up`);
      for (const [asset, units] of l.assets) {
        const start = config.startAssetUsdPerVenue / (this.prices.get(asset) || 1);
        if (units < start * 0.15) out.push(`${venue}: ${asset} down to ${units.toFixed(3)} (started ~${start.toFixed(3)}) — can't sell here until topped up`);
      }
    }
    return out;
  }

  /**
   * NFR reconciliation: compare what we believe we hold with what the venue
   * reports. Non-atomic legs can drift from expectations, so a mismatch
   * beyond tolerance is a signal, not noise.
   */
  reconcile(actual: Map<string, VenueLedger>): Mismatch[] {
    const out: Mismatch[] = [];
    for (const [venue, exp] of this.ledgers) {
      const act = actual.get(venue);
      if (!act) continue;
      const venueVal = Math.max(this.venueValueUsd(venue), 1);
      const check = (what: string, e: number, a: number, priceUsd: number) => {
        const driftPct = (Math.abs(e - a) * priceUsd / venueVal) * 100;
        if (driftPct > config.reconcileTolerancePct) out.push({ venue, what, expected: e, actual: a, driftPctOfVenue: driftPct });
      };
      check("USDT", exp.usdt, act.usdt, 1);
      for (const [asset, units] of exp.assets) check(asset, units, act.assets.get(asset) ?? 0, this.prices.get(asset) ?? 0);
    }
    return out;
  }

  /** What the "exchange" would report — in paper mode, exactly the ledger. */
  actualView(): Map<string, VenueLedger> {
    const m = new Map<string, VenueLedger>();
    for (const [v, l] of this.ledgers) m.set(v, { usdt: l.usdt, assets: new Map(l.assets) });
    return m;
  }

  snapshot(): CapitalStatus {
    const total = this.totalUsd();
    const venues = [...this.ledgers.keys()].map((venue) => {
      const l = this.ledgers.get(venue)!;
      const value = this.venueValueUsd(venue);
      return { venue, usdt: l.usdt, assetsUsd: value - l.usdt, valueUsd: value, sharePct: total > 0 ? (value / total) * 100 : 0, capped: this.cappedVenues.has(venue) };
    });
    return { totalUsd: total, startUsd: this.startUsd, venues, custodyCapPct: config.custodyCapPct, breaches: this.custodyBreaches(), rebalance: this.rebalanceSuggestions() };
  }
}
