import { existsSync } from "node:fs";
import { logger } from "./logger.js";

// FR-8: kill switch. Manual triggers (Ctrl+C, KILL_SWITCH file) stop the
// process. Automatic triggers (M4: elevated unwind rate, session loss limit,
// reconciliation drift) stop all NEW trades but keep the process alive so
// monitoring stays visible — a tripped switch you can still observe beats a
// dead process you can't. Per-venue halts (FR-8.4) pause one venue only.

export type KillReason =
  | "manual"
  | "manual_file"
  | "elevated_unwind_rate"
  | "session_loss_limit"
  | "reconciliation_drift";

export class KillSwitch {
  private tripped = false;
  private reason: KillReason | null = null;
  private readonly flagFile = "KILL_SWITCH";
  private readonly listeners: Array<(reason: KillReason) => void> = [];
  private readonly venueHalts = new Map<string, string>();

  constructor() {
    process.once("SIGINT", () => this.trip("manual"));
    process.once("SIGTERM", () => this.trip("manual"));
  }

  /** Call periodically from the run loop to pick up a file-based manual kill. */
  pollFileFlag(): void {
    if (!this.tripped && existsSync(this.flagFile)) {
      this.trip("manual_file");
    }
  }

  trip(reason: KillReason): void {
    if (this.tripped) return;
    this.tripped = true;
    this.reason = reason;
    logger.system(`kill switch tripped: ${reason}`, { event: "kill_switch", reason, automatic: this.isAutomatic() });
    for (const l of this.listeners) l(reason);
  }

  isTripped(): boolean {
    return this.tripped;
  }

  tripReason(): KillReason | null {
    return this.reason;
  }

  /** Automatic trips (risk limits) don't exit the process; manual ones do. */
  isAutomatic(): boolean {
    return this.reason !== null && this.reason !== "manual" && this.reason !== "manual_file";
  }

  onTrip(listener: (reason: KillReason) => void): void {
    this.listeners.push(listener);
  }

  /** FR-8.4: pause one venue without halting the whole system. Returns true if newly halted. */
  haltVenue(venueId: string, reason: string): boolean {
    if (this.venueHalts.has(venueId)) return false;
    this.venueHalts.set(venueId, reason);
    logger.risk({ event_type: "venue_halted", venue: venueId, reason });
    return true;
  }

  resumeVenue(venueId: string): boolean {
    if (!this.venueHalts.delete(venueId)) return false;
    logger.risk({ event_type: "venue_resumed", venue: venueId });
    return true;
  }

  isVenueHalted(venueId: string): boolean {
    return this.venueHalts.has(venueId);
  }

  haltedVenues(): Array<{ venue: string; reason: string }> {
    return [...this.venueHalts.entries()].map(([venue, reason]) => ({ venue, reason }));
  }
}
