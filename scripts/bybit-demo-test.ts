import { BybitAdapter } from "../src/adapters/cex/bybit.js";
import { KillSwitch } from "../src/monitoring/killswitch.js";
import { config } from "../src/config/env.js";

/**
 * M3: places one real order against Bybit's Demo Trading sandbox
 * (api-demo.bybit.com — no real funds) and polls its status. Requires
 * BYBIT_API_KEY/BYBIT_API_SECRET in .env, generated from YOUR Bybit
 * account's Demo Trading mode (see README) — this script refuses to run
 * without them rather than falling back to anything mainnet-shaped.
 */

async function main() {
  const killSwitch = new KillSwitch();
  killSwitch.pollFileFlag();
  if (killSwitch.isTripped()) {
    console.log("KILL_SWITCH is active — refusing to place any order.");
    return;
  }

  if (!config.bybitApiKey || !config.bybitApiSecret) {
    console.error("Set BYBIT_API_KEY and BYBIT_API_SECRET in .env first — see README for how to generate a Demo Trading key.");
    process.exit(1);
  }

  const adapter = new BybitAdapter();

  console.log("Placing a small market order on Bybit Demo Trading (SOL/USDT, buy, 0.01)...");
  const leg = await adapter.placeOrder("SOL", "buy", 0.01);
  console.log(leg);

  if (leg.status === "failed") {
    console.error("\nOrder was rejected — see the failure log above for Bybit's retCode/retMsg.");
    process.exit(1);
  }

  console.log("\nPolling order status...");
  await new Promise((r) => setTimeout(r, 2000));
  const status = await adapter.getOrderStatus(leg.legId);
  console.log(status);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
