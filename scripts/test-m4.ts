import { CapitalManager, type VenueLedger } from "../src/capital/capitalManager.js";
import { KillSwitch } from "../src/monitoring/killswitch.js";
import { RiskMonitor } from "../src/monitoring/riskMonitor.js";
import { config } from "../src/config/env.js";

/**
 * M4 safety-layer checks: capital pre-checks, custody cap, reconciliation,
 * and each automatic kill-switch trigger, on synthetic data (no network,
 * no venues). Proves the controls fire when they should AND stay quiet when
 * they shouldn't.
 */

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { pass++; console.log(`  ok — ${name}`); }
  else { fail++; console.log(`  FAIL — ${name}`, detail ?? ""); }
}

function freshCapital(): CapitalManager {
  const c = new CapitalManager(new Set(["mexc", "bybit"]));
  for (const v of ["raydium", "mexc", "bybit"]) c.seedIfNeeded(v, "SOL", 100);
  return c;
}

console.log("1. Pre-trade balance check (FR-3.7)");
{
  const c = freshCapital();
  check("affordable trade passes", c.preTrade("mexc", "bybit", "SOL", 5, 100, 10).ok);
  const tooBig = c.preTrade("mexc", "bybit", "SOL", 1000, 100, 10);
  check("rejects when the buy venue lacks USDT", !tooBig.ok && /insufficient USDT on mexc/.test(tooBig.ok ? "" : tooBig.reason), tooBig);
  const noAsset = c.preTrade("mexc", "bybit", "SOL", 60, 1, 10); // cheap price -> USDT fine, but 60 SOL > the 50 SOL held on bybit
  check("rejects when the sell venue lacks the asset", !noAsset.ok && /insufficient SOL on bybit/.test(noAsset.ok ? "" : noAsset.reason), noAsset);
}

console.log("2. Ledger keeps value consistent");
{
  const c = freshCapital();
  const before = c.totalUsd();
  c.applyTrade("mexc", "bybit", "SOL", { filled: 5, avg: 100 }, { filled: 5, avg: 100 }, 0, 0);
  check("a zero-edge, zero-fee round trip leaves total value unchanged", Math.abs(c.totalUsd() - before) < 1e-6, { before, after: c.totalUsd() });
  c.applyTrade("mexc", "bybit", "SOL", { filled: 5, avg: 100 }, { filled: 5, avg: 100 }, 1, 1);
  check("fees reduce total value by exactly the fees paid", Math.abs(c.totalUsd() - (before - 2)) < 1e-6, c.totalUsd());
}

console.log("3. Custody cap (FR-6.4)");
{
  const c = freshCapital();
  check("no breach at the starting split", c.custodyBreaches().length === 0, c.custodyBreaches());
  c.applyUnwind("mexc", "SOL", "sell", 10, 3000); // inflate MEXC's holdings far past its allowed share
  const b = c.custodyBreaches();
  check("breach detected on the over-concentrated CEX", b.length === 1 && b[0].venue === "mexc", b);
  const kill = new KillSwitch();
  new RiskMonitor(kill, c).checkCustody();
  check("that venue is halted, the global switch is not tripped", kill.isVenueHalted("mexc") && !kill.isTripped());
}

console.log("4. Reconciliation drift halts only the drifting venue");
{
  const c = freshCapital();
  const kill = new KillSwitch();
  const risk = new RiskMonitor(kill, c);
  check("no mismatch when ledger and venue agree", risk.reconcile().length === 0);
  const actual: Map<string, VenueLedger> = c.actualView();
  actual.get("bybit")!.usdt += 800; // the exchange reports more USDT than we expect
  const mm = risk.reconcile(actual);
  check("mismatch found on bybit", mm.length === 1 && mm[0].venue === "bybit" && mm[0].what === "USDT", mm);
  check("bybit halted, mexc and raydium untouched", kill.isVenueHalted("bybit") && !kill.isVenueHalted("mexc") && !kill.isVenueHalted("raydium"));
}

console.log("5. Elevated unwind rate trips the global kill switch (FR-8.5)");
{
  const kill = new KillSwitch();
  const risk = new RiskMonitor(kill, freshCapital());
  for (let i = 0; i < config.unwindRateWindow; i++) risk.recordTrade(i < 3); // 30% unwinds, under the 50% threshold
  check("healthy unwind rate does not trip it", !kill.isTripped(), risk.unwindRate());
  const kill2 = new KillSwitch();
  const risk2 = new RiskMonitor(kill2, freshCapital());
  for (let i = 0; i < config.unwindRateWindow; i++) risk2.recordTrade(true);
  check("a window of all-unwinds trips it", kill2.isTripped() && kill2.tripReason() === "elevated_unwind_rate");
  check("and it is automatic (process stays up)", kill2.isAutomatic());
  const kill3 = new KillSwitch();
  const risk3 = new RiskMonitor(kill3, freshCapital());
  for (let i = 0; i < config.unwindRateWindow - 1; i++) risk3.recordTrade(true);
  check("it waits for a full window before judging", !kill3.isTripped());
}

console.log("6. Session loss limit trips the global kill switch");
{
  const kill = new KillSwitch();
  const risk = new RiskMonitor(kill, freshCapital());
  risk.recordSessionPnl(-(config.maxSessionLossUsd - 1));
  check("a loss under the limit is tolerated", !kill.isTripped());
  risk.recordSessionPnl(-config.maxSessionLossUsd);
  check("hitting the limit trips it", kill.isTripped() && kill.tripReason() === "session_loss_limit");
}

console.log("7. Venue feed errors halt one venue, then it recovers (FR-8.4)");
{
  const kill = new KillSwitch();
  const risk = new RiskMonitor(kill, freshCapital());
  const t0 = 1_000_000;
  for (let i = 0; i < config.venueErrorThreshold - 1; i++) risk.recordVenueResult("mexc", false, t0 + i);
  check("errors under the threshold don't halt", !kill.isVenueHalted("mexc"));
  risk.recordVenueResult("mexc", false, t0 + 10);
  check("reaching the threshold halts mexc", kill.isVenueHalted("mexc"));
  check("other venues and the global switch are unaffected", !kill.isVenueHalted("bybit") && !kill.isTripped());
  for (let i = 0; i < config.venueRecoverySuccesses; i++) risk.recordVenueResult("mexc", true);
  check("clean polls resume the venue", !kill.isVenueHalted("mexc"));
  const kill2 = new KillSwitch();
  const risk2 = new RiskMonitor(kill2, freshCapital());
  for (let i = 0; i < config.venueErrorThreshold; i++) risk2.recordVenueResult("bybit", false, t0 + i * (config.venueErrorWindowMs + 1));
  check("errors spread wider than the window don't accumulate", !kill2.isVenueHalted("bybit"));
}

console.log("8. Drained inventory is flagged for rebalancing (FR-6.3)");
{
  const c = freshCapital();
  for (let i = 0; i < 9; i++) c.applyTrade("mexc", "bybit", "SOL", { filled: 5, avg: 100 }, { filled: 5, avg: 100 }, 0, 0);
  const s = c.rebalanceSuggestions();
  check("drained USDT on mexc / SOL on bybit are called out", s.some((x) => x.startsWith("mexc: USDT")) && s.some((x) => x.startsWith("bybit: SOL")), s);
  const gate = c.preTrade("mexc", "bybit", "SOL", 5, 100, 10);
  check("and trading that route is blocked until topped up", !gate.ok, gate);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
