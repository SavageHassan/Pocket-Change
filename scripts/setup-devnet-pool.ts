import { Keypair, PublicKey } from "@solana/web3.js";
import { createMint, createAccount, mintTo, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { TokenSwap, TOKEN_SWAP_PROGRAM_ID, CurveType } from "@solana/spl-token-swap";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { devnetConnection, ensureFunded, loadOrCreateWallet } from "../src/execution/wallet.js";
import { logger } from "../src/monitoring/logger.js";

/**
 * M3, one-time provisioning: mints two devnet test tokens and creates a
 * Token-Swap pool between them so devnet-dex-test.ts has something real to
 * swap against. Raydium's real pools don't exist on devnet (see README) —
 * this is the documented stand-in.
 *
 * Idempotent: if devnet-pool.json already exists, does nothing and prints
 * the existing pool instead of creating a new one every run.
 */

const POOL_FILE = "devnet-pool.json";
const INITIAL_LIQUIDITY = 1_000_000n; // in each token's base units (6 decimals -> 1.0 token)

interface PoolConfig {
  tokenSwap: string;
  authority: string;
  mintA: string;
  mintB: string;
  tokenAccountA: string;
  tokenAccountB: string;
  poolMint: string;
  feeAccount: string;
  payerTokenAccountA: string;
  payerTokenAccountB: string;
}

async function main() {
  if (existsSync(POOL_FILE)) {
    console.log(`${POOL_FILE} already exists — pool already provisioned:`);
    console.log(readFileSync(POOL_FILE, "utf8"));
    return;
  }

  const payer = loadOrCreateWallet();
  const connection = devnetConnection();
  await ensureFunded(connection, payer);

  console.log("Creating test token mints...");
  const mintA = await createMint(connection, payer, payer.publicKey, null, 6);
  const mintB = await createMint(connection, payer, payer.publicKey, null, 6);

  const tokenSwapAccount = Keypair.generate();
  const [authority] = PublicKey.findProgramAddressSync([tokenSwapAccount.publicKey.toBuffer()], TOKEN_SWAP_PROGRAM_ID);

  console.log("Creating pool-side token accounts (owned by the pool authority PDA)...");
  const tokenAccountA = await createAccount(connection, payer, mintA, authority);
  const tokenAccountB = await createAccount(connection, payer, mintB, authority);

  console.log("Funding initial pool liquidity...");
  await mintTo(connection, payer, mintA, tokenAccountA, payer, INITIAL_LIQUIDITY);
  await mintTo(connection, payer, mintB, tokenAccountB, payer, INITIAL_LIQUIDITY);

  console.log("Creating our own token accounts (to hold what we'll trade with)...");
  const payerTokenAccountA = await createAccount(connection, payer, mintA, payer.publicKey);
  const payerTokenAccountB = await createAccount(connection, payer, mintB, payer.publicKey);
  await mintTo(connection, payer, mintA, payerTokenAccountA, payer, INITIAL_LIQUIDITY / 10n);
  await mintTo(connection, payer, mintB, payerTokenAccountB, payer, INITIAL_LIQUIDITY / 10n);

  console.log("Creating pool mint + fee/pool-token accounts...");
  const poolMint = await createMint(connection, payer, authority, null, 2);
  const feeAccount = await createAccount(connection, payer, poolMint, payer.publicKey);
  const tokenAccountPool = await createAccount(connection, payer, poolMint, payer.publicKey);

  console.log("Initializing the Token-Swap pool (constant-product curve)...");
  await TokenSwap.createTokenSwap(
    connection,
    payer,
    tokenSwapAccount,
    authority,
    tokenAccountA,
    tokenAccountB,
    poolMint,
    mintA,
    mintB,
    feeAccount,
    tokenAccountPool,
    TOKEN_SWAP_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    25n, // tradeFeeNumerator -> 25/10000 = 0.25%, roughly matching a real AMM fee tier
    10000n, // tradeFeeDenominator
    0n,
    0n, // ownerTradeFee
    0n,
    0n, // ownerWithdrawFee
    0n,
    0n, // hostFee
    CurveType.ConstantProduct,
  );

  const config: PoolConfig = {
    tokenSwap: tokenSwapAccount.publicKey.toBase58(),
    authority: authority.toBase58(),
    mintA: mintA.toBase58(),
    mintB: mintB.toBase58(),
    tokenAccountA: tokenAccountA.toBase58(),
    tokenAccountB: tokenAccountB.toBase58(),
    poolMint: poolMint.toBase58(),
    feeAccount: feeAccount.toBase58(),
    payerTokenAccountA: payerTokenAccountA.toBase58(),
    payerTokenAccountB: payerTokenAccountB.toBase58(),
  };
  writeFileSync(POOL_FILE, JSON.stringify(config, null, 2));

  logger.system("devnet pool provisioned", { ...config });
  console.log(`\nDone. Pool config written to ${POOL_FILE}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
