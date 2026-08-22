# crypto-arb-bot

Multi-venue crypto arbitrage bot, built per `SRS_MultiExchange_Arbitrage_Bot_v2.md`
(v2 SRS). Currently at **M0**: live, read-only market data ingestion and
opportunity detection/logging. No wallet, no exchange API keys, no order
placement anywhere in this milestone.

## Status: M0 complete

- Venues: [Raydium](https://raydium.io) (Solana DEX) + [MEXC](https://www.mexc.com) (CEX)
- Assets: SOL/USDT, RAY/USDT (see `src/config/assets.ts` — adding an asset is a config edit, not a code change)
- Detects cross-venue price spreads, computes fee-adjusted net spread, logs every opportunity (profitable or not) as structured JSON
- No trading — this milestone only observes and logs

## Setup

```bash
npm install
cp .env.example .env   # optional — defaults work with no keys for M0
npm start               # M0 detection mode (default)
```

You'll see console lines only when a net-positive-or-notable spread appears,
and structured JSON for every scan cycle in `logs/events.jsonl` (gitignored).
To see all computed spreads including negative ones (useful for sanity-checking),
temporarily lower the threshold:

```bash
MIN_NET_SPREAD_BPS=-100000 npm start
```

Stop with `Ctrl+C`, or by creating a `KILL_SWITCH` file in the project root
(the manual-trigger kill switch, FR-8, polls for this file every scan cycle).

## Run modes

- `npm start` / `--mode=detect` — **M0, implemented.** Live detection + logging only.
- `--mode=paper` — **M1, not yet implemented.** Currently prints a message and exits. This is scaffolded as a first-class flag now so M1 slots in without changing the CLI surface.

## Path to M1 (paper trading)

M1 needs, on top of what exists:
1. A simulated fill engine: for MEXC, walk the order-book depth already being
   fetched (`bidDepth`/`askDepth` in `NormalizedQuote`) to estimate partial
   fills at a given order size, instead of assuming full fill at top-of-book.
2. For Raydium, model slippage against pool reserves/TVL instead of using
   the flat `impliedPrice` M0 uses.
3. A hypothetical P&L tracker that logs simulated trades the same way M0
   logs opportunities, and accumulates realized-vs-theoretical P&L (FR-7.6).
4. Wire `--mode=paper` in `src/cli.ts` to this engine instead of the
   detect-only loop.

None of this needs API keys — M1 still runs entirely against the same public
data feeds M0 uses.

## What you'll need to supply for later milestones

**M0 (now):** nothing. Both adapters hit public, unauthenticated APIs.

**M1 (paper trading):** nothing — simulation against live public data.

**M2 (second CEX + unwind stress-testing in paper mode):** nothing yet
either, unless the second CEX's public endpoints need registration (most
don't for market data).

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
    cex/        MexcAdapter
  ingestion/    polls adapters, tracks per-venue freshness (FR-1.5)
  engine/       opportunityDetector — cross-venue spread detection (FR-2)
  execution/    empty — M3+
  capital/      empty — M4+ (real capital allocation, FR-6)
  monitoring/   structured JSON logger (FR-7), kill switch (FR-8)
  cli.ts        entrypoint, --mode flag
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

## Non-negotiables carried forward (not yet exercised in M0)

These are honored in the type/interface design now so M2/M3 don't require
rework, even though M0 has no execution path to exercise them:

- `VenueAdapter.placeOrder`/`getOrderStatus` exist in the interface and
  throw `NotImplementedError` in both adapters — the shape is fixed, the
  implementation is deliberately deferred.
- The atomic-DEX and hedged-CEX-unwind execution models (FR-4.1/4.3,
  FR-5.2–5.5) aren't implemented yet; M2 is where the unwind procedure gets
  built and stress-tested in paper mode per your milestone plan.
