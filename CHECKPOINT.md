# Checkpoint — Yahoo Auction Helper

**Last updated:** 2026-07-27 (session: TS knapsack solver port + latency validation; live-draft engine committed)

> **Git state:** live-draft engine = `c2f2838`; TS solver port + benchmark = `01ff413`.
> Working tree clean; `tsc` / `oxlint` / `knip` / 116 tests / `build` all green.
**Purpose:** Let a fresh session resume this work without rediscovering the
Yahoo draft-room DOM, the probe architecture, or the par-sheet modeling
pipeline. Read this, then `PLAN.md` (scope) and `AGENTS.md` (conventions).

There are **two workstreams**:
1. **Live-draft extension** (`src/`) — the Chrome MV3 helper. Status below.
2. **Pre-draft strategy analysis** (`analysis/`) — derive the optimal 2026
   par sheet from league price history + ADP + projections. Status in its own
   section near the bottom: **"Pre-draft strategy analysis (`analysis/`)**".

---

## TL;DR

The **DOM probe** is built, robust, and proven against a real live Yahoo
auction draft. The **live-state scraper** (`src/scraper.ts`) is built with
unit-tested parsing logic and is wired into the content script. Everything is
green (`tsc`, `oxlint`, `knip`, 116 tests, `build`).

**Next big step:** the **engine mapping** (`ScrapedDraftRoom` → `DraftState`, in
`src/engine/`), the **engine alerts** (`opponentNeeds`, `endgameLeverage`,
`valueAlert`, `tierCliff`, `nominationSuggest`), the **poll loop** (resident
content-script `setInterval` → `toDraftState` → diff → `DRAFT_STATE_KEY`),
the **Live tab** rendering all of it (value flag, tier cliffs, endgame-leverage
banner, per-team budget/max-bid/must-fill, **nomination prep**), and **Par
Sheet auto-fill** from the live sold feed are built and unit-tested. What
remains: the live **"my turn" DOM detector** (needs one mock-draft capture to
wire `nominationSuggest` to actually fire on your turn) and
`chrome.notifications` push delivery.

**Separately,** the 2026 par sheet is derived in `analysis/` (rank-based SF
cost model + hill-climb optimizer), and the exact 0/1-knapsack solver
(`opt_skill`) has been **ported to TypeScript** and validated for live use.
**Decision: run the re-solve in the content script — no local server** (a full
per-tick re-solve is ~0.9 ms, ~0.04% of the 2 s poll). **Next big step:** lift
the solver into `src/engine/` as `optCompletion` (exclude sold, lock filled
slots, re-budget) so the par sheet becomes *live* and `nominationSuggest` /
`valueAlert` ceilings become roster-grounded — this supersedes the old
"transcribe into `DEFAULT_WEIGHTS`" plan. Details: "Live re-solve" under the
`analysis/` section.

---

## Run / verify

```bash
npm install
npm run check   # tsc --noEmit
npm run lint    # oxlint
npm run knip    # dead code / deps
npm test        # vitest (116 tests)
npm run build   # esbuild -> dist/  (load unpacked from dist/)
npm run watch   # rebuild on save
```

Load unpacked from **`dist/`**. Rankings are runtime data (side panel import).

---

## Pre-draft strategy analysis (`analysis/`)

Pure-stdlib **Python** (no deps, ships nothing) that derives the optimal 2026
par sheet, **plus a TypeScript port of the exact knapsack solver** for live
in-draft re-optimization (see "Live re-solve" below). See `analysis/RESULTS.md`
for the final writeup. The user's old price-prediction model (Google Apps
Script OLS) is **broken and intentionally not used** — see "Rejected
approaches" below.

### Live re-solve — TS solver port (`analysis/ts-solver/`)

The Python `opt_skill` (exact 0/1 knapsack over RB/WR/TE starter slots) is
**ported to TS** as `solver.ts` (`posFrontier` / `buildFronts` / `optSkill`),
with O(1) back-pointer reconstruction. Validated bit-identical to the Python
reference (same projected pts + rosters at budgets 165/140/120).

**Decision — run it live in the content script, no local server.** A full
per-tick re-solve (rebuild frontiers excluding sold + solve, 425-player pool)
measures **~0.9 ms in Node** — ~9× faster than Python and ~0.04% of the 2 s
poll interval (a ~2,300:1 margin). A local server would add a failure mode and
break the zero-dep / load-unpacked property for zero latency gain.

`bench.ts` is the timing harness (run via esbuild — see its header). The whole
dir is **intentionally excluded** from the project's tsc/oxlint/knip toolchain
(`.eslintignore` + `tsconfig.json` exclude + `knip.jsonc` ignore) — it's a
standalone artifact until wired into `src/engine/`. When ported in, re-tool the
`!` non-null assertions (the solver uses them; project oxlint forbids
`no-non-null-assertion`).

### League config (Avant)

- 12 teams, **$200** each → $2,400 pool (confirmed from history totals).
- Roster = **15**: QB, RB, RB, WR, WR, TE, FLEX, SF, K, DST + 5 bench. (+1 IR
  spot, situational — not modeled.) **Superflex since 2019; 15-man since 2020**
  (2019 was a 16-man one-off). `types.ts` is correct (15); "16" in AGENTS.md is
  a typo.
- **Scoring** (baked into `common.py` `LeagueConfig`): **4-pt pass TD, 0.5 PPR,
  −1 INT**, pass yds 1/25, rush/rec yds 1/10, rush/rec TD 6, **no TE premium**.

### Inputs (all in `~/Downloads`, NOT committed)

| File | What |
| --- | --- |
| `Avant League History - Data.csv` | This league's prices 2015–2025 (SF since '19). Cols padded with spaces — `.strip()` every field. |
| `Avant League History - Historical ADP - Fantasy Pros (2).csv` | FantasyPros ADP + this league's SF `Auction Paid`, 2021–2025. **2026 rows have Position Rank but blank ADP/$** (rank-only). |
| `FantasyPros_2026_Overall_ADP_Rankings.csv` | **Real 2026 ADP** (1-QB!). Cols `Rank,Player (Bye),POS,Yahoo,Sleeper,RTSports,AVG,Real-Time`. 327 players. |
| `Ben Gretch 2026 Projections (7_23).xlsx` | 2026 projections. 4 sheets QB/RB/WR/TE (raw stats, single-point). Parsed as zip-of-XML (no openpyxl). |

### Pipeline (`cd analysis && python3 <file>`)

- `common.py` — loaders (`load_prices`, `load_projections`, xlsx parsed as
  zip-of-XML), `LeagueConfig` (Avant scoring), `points(pos, stats...)`. **Has a
  `~/Downloads` path + a name-normalizer** (`norm()` strips suffixes/.
  apostrophes) reused by the cost builders.
- `01_dollar_curve.py` — first cost model (price-by-position-rank, 2020–25 SF).
  → `out/dollar_curve.json`. Earlier exploration; superseded for 2026 by
  `build_2026.py`.
- `02_value.py` — VORP + fair$ (over-engineered; fair$ MAE $17, diverges from
  market for mid-QBs). Has a hook to read `out/prices_2026.csv` (user-supplied
  per-player prices) — **not currently used** (build_2026 owns cost now).
- `05_adp_cost.py` — ADP-*value*-based cost (price ~ FantasyPros AVG ADP).
  **Too choppy** (sparse buckets → Dak $1 / Mahomes $21 nonsense). Kept for
  reference; **rank-based (build_2026) is the live cost model.**
- **`build_2026.py` — THE cost pipeline.** Within-position **ADP rank** → this
  league's SF price (2021–25 monotonic medians); matches projections by
  normalized name; writes **`out/players.json`** (`name,pos,rank,cost,pts`).
  Re-run this if inputs change.
- **`03_optimize.py` — hill-climbing optimizer.** 1-opt (all slots) + 2-opt
  rebudget (starter pairs, **incremental** eval) + basin-hopping. Maximizes
  **starter points** (bench weight 0 — Davenport $1-baseline). Outputs
  `out/par_sheet.json` + prints optimal + 4 archetypes. **~35–40 s runtime.**
- **`04_qb_strategies.py` — QB roster-construction comparison.** For each QB
  plan it FIXES the QBs, then solves EXACTLY (0/1 knapsack DP) for the best 6
  non-QB starters within the leftover budget. **Every build carries 3 QBs**
  (2 start + 1 cheap bench insurance) — the realistic SF constraint. NB: the
  skill optimum is a pure function of budget (QBs never compete with RB/WR/TE
  slots), so it's solved once as a knapsack. An earlier hill-climb version was
  ~30 pts suboptimal (stuck on tier cliffs); the exact solver is authoritative.
  → `out/qb_strategies.json`. Median optimum = Kyler+Love+Baker = 2094 pts.
- `generate_review_html.py` — → `review.html` (now **two tabs**: Price Review =
  predicted $ + each player's actual history + ⚠ flags; **QB Strategies** = the
  roster-construction comparison with a summary table, bar chart, and
  collapsible full rosters). Reads `players.json` + `qb_strategies.json`.
- `RESULTS.md` — final writeup (par sheet, strategy, caveats).

### Key methodology decisions (don't re-litigate without reason)

- **Cost basis = within-position ADP rank → historical SF price** (monotonic
  medians). Rejected alternatives: projection-rank (misprices Tua/Stroud/
  Rodgers — famous players whose projection dipped), ADP-value (sparse/choppy),
  the user's OLS price model (collinear features → predictions rise with rank).
- **1-QB ADP → SF league gap is handled** by pricing the rank against this
  league's SF history (premium baked in). Only the within-position *order* is
  taken from ADP; the absolute QB position shift doesn't matter.
- **Objective = maximize STARTER points, bench = $1** (BENCH_W=0). An earlier
  BENCH_W=0.25 made the optimizer stuff the bench with QBs (raw-points
  distortion — a 5th QB never plays). Verified global optimum: OPTIMAL =
  STARS&SCRUBS = HERO-RB all converge to **2073 starter pts**.
- **Verified ranks:** the 2026 ADP-only ranks in the historical file exactly
  match the real FantasyPros 2026 ADP ordering (Stroud really is ~QB23 across
  Yahoo/Sleeper/RTSports). So cheap-mid-QB values are real consensus, not noise.

### Final par sheet (see RESULTS.md)

QB1 $17, SF $11, RB1 $59, RB2 $17, WR1 $54, WR2 $6, TE $18, FLEX $10, K $1,
DST $1, BN1–5 $1 each (=$199, round to $200). Strategy: **don't pay up for an
elite QB** (two mid-QBs ~$11–17 project within ~30 pts of Allen/Lamar for 1/3
the price); spend elite $ on **RB1 + WR1** (~$55–60 each); **TE** target TE2–3
(~$18–22) or punt to $1–4 (Bowers $32 is worst value); fill RB2/WR2/FLEX with
$6–17 mid-tier values; bench = $1.

### Caveats a fresh session MUST carry

- **Predicted $ is a rank-median with wide spread (~±$5–10).** Individual
  players deviate a lot — e.g. **Baker Mayfield pred $6 (QB20) but was $33 in
  2025 as QB7** (rank dropped). `review.html` surfaces these via the History
  column + ⚠ flag. **This league bids names above their rank** — the model is a
  baseline, not a per-player forecast.
- **Elite-QB finding is median-only.** Gretch is single-point (no ceiling).
  Allen/Lamar's week-winning ceilings are undersold; if you weight ceiling,
  paying for one top-5 QB is defensible. **Ceiling-tilted variant not yet built.**
- **1-QB ADP:** your SF room may bid the QB12–24 tier *up* vs 1-QB ADP rank (2
  QBs start). Treat $6 mid-QB figures as a floor (~$10–12 live).
- **Re-validate in August** — spring ADP firms up. Re-paste updated FantasyPros
  ADP and re-run `build_2026.py` → `03_optimize.py`; nothing else changes.

### Attrition, realization & max-bid (2026-07-27)

Three additions to the analysis pipeline (all in `analysis/`). The **realization
priors** and the **max-bid mechanic** are the parts the TS real-time optimizer
should port; the lessons change how to read the par sheet.

**1. Attrition study — `analysis/attrition_study.py`** (reproducible; re-fetches
nflverse `snap_counts` 2018–2024 into `_nfl/`). Derives a per-position
*realization* haircut on median projections = fraction of the season an expected
starter (top-N on own team by Wk 1–3 snaps) actually keeps a starter role.
- **Availability (games played) is flat ~84% across skill positions** — RBs are
  NOT uniquely injury-prone at this cohort; the "RBs get hurt most" folk wisdom
  doesn't hold here.
- **Role retention is tier-driven:** within each position the locked-in
  (high-snap-share) tier is MORE stable, the mid/committee tier is volatile.
  RB: bellcow 80% / shared-WH 76% / committee 71% / depth 60%. WR1 77% /
  WR2-3 63%. TE1 73% / TE2+ 53%. QB1 76%.
- **Two axes — don't conflate.** Role-security (snap share, what this measures)
  ≠ elite/talent/ceiling. Gibbs and Montgomery both grade workhorse; Gibbs is
  elite, Montgomery isn't. Realization adjusts role security; ceiling is a
  SEPARATE input (`ceiling` column / a ceiling-weighted objective).
- **Base-rate reality check:** for a 4-stud core, P(≥1 misses ≥4g)≈74%, P(≥2)≈33%,
  P(≥3)≈7% (~one team/league/year). 2025's 3-of-4 (Rootin Tutens) was unlucky,
  not a black swan. **Lesson: concentration requires survivable depth — size the
  bench for the 74% case, not the 24% "zero injuries" case.**

Recommended realization priors (rank-proxy for tier), multiply median pts by:
```
QB 0.76 (rk≤16) / 0.50      RB 0.80(rk≤6) / 0.76(rk≤16) / 0.71(rk≤30) / 0.60
WR 0.77 (rk≤12) / 0.63      TE 0.73 (rk≤6) / 0.53
```

**2. Max-bid calculator — `analysis/05_max_bid.py`.** For each target, the
highest price where the optimal roster STILL includes him vs the best roster
that excludes him (the pivot); above it, pivot. Two columns:
- **RAW** = median points only. **REAL** = median × realization. Same fast 1-opt
  climb; relative comparison is what's sound. Read `gap = REAL − market`: + room
  to spend, − even at market the pivot wins. It's a CEILING, not a target.
  Example (BENCH_W=0.25, realization on): Gibbs mkt $59 → ceiling ~$65.
- **BUG fixed this session:** the anchored target must be looked up IN the
  supplied pool so its pts match the pool's realization — otherwise an unrealized
  target in a realized pool is credited full median and inflates the bid ~$20.
  **The TS port must do the same** (anchor value consistent with the objective's
  player values).
- **Known limitation:** anchors the target in its PRIMARY slot (RB1/WR1…).
  Reliable for elites you'd pay up for; under-values mid-tier (a WR15 forced into
  WR1). Fix = try all eligible slots, take best.

**3. Lessons that change the par sheet / objective** (carried forward):
- **`BENCH_W=0` was forcing stars-and-scrubs** into existence (bench had no
  opportunity cost → model punted 5 slots to $1). `05_max_bid.py` now defaults
  `BENCH_W=0.25`. The TS objective must value bench (realization + positive
  bench weight) or it reproduces this artifact.
- **SF QB underpricing CONFIRMED** (the RESULTS caveat, now measured): Mayfield
  $6/304 (50 ppd!), Murray $17/328, Stafford $18/327 — the cost model prices
  QB13–24 like backups when 24 QBs start in 12-team SF. Optimizer stacks two
  cheap elite QBs and spends the phantom savings overpaying RBs. **Fix lives in
  `build_2026.py`'s cost curve**, not the optimizer. Until fixed, max-bid /
  inflation outputs run optimistic.
- **Elite bellcow RBs are the STABLE tier, not the fragile one** (role 80%).
  Don't add an extra injury discount to a Gibbs/Bijan — pay-up is safe on
  attrition grounds; the ceiling is what justifies the price.

### Open / next steps ➡️

1. **User is reviewing `review.html`.** Likely wants either an editable
   "adjusted price" column in the HTML, or will hand back a list of repriced
   players to feed the optimizer. (The `out/prices_2026.csv` hook in
   `02_value.py` expects `name,position,predicted_price` if used, but the live
   path is `build_2026.py` → `players.json` — wire overrides there.)
2. **~~Wire the par sheet into `DEFAULT_WEIGHTS`~~ → SUPERSEDED.** The static
   transcription is replaced by a *live* re-solve: port `optCompletion` into
   `src/engine/` (content-script poll loop) → live par sheet + roster-grounded
   `nominationSuggest` / `valueAlert` ceiling. The TS solver foundation is done
   & validated; the wiring is the next step. *(Issue 1: pivot /
   regenerate-optimal-roster-on-the-fly when you miss a target.)*
3. **Ceiling-tilted variant** — force one top-5 QB, re-optimize, quantify the
   starter-pts cost; produces a Plan B par sheet. Offered, not done.
4. Generate the `prices_2026.csv`-style market-value feed the live **value-alerts**
   engine (`src/engine/alerts.ts` `valueAlert`) will consume in-draft.
5. **Port realization + max-bid into the TS real-time solver.** Apply the
   realization priors above as a haircut on projected pts in the objective; add
   a max-bid calc per nominated target ("bid on this guy now" / ceiling + gap vs
   live inflation-adjusted market). Keep the anchor-value-consistent-with-pool
   rule (see bug note) or bids will be inflated. *(The solver foundation landed
   this session — `analysis/ts-solver/solver.ts`; this item = layering
   realization priors + a max-bid calc on top of it.)*
6. **Fix the SF QB cost curve in `build_2026.py`** — reprice QB13–24 to SF
   starter demand (24 QBs start). This is the highest-leverage input fix;
   unblocks trustworthy max-bid/inflation numbers.
7. **Fix mid-tier anchoring in `05_max_bid.py`** — try all eligible starter
   slots for the target, take the best, so value flags on WR2/RB2 types are
   reliable, not just elites.
8. **Team-stack constraint (issue 2).** `players.json` has no NFL `team` field
   but `common.py load_projections()` already reads it — thread `team` through
   `build_2026.py`, then add a **starters-only max-2-per-team** constraint to
   the optimizer (hard cap or soft penalty). Lower priority; quantify the
   starter-pts cost. (Bench teammates are harmless insurance — constrain
   starters only. Adjacent but distinct: a same-bye-week starter collision
   check would need bye data too.)

---

## Architecture (current)

Three Chrome contexts; pure engine layer pending.

| File                      | Role                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/probe.ts`            | **`captureDomProbe()`** — ONE self-contained function (constants inline, helpers nested) so it serializes cleanly via `chrome.scripting.executeScript({ func })`. Produces `{ meta, skeleton, textMap, html }`.                                                                                                                                                 |
| `src/content.ts`          | Resident in the draft tab: `Alt+Shift+P` + `?probe=1` probe triggers, **and the poll loop** — a `setInterval` that scrapes → `toDraftState` (rankings-aware) → `stateSignature` diff → writes `DRAFT_STATE_KEY`. Rankings auto-refresh on league/import changes.                                                                                                |
| `src/sidepanel.ts`        | UI: Par Sheet / Rankings / **Live** / Probe tabs. **Live tab = the alert surface**: freshness/stale badge, endgame-leverage banner, phase/inflation, current nomination (value flag), tier cliffs, and a per-team grid with budget / max-bid / must-fill (boxed-in highlight). Probe tab = Capture now (via `executeScript`, no CS dependency) + download/copy. |
| `src/messages.ts`         | Shared types: `DOM_PROBE_KEY`, `DRAFT_STATE_KEY`, `DRAFT_ROOM_KEY`, `DomProbe`, `ProbeMeta`, `TextEntry`, `ProbeResponse`.                                                                                                                                                                                                                                      |
| `src/scraper.ts`          | **Live-state scraper.** Pure parsers (tested) + DOM scrapers → `scrapeDraftRoom(root)`. Exports `ScrapedDraftRoom`/`ScrapedNomination` for the engine.                                                                                                                                                                                                          |
| `src/engine/match.ts`     | **Name resolver** — `createNameResolver(players)` maps Yahoo's abbreviated names ("J. Hurts", DST nicknames) → `Player`, narrowing by position. Pure, tested.                                                                                                                                                                                                   |
| `src/engine/map-state.ts` | **Scrape → DraftState mapper** — `toDraftState(room, {players})` reconciles teams/rosters, winner→teamId, nomination, `inferPhase`, `computeInflation`. Pure, tested.                                                                                                                                                                                           |
| `src/engine/alerts.ts`    | **Engine alerts** — `maxBidOf`, `teamNeeds`/`opponentNeeds` (max-bid + forced must-fill), `endgameLeverage` ("money off the board"), `valueAlert` (<X% of inflation-adjusted value), `tierCliff` (last of a tier), `nominationSuggest` (poison-pill / cold-market snipe / scare-nominate). Pure, tested.                                                        |
| `src/engine/poll.ts`      | **Poll-loop pure helpers** — `POLL_INTERVAL_MS`, `STALE_AFTER_MS`, `PollPayload`, `stateSignature` (material-change diff), `isStale`. The chrome/DOM glue is in `src/content.ts`. Pure, tested.                                                                                                                                                                 |
| `src/par-sheet.ts`        | Drew Davenport par-sheet math (done, tested) + **`reconcileParSheet`** (live auto-fill: assign unplaced wins to their best empty eligible slot; add-only/idempotent so manual edits survive).                                                                                                                                                                   |
| `src/rankings.ts`         | CSV import (done, tested).                                                                                                                                                                                                                                                                                                                                      |
| `src/storage.ts`          | Per-league persistence in `chrome.storage.local`.                                                                                                                                                                                                                                                                                                               |
| `src/types.ts`            | Domain models: `Player`, `Tier`, `ParSheet`, `TeamState`, `Nomination`, `DraftState`, etc.                                                                                                                                                                                                                                                                      |

### Probe triggers (capture the DOM)

1. **Side panel "Capture now"** → `chrome.scripting.executeScript({ func: captureDomProbe })`. **Robust** — works with no content script present (this fixed the "Receiving end does not exist" failure).
2. **`Alt+Shift+P`** in the draft tab → content script (requires the tab to have the CS injected; reload tab if stale).
3. **`?probe=1`** URL → content script, waits for SPA render first.

### Storage keys (`chrome.storage.local`)

- `domProbe` (`DOM_PROBE_KEY`) — raw probe `{ meta, skeleton, textMap, html }`
- `draftState` (`DRAFT_STATE_KEY`) — **poll-loop output**: `{ state: DraftState, room: ScrapedDraftRoom, at }` (`PollPayload`), written every tick the state materially changes. Read by the Live tab.
- `draftRoom` (`DRAFT_ROOM_KEY`) — raw `ScrapedDraftRoom` from the one-shot probe triggers (parity/debugging)
- `rankings:<league>`, `parSheet:<league>`, `leagues`, `currentLeague`

---

## Yahoo draft-room DOM — the hard-won knowledge

**Reality:** Yahoo DraftClient uses **Atomic CSS** — class tokens are layout
utilities (`D(f)`, `Bdrs(16px)`, `W(100%)`, …) or CSS-module hashes
(`_ys_17bhdbw`). **Both are unstable and meaningless** — never use them as
selectors. The probe's skeleton **strips** them; the scraper **ignores** them
and leans on the few stable hooks below. The app also nests ~13 wrapper divs
before any content, so the skeleton depth cap is 40.

### Stable selector map (validated against live captures)

| Target              | Selector / signal                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status: timer**   | `MM:SS` span — the `previousElementSibling` of the `"N nominations until your turn"` span. Absent between nominations (scraper returns `null`).                                                                                                                                                                                                                                     |
| **Status: turn**    | span text `/nominations? until your turn/i`                                                                                                                                                                                                                                                                                                                                         |
| **"Last:" sold**    | sibling spans: `Last:` · `"Name (Pos · NFL)"` · winner team                                                                                                                                                                                                                                                                                                                         |
| **Teams (×12)**     | `div.ys-team[data-id]` → name `.ys-team > div:nth-of-type(1) > span`; budget `div:nth-of-type(2) > span:nth-of-type(1)` (`"$N"`); fill `div:nth-of-type(2) > span:nth-of-type(2)` (`"N/15"`). **isMe** = name `"You"`. **maxBid** = `budget − (rosterSize − filled − 1)`. ⚠️ stray direct-child `.ys-team > span` (`$1`/`$9`) exist — NOT budgets; the nested selector avoids them. |
| **Player card**     | `.ys-player` — name = first span **not** inside an `<abbr>`; `<abbr>` texts carry pos / nfl / bye / proj.                                                                                                                                                                                                                                                                           |
| **Nomination card** | Only when an `Offer $N` button exists (text `/^Offer \$\d+$/`). Panel = nearest ancestor of that button containing a `.ys-player`. **current bid** = bare `"$N"` span in panel (Proj/Max/Budget/Offer are prefixed); its `nextElementSibling` = leading team. Your max = `"Max Offer $N"`; budget = `"Budget $N"`; `"Over your budget"` status.                                     |
| **Results table**   | the `<table>` whose thead has `Pick` + `Cost`. Cols: `Pick \| Player(.ys-player) \| Cost("$N") \| Team`. Winner shown as team name; **`"Your Team"` = me**. Rows grouped by `Round N` header rows.                                                                                                                                                                                  |
| **Player pool**     | `div.ys-player[data-id="<yahooid>"]`                                                                                                                                                                                                                                                                                                                                                |
| **Tabs**            | `#players #board #results #standings`, `button[data-id="queue"                                                                                                                                                                                                                                                                                                                      | "picks"]`       |
| **Sort filter**     | `#auction-draft-order-filter` (opts `budget`/`maxBid`/`avgPlayerCost`)                                                                                                                                                                                                                                                                                                              |
| **Bid input**       | `input[type=text][maxlength=4]` value `"$N"`                                                                                                                                                                                                                                                                                                                                        |
| **Stable ids**      | `#app`, `#render-target-default`, `#main-0-DraftClientBootstrap-Proxy`, `#ys-error-modal`                                                                                                                                                                                                                                                                                           |
| **Icons**           | `[data-icon="add-default"                                                                                                                                                                                                                                                                                                                                                           | "close-default" | "refresh" | …]` |

---

## Scraper (`src/scraper.ts`)

**Public API:** `scrapeDraftRoom(root: ParentNode): ScrapedDraftRoom` →
`{ status, teams, nomination, sold }`. Internal: `scrapeStatus/Teams/Nomination/Results`.

**Pure parsers (unit-tested in `src/__tests__/scraper.test.ts`):**
`parseMoney`, `parseFill`, `parseTimer`, `computeMaxBid`, `parsePlayerMeta`,
`isPosition`. Tests use **real captured values** (e.g.
`computeMaxBid(12,6,15)===4` matches Yahoo's own "Max Offer $4").

The DOM-query glue is **thin and content-anchored** (anchor on the `Offer`
button / `.ys-player` / Results thead, not brittle nth-of-type paths).

---

## Done ✅

- Hardened probe: self-contained `captureDomProbe`; side-panel `executeScript`
  capture (no CS dependency); content-script shortcut + `?probe=1`.
- Probe tab UI: Capture now / Download .json / Copy skeleton / status grid /
  live `storage.onChanged` refresh.
- `src/scraper.ts`: parsers + `scrapeDraftRoom`, wired into content.ts shortcut.
- **Engine mapping** (`src/engine/`): `createNameResolver` (abbreviated/DST
  name → `Player`) + `toDraftState` (winner→teamId, roster rebuild,
  `inferPhase`, `computeInflation`). Pure + unit-tested (25 new tests).
- **Opponent-state alerts** (`src/engine/alerts.ts`): `maxBidOf`,
  `teamNeeds`/`opponentNeeds` (per-rival max-bid + positions they're forced
  to draft), `endgameLeverage` ("money off the board" — targets only I can
  afford). Pure + unit-tested.
- **Value & tier alerts** (`src/engine/alerts.ts`): `valueAlert()` (flags a
  live nomination going for <X% of inflation-adjusted market value, default
  70%, with an actionable `valueCeiling` "bid up to" and a signed `discount`)
  and `tierCliff()` (per position, the top remaining tier + a scarcity-premium
  flag when it's down to its last player). Pure + unit-tested.
- **Poll loop** (`src/content.ts` + `src/engine/poll.ts`): a resident
  content-script `setInterval` scrapes every 2s → `toDraftState` (rankings-
  aware, auto-refreshes on league/import changes) → `stateSignature` diff →
  writes `DRAFT_STATE_KEY` only on material change. `stateSignature`/`isStale`
  pure + tested. Side-panel **Live** tab renders the feed (freshness,
  phase/inflation, current nomination with value flag, per-team budget/max-bid).
- **Live alert UI** (`src/sidepanel.ts`): the Live tab now surfaces the whole
  engine — endgame-leverage banner ("you set the price" / "you're capped"),
  tier cliffs (per-position top remaining tier, last-of-a-tier flagged), and a
  per-team grid with max-bid + must-fill positions (boxed-in teams flagged).
  UI glue (not unit-tested, per project convention); pure logic is tested.
- **Par Sheet auto-fill** (`src/par-sheet.ts` `reconcileParSheet` + wired in
  `src/sidepanel.ts`): each player I win is auto-placed into their best empty
  eligible slot (starter-first, premium picks claim starter slots), with the
  price paid — so the Par Sheet's balance/variance stays live with zero manual
  entry. Add-only & idempotent (manual placements and par edits survive).
  Pure + unit-tested (8 tests).
- **Nomination strategy** (`src/engine/alerts.ts` `nominationSuggest` + a Live-
  tab **Nomination prep** preview): three pure strategies over
  `(DraftState, rankings)` — poison-pill (drain a rival forced to fill a
  position), cold-market snipe (your target when no rival is forced there &
  you can afford it), scare-nominate (the last of a thin tier rivals need) —
  each with a plain-English reason. Assumes it's your turn; the Live tab shows
  it as prep between nominations until the "my turn" detector lands. Pure +
  unit-tested (16 tests).
- Par Sheet + Rankings (pre-existing) remain intact.

## Next ➡️ (priority order)

1. **Engine alert functions** (pure, the actual "edge") — over
   `(ParSheet, Rankings, DraftState)`. **All done & tested:** `opponentNeeds()`,
   `endgameLeverage()`, `valueAlert()`, `tierCliff()`, `nominationSuggest()`
   (`src/engine/alerts.ts`). `nominationSuggest` assumes it's your turn; wiring
   it to actually fire on your turn needs the **"my turn" DOM detector** below.
2. **Poll loop** — **done.** Resident content-script `setInterval` (every 2s)
   → `toDraftState` → `stateSignature` diff → emits `DRAFT_STATE_KEY`. Live
   tab renders it. Names → ids via `createNameResolver`; rankings auto-refresh.
3. **Alert UI** — **done (panel).** The Live tab renders value (nomination
   flag), nomination prep, tier cliffs, endgame leverage, and per-team
   max-bid/must-fill; the Par Sheet auto-fills from the live sold feed. Still
   open: only `chrome.notifications` for push delivery when the panel isn't
   focused.
4. **Live roster re-solve (issue 1 — the pivot engine).** Port
   `analysis/ts-solver/solver.ts` into `src/engine/` as
   `optCompletion({exclude: sold, filled: locked slots + spent, budget})`, run
   it in the content-script poll loop after `toDraftState`, and augment
   `DraftState` with `{optimalRoster, topTargets, valueCeilings}`. This makes
   the par sheet *live* (reactive pivot when you miss a target) and grounds
   `nominationSuggest` / `valueAlert`'s ceiling in true opportunity cost
   (proactive — "bid up to $B; at $B+1 the reallocation elsewhere beats it").
   Foundation done & validated (~0.9 ms/tick, no server); this item is the
   wiring. Re-tool the `!` assertions for oxlint when porting in.
5. **"My turn" detector** — capture the draft room on your turn to nominate
   (no `Offer` button in that state) to learn the turn signal, then flip a
   `phase: "MY_NOMINATION"`/flag in the mapper so `nominationSuggest` fires
   for real. **This is the one capture the user needs to do.**
6. **Harden tests** — add `jsdom` dev-dep + a trimmed fixture (from a
   capture) to unit-test the DOM glue end-to-end through `scrapeDraftRoom` →
   `toDraftState` (and the poll tick).

## Known gaps / risks ⚠️

- **DOM glue validated by inspection, not unit-tested** (no `jsdom` yet). Pure
  logic is tested.
- **Unobserved state: your turn to nominate.** No `Offer` button then →
  `scrapeNomination` returns `null`; the turn text (`/nominations? until your
turn/i`) likely changes but is unverified. **One mock-draft capture on your
  turn** fixes this and unblocks the `nominationSuggest` "my turn" detector.
  Also still unobserved: the sold-transition instant and end-of-draft.
- **Timer** absent in some captures (mock was "Coin Toss - H2H" w/ autodraft);
  a live human league may differ. Scraper handles `null`.
- **isMe** relies on display labels (`"You"` / `"Your Team"`); prefer mapping
  via the team list's `data-id` for robustness.
- Some selectors remain nth-of-type-heavy; stable anchors are preferred but
  re-verify if Yahoo ships a redesign.

---

## Captured fixtures (ephemeral — in `~/Downloads`)

| File                                | State captured                                                                         |
| ----------------------------------- | -------------------------------------------------------------------------------------- |
| `yahoo-domprobe-1784913570586.json` | Players tab, early (no timer/results)                                                  |
| `yahoo-domprobe-1784914851612.json` | Players tab, active nomination (D. Adams), full teams                                  |
| `yahoo-domprobe-1784915101223.json` | **Results tab** — timer `00:18`, full sold table, "Last: J. Hurts". **Most complete.** |

**Recommend:** save a trimmed copy of the Results snapshot into
`src/__tests__/fixtures/` for future jsdom-backed scraper tests.

## How to re-capture (for any agent/user)

Load unpacked from `dist/` → reload extension → reopen side panel → open Yahoo
draft tab → **Probe tab → Capture now** (or `Alt+Shift+P`) → **Download .json**.
Capture during **active bidding** for the nomination card + timer; click the
**Results** tab first for the sold feed.
