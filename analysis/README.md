# Auction strategy analysis (pre-draft)

Pre-draft modeling to DERIVE the optimal 2026 par sheet, separate from the
extension (which EXECUTES the plan live). Pure-stdlib Python — no deps, ships
nothing. Output par allocation is transcribed into `src/par-sheet.ts`
`DEFAULT_WEIGHTS`.

## Inputs (not committed)

- Price history: `~/Downloads/Avant League History - Data.csv`
- Projections (Ben Gretch 2026): `~/Downloads/Ben Gretch 2026 Projections (7_23).xlsx`

## Pipeline

1. `common.py` — loaders (xlsx + csv) + league-config + `points()` (compute
   fantasy points from raw stats for any scoring).
2. `01_dollar_curve.py` — fit price-by-rank curves per position on the 15-man
   Superflex era (2020–2025). Scoring-INDEPENDENT (cost half of the model).
3. `02_value.py` — VORP + dollars-per-value (needs league scoring).
4. `03_optimize.py` — maximize team value s.t. fill 15 slots / $200 → par sheet
   per roster archetype.

## Tier assessment (recurring input)

The one recurring human input — re-author when a new Gretch tiers article drops.
Per-position YAML in `data/tiers/{pos}.yml` carries tier/subtier/profile/target/
fade/big_break_after/dead_zone/note. `assemble.py` joins it onto
`out/players.json` (base median/cost/rank from `build_2026.py`) + `rubric.py`
(profile → floor/ceiling fractions) → the canonical table. The median is never
moved by tiers; profiles only shape the band.

- **`rubric.py`** — the 6 profile band shapes (single calibration source).
- **`assemble.py`** — base + tiers + rubric → `out/players.json` + `players.csv`.
- **`extract_targets.py`** — pulls bold=target / italics=fade off a saved
  article HTML (the convention is fixed across RB/TE/WR/QB). Two modes:

  ```bash
  # audit: print the tier → target/fade map
  python3 data/tiers/extract_targets.py "Article.html"

  # skeleton: emit a valid, assemble-able data/tiers/{pos}.yml with tiers,
  # subtiers, ordering, and target/fade pre-filled (profiles/notes/flags are
  # TODO). Position auto-detected from <title>; override with --position.
  python3 data/tiers/extract_targets.py "QB Article.html" --yaml > data/tiers/qb.yml
  ```

  Then hand-fill `profile` (map the prose to a `rubric.py` shape), optional
  `note`, and tier-level `big_break_after`/`dead_zone`, and run `python3
assemble.py`.

## Validation

- **`attrition_study.py`** — pulls nflverse `snap_counts` (2018–24); derives
  per-position ROLE-retention priors (the injury/role haircut on median pts).
- **`backtest_realization.py`** — V3: joins nflverse realized half-PPR
  (`player_stats_season_*`, 2021–24) to the league draft history, reconstructs
  the draft-time median as a leave-one-year-out rank-bin curve, and measures
  realized (actual/expected) percentiles vs `rubric.py` band fractions + a
  draft-bucket finish-rate divergence proxy. See `TODO.md` V3 for findings.
- **`backtest_role_weighting.py`** — V3 (V4 gate): the role-weighting test.
  Does a bench slot value the high-ceiling/low-floor profile MORE than a
  starter slot? Joins the league draft history → realized half-PPR → nflverse
  `players.csv.gz` (for `rookie_season` + `draft_round`), proxies the
  high-ceiling profile by two independent draft-time axes (experience + draft
  capital), and measures each cohort across a tail gradient (mean pts →
  `E[pts·1(top12)]` startable production → `E[pts·1(top6)]` league-winner).
  Position-aware verdict (see `TODO.md` V4): bench ceiling-tilt is
  evidence-backed at **QB** (robust, all 4 yrs) and **WR** (stable), but has
  **no stable signal at RB** (a 2023-artifact reversal), so the V4 bench layer
  must be position-aware. Run: `python3 analysis/backtest_role_weighting.py`.
- **`backtest_gretch_signal.py`** — V3 (V4 gate, follow-up): re-cuts the
  role-weighting test with Gretch's OWN draft-time signal (target/fade + tier
  rank) parsed from saved tier articles (`~/Downloads/gretch/{2021..2025}/`,
  instead of the age/draft-capital proxy. 2021 parsed via a custom parser (no
  target/fade markup — pre-convention); 2025 realized aggregated from the weekly
  CSV. Three tests: (1) target/fade role-weighting on the same bench pool as the
  proxy (targets >> none >> fades, uniform incl. RB — resolves the proxy's RB
  ambiguity); (1b) **target edge by slot** — bench-specific (overperforms in
  bench, underperforms at elite) → data-motivates the per-slot split; (2) level-
  controlled tier divergence re-cut against an **independent ADP market** (not
  this Gretch-influenced room): sleeper side confirmed & stronger under ADP
  (deep sleepers P50 1.28), but "market-higher-than-Gretch busts" does NOT
  survive ADP (P50 0.96 — retracted). Note: articles lack the rubric profile
  tags, so this is target/fade, not the literal profile test.
  Run: `python3 analysis/backtest_gretch_signal.py`.
- **`backtest_room_micromarket.py`** — league-specific exploit (a digression from
  the V4 gate): where does THIS 12-team room deviate from the consensus market
  (FantasyPros ADP, sourced from `~/Downloads/...Historical ADP - Fantasy Pros
(2).csv`), and do those deviations win or lose? Finds one stable, 5-year error:
  the **lone-wolf reach** (room drafts a guy earlier than BOTH consensus ADP and
  Gretch) underperforms its slot (P50 ~0.85, holds 2021–2025), while room reaches
  that Gretch _endorses_ win (~1.05, and skew young — converges with the
  role-weighting youth finding). The marker is "room > market AND room > Gretch,"
  not veteran/position-specific. Re-runs each August against the new season.
  Run: `python3 analysis/backtest_room_micromarket.py`.

## League facts

- 12 teams, $200 each → $2,400 pool (confirmed from history totals).
- Roster = 15: QB, RB, RB, WR, WR, TE, FLEX, SF, K, DST + 5 bench.
- Superflex since 2019; 15-man since 2020. Curve fit uses 2020–2025.
