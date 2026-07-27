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

## League facts
- 12 teams, $200 each → $2,400 pool (confirmed from history totals).
- Roster = 15: QB, RB, RB, WR, WR, TE, FLEX, SF, K, DST + 5 bench.
- Superflex since 2019; 15-man since 2020. Curve fit uses 2020–2025.
