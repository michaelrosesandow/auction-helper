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

## League facts

- 12 teams, $200 each → $2,400 pool (confirmed from history totals).
- Roster = 15: QB, RB, RB, WR, WR, TE, FLEX, SF, K, DST + 5 bench.
- Superflex since 2019; 15-man since 2020. Curve fit uses 2020–2025.
