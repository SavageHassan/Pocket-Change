import type { UnwindEvent } from "../types/index.js";

/**
 * FR-7.5: dedicated unwind-events tracking — a rising unwind rate signals
 * the hedged-execution assumption is breaking down and should trigger
 * review. M2 scope is tracking + visibility; FR-8.5's auto-kill-switch on
 * elevated unwind rate is M3 scope (needs live execution to actually kill).
 */
export class UnwindTracker {
  private events: UnwindEvent[] = [];
  private incompleteCount = 0;

  record(event: UnwindEvent, fullyFlattened: boolean): void {
    this.events.push(event);
    if (!fullyFlattened) this.incompleteCount += 1;
  }

  count(): number {
    return this.events.length;
  }

  incompleteFlattenCount(): number {
    return this.incompleteCount;
  }

  totalRealizedLossUsd(): number {
    return this.events.reduce((sum, e) => sum + e.realizedLoss, 0);
  }

  all(): UnwindEvent[] {
    return this.events;
  }
}
