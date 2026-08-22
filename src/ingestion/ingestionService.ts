import type { NormalizedQuote, VenueAdapter } from "../types/index.js";
import { config } from "../config/env.js";
import { logger } from "../monitoring/logger.js";

export interface PollableVenueAdapter extends VenueAdapter {
  refresh(): Promise<void>;
}

/**
 * Owns polling of every venue adapter and gives the detection engine a
 * single place to ask "what's the freshest quote for (venue, asset)".
 *
 * FR-1.5: each venue's data freshness is tracked independently (per adapter
 * poll loop, own error handling) so one venue's failure never blocks or
 * masks another's, and a stale quote is never silently treated as fresh.
 */
export class IngestionService {
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly adapters: PollableVenueAdapter[],
    private readonly pollIntervalsMs: Record<string, number>,
  ) {}

  start(): void {
    for (const adapter of this.adapters) {
      const intervalMs = this.pollIntervalsMs[adapter.venue.id] ?? 5000;
      const poll = async () => {
        try {
          await adapter.refresh();
        } catch (err) {
          logger.failure({
            venue: adapter.venue.id,
            stage: "ingestion_poll",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      };
      void poll(); // fire immediately, don't wait for the first interval tick
      this.timers.push(setInterval(poll, intervalMs));
    }
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /**
   * Returns the freshest quote for (venueId, assetId) plus a freshness flag.
   * Callers (the opportunity detector) must check `isFresh` before using a
   * quote in a cross-venue profit calculation — never mix stale with fresh.
   */
  async getQuote(venueId: string, assetId: string): Promise<{ quote: NormalizedQuote; isFresh: boolean } | null> {
    const adapter = this.adapters.find((a) => a.venue.id === venueId);
    if (!adapter) return null;
    try {
      const quote = await adapter.getQuote(assetId);
      const ageMs = Date.now() - quote.fetchedAt;
      return { quote, isFresh: ageMs <= config.maxQuoteAgeMs };
    } catch {
      return null; // no quote cached yet (e.g. first poll hasn't completed)
    }
  }

  listVenueIds(): string[] {
    return this.adapters.map((a) => a.venue.id);
  }
}
