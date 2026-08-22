import pino from "pino";
import { mkdirSync } from "node:fs";
import type { Opportunity } from "../types/index.js";

// FR-7: structured logging for every detected opportunity, every trade
// attempt, and every fallback/failure event, from day one (M0) — not
// bolted on later. Every event carries venue identity per FR-7.1 extension.

mkdirSync("logs", { recursive: true });

const destination = pino.multistream([
  { stream: pino.destination({ dest: "logs/events.jsonl", mkdir: true }) },
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
