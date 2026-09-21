import { RaydiumAdapter } from "./adapters/dex/raydium.js";
import { MexcAdapter } from "./adapters/cex/mexc.js";
import { BybitAdapter } from "./adapters/cex/bybit.js";
import { IngestionService } from "./ingestion/ingestionService.js";
import { scanForOpportunities } from "./engine/opportunityDetector.js";
import { runPaperTradingCycle } from "./engine/paperTradingEngine.js";
import { KillSwitch } from "./monitoring/killswitch.js";
import { PnLTracker } from "./monitoring/pnlTracker.js";
import { UnwindTracker } from "./monitoring/unwindTracker.js";
import { RiskMonitor } from "./monitoring/riskMonitor.js";
import { CapitalManager } from "./capital/capitalManager.js";
import { BybitDemoExecutor } from "./execution/bybitDemoExecutor.js";
import { logger } from "./monitoring/logger.js";
import { config } from "./config/env.js";

type Mode = "detect" | "paper";

function parseMode(): Mode {
  const arg = process.argv.find((a) => a.startsWith("--mode="));
  const value = arg?.split("=")[1] ?? "detect";
  if (value !== "detect" && value !== "paper") {
    console.error(`Unknown --mode=${value}. Supported: detect (M0), paper (M1).`);
    process.exit(1);
  }
  return value;
}

function parseStressTest(): boolean {
  return process.argv.includes("--stress-test");
}

function parseLiveDemo(): boolean {
  return process.argv.includes("--live-demo");
}

const SCAN_INTERVAL_MS = 3000;
const SUMMARY_EVERY_N_SCANS = 5;

function buildIngestion(onPollResult?: (venueId: string, ok: boolean) => void): IngestionService {
  const raydium = new RaydiumAdapter();
  const mexc = new MexcAdapter();
  const bybit = new BybitAdapter();
  return new IngestionService([raydium, mexc, bybit], {
    raydium: config.raydiumPollMs,
    mexc: config.mexcPollMs,
    bybit: config.bybitPollMs,
  }, onPollResult);
}

async function runDetectMode(): Promise<void> {
  const ingestion = buildIngestion();
  const killSwitch = new KillSwitch();

  ingestion.start();
  logger.system("M0 detection mode started", {
    venues: ingestion.listVenueIds(),
    scanIntervalMs: SCAN_INTERVAL_MS,
  });

  const scanLoop = setInterval(async () => {
    killSwitch.pollFileFlag();
    if (killSwitch.isTripped()) return;
    const found = await scanForOpportunities(ingestion);
    if (found.length > 0) {
      console.log(
        `[${new Date().toISOString()}] ${found.length} opportunit${found.length === 1 ? "y" : "ies"}: ` +
          found
            .map(
              (o) =>
                `${o.assetId} buy@${o.buyVenueId}(${o.buyPrice.toFixed(4)}) -> sell@${o.sellVenueId}(${o.sellPrice.toFixed(4)}) net=${o.netSpreadBps.toFixed(1)}bps${o.flaggedAnomalous ? " [ANOMALOUS]" : ""}`,
            )
            .join(" | "),
      );
    }
  }, SCAN_INTERVAL_MS);

  killSwitch.onTrip(() => {
    clearInterval(scanLoop);
    ingestion.stop();
    logger.system("M0 detection mode stopped (kill switch)");
    process.exit(0);
  });
}

async function runPaperMode(stressTest: boolean, liveDemo: boolean): Promise<void> {
  let bybitLive: BybitDemoExecutor | undefined;
  if (liveDemo) {
    if (!config.bybitApiKey || !config.bybitApiSecret) {
      console.error("--live-demo needs BYBIT_API_KEY and BYBIT_API_SECRET in .env: a Demo Trading key from YOUR Bybit account (Demo Trading mode -> API). See README. Never a real-money key.");
      process.exit(1);
    }
    const adapter = new BybitAdapter();
    try {
      const balances = await adapter.getBalances(); // real call to api-demo.bybit.com: proves the key and account work before we trade
      const usdt = balances.find((b) => b.assetId === "USDT");
      console.log(`Bybit Demo account reachable. USDT available: ${usdt ? usdt.available.toFixed(2) : "none"}; coins held: ${balances.filter((b) => b.available > 0).map((b) => b.assetId).join(", ") || "none"}`);
    } catch (err) {
      console.error(`--live-demo could not use the Bybit Demo account: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    bybitLive = new BybitDemoExecutor(adapter);
  }
  const killSwitch = new KillSwitch();
  const capital = new CapitalManager(new Set(["mexc", "bybit"])); // CEX custody is capped (FR-6.4); the DEX wallet is self-custody
  const risk = new RiskMonitor(killSwitch, capital);
  const ingestion = buildIngestion((venueId, ok) => risk.recordVenueResult(venueId, ok));
  const pnlTracker = new PnLTracker();
  const unwindTracker = new UnwindTracker();

  ingestion.start();
  if (liveDemo) logger.system("live-demo enabled: Bybit legs place real orders on Bybit Demo Trading (play funds)", { event: "live_demo", tradeUsd: config.demoTradeUsd, maxOrdersPerMin: config.demoMaxOrdersPerMin });
  logger.system("M4 paper trading mode started", {
    venues: ingestion.listVenueIds(),
    scanIntervalMs: SCAN_INTERVAL_MS,
    tradeSizeUsd: config.paperTradeSizeUsd,
    stressTest,
    limits: {
      maxTradeUsd: config.maxTradeUsd,
      custodyCapPct: config.custodyCapPct,
      maxSessionLossUsd: config.maxSessionLossUsd,
      unwindRateThreshold: config.unwindRateThreshold,
      unwindRateWindow: config.unwindRateWindow,
    },
  });
  console.log(`paper trading mode — simulating $${Math.min(config.paperTradeSizeUsd, config.maxTradeUsd)} trades against live order-book/pool depth. No real orders are placed.`);
  console.log(`risk limits: session loss $${config.maxSessionLossUsd}, unwind rate >${config.unwindRateThreshold * 100}% over ${config.unwindRateWindow} trades, CEX custody cap ${config.custodyCapPct}%`);
  if (liveDemo) {
    console.log(`*** --live-demo ACTIVE: the Bybit leg of any route through Bybit is a REAL order on Bybit Demo Trading (play funds, $${Math.min(config.demoTradeUsd, config.maxTradeUsd)} per trade, max ${config.demoMaxOrdersPerMin} orders/min). The other leg stays simulated. Routes not involving Bybit remain paper. ***`);
  }
  if (stressTest) {
    console.log("*** --stress-test ACTIVE: leg fills are being synthetically corrupted to exercise the FR-5.4 unwind path. Not real market behavior. ***");
    console.log("*** Expect the FR-8.5 auto kill switch to trip quickly under stress-test; that is the safety net working. ***");
  }

  let scanCount = 0;
  const scanLoop = setInterval(async () => {
    killSwitch.pollFileFlag();

    const trades = await runPaperTradingCycle(ingestion, pnlTracker, unwindTracker, { capital, risk, kill: killSwitch }, { injectFailures: stressTest, bybitLive });
    for (const t of trades) {
      const sign = t.realizedPnlUsd >= 0 ? "+" : "";
      const mismatch = (Math.abs(t.buyFill.filledQty - t.sellFill.filledQty) > 1e-9 ? " [LEG MISMATCH -> UNWOUND]" : "") +
        (t.demoOrders ? ` [REAL bybit demo: ${t.demoOrders.map((o) => `${o.role} ${o.status}${o.orderId ? " " + o.orderId : ""}${o.error ? " (" + o.error + ")" : ""}`).join("; ")}]` : "");
      console.log(
        `[${new Date().toISOString()}] paper trade: ${t.assetId} buy@${t.buyVenueId} -> sell@${t.sellVenueId}, ` +
          `matched=${t.matchedQty.toFixed(4)}, theoretical=${t.theoreticalNetSpreadBps.toFixed(1)}bps, realized=${sign}$${t.realizedPnlUsd.toFixed(4)}${mismatch}`,
      );
    }

    scanCount += 1;
    if (scanCount % 10 === 0) risk.reconcile();
    if (scanCount % SUMMARY_EVERY_N_SCANS === 0) {
      const snap = capital.snapshot();
      logger.capital({
        ...snap,
        kill: { tripped: killSwitch.isTripped(), reason: killSwitch.tripReason() },
        haltedVenues: killSwitch.haltedVenues(),
        unwindRate: risk.unwindRate(),
        sessionPnlUsd: pnlTracker.totalRealizedPnlUsd(),
        limits: { maxSessionLossUsd: config.maxSessionLossUsd, unwindRateThreshold: config.unwindRateThreshold, unwindRateWindow: config.unwindRateWindow },
      });
      if (pnlTracker.tradeCount() > 0) {
        console.log(`--- P&L summary (${pnlTracker.tradeCount()} simulated trades, total realized $${pnlTracker.totalRealizedPnlUsd().toFixed(4)}) ---`);
        for (const s of pnlTracker.summary()) {
          console.log(`  ${s.key}: ${s.trades} trades, theoretical $${s.theoreticalPnlUsd.toFixed(4)}, realized $${s.realizedPnlUsd.toFixed(4)}`);
        }
        if (unwindTracker.count() > 0) {
          console.log(
            `--- Unwind summary (FR-5.4/7.5): ${unwindTracker.count()} events, ${unwindTracker.incompleteFlattenCount()} incomplete, total realized loss $${unwindTracker.totalRealizedLossUsd().toFixed(4)} ---`,
          );
        }
      }
      console.log(
        `--- Capital (paper ledger): $${snap.totalUsd.toFixed(0)} total; ` +
          snap.venues.map((v) => `${v.venue} ${v.sharePct.toFixed(0)}%`).join(", ") +
          (snap.breaches.length ? `; CUSTODY BREACH: ${snap.breaches.map((b) => b.venue).join(",")}` : "") +
          (killSwitch.haltedVenues().length ? `; HALTED: ${killSwitch.haltedVenues().map((h) => h.venue).join(",")}` : "") +
          ` ---`,
      );
    }
  }, SCAN_INTERVAL_MS);

  killSwitch.onTrip((reason) => {
    if (killSwitch.isAutomatic()) {
      console.log(`\n*** AUTO KILL SWITCH: ${reason}. No new trades will execute; detection and monitoring keep running. Ctrl+C to exit. ***\n`);
      return;
    }
    clearInterval(scanLoop);
    ingestion.stop();
    logger.system("M4 paper trading mode stopped (kill switch)", {
      totalTrades: pnlTracker.tradeCount(),
      totalRealizedPnlUsd: pnlTracker.totalRealizedPnlUsd(),
      totalUnwindEvents: unwindTracker.count(),
      incompleteUnwinds: unwindTracker.incompleteFlattenCount(),
    });
    process.exit(0);
  });
}

async function main() {
  const mode = parseMode();
  if (mode === "paper") {
    await runPaperMode(parseStressTest(), parseLiveDemo());
    return;
  }
  await runDetectMode();
}

main().catch((err) => {
  logger.failure({ stage: "fatal", message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
