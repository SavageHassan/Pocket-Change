import { RaydiumAdapter } from "./adapters/dex/raydium.js";
import { MexcAdapter } from "./adapters/cex/mexc.js";
import { IngestionService } from "./ingestion/ingestionService.js";
import { scanForOpportunities } from "./engine/opportunityDetector.js";
import { KillSwitch } from "./monitoring/killswitch.js";
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

async function runDetectMode(): Promise<void> {
  const raydium = new RaydiumAdapter();
  const mexc = new MexcAdapter();
  const ingestion = new IngestionService([raydium, mexc], {
    raydium: config.raydiumPollMs,
    mexc: config.mexcPollMs,
  });
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

async function main() {
  const mode = parseMode();
  if (mode === "paper") {
    console.log(
      "paper trading mode (M1) is not implemented yet — this milestone (M0) only detects and logs opportunities.\n" +
        "Run with no flag or --mode=detect to see live opportunity detection.",
    );
    process.exit(0);
  }
  await runDetectMode();
}

main().catch((err) => {
  logger.failure({ stage: "fatal", message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
