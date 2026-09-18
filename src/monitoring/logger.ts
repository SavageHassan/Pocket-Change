import pino from "pino";
import { mkdirSync } from "node:fs";
import type { Opportunity, PaperTrade } from "../types/index.js";

// FR-7: structured logging for every detected opportunity, every trade
// attempt, and every fallback/failure event, from day one (M0) — not
// bolted on later. Every event carries venue identity per FR-7.1 extension.

mkdirSync("logs", { recursive: true });

// sync: true — short-lived one-shot scripts (M3's devnet/Bybit test scripts)
// can call process.exit() moments after a log call, which races pino's
// default async file destination before its "ready" event fires ("sonic
// boom is not ready yet"). Our log volume is low enough that synchronous
// writes cost nothing meaningful, and it removes this whole failure class.
const destination = pino.multistream([
  { stream: pino.destination({ dest: "logs/events.jsonl", mkdir: true, sync: true }) },
  { stream: process.stdout },
]);

const base = pino(
  {
    level: process.env.LOG_LEVEL ?? "info",
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  destination,
);

export const logger = {
  opportunity(opp: Opportunity) {
    base.info({ event: "opportunity_detected", ...opp }, "opportunity detected");
  },
  tradeAttempt(payload: Record<string, unknown>) {
    base.info({ event: "trade_attempt", ...payload }, "trade attempt");
  },
  paperTrade(trade: PaperTrade) {
    base.info({ event: "paper_trade", ...trade }, "paper trade simulated");
  },
  failure(payload: Record<string, unknown>) {
    base.error({ event: "failure", ...payload }, "failure");
  },
  unwind(payload: Record<string, unknown>) {
    base.warn({ event: "unwind", ...payload }, "unwind event");
  },
  system(msg: string, payload: Record<string, unknown> = {}) {
    base.info({ event: "system", ...payload }, msg);
  },
};
