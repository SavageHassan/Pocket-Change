import { existsSync, readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { TOKEN_SWAP_PROGRAM_ID } from "@solana/spl-token-swap";
import { devnetConnection, loadOrCreateWallet } from "../src/execution/wallet.js";
import { executeAtomicSwap, type PoolAccounts } from "../src/execution/atomicSwap.js";
import { KillSwitch } from "../src/monitoring/killswitch.js";
import { logger } from "../src/monitoring/logger.js";

/**
 * M3: the real devnet proof — two actual swaps against the pool from
 * setup-devnet-pool.ts, run one after the other:
 *   1. A sane trade that should confirm on-chain.
 *   2. A deliberately-doomed trade (minimumAmountOut set far above what's
 *      possible) that must be rejected — proving FR-4.1/4.3's on-chain
 *      guard actually holds, the same way M2 proved the unwind procedure
 *      by deliberately breaking things instead of only testing the happy path.
 *
 * Requires: npm run setup:devnet-pool to have completed first (needs a
 * funded devnet wallet — see README).
 */

const POOL_FILE = "devnet-pool.json";

async function main() {
  const killSwitch = new KillSwitch();
  killSwitch.pollFileFlag();
  if (killSwitch.isTripped()) {
    console.log("KILL_SWITCH is active — refusing to submit any transaction.");
    return;
  }

  if (!existsSync(POOL_FILE)) {
    console.error(`${POOL_FILE} not found — run "npm run setup:devnet-pool" first.`);
    process.exit(1);
  }
  const poolCfg = JSON.parse(readFileSync(POOL_FILE, "utf8"));

  const payer = loadOrCreateWallet();
  const connection = devnetConnection();

  const pool: PoolAccounts = {
    tokenSwap: new PublicKey(poolCfg.tokenSwap),
    authority: new PublicKey(poolCfg.authority),
    tokenAccountA: new PublicKey(poolCfg.tokenAccountA),
    tokenAccountB: new PublicKey(poolCfg.tokenAccountB),
    mintA: new PublicKey(poolCfg.mintA),
    mintB: new PublicKey(poolCfg.mintB),
    poolToken: new PublicKey(poolCfg.poolMint),
    feeAccount: new PublicKey(poolCfg.feeAccount),
    swapProgramId: TOKEN_SWAP_PROGRAM_ID,
    poolTokenProgramId: TOKEN_PROGRAM_ID,
  };

  // These are the plain (non-ATA) token accounts setup-devnet-pool.ts already
  // created and funded for us — not associated-token-account lookups, since
  // that would resolve to a different, empty address.
  const userSource = new PublicKey(poolCfg.payerTokenAccountA);
  const userDestination = new PublicKey(poolCfg.payerTokenAccountB);

  console.log("--- Test 1: sane trade, should confirm ---");
  const amountIn = 1000n; // 0.001 of token A against a 1.0/1.0 pool
  const expectedRoughlyOut = 990n; // ~0.25% fee + tiny slippage
  const minimumAmountOut = (expectedRoughlyOut * 90n) / 100n; // 10% tolerance, generous for a demo
  const result1 = await executeAtomicSwap(connection, payer, pool, "AtoB", userSource, userDestination, amountIn, minimumAmountOut);
  console.log(result1);

  console.log("\n--- Test 2: deliberately impossible minimumAmountOut, must be rejected ---");
  const result2 = await executeAtomicSwap(connection, payer, pool, "AtoB", userSource, userDestination, amountIn, 999_999_999n);
  console.log(result2);

  logger.system("devnet dex test complete", { test1: result1.status, test2: result2.status });

  if (result1.status !== "confirmed") {
    console.error("\nTest 1 did not confirm — see logs above.");
    process.exit(1);
  }
  if (result2.status !== "guard_rejected" && result2.status !== "simulation_failed") {
    console.error("\nTest 2 unexpectedly did not fail — the guard may not be working.");
    process.exit(1);
  }
  console.log("\nBoth outcomes are as expected: a real trade confirmed, and the impossible one was rejected before ever submitting.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
