# crypto-arb-bot

Multi-venue crypto arbitrage bot, built per `SRS_MultiExchange_Arbitrage_Bot_v2.md`
(v2 SRS). M0–M2 (detection, paper trading, unwind) are complete and verified
against live venues. **M4's safety layer (capital controls, automatic kill
switches, monitoring) is built and tested; live order placement is
deliberately NOT enabled.** **M3 (devnet/testnet execution) is code-complete and
verified against mocks, but not yet run end-to-end against real devnet/Bybit
infrastructure** — see the status note in "Path to M3" below for exactly
where it stands and why. Still no mainnet, no real capital, anywhere.

## Status: M0–M2 complete, M4 safety layer built, M3 in progress

- Venues: [Raydium](https://raydium.io) (Solana DEX) + [MEXC](https://www.mexc.com) + [Bybit](https://www.bybit.com) (CEXs)
- Assets: SOL/USDT (all three venues), RAY/USDT (Raydium + MEXC — not listed on Bybit; see `src/config/assets.ts`, adding an asset/venue is a config edit + one adapter file, not a core change)
- **M0:** detects cross-venue price spreads, computes fee-adjusted net spread, logs every opportunity (profitable or not) as structured JSON
- **M1:** every opportunity that clears the profit threshold is re-priced through realistic fill simulation — order-book depth walk for CEX legs, pool-slippage model for the Raydium leg — and the hypothetical result (matched quantity, fees, realized P&L) is logged and tracked per venue-pair
- **M2:** second CEX adapter (Bybit) live; `--stress-test` deliberately corrupts leg fills to exercise FR-5.4's unwind procedure on demand, which now actually simulates the offsetting order (not just logs the mismatch) and tracks whether the exposure was fully flattened
- **M3:** real atomic-transaction pipeline (Solana devnet) and real order submission (Bybit Demo Trading) are written and passing mock-based logic tests; blocked on external infra to prove end-to-end (see below)
- **M4 (safety layer only):** paper capital ledger with pre-positioned balances per venue, hard CEX custody cap, per-trade size ceiling, reconciliation, and automatic kill switches (unwind rate, session loss, per-venue feed errors, custody, drift). See "M4 safety layer" below. Live order placement is not part of it.
- No trading with real capital anywhere

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

## M4 safety layer (capital controls + automatic kill switches)

M4 in the SRS is where real capital first touches the bot. What's built here is
the control layer that has to exist first — on the **paper** ledger. Nothing in
it can place or move real money, and the codebase still has no path to a
mainnet trading endpoint.

- **Pre-positioned capital (FR-6.1, FR-3.7)** — `capital/capitalManager.ts` seeds each venue with USDT and each asset it lists (defaults: $5,000 USDT and $5,000 of each asset per venue). Before any trade it checks USDT exists on the buy venue and the asset on the sell venue; otherwise the trade is rejected and logged. Every fill, including the unwind's offsetting order, updates the ledger.
- **Custody cap (FR-6.4)** — a CEX holding more than `CUSTODY_CAP_PCT` (50%) of total capital is halted. The DEX wallet is self-custody and uncapped.
- **Per-trade ceiling** — `MAX_TRADE_USD` (1000).
- **Utilization / rebalancing (FR-6.3)** — venues drained below 15% of their starting USDT or asset are flagged with what to top up. Actual rebalancing needs withdrawals, which this codebase deliberately doesn't implement.
- **Reconciliation** — every 10 scans the ledger is compared with what each venue reports; drift over `RECONCILE_TOLERANCE_PCT` halts that venue. In paper mode "what the venue reports" is the ledger itself, so this only fires in tests (`scripts/test-m4.ts` injects drift) until there is a real balance API to compare against.
- **Automatic kill switches (FR-8.4 / 8.5)** — `monitoring/riskMonitor.ts`:
  - unwind rate over `UNWIND_RATE_THRESHOLD` (50%) across `UNWIND_RATE_WINDOW` (10) trades trips the **global** switch
  - realized session loss reaching `MAX_SESSION_LOSS_USD` (100) trips the global switch
  - `VENUE_ERROR_THRESHOLD` (5) feed errors in `VENUE_ERROR_WINDOW_MS` halts **that venue only**; `VENUE_RECOVERY_SUCCESSES` (3) clean polls resume it
  - Automatic trips stop new trades but keep the process running so monitoring stays visible. Manual trips (Ctrl+C, `KILL_SWITCH` file) still exit.
- **Monitoring** — the bot logs a `capital_status` snapshot every 15s and `risk_event`s (auto kills, halts, rejections, drift). The dashboard's "Your real bot" panel shows them.

**Verified:** `npm run test:m4` (24 checks: each control fires when it should and stays quiet when it shouldn't), plus live runs against the real feeds: `--stress-test` tripped the unwind-rate kill after 10 trades at a 90% unwind rate; a normal run with every route allowed to trade at a negative edge (`MIN_NET_SPREAD_BPS=-100`) tripped the session-loss limit at about -$102 after 78 trades.

**Two things to know when reading the numbers:**
- Because of these limits, `--stress-test` now stops trading quickly by design. Raise `UNWIND_RATE_THRESHOLD` to 1 and `MAX_SESSION_LOSS_USD` high if you want the old long-running stress demo.
- Ledger equity moves with the price of the inventory held at each venue, not only with trade P&L, so it won't match the P&L tracker. That price exposure is a real cost of pre-positioning capital.

**Not built (needs your decision, and real credentials):** live order submission on a real exchange, real balance fetching, and real rebalancing transfers. The SRS's "small real capital" part of M4 depends on those.

## Real orders, fake money (`--live-demo`)

```bash
npm start -- --mode=paper --live-demo
```

The Bybit leg of any route through Bybit becomes a **real order on Bybit Demo
Trading** (their sandbox, play funds). You get real order IDs and real fills.
The other venue's leg stays simulated: MEXC has no sandbox and Raydium's pools
aren't on devnet, so there is nowhere real to send it. Routes that don't involve
Bybit stay paper. Every trade record says which legs were real.

- **Real unwind:** if the Bybit leg over-fills relative to the other leg, the
  offsetting order is also a real demo order; if the excess sits on the
  simulated venue, the unwind is simulated.
- **Guards:** the M4 kill switches, venue halts, custody cap and capital
  pre-checks all still apply; orders are limited to `DEMO_TRADE_USD` (50) each and
  `DEMO_MAX_ORDERS_PER_MIN` (6). `--stress-test` doesn't inject failures into real legs.
- **Startup check:** it calls your demo account's balance endpoint first and
  exits with the reason if the key is missing or rejected. It has no path to any
  real-money host: the adapter only knows `api-demo.bybit.com`.
- **You need:** a Demo Trading API key from your own Bybit account (account menu
  -> Demo Trading -> API) in `.env` as `BYBIT_API_KEY` / `BYBIT_API_SECRET`.
- **Verified so far:** `npm run test:mock-demo` (18 checks against a fake Bybit
  account: real-order wiring, real unwind, rejection, rate limit) and the
  refusal without a key. **Not yet verified against Bybit's real demo API.**
  Their docs don't clearly list plain spot orders as supported in Demo Trading,
  so the first real run may be rejected; the run then shows Bybit's own
  error, and the trade is handled as a failed leg. Selling SOL also needs SOL in
  the demo account; if it has none, sell legs will be rejected and unwound.

## Showing your bot on the Vercel page (cloud relay)

Browsers often block a public https page from reaching `localhost`, so the
Vercel page can't read your bridge directly. The relay fixes that: the bot's
status snapshot (counters, latest spreads, recent paper trades, log lines,
capital status; no keys, no raw logs) is pushed to a small Redis store, and the
page reads it from there. It works in any browser.

One-time setup:
1. **Vercel dashboard -> your project -> Storage -> Create Database -> Upstash Redis**, and connect it to the project. That adds `KV_REST_API_URL` / `KV_REST_API_TOKEN` automatically.
2. **Settings -> Environment Variables:** add `RELAY_TOKEN` = any long random string (for example `openssl rand -hex 24`).
3. **Redeploy** (Deployments -> ... -> Redeploy) so the functions see the new variables.
4. In your local `.env` add `RELAY_URL=https://pocket-change-six.vercel.app` and the **same** `RELAY_TOKEN`.
5. Run the bot and `npm run bridge` as usual. The bridge now also relays. (`npm run relay` does only the relay.)

The Vercel page then shows "bot running · via cloud". It pushes only when
something changed (about every 8s while the bot runs; `RELAY_INTERVAL_MS` to slow
it) to stay inside free Redis limits. `/api/ingest` needs the token to write;
`/api/bot` is read-only and public, and only ever holds paper-trading status.
`npm run test:relay` checks the plumbing (20 checks, fake Redis/network).

## Watching the real bot on the dashboard

The dashboard's "Your real bot" panel reads your bot's own event log through
a small read-only bridge (it can't control the bot or place anything, and it
only listens on 127.0.0.1). In two terminals:

```bash
npm start -- --mode=paper     # the bot
npm run bridge                # serves logs/events.jsonl on localhost:8787
```

Then open **http://127.0.0.1:8787** — the bridge serves the dashboard itself, so
the real-bot panel, live prices and scenario buttons all work in one place with
no browser blocking. (The Vercel-hosted copy can also read the bridge, but
browsers may block a public page from reaching localhost; that path is
untested. Safari blocks it outright.) Start the bot with
`MIN_NET_SPREAD_BPS=-100` to log every route, since it only logs spreads above
its threshold (default 5 bps).

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

## Path to M3 (devnet/testnet execution) — current status

**What exists and is verified:**
- `src/execution/wallet.ts` — generates/loads a devnet-only Solana keypair, connects to devnet, requests an airdrop if underfunded.
- `src/execution/atomicSwap.ts` — the real FR-4.1/4.3 pipeline: build the swap instruction, **simulate before submit**, classify a simulated failure as a guard rejection (the on-chain `minimumAmountOut` check) vs. a generic failure, only submit+confirm on a clean simulation.
- `scripts/setup-devnet-pool.ts` — one-time provisioning: mints two devnet test tokens and creates a Token-Swap pool between them (see Deviations below for why not literally Raydium).
- `scripts/devnet-dex-test.ts` — runs one real trade that should confirm, then one deliberately-impossible trade that must be rejected, against that pool.
- `src/adapters/cex/bybit.ts` — `placeOrder`/`getBalances`/`getOrderStatus` now make real signed v5 API calls against `api-demo.bybit.com` (Bybit's Demo Trading sandbox) instead of throwing `NotImplementedError`. It refuses to run without `BYBIT_API_KEY`/`BYBIT_API_SECRET` and has no code path to any mainnet trading endpoint.
- `scripts/bybit-demo-test.ts` — places one real demo order and polls its status.
- **`npm run test:mock-atomic-swap` and `npm run test:mock-bybit`** — 19 checks total, all passing, verifying the logic above (simulate/submit branching, guard-rejection classification, request signing, response parsing, credential-gating) against faked RPC/HTTP responses. These prove the code is *correct*; they do not prove Bybit's or Solana devnet's real infrastructure accepts our requests.

**What's blocking the real (unmocked) run, and why it's not a code problem:**
- Solana's public devnet faucet (`api.devnet.solana.com`) is rate-limited/dry from the environment this was built in — `npm run setup:devnet-pool` gets as far as generating and saving a devnet wallet, then the airdrop call fails with HTTP 429. The wallet's address is printed by the script; fund it yourself with `solana airdrop 1 <address> --url devnet` or via https://faucet.solana.com (that page needs a captcha, which isn't something to script around), then re-run the setup script — it picks up the existing wallet and continues.
- Bybit Demo Trading needs an API key generated from *your* Bybit account (Demo Trading mode) — that's account access I don't have and shouldn't try to get. Put it in `.env` and run `npm run test:bybit-demo`.

Once either is unblocked, re-run the corresponding script and the real (not mocked) result replaces this note.

**Remaining after that:**
1. Wiring `RaydiumAdapter.placeOrder`/`getOrderStatus` for real stays out of scope — see Deviations for why devnet can't validate against the actual mainnet Raydium pools this bot tracks.
2. The kill switch's automatic triggers (FR-8.4 per-venue error rate, FR-8.5 elevated unwind rate) become meaningful once there's live execution and unwind history to compute rates from — M2's manual trigger and unwind tracking are the prerequisite state for this, still pending real trigger conditions.

Per your original instructions: stop after M3 and report status before
touching mainnet or real capital — nothing past devnet/testnet execution is
in scope without your explicit go-ahead in a later session.

## What you'll need to supply for later milestones

**M0/M1/M2 (now):** nothing. All three adapters hit public, unauthenticated APIs.

**M3 (devnet/testnet execution):**
- Nothing for the Solana side — `SOLANA_WALLET_PRIVATE_KEY` is generated and saved to `.env` automatically the first time you run an execution script. You only need to fund the printed address with devnet SOL (see above) if the automatic airdrop fails.
- `BYBIT_API_KEY` / `BYBIT_API_SECRET` — a **Demo Trading** key from your own Bybit account (account menu → Demo Trading → API), never a real trading key.
- MEXC has no sandbox/testnet at all (confirmed against their current docs) — there's no key to supply; it stays detect/paper-only.

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
  execution/    wallet.ts + atomicSwap.ts (FR-4.1/4.3, M3 devnet pipeline)
  capital/      empty — M4+ (real capital allocation, FR-6)
  monitoring/   structured JSON logger (FR-7), kill switch (FR-8), pnlTracker (FR-7.6, M1), unwindTracker (FR-7.5, M2)
  cli.ts        entrypoint, --mode and --stress-test flags
scripts/        M3 one-shot provisioning/test scripts (setup-devnet-pool, devnet-dex-test, bybit-demo-test) + mock-test-* (no external infra needed)
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

7. **(Superseded by M4 — the automatic triggers are now implemented; see "M4 safety layer".) Kill switch (FR-8) was scaffolded with only the manual trigger live**
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

13. **M3's DEX leg validates against the classic SPL Token-Swap program on
    devnet, not Raydium.** Confirmed by checking Raydium's own devnet
    program ID before building: it exists, but none of the pools this bot
    tracks (SOL/USDT, RAY/USDT) are deployed there — those only exist on
    mainnet. Building a real Raydium pool from scratch on devnet needs an
    OpenBook market as a prerequisite, a materially heavier task than
    validating the same atomic-tx/simulate/min-output-guard mechanics
    against a simpler, equally-real on-chain swap program. This was an
    explicit tradeoff you chose over building a real Raydium devnet pool —
    the atomic-transaction *pipeline* is proven either way; the specific
    program it's proven against is not Raydium's.

14. **M3's real (unmocked) execution scripts are written, typechecked, and
    logic-verified via mocks, but have not yet been run end-to-end against
    live devnet/Bybit** — blocked on external infra (a rate-limited public
    devnet faucet; a Bybit Demo Trading key that has to come from your own
    account), not a code gap. See "Path to M3" above for exactly what's
    proven vs. still pending, and what unblocks each.

15. **A real bug was caught and fixed while building the mock tests, not
    just a deviation — worth flagging.** Short-lived scripts calling
    `process.exit()` shortly after a log call could crash with "sonic boom
    is not ready yet": pino's default file destination writes
    asynchronously, and exiting before its first write completes races the
    stream. Fixed by making the destination synchronous
    (`monitoring/logger.ts`) — our log volume is far too low for the
    throughput cost to matter, and it removes the failure class everywhere,
    not just in the script that first exposed it.

## Non-negotiables carried forward

- `VenueAdapter.placeOrder`/`getOrderStatus`: real for `BybitAdapter`
  (Demo Trading, M3) and for the devnet Token-Swap pipeline
  (`execution/atomicSwap.ts`); still `NotImplementedError` for
  `RaydiumAdapter` and `MexcAdapter` (see Deviations #13/#14 for why, and
  the M3 status note for what unblocks Bybit's real run).
- The atomic-DEX execution model (FR-4.1/4.3: simulate-before-submit,
  on-chain minimum-output guard) is implemented and mock-verified in
  `execution/atomicSwap.ts`. The hedged-CEX-unwind model (FR-5.2–5.5) is
  implemented and stress-tested in paper mode (M2); wiring it to real
  execution instead of simulated fills is M4+ scope.
- No code path anywhere in this repo points at a mainnet trading endpoint
  or a mainnet Solana cluster — `execution/wallet.ts` hardcodes devnet,
  and `adapters/cex/bybit.ts`'s signed requests only ever target
  `api-demo.bybit.com`.
