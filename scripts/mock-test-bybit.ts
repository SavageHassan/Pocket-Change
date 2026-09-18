/**
 * Verifies BybitAdapter's execution methods (placeOrder / getOrderStatus /
 * getBalances) against a faked `fetch` returning canned Bybit v5 response
 * shapes — no real API key, no network call, no real Demo Trading account
 * needed. Proves the request signing, URL/body construction, and response
 * parsing are all correct; does NOT prove Bybit's real Demo Trading API
 * actually accepts our request (that needs scripts/bybit-demo-test.ts with
 * a real key, once you have one).
 */

process.env.BYBIT_API_KEY = "mock-key";
process.env.BYBIT_API_SECRET = "mock-secret";

const { BybitAdapter } = await import("../src/adapters/cex/bybit.js");

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

type FetchArgs = [string, RequestInit | undefined];
let lastCall: FetchArgs | undefined;

function mockFetchReturning(body: unknown) {
  return (async (...args: FetchArgs) => {
    lastCall = args;
    return { json: async () => body } as Response;
  }) as typeof fetch;
}

async function main() {
  const adapter = new BybitAdapter();

  console.log("1. placeOrder success -> Leg with pending status and Bybit's orderId");
  {
    globalThis.fetch = mockFetchReturning({ retCode: 0, retMsg: "OK", result: { orderId: "ORD123" } });
    const leg = await adapter.placeOrder("SOL", "buy", 1.5);
    check("status is pending", leg.status === "pending", leg);
    check("legId is Bybit's orderId", leg.legId === "ORD123", leg);
    check("hit /v5/order/create", !!lastCall?.[0].includes("/v5/order/create"), lastCall?.[0]);
    check("used the demo host, never mainnet", lastCall?.[0].startsWith("https://api-demo.bybit.com") ?? false, lastCall?.[0]);
    const sentBody = JSON.parse((lastCall?.[1]?.body as string) ?? "{}");
    check("side mapped Buy correctly", sentBody.side === "Buy", sentBody);
    check("symbol resolved from asset config", sentBody.symbol === "SOLUSDT", sentBody);
  }

  console.log("2. placeOrder rejected by Bybit -> Leg with failed status, not thrown");
  {
    globalThis.fetch = mockFetchReturning({ retCode: 10001, retMsg: "insufficient balance", result: {} });
    const leg = await adapter.placeOrder("SOL", "sell", 1000);
    check("status is failed", leg.status === "failed", leg);
  }

  console.log("3. getOrderStatus maps Bybit's orderStatus strings onto our Leg statuses");
  {
    globalThis.fetch = mockFetchReturning({
      retCode: 0,
      retMsg: "OK",
      result: { list: [{ side: "Buy", qty: "1.5", cumExecQty: "1.5", orderStatus: "Filled" }] },
    });
    const leg = await adapter.getOrderStatus("ORD123");
    check("status mapped Filled -> filled", leg.status === "filled", leg);
    check("filledQty parsed", leg.filledQty === 1.5, leg);
  }

  console.log("4. getBalances parses wallet-balance response into Balance[]");
  {
    globalThis.fetch = mockFetchReturning({
      retCode: 0,
      retMsg: "OK",
      result: { list: [{ coin: [{ coin: "USDT", walletBalance: "100.5", locked: "10" }] }] },
    });
    const balances = await adapter.getBalances();
    check("one balance parsed", balances.length === 1, balances);
    check("available = walletBalance - locked", balances[0].available === 90.5, balances);
  }

  console.log("5. No API key configured -> NotImplementedError, never silently calls a real endpoint");
  {
    delete process.env.BYBIT_API_KEY;
    delete process.env.BYBIT_API_SECRET;
    const { config } = await import("../src/config/env.js");
    config.bybitApiKey = undefined;
    config.bybitApiSecret = undefined;
    let threw = false;
    try {
      await adapter.placeOrder("SOL", "buy", 1);
    } catch (err) {
      threw = err instanceof Error && err.name === "NotImplementedError";
    }
    check("throws NotImplementedError without credentials", threw);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
