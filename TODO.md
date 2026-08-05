# TODO — Validate the blended projection

The tiers work is shipped (archived at `todo_archive/TODO-tiers.md`). What
remains open is **validation**: T3's `blendPts` replaced the raw median as the
optimizer's `pts`, the _mechanism_ is unit-tested, but the _calibration_
(weights + `rubric.py` fractions) is unmeasured — "defensible starting
points." This is the validation plan, ordered cheapest → most definitive.

## DONE (this session): resolve the wiring gap (#3)

The optimizer is **starter-only by architecture** — the solver knapsack fills
the 6 skill STARTER slots (2RB+2WR+1TE+FLEX); bench is $1 leftovers and the
backup QB a flat allowance, neither optimized. So `bench-skill` / `bench-qb`
roles had no caller → dead code (knip would flag them).

- **Removed** the bench roles. `blendPts(p, opts?)` now does the single
  starter ceiling-tilt (`0.7·median + 0.3·ceiling`, fade-discounted). Callers
  - tests updated; knip clean.
- **Tradeoff acknowledged:** the Hampton-style "low-median / high-ceiling
  upside bet" is NOT surfaced by the blend at starter tilt — 0.3 can't
  overcome the median gap, so a Dead-Zone floor-back (high median) correctly
  outranks it for any starter slot. That signal currently lives only in the
  `target` flag → `nominationSuggest` cold-market path. Reintroducing bench
  valuation is a candidate follow-up (V4), gated on the empirical backtest.

## V1 — Mechanism guards (cheap; mostly done, close gaps)

- [x] symmetry (weights sum to 1.0), monotonic tilt, graceful degradation to
      median, fade discount. (The bench-role acceptance scenario is retired with
      the roles — see `todo_archive`.)
- [ ] **Double-discount guard:** a Fade with a low ceiling isn't discounted
      twice (the fade is multiplicative on the whole blend, not added on the
      ceiling term). Property test.
- [ ] **Anchoring / parity:** assert `projMedian` in `players.json` is
      byte-identical before/after T3 wiring — the "tiers never move the median"
      rule. Currently unenforced.

## V2 — Sensitivity / robustness (local, cheap)

- [ ] **Weight sweep:** re-run `optimizeRoster` across starter-tilt 0.2 → 0.4;
      measure how often the selected roster changes. If ±0.05 flips the
      recommended pair, the calibration is sharper than the data justifies —
      report a plateau, not an answer. Port `analysis/06_robustness.py`'s idea to
      the TS solver.
- [ ] **blendPts vs median A/B:** run the optimizer once with `pts = median`,
      once with `pts = blendPts(p)`, on the real RB+TE pool. Diff the selected
      rosters — if it barely moves, the blend isn't earning its complexity.

## V3 — Empirical calibration (the real one — the original "calibration path")

`analysis/attrition_study.py` already pulls nflverse 2021–25; the plumbing
exists. This is the only validation that addresses "are the _numbers_ right."

- [ ] **Backtest the rubric bands:** per profile, draft-time median (season
      projection) vs final-season actual points; measure realized P10/P50/P90.
      Compare to `rubric.py` fractions. If `upside-swing` realizes P90 ≈ 1.35×,
      the rubric is right; if it's 1.6×, retune in one place.
- [ ] **The divergence test (the tiers thesis):** do players with tier-rank ≫
      projection-rank realize more upside than their median alone predicts? If
      yes, ceiling-tilting is data-justified; if no, the median was already right
      and the blend adds noise.
- [ ] **Role-weighting (only if V4 is pursued):** did _bench_ slots filled
      with high-ceiling/low-floor players outperform high-floor players on
      hit-rate / league-winner basis? That's the claim behind any bench tilt >
      starter tilt. Without it, a split is a guess.

## V4 — Candidate follow-up (gated on V3)

- [ ] **Reintroduce bench valuation** by wiring `blendPts` into the
      value/nomination layer (`valueAlert` / `nominationSuggest` cold-market
      sizing), **not** the solver. That is the real home for the upside-bet signal
      the optimizer can't express (it has no bench slots). Only justified if V3's
      divergence / backtest tests pass.

## V5 — Live-draft sanity (final check, not primary validation)

- [ ] Watch a real draft: do cold-market picks + the QB-strategy re-solve
      surface the names Gretch calls out, or still float Dead-Zone floor-backs?
      One data point, not validation — do V3 first so the live test isn't
      confirming an unmeasured guess.
