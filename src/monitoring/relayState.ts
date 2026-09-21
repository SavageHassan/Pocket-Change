/**
 * Turns the bot's event stream into the small status snapshot the dashboard
 * shows: counters, latest spread per route, recent trades, recent log lines,
 * and the last capital/risk status. The same logic runs in the browser for the
 * localhost bridge; this copy runs next to the bot so the snapshot can be
 * pushed to the cloud relay (which only stores it — it never sees raw logs).
 */

type Ev = Record<string, any>;

const usd = (n: number) => (n < 0 ? "−" : n > 0 ? "+" : "") + "$" + Math.abs(n).toFixed(4);
const fmt = (n: number, d = 4) => Number(n).toFixed(d);

export interface Snapshot {
  polls: number;
  pollBy: Record<string, number>;
  oppCount: number;
  opps: Ev[];
  trades: Ev[];
  tradeCount: number;
  pnl: number;
  unw: number;
  inc: number;
  lines: Array<{ t: string; k: string; m: string }>;
  cap: Ev | null;
  liveDemo: boolean;
  lastEventAt: number;
  pushedAt: number;
}

export class RelayState {
  private polls = 0;
  private pollBy: Record<string, number> = {};
  private opps = new Map<string, Ev>();
  private oppCount = 0;
  private trades: Ev[] = [];
  private tradeCount = 0;
  private pnl = 0;
  private unw = 0;
  private inc = 0;
  private lines: Array<{ t: string; k: string; m: string }> = [];
  private cap: Ev | null = null;
  private liveDemo = false;
  private lastEventAt = 0;

  private line(time: unknown, k: string, m: string) {
    this.lines.push({ t: String(time).substr(11, 8), k, m });
    if (this.lines.length > 60) this.lines.shift();
  }

  handle(e: Ev): void {
    const ev = e.event;
    if (e.time) this.lastEventAt = new Date(String(e.time)).getTime() || this.lastEventAt;

    if (ev === "system" && e.venue) {
      this.polls++;
      this.pollBy[e.venue] = (this.pollBy[e.venue] || 0) + 1;
    } else if (ev === "system") {
      this.line(e.time, "sys", String(e.msg));
    } else if (ev === "live_demo") {
      this.liveDemo = true;
      this.line(e.time, "trade", "LIVE-DEMO on: Bybit legs are real orders on Bybit Demo Trading (play funds)");
    } else if (ev === "kill_switch") {
      this.line(e.time, "fail", "kill switch: " + e.reason);
    } else if (ev === "opportunity_detected") {
      this.oppCount++;
      this.opps.set(e.assetId + e.buyVenueId + e.sellVenueId, {
        assetId: e.assetId, buyVenueId: e.buyVenueId, sellVenueId: e.sellVenueId,
        buyPrice: e.buyPrice, sellPrice: e.sellPrice, netSpreadBps: e.netSpreadBps, detectedAt: e.detectedAt,
      });
    } else if (ev === "paper_trade") {
      this.trades.unshift({
        time: e.time, assetId: e.assetId, buyVenueId: e.buyVenueId, sellVenueId: e.sellVenueId,
        matchedQty: e.matchedQty, realizedPnlUsd: e.realizedPnlUsd,
        buyFill: { filledQty: e.buyFill?.filledQty }, sellFill: { filledQty: e.sellFill?.filledQty },
        demoOrders: e.demoOrders,
      });
      if (this.trades.length > 15) this.trades.pop();
      this.tradeCount++;
      this.pnl += e.realizedPnlUsd;
      this.line(e.time, "trade", `paper trade ${e.assetId} ${e.buyVenueId}→${e.sellVenueId} realized ${usd(e.realizedPnlUsd)}`);
    } else if (ev === "capital_status") {
      this.cap = {
        totalUsd: e.totalUsd, startUsd: e.startUsd, venues: e.venues, custodyCapPct: e.custodyCapPct,
        rebalance: e.rebalance, kill: e.kill, haltedVenues: e.haltedVenues, unwindRate: e.unwindRate,
        sessionPnlUsd: e.sessionPnlUsd, limits: e.limits,
      };
    } else if (ev === "risk_event") {
      const t = e.event_type;
      const m =
        t === "auto_kill" ? "AUTO KILL: " + e.trigger + (e.rate != null ? ` (unwind rate ${Math.round(e.rate * 100)}%)` : e.realizedUsd != null ? ` (realized ${usd(e.realizedUsd)})` : "")
        : t === "venue_halted" ? "VENUE HALTED " + e.venue + ": " + e.reason
        : t === "venue_resumed" ? "venue resumed: " + e.venue
        : t === "reconciliation_drift" ? `RECONCILIATION DRIFT ${e.venue} ${e.what} ${fmt(e.driftPctOfVenue, 2)}% of venue`
        : t === "trade_rejected" ? "trade rejected: " + (e.route ? e.route + ", " : "") + e.reason
        : (t || "risk") + " " + (e.reason || "");
      this.line(e.time, t === "trade_rejected" || t === "venue_resumed" ? "sys" : "fail", m);
    } else if (ev === "unwind") {
      this.unw++;
      if (e.fullyFlattened === false) this.inc++;
      this.line(e.time, e.fullyFlattened === false ? "fail" : "unwind", "UNWIND " + e.actionTaken);
    } else if (ev === "failure") {
      this.line(e.time, "fail", `${e.venue || ""} ${e.stage || ""} ${e.message || e.error || e.retMsg || ""}`);
    }
  }

  snapshot(now = Date.now()): Snapshot {
    return {
      polls: this.polls, pollBy: this.pollBy, oppCount: this.oppCount,
      opps: [...this.opps.values()], trades: this.trades, tradeCount: this.tradeCount,
      pnl: this.pnl, unw: this.unw, inc: this.inc, lines: this.lines, cap: this.cap,
      liveDemo: this.liveDemo, lastEventAt: this.lastEventAt, pushedAt: now,
    };
  }
}
