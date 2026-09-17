import { RaydiumAdapter } from "./adapters/dex/raydium.js";
import { MexcAdapter } from "./adapters/cex/mexc.js";
import { IngestionService } from "./ingestion/ingestionService.js";
import { scanForOpportunities } from "./engine/opportunityDetector.js";
import { runPaperTradingCycle } from "./engine/paperTradingEngine.js";
import { KillSwitch } from "./monitoring/killswitch.js";
import { PnLTracker } from "./monitoring/pnlTracker.js";
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

const SCAN_INTERVAL_MS = 3000;
const PNL_SUMMARY_EVERY_N_SCANS = 5;

function buildIngestion(): IngestionService {
  const raydium = new RaydiumAdapter();
  const mexc = new MexcAdapter();
  return new IngestionService([raydium, mexc], {
    raydium: config.raydiumPollMs,
    mexc: config.mexcPollMs,
  });
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

async function runPaperMode(): Promise<void> {
  const ingestion = buildIngestion();
  const killSwitch = new KillSwitch();
  const pnlTracker = new PnLTracker();

  ingestion.start();
  logger.system("M1 paper trading mode started", {
    venues: ingestion.listVenueIds(),
    scanIntervalMs: SCAN_INTERVAL_MS,
    tradeSizeUsd: config.paperTradeSizeUsd,
  });
  console.log(`paper trading mode — simulating $${config.paperTradeSizeUsd} trades against live order-book/pool depth. No real orders are placed.`);

  let scanCount = 0;
  const scanLoop = setInterval(async () => {
    killSwitch.pollFileFlag();
    if (killSwitch.isTripped()) return;

    const trades = await runPaperTradingCycle(ingestion, pnlTracker);
    for (const t of trades) {
      const sign = t.realizedPnlUsd >= 0 ? "+" : "";
      console.log(
        `[${new Date().toISOString()}] paper trade: ${t.assetId} buy@${t.buyVenueId} -> sell@${t.sellVenueId}, ` +
          `matched=${t.matchedQty.toFixed(4)}, theoretical=${t.theoreticalNetSpreadBps.toFixed(1)}bps, realized=${sign}$${t.realizedPnlUsd.toFixed(4)}`,
      );
    }

    scanCount += 1;
    if (scanCount % PNL_SUMMARY_EVERY_N_SCANS === 0 && pnlTracker.tradeCount() > 0) {
      console.log(`--- P&L summary (${pnlTracker.tradeCount()} simulated trades, total realized $${pnlTracker.totalRealizedPnlUsd().toFixed(4)}) ---`);
      for (const s of pnlTracker.summary()) {
        console.log(`  ${s.key}: ${s.trades} trades, theoretical $${s.theoreticalPnlUsd.toFixed(4)}, realized $${s.realizedPnlUsd.toFixed(4)}`);
      }
    }
  }, SCAN_INTERVAL_MS);

  killSwitch.onTrip(() => {
    clearInterval(scanLoop);
    ingestion.stop();
    logger.system("M1 paper trading mode stopped (kill switch)", {
      totalTrades: pnlTracker.tradeCount(),
      totalRealizedPnlUsd: pnlTracker.totalRealizedPnlUsd(),
    });
    process.exit(0);
  });
}

async function main() {
  const mode = parseMode();
  if (mode === "paper") {
    await runPaperMode();
    return;
  }
  await runDetectMode();
}

main().catch((err) => {
  logger.failure({ stage: "fatal", message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
