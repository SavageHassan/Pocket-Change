import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { TokenSwap } from "@solana/spl-token-swap";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { logger } from "../monitoring/logger.js";

/** Only the pool fields this module actually reads — a real `TokenSwap` instance satisfies this structurally, and so does a plain mock in tests. */
export interface PoolAccounts {
  tokenSwap: PublicKey;
  authority: PublicKey;
  tokenAccountA: PublicKey;
  tokenAccountB: PublicKey;
  mintA: PublicKey;
  mintB: PublicKey;
  poolToken: PublicKey;
  feeAccount: PublicKey;
  swapProgramId: PublicKey;
  poolTokenProgramId: PublicKey;
}

/**
 * FR-4.1/4.3 (v1 SRS, carried into v2 as the DEX execution model): every DEX
 * trade is a single atomic transaction, simulated before submission, with
 * an on-chain minimum-output guard — never a partial, unguarded execution.
 *
 * This is the M3 devnet proof of that pipeline against the classic SPL
 * Token-Swap program (see README for why not literally Raydium — its
 * devnet pools don't mirror the mainnet ones this bot tracks).
 *
 * The guard itself is enforced by the on-chain program: `minimumAmountOut`
 * is passed into the swap instruction, and the program aborts the entire
 * transaction if the actual computed output would be lower — Solana's
 * transaction model means "abort" here means nothing happens at all, not a
 * partial fill. Simulating first means a guard rejection is caught for free
 * (no fee paid, no transaction landed) rather than discovered on-chain.
 */

export type SwapDirection = "AtoB" | "BtoA";

export interface AtomicSwapResult {
  status: "confirmed" | "guard_rejected" | "simulation_failed" | "submit_failed";
  signature?: string;
  logs?: string[];
  error?: string;
}

function resolvePoolSideAccounts(tokenSwap: PoolAccounts, direction: SwapDirection) {
  return direction === "AtoB"
    ? { poolSource: tokenSwap.tokenAccountA, poolDestination: tokenSwap.tokenAccountB, sourceMint: tokenSwap.mintA, destinationMint: tokenSwap.mintB }
    : { poolSource: tokenSwap.tokenAccountB, poolDestination: tokenSwap.tokenAccountA, sourceMint: tokenSwap.mintB, destinationMint: tokenSwap.mintA };
}

function looksLikeGuardRejection(logs: string[] | null | undefined): boolean {
  if (!logs) return false;
  return logs.some((l) => /slippage|minimum.*amount|exceeded/i.test(l));
}

export async function executeAtomicSwap(
  connection: Connection,
  payer: Keypair,
  tokenSwap: PoolAccounts,
  direction: SwapDirection,
  userSource: PublicKey,
  userDestination: PublicKey,
  amountIn: bigint,
  minimumAmountOut: bigint,
): Promise<AtomicSwapResult> {
  const { poolSource, poolDestination, sourceMint, destinationMint } = resolvePoolSideAccounts(tokenSwap, direction);

  const instruction = TokenSwap.swapInstruction(
    tokenSwap.tokenSwap,
    tokenSwap.authority,
    payer.publicKey,
    userSource,
    poolSource,
    poolDestination,
    userDestination,
    tokenSwap.poolToken,
    tokenSwap.feeAccount,
    null,
    sourceMint,
    destinationMint,
    tokenSwap.swapProgramId,
    TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    tokenSwap.poolTokenProgramId,
    amountIn,
    minimumAmountOut,
  );

  const tx = new Transaction().add(instruction);
  tx.feePayer = payer.publicKey;
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.sign(payer);

  logger.tradeAttempt({
    venue: "solana-devnet-tokenswap",
    stage: "simulate",
    direction,
    amountIn: amountIn.toString(),
    minimumAmountOut: minimumAmountOut.toString(),
  });

  const sim = await connection.simulateTransaction(tx);
  if (sim.value.err) {
    const rejected = looksLikeGuardRejection(sim.value.logs);
    logger.failure({
      venue: "solana-devnet-tokenswap",
      stage: "simulate",
      err: JSON.stringify(sim.value.err),
      logs: sim.value.logs,
      classification: rejected ? "guard_rejected" : "simulation_failed",
    });
    return {
      status: rejected ? "guard_rejected" : "simulation_failed",
      logs: sim.value.logs ?? [],
      error: JSON.stringify(sim.value.err),
    };
  }

  try {
    const signature = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction(signature, "confirmed");
    logger.tradeAttempt({ venue: "solana-devnet-tokenswap", stage: "confirmed", signature, direction });
    return { status: "confirmed", signature, logs: sim.value.logs ?? [] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.failure({ venue: "solana-devnet-tokenswap", stage: "submit", error: message });
    return { status: "submit_failed", error: message };
  }
}
