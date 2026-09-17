# crypto-arb-bot

Multi-venue crypto arbitrage bot, built per `SRS_MultiExchange_Arbitrage_Bot_v2.md`
(v2 SRS). Currently at **M2**: live market data ingestion across three
venues, opportunity detection, paper trading with realistic fill
simulation, and a stress-tested unwind procedure. No wallet, no exchange
API keys, no order placement anywhere in these milestones.

## Status: M2 complete

- Venues: [Raydium](https://raydium.io) (Solana DEX) + [MEXC](https://www.mexc.com) + [Bybit](https://www.bybit.com) (CEXs)
- Assets: SOL/USDT (all three venues), RAY/USDT (Raydium + MEXC — not listed on Bybit; see `src/config/assets.ts`, adding an asset/venue is a config edit + one adapter file, not a core change)
- **M0:** detects cross-venue price spreads, computes fee-adjusted net spread, logs every opportunity (profitable or not) as structured JSON
- **M1:** every opportunity that clears the profit threshold is re-priced through realistic fill simulation — order-book depth walk for CEX legs, pool-slippage model for the Raydium leg — and the hypothetical result (matched quantity, fees, realized P&L) is logged and tracked per venue-pair
- **M2:** second CEX adapter (Bybit) live; `--stress-test` deliberately corrupts leg fills to exercise FR-5.4's unwind procedure on demand, which now actually simulates the offsetting order (not just logs the mismatch) and tracks whether the exposure was fully flattened
- Still no trading — all three milestones only observe, simulate, and log

## Setup

```bash
npm install
cp .env.example .env   # optional — defaults work with no keys through M2
npm start                                      # M0: detection mode (default)
npm start -- --mode=paper                      # M1: paper trading mode
npm start -- --mode=paper --stress-test        # M2: paper trading with injected leg failures
```

You'll see console lines only when a net-positive-or-notable spread appears
(detect mode) or a simulated trade fires (paper mode), and structured JSON
for every event in `logs/events.jsonl` (gitignored). To see all computed
spreads/trades including unprofitable ones (useful for sanity-checking the
pipeline is actually computing, since real spreads are usually negative
after fees):

```bash
MIN_NET_SPREAD_BPS=-100000 npm start -- --mode=paper
```

Stop with `Ctrl+C`, or by creating a `KILL_SWITCH` file in the project root
(the manual-trigger kill switch, FR-8, polls for this file every scan cycle).

## Run modes

- `npm start` / `--mode=detect` — **M0, implemented.** Live detection + logging only.
- `--mode=paper` — **M1, implemented.** Simulates fills for every opportunity that clears the profit threshold and tracks hypothetical P&L. No orders are ever placed.
- `--mode=paper --stress-test` — **M2, implemented.** Same as paper mode, but deliberately corrupts one leg's fill on ~80% of trades (0% or a random partial fraction) to force the FR-5.4 unwind path to fire reliably, instead of waiting on the rare natural mismatches real order-book/pool depth produces at $500 trade size. Console-tagged `[LEG MISMATCH -> UNWOUND]` and structured-logged as `event: "unwind"` with whether the exposure was fully flattened.

## How M1's fill simulation works

- **MEXC (CEX) leg:** walks the real order-book levels already being polled
  (`NormalizedQuote.raw`), consuming liquidity level-by-level until the
  simulated order size is filled or the book runs out — so a trade size
  larger than what's actually sitting at the top of book gets a realistically
  worse average price, or a partial fill, instead of an idealized full fill.
- **Raydium (DEX) leg:** constant-product slippage model using *virtual*
  reserves derived from the pool's quoted price and TVL (see
  `engine/fillSimulator.ts` for why — the pools here are CLMM, and their raw
  on-chain reserves aren't valid constant-product inputs; this was a real bug
  caught during testing, see Deviations #8 below).
- **P&L tracking (FR-7.6):** `monitoring/pnlTracker.ts` accumulates
  theoretical vs. realized P&L per (asset, buy-venue, sell-venue), printed
  as a running summary every 5 scan cycles in paper mode.
## How M2's unwind procedure works (FR-5.4)

`engine/unwindSimulator.ts` is called after every simulated trade. If the two
legs' filled quantities don't match:

1. Compute the net exposure (`buyFill.filledQty - sellFill.filledQty`).
2. If positive (bought more than sold — naked long), simulate selling the
   excess immediately **on the buy venue**, where the fill happened.
3. If negative (sold more than bought — naked short), simulate buying back
   the excess immediately **on the sell venue**.
4. The unwind's own slippage cost is folded into the trade's `realizedPnlUsd`
   — flattening a naked position isn't free, and pretending otherwise would
   understate real risk.
5. If the unwind order itself can't fully fill (the book/pool doesn't have
   enough depth to absorb it), the event is marked `fullyFlattened: false`
   and the `actionTaken` string says so explicitly — a real tail risk, not
   swept under the rug.

`monitoring/unwindTracker.ts` (FR-7.5) accumulates event count, incomplete-
flatten count, and total realized unwind loss, printed alongside the P&L
summary. A verification run with `--stress-test` (see below) produced 35
unwind events across 40 trades, 34 fully flattened and 1 incomplete — every
mismatch got a response, none were left as a silent naked position.

## Path to M3 (devnet/testnet execution)

M3 needs, on top of what exists:
1. A Solana devnet wallet + RPC connection, and real atomic transaction
   building for the Raydium leg (FR-4.1/4.3) — simulate-before-submit, with
   an on-chain minimum-output guard, using devnet funds only.
2. Real order submission to MEXC/Bybit sandbox or testnet APIs, if
   available for spot (needs a specific check at M3 time — availability
   changes).
3. Wiring `VenueAdapter.placeOrder`/`getOrderStatus` for real, replacing the
   `NotImplementedError` stubs — the interface shape doesn't change, only
   the implementation.
4. The kill switch's automatic triggers (FR-8.4 per-venue error rate,
   FR-8.5 elevated unwind rate) become meaningful once there's live
   execution and unwind history to compute rates from — M2's manual trigger
   and unwind tracking are the prerequisite state for this.

Per your original instructions: stop after M3 and report status before
touching mainnet or real capital — nothing past devnet/testnet execution is
in scope without your explicit go-ahead in a later session.

## What you'll need to supply for later milestones

**M0/M1/M2 (now):** nothing. All three adapters hit public, unauthenticated APIs.

**M3 (devnet/testnet execution):**
- `SOLANA_DEVNET_RPC_URL` — a Solana devnet RPC endpoint
- `SOLANA_WALLET_PRIVATE_KEY` — a **devnet-only** keypair, funded with devnet SOL from a faucet, never a mainnet key
- MEXC sandbox/testnet API key + secret if MEXC offers one for spot (verify current availability — this needs a specific check at M3 time); scoped trading-only, withdrawals disabled (FR-10.3)

All secrets load from a git-ignored `.env` (see `.env.example` for the full list with inline explanations). Nothing is ever hardcoded.

## Architecture

```
src/
  types/        canonical data model (Venue, Balance, Leg, UnwindEvent, NormalizedQuote, Opportunity) + VenueAdapter interface (FR-1.1)
  config/       asset universe (config, not code) + env-driven tuning
  adapters/
    dex/        RaydiumAdapter
    cex/        MexcAdapter, BybitAdapter (M2)
  ingestion/    polls adapters, tracks per-venue freshness (FR-1.5)
  engine/       opportunityDetector (FR-2), fillSimulator + paperTradingEngine (FR-9.1, M1), unwindSimulator + legFailureInjector (FR-5.4, M2)
  execution/    empty — M3+
  capital/      empty — M4+ (real capital allocation, FR-6)
  monitoring/   structured JSON logger (FR-7), kill switch (FR-8), pnlTracker (FR-7.6, M1), unwindTracker (FR-7.5, M2)
  cli.ts        entrypoint, --mode and --stress-test flags
```

Every adapter implements the same `VenueAdapter` interface
(`src/types/index.ts`), so the detection engine never talks to a
venue-specific client directly — adding exchange #3 or chain #2 means
writing a new file in `adapters/`, not touching `engine/` or `ingestion/`.

## Deviations from the SRS, and why

1. **v1 SRS (`SRS_Solana_Arbitrage_Bot.md`) was unavailable.** It's
   referenced throughout v2 as the source of truth for the exact atomic-DEX
   execution pattern (FR-4.1/4.3), the on-chain ingestion design (FR-1.3),
   and the original 18 fallback scenarios — but the file wasn't present in
   `~/Downloads` when this was built, and per your instruction M0 proceeded
   from v2's own summary of that model (sections 0, 2.2, FR-4.1, FR-5.1,
   FR-9.1) rather than the verbatim v1 text. If you locate the v1 file,
   worth a pass to confirm nothing in the execution-layer design (M3+)
   conflicts with what's built here — M0/M1 don't touch execution, so
   they're unaffected either way.

2. **Raydium ingestion uses REST polling of Raydium's public v3 API
   (`api-v3.raydium.io`), not direct on-chain account subscription.**
   Reading a Raydium AMM/CLMM pool's live state directly off-chain requires
   parsing Solana account byte layouts, which is exactly the kind of detail
   the missing v1 doc likely specified precisely. Raydium's own API computes
   the same price/TVL/fee data from live on-chain state and is what
   Raydium's own frontend uses, so this is real live data — just fetched one
   layer up instead of parsing raw accounts. Worth revisiting for lower
   latency once v1's on-chain design is available, or before M3 if
   sub-150ms detection-to-submit (NFR table) isn't achievable through the
   REST API alone.

3. **MEXC ingestion uses REST polling, not WebSocket.** FR-1.2 specifies WS
   as primary. I checked MEXC's current API docs before building: their
   public market-data WebSocket now pushes **protobuf-only** payloads (no
   plain-JSON channel — confirmed against their live docs), which means a
   WS implementation needs MEXC's protobuf schema files
   (`mexcdevelop/websocket-proto` on GitHub) and a decode step, real added
   complexity for M0's scope. REST polling every 2s is a legitimate
   fallback per FR-1.2's own wording ("REST polling only as fallback"), and
   it's what's implemented. **Recommend upgrading to the protobuf WS stream
   before M2**, where two-leg timing (FR-5.2's "as close to simultaneously
   as possible") starts to matter and 2-second-stale REST snapshots become a
   real risk of comparing a fresh quote against a stale one.

4. **Fixed a real clock-drift bug during verification, not a deviation but
   worth flagging:** the MEXC adapter originally stamped quotes with the
   exchange's own reported timestamp. Under live testing this occasionally
   produced negative "quote age" values (the venue's clock read slightly
   ahead of local time) — a live instance of fallback scenario 28 (clock
   drift between venue feeds) showing up in the freshness check itself.
   Fixed to stamp quotes with local receipt time; the venue's own timestamp
   is preserved in `NormalizedQuote.raw` for future drift monitoring.

5. **Asset universe is a curated starter list (SOL, RAY), not the
   auto-discovery + tradable-universe filter section 2.3 describes.** The
   SRS itself frames "all coins" as a filter-engineering problem to build
   incrementally, not a day-one requirement — M0 hand-picked two pairs with
   verified liquidity on both venues (checked live before hardcoding) to
   prove the pipeline end-to-end. The filter pipeline (min depth, min
   history, honeypot/scam exclusion, delisting checks) is unbuilt; adding it
   is a natural M1/M2-adjacent task since it gates what M1's paper trading
   should even consider.

6. **DEX side has no bid/ask spread or slippage model in M0** — Raydium's
   API gives a single pool-implied price, used for both buy and sell sides.
   Real DEX execution has slippage that grows with trade size against pool
   depth; this is explicitly M1 scope per FR-9.1 ("model realistic
   partial-fill... scenarios, not just idealized full fills") and isn't
   pretended to be solved here.

7. **Kill switch (FR-8) is scaffolded but only the manual trigger is live**
   in M0 (`Ctrl+C` or a `KILL_SWITCH` file). The automatic triggers —
   per-venue error-rate (FR-8.4) and elevated-unwind-rate (FR-8.5) — are
   stubbed methods that throw if called; they need state (error-rate
   history, unwind event counts) that doesn't exist until M2/M3. Per your
   instruction the kill-switch system exists and is wired into the run loop
   before any execution milestone is reachable, but its automatic half has
   nothing to trigger on yet.

8. **Raydium slippage simulation uses virtual reserves (price + TVL), not
   raw on-chain pool reserves — a real bug was caught and fixed during M1
   testing.** The first implementation fed `mintAmountA`/`mintAmountB`
   (the pool's raw token amounts) directly into x\*y=k constant-product
   math. Because the configured pools are CLMM (concentrated liquidity),
   those raw amounts are aggregated across the pool's entire historical
   tick range, not deployed as a single curve at the current price — in a
   live test run this produced a simulated SOL buy price of $72.47 against
   a real market price of $100.32 (~28% off), which fabricated a fake
   $138 "profit" in the P&L tracker. Fixed by deriving virtual reserves
   from the pool's own quoted price and TVL instead (`engine/fillSimulator.ts`),
   which anchors slippage simulation at the correct price; it's still an
   approximation of CLMM depth (spreading TVL across a flat constant-product
   curve generally overstates slippage vs. real concentrated liquidity near
   the current price), but the earlier version wasn't a defensible
   approximation, it was simply wrong. Worth a more precise CLMM tick-aware
   model if M2/M3 sizing decisions get large enough for the difference to
   matter.

9. **M1's fill simulation reuses `scanForOpportunities` (M0's detector) and
   re-fetches quotes rather than sharing the exact quote instance used for
   detection.** Because both happen within the same scan cycle against the
   same polling cache, the values are consistent in practice (confirmed
   during testing), but it's worth noting this is two reads of the ingestion
   cache rather than one atomic read — a future refactor could pass the
   `Opportunity`'s underlying quotes through directly instead.

10. **RAY has no third venue — Bybit doesn't list it.** Rather than force a
    RAY pairing against a thin/stale pool just to have three-way coverage on
    every asset (checked and rejected: a RAY-adjacent Raydium pool had ~$2k
    TVL and a price ~2x off the real market), RAY stays a two-venue
    (Raydium + MEXC) pair and Bybit only covers SOL. This is the SRS's own
    "all coins is a filter problem" point (section 2.3) showing up as a real
    constraint rather than something to paper over.

11. **OKX was the first choice for CEX #2 and was dropped** — its public API
    reset the TLS connection from this build environment (likely a
    Cloudflare/geo block on this network, not a code issue). Bybit was
    used instead; worth retrying OKX from wherever this actually deploys,
    since it wasn't ruled out for any capability reason.

12. **`--stress-test`'s leg-failure injection rate (~80% of trades get one
    leg corrupted) is arbitrary, tuned for demo/verification density, not
    calibrated to any real failure-rate data.** It exists to prove the
    unwind path works reliably under many trials in one short run; it isn't
    a model of how often real leg failures happen in production (FR-8.5's
    unwind-rate threshold, whenever it's tuned in M3+, should be calibrated
    from real execution data, not this number).

## Non-negotiables carried forward (not yet exercised in M0/M1/M2)

These are honored in the type/interface design now so M3 doesn't require
rework, even though M0/M1/M2 have no real execution path to exercise them:

- `VenueAdapter.placeOrder`/`getOrderStatus` exist in the interface and
  throw `NotImplementedError` in both adapters — the shape is fixed, the
  implementation is deliberately deferred.
- The atomic-DEX and hedged-CEX-unwind execution models (FR-4.1/4.3,
  FR-5.2–5.5) aren't implemented yet; M2 is where the unwind procedure gets
  built and stress-tested in paper mode per your milestone plan.
