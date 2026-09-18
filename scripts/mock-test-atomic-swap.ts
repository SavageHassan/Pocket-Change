import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { executeAtomicSwap, type PoolAccounts } from "../src/execution/atomicSwap.js";

/**
 * Verifies executeAtomicSwap's own logic (build instruction, branch on
 * simulate result, classify guard-rejection vs. generic failure, submit on
 * success) against a fake Connection — no devnet RPC, no funded wallet, no
 * network at all. This is what "test it with mock data" means for this
 * module: proving the pipeline's decision logic is correct in isolation
 * from the currently-rate-limited devnet faucet. It does NOT prove the
 * real Token-Swap program accepts our instruction encoding — only a real
 * devnet run (scripts/devnet-dex-test.ts, once funded) proves that.
 */

const fakePool: PoolAccounts = {
  tokenSwap: Keypair.generate().publicKey,
  authority: Keypair.generate().publicKey,
  tokenAccountA: Keypair.generate().publicKey,
  tokenAccountB: Keypair.generate().publicKey,
  mintA: Keypair.generate().publicKey,
  mintB: Keypair.generate().publicKey,
  poolToken: Keypair.generate().publicKey,
  feeAccount: Keypair.generate().publicKey,
  swapProgramId: Keypair.generate().publicKey,
  poolTokenProgramId: Keypair.generate().publicKey,
};

const payer = Keypair.generate();
const userSource = Keypair.generate().publicKey;
const userDestination = Keypair.generate().publicKey;

function fakeConnection(simResult: { err: unknown; logs: string[] | null }, sendShouldFail = false): Connection {
  return {
    // A base58 string that decodes to exactly 32 bytes, like a real blockhash — any PublicKey's address satisfies that.
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 }),
    simulateTransaction: async () => ({ context: { slot: 0 }, value: simResult }),
    sendRawTransaction: async () => {
      if (sendShouldFail) throw new Error("mock RPC: transaction failed on submit");
      return "mockSignature1111111111111111111111111111111111111111111111111111111111111";
    },
    confirmTransaction: async () => ({ context: { slot: 0 }, value: { err: null } }),
  } as unknown as Connection;
}

let pass = 0;
let fail = 0;
function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) {
    pass++;
    console.log(`  ok — ${name}`);
  } else {
    fail++;
    console.log(`  FAIL — ${name}`, detail ?? "");
  }
}

async function main() {
  console.log("1. Successful swap (simulation clean, submit succeeds) -> status 'confirmed'");
  {
    const result = await executeAtomicSwap(fakeConnection({ err: null, logs: ["Program log: swap ok"] }), payer, fakePool, "AtoB", userSource, userDestination, 1000n, 900n);
    check("status is confirmed", result.status === "confirmed", result);
    check("signature is present", !!result.signature, result);
  }

  console.log("2. Unrealistic minimumAmountOut -> simulation fails with a slippage-shaped error -> status 'guard_rejected', nothing submitted");
  {
    let submitCalled = false;
    const conn = fakeConnection({ err: { InstructionError: [0, { Custom: 1 }] }, logs: ["Program log: Error: Swap instruction exceeds desired slippage limit"] });
    const originalSend = conn.sendRawTransaction.bind(conn);
    conn.sendRawTransaction = (async (...args: unknown[]) => {
      submitCalled = true;
      // @ts-expect-error mock passthrough
      return originalSend(...args);
    }) as typeof conn.sendRawTransaction;

    const result = await executeAtomicSwap(conn, payer, fakePool, "AtoB", userSource, userDestination, 1000n, 999999999n);
    check("status is guard_rejected", result.status === "guard_rejected", result);
    check("no real submission was attempted", !submitCalled);
  }

  console.log("3. Unrelated program error (not slippage-shaped) -> status 'simulation_failed', still never submitted");
  {
    const result = await executeAtomicSwap(fakeConnection({ err: { InstructionError: [0, { Custom: 99 }] }, logs: ["Program log: Error: some unrelated failure"] }), payer, fakePool, "BtoA", userSource, userDestination, 1000n, 1n);
    check("status is simulation_failed", result.status === "simulation_failed", result);
  }

  console.log("4. Simulation clean but the real submit throws -> status 'submit_failed', not misreported as confirmed");
  {
    const result = await executeAtomicSwap(fakeConnection({ err: null, logs: [] }, true), payer, fakePool, "AtoB", userSource, userDestination, 1000n, 1n);
    check("status is submit_failed", result.status === "submit_failed", result);
    check("no signature on failure", !result.signature);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
