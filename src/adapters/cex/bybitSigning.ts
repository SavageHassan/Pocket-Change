import { createHmac } from "node:crypto";

/**
 * Bybit v5 API request signing (HMAC-SHA256), used identically for
 * mainnet and Demo Trading — only the base URL differs. This module
 * itself has no base URL in it; the caller decides, and this codebase
 * only ever calls it with the demo host (see bybit.ts).
 */

export const DEMO_BASE_URL = "https://api-demo.bybit.com";
const RECV_WINDOW = "5000";

export interface SignedRequestHeaders extends Record<string, string> {
  "X-BAPI-API-KEY": string;
  "X-BAPI-SIGN": string;
  "X-BAPI-SIGN-TYPE": "2";
  "X-BAPI-TIMESTAMP": string;
  "X-BAPI-RECV-WINDOW": string;
  "Content-Type": "application/json";
}

export function signRequest(apiKey: string, apiSecret: string, payload: string): SignedRequestHeaders {
  const timestamp = Date.now().toString();
  const signPayload = timestamp + apiKey + RECV_WINDOW + payload;
  const signature = createHmac("sha256", apiSecret).update(signPayload).digest("hex");
  return {
    "X-BAPI-API-KEY": apiKey,
    "X-BAPI-SIGN": signature,
    "X-BAPI-SIGN-TYPE": "2",
    "X-BAPI-TIMESTAMP": timestamp,
    "X-BAPI-RECV-WINDOW": RECV_WINDOW,
    "Content-Type": "application/json",
  };
}
