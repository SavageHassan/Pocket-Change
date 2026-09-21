import { config } from "../config/env.js";
import type { CapitalManager, Mismatch } from "../capital/capitalManager.js";
import { logger } from "./logger.js";
import type { KillSwitch } from "./killswitch.js";

/**
 * M4 automatic kill-switch triggers:
 *   FR-8.5  elevated unwind rate  -> global trip (the hedged-execution model is failing)
 *   FR-8.4  venue feed errors     -> halt that venue only, auto-resume once it recovers
 *   FR-6.4  custody cap breach    -> halt that venue
 *   NFR     reconciliation drift  -> halt that venue
 *   limit   session realized loss -> global trip
 * All thresholds live in config/env.ts.
 */
export class RiskMonitor {
  private recentUnwinds: boolean[] = [];
  private errorTimes = new Map<string, number[]>();
  private okStreak = new Map<string, number>();
  private errorHalted = new Set<string>();

  constructor(
    private readonly kill: KillSwitch,
    private readonly capital: CapitalManager,
  ) {}

  unwindRate(): number {
    if (!this.recentUnwinds.length) return 0;
    return this.recentUnwinds.filter(Boolean).length / this.recentUnwinds.length;
  }

  recordTrade(hadUnwind: boolean): void {
    this.recentUnwinds.push(hadUnwind);
    if (this.recentUnwinds.length > config.unwindRateWindow) this.recentUnwinds.shift();
    const rate = this.unwindRate();
    if (this.recentUnwinds.length >= config.unwindRateWindow && rate > config.unwindRateThreshold) {
      logger.risk({ event_type: "auto_kill", trigger: "elevated_unwind_rate", rate, window: config.unwindRateWindow, threshold: config.unwindRateThreshold });
      this.kill.trip("elevated_unwind_rate");
    }
  }

  recordSessionPnl(totalRealizedUsd: number): void {
    if (totalRealizedUsd <= -config.maxSessionLossUsd) {
      logger.risk({ event_type: "auto_kill", trigger: "session_loss_limit", realizedUsd: totalRealizedUsd, limit: -config.maxSessionLossUsd });
      this.kill.trip("session_loss_limit");
    }
  }

  /** Feed a venue's poll result. Repeated errors halt just that venue; sustained recovery resumes it. */
  recordVenueResult(venueId: string, ok: boolean, now = Date.now()): void {
    if (ok) {
      const streak = (this.okStreak.get(venueId) ?? 0) + 1;
      this.okStreak.set(venueId, streak);
      if (this.errorHalted.has(venueId) && streak >= config.venueRecoverySuccesses) {
        this.errorHalted.delete(venueId);
        this.kill.resumeVenue(venueId);
      }
      return;
    }
    this.okStreak.set(venueId, 0);
    const times = (this.errorTimes.get(venueId) ?? []).filter((t) => now - t <= config.venueErrorWindowMs);
    times.push(now);
    this.errorTimes.set(venueId, times);
    if (times.length >= config.venueErrorThreshold && !this.errorHalted.has(venueId)) {
      this.errorHalted.add(venueId);
      this.kill.haltVenue(venueId, `feed errors: ${times.length} in ${config.venueErrorWindowMs / 1000}s`);
    }
  }

  /** FR-6.4: a capped venue holding too much of total capital gets halted. */
  checkCustody(): void {
    for (const b of this.capital.custodyBreaches()) {
      this.kill.haltVenue(b.venue, `custody cap breached: ${b.sharePct.toFixed(1)}% > ${config.custodyCapPct}%`);
    }
  }

  /** Compare the ledger with what the venues report; drift halts the offending venue. */
  reconcile(actual = this.capital.actualView()): Mismatch[] {
    const mismatches = this.capital.reconcile(actual);
    for (const m of mismatches) {
      logger.risk({ event_type: "reconciliation_drift", ...m });
      this.kill.haltVenue(m.venue, `reconciliation drift on ${m.what}: ${m.driftPctOfVenue.toFixed(2)}% of venue value`);
    }
    return mismatches;
  }
}
