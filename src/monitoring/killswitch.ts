import { existsSync } from "node:fs";
import { logger } from "./logger.js";

// FR-8: kill switch, manual + automatic triggers. Scaffolded in M0 even
// though nothing trades yet, per the build instructions — wired to actually
// stop the run loop now so it's a real control, not a dead stub.
//
// Automatic triggers this scaffolds but does NOT yet activate:
//   - FR-8.4 per-venue kill switch (needs per-venue error-rate monitoring — M2)
//   - FR-8.5 elevated-unwind-rate auto-kill (needs unwind events to exist — M2/M3)
// Wiring those in requires state (error rates, unwind counts) that doesn't
// exist until later milestones; the hooks below are where that logic attaches.

export type KillReason = "manual" | "manual_file" | "elevated_unwind_rate" | "venue_error_rate";

export class KillSwitch {
  private tripped = false;
  private reason: KillReason | null = null;
  private readonly flagFile = "KILL_SWITCH";
  private readonly listeners: Array<(reason: KillReason) => void> = [];

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
    logger.system(`kill switch tripped: ${reason}`, { event: "kill_switch", reason });
    for (const l of this.listeners) l(reason);
  }

  isTripped(): boolean {
    return this.tripped;
  }

  onTrip(listener: (reason: KillReason) => void): void {
    this.listeners.push(listener);
  }

  // Stub hooks for M2+ automatic triggers (FR-8.4/8.5). Not called anywhere
  // yet — no unwind events or per-venue error-rate tracking exist until the
  // execution/unwind milestones are built.
  triggerOnElevatedUnwindRate(_currentRate: number, _threshold: number): void {
    throw new Error("not implemented before M2/M3 — no unwind events exist yet");
  }

  triggerOnVenueErrorRate(_venueId: string, _currentRate: number, _threshold: number): void {
    throw new Error("not implemented before M2 — needs per-venue error-rate tracking");
  }
}
