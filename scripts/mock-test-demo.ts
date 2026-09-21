import type { Leg, LegSide, NormalizedQuote } from "../src/types/index.js";
import { BybitDemoExecutor, type OrderPlacer } from "../src/execution/bybitDemoExecutor.js";
import { runPaperTradingCycle } from "../src/engine/paperTradingEngine.js";
import { CapitalManager } from "../src/capital/capitalManager.js";
import { KillSwitch } from "../src/monitoring/killswitch.js";
import { RiskMonitor } from "../src/monitoring/riskMonitor.js";
import { PnLTracker } from "../src/monitoring/pnlTracker.js";
import { UnwindTracker } from "../src/monitoring/unwindTracker.js";
import type { IngestionService } from "../src/ingestion/ingestionService.js";

/**
 * --live-demo checks against a FAKE Bybit account (no network, no key):
 * proves the wiring — that the Bybit leg is a real order call, that its actual
 * fill replaces the simulated one, that an excess left on Bybit is unwound
 * with a second real order, and that rejections and the rate limit behave.
 * It does not prove Bybit's demo API accepts spot orders; only a real run
 * with your Demo key does.
 */

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { pass++; console.log(`  ok — ${name}`); }
  else { fail++; console.log(`  FAIL — ${name}`, detail ?? ""); }
}
const instant = async () => {};

interface FakeOpts { fillFraction?: number; reject?: boolean; neverFills?: boolean; price?: number }
function fakeAdapter(opts: FakeOpts = {}) {
  const placed: Array<{ side: LegSide; qty: number }> = [];
  let n = 0;
  const orders = new Map<string, { side: LegSide; qty: number }>();
  const adapter: OrderPlacer = {
    async placeOrder(_a, side, qty): Promise<Leg> {
      placed.push({ side, qty });
      if (opts.reject) return { tradeId: "", legId: "", venueId: "bybit", side, requestedQty: qty, filledQty: 0, status: "failed", timestamp: 0 };
      const id = `ORD${++n}`;
      orders.set(id, { side, qty });
      return { tradeId: id, legId: id, venueId: "bybit", side, requestedQty: qty, filledQty: 0, status: "pending", timestamp: 0 };
    },
    async getOrderStatus(id): Promise<Leg> {
      const o = orders.get(id)!;
      if (opts.neverFills) return { tradeId: id, legId: id, venueId: "bybit", side: o.side, requestedQty: o.qty, filledQty: 0, status: "pending", timestamp: 0 };
      const f = o.qty * (opts.fillFraction ?? 1);
      return { tradeId: id, legId: id, venueId: "bybit", side: o.side, requestedQty: o.qty, filledQty: f, avgPrice: opts.price ?? 100.05, status: f >= o.qty ? "filled" : "partially_filled", timestamp: 0 };
    },
  };
  return { adapter, placed };
}

function quote(venue: string, bid: number, ask: number, bidQty: number, askQty: number): NormalizedQuote {
  return { venueId: venue, assetId: "SOL", quoteAssetId: "USDT", bestBid: bid, bestAsk: ask, feeSchedule: { takerBps: 10 }, fetchedAt: Date.now(), raw: { bids: [[bid, bidQty]], asks: [[ask, askQty]] } };
}
function fakeIngestion(mexcBidQty: number): IngestionService {
  const q: Record<string, NormalizedQuote> = {
    "bybit|SOL": quote("bybit", 100, 100.05, 500, 500),
    "mexc|SOL": quote("mexc", 100.6, 100.65, mexcBidQty, 500), // MEXC bids 55 bps above Bybit's ask
  };
  return {
    listVenueIds: () => ["bybit", "mexc"],
    getQuote: async (v: string, a: string) => (q[`${v}|${a}`] ? { quote: q[`${v}|${a}`], isFresh: true } : null),
  } as unknown as IngestionService;
}
function ctx() {
  const kill = new KillSwitch();
  const capital = new CapitalManager(new Set(["bybit", "mexc"]));
  return { capital, kill, risk: new RiskMonitor(kill, capital) };
}

async function main() {
  console.log("1. Executor basics");
  {
    const a = fakeAdapter();
    const ex = new BybitDemoExecutor(a.adapter, instant);
    const r = await ex.placeAndAwait("SOL", "buy", 0.4997);
    check("quantity is rounded down to the lot step", a.placed[0].qty === 0.499, a.placed);
    check("a filled order reports its real fill and price", r.status === "filled" && r.filled === 0.499 && r.avg === 100.05, r);
    const tiny = await ex.placeAndAwait("SOL", "buy", 0.0004);
    check("a quantity that rounds to zero is skipped, not sent", tiny.status === "skipped" && a.placed.length === 1);
    const stuck = await new BybitDemoExecutor(fakeAdapter({ neverFills: true }).adapter, instant).placeAndAwait("SOL", "buy", 1);
    check("an order that never fills reports a timeout, not a fill", stuck.status === "timeout" && stuck.filled === 0, stuck);
    const rej = await new BybitDemoExecutor(fakeAdapter({ reject: true }).adapter, instant).placeAndAwait("SOL", "buy", 1);
    check("a rejected order reports failed with no fill", rej.status === "failed" && rej.filled === 0, rej);
  }

  console.log("2. Full trade: real Bybit buy fills, simulated MEXC sell fills");
  {
    const a = fakeAdapter();
    const c = ctx();
    const pnl = new PnLTracker(), unw = new UnwindTracker();
    const trades = await runPaperTradingCycle(fakeIngestion(1000), pnl, unw, c, { bybitLive: new BybitDemoExecutor(a.adapter, instant) });
    const t = trades.find((x) => x.buyVenueId === "bybit");
    check("exactly one real order was placed (the Bybit buy)", a.placed.length === 1 && a.placed[0].side === "buy", a.placed);
    check("trade is tagged with the real order", t?.demoOrders?.length === 1 && t.demoOrders[0].role === "leg" && t.demoOrders[0].orderId === "ORD1", t?.demoOrders);
    check("the real fill price is used, not the simulated one", t?.buyFill.avgPrice === 100.05, t?.buyFill);
    check("legs matched, so no unwind", unw.count() === 0);
    check("the sell route through Bybit was ALSO real (Bybit as sell venue)", trades.filter((x) => x.sellVenueId === "bybit").every((x) => x.demoOrders?.length), trades.map((x) => x.demoOrders));
  }

  console.log("3. Excess left on Bybit is unwound with a SECOND real order");
  {
    const a = fakeAdapter();
    const c = ctx();
    const unw = new UnwindTracker();
    const trades = await runPaperTradingCycle(fakeIngestion(0.2), new PnLTracker(), unw, c, { bybitLive: new BybitDemoExecutor(a.adapter, instant) });
    const t = trades.find((x) => x.buyVenueId === "bybit" && x.sellVenueId === "mexc");
    check("bought 0.499 on Bybit but MEXC's book only absorbed 0.2 -> two real orders (buy then sell)", a.placed.length >= 2 && a.placed[0].side === "buy" && a.placed[1].side === "sell", a.placed);
    check("the offsetting order is the excess, lot-rounded", Math.abs(a.placed[1].qty - 0.299) < 1e-9, a.placed[1]);
    check("unwind is recorded as a REAL demo order", unw.all().some((e) => /REAL demo order/.test(e.actionTaken)), unw.all().map((e) => e.actionTaken));
    check("trade lists both the leg and the unwind orders", t?.demoOrders?.map((o) => o.role).join() === "leg,unwind", t?.demoOrders);
  }

  console.log("4. Bybit rejects the order (e.g. no funds/spot unsupported)");
  {
    const a = fakeAdapter({ reject: true });
    const c = ctx();
    const unw = new UnwindTracker();
    const trades = await runPaperTradingCycle(fakeIngestion(1000), new PnLTracker(), unw, c, { bybitLive: new BybitDemoExecutor(a.adapter, instant) });
    const t = trades.find((x) => x.buyVenueId === "bybit" && x.sellVenueId === "mexc");
    check("the rejection is recorded on the trade", t?.demoOrders?.[0].status === "failed", t?.demoOrders);
    check("Bybit leg filled nothing, so the simulated MEXC sell is unwound on MEXC (simulated, not a real order)", !!t && t.buyFill.filledQty === 0 && unw.all().some((e) => !/REAL/.test(e.actionTaken)), unw.all());
    check("no second real order was attempted for a simulated-venue unwind", a.placed.length === 1 && a.placed[0].side === "buy", a.placed);
  }

  console.log("5. Order rate limit");
  {
    const a = fakeAdapter();
    const c = ctx();
    const ex = new BybitDemoExecutor(a.adapter, instant);
    for (let i = 0; i < 12; i++) await runPaperTradingCycle(fakeIngestion(1000), new PnLTracker(), new UnwindTracker(), c, { bybitLive: ex });
    check("never exceeds DEMO_MAX_ORDERS_PER_MIN real orders", a.placed.length <= 6 && a.placed.length > 0, a.placed.length);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
