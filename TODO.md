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
- [x] **Double-discount guard:** a Fade with a low ceiling isn't discounted
      twice (the fade is multiplicative on the whole blend, not added on the
      ceiling term). Property test — `optimize.test.ts`: the discount ratio is
      asserted constant (= fadeDiscount) across a band-shape sweep incl. a
      low/compressed ceiling and a degenerate ceil < median; concrete low-
      ceiling Fade pinned to `blend·0.9` and bounded against both buggy forms.
- [x] **Anchoring / parity:** assert `projMedian` is byte-identical before/after
      T3 wiring — the "tiers never move the median" rule. Enforced at the
      importer (`rankings.test.ts`): (1) `projMedian` is byte-identical to the
      raw median cell, decimals preserved; (2) the property form — identical
      median, maximally different tier/subtier/flag/band context (BigBreak vs
      DeadZone vs unflagged, full vs compressed vs median-only band, across
      positions) yields identical `projMedian`, with sanity checks proving the
      tier assembly actually ran (so the assertion is non-vacuous).

## V2 — Sensitivity / robustness (local, cheap)

- [x] **Weight sweep:** re-run `optimizeRoster` across starter-tilt 0.2 → 0.4;
      measure how often the selected roster changes. Harness:
      `analysis/ts-solver/tilt-sweep.ts` (run via the esbuild one-liner in its
      header) blends the real `players.json` via `blendPts({ ceilingTilt })`
      and re-solves at both backup-QB regimes ($7 / $13). **Finding:** the tilt
      is **stable in the comfortable regime** ($7 backup → Dak+Jones leads at
      every tilt 0.20–0.40, margin 8–11 pts, zero skill-roster churn) but hits a
      **knife-edge in the flat/pricy-backup regime** ($13 backup → a ±0.05 step
      at 0.25→0.30 flips Dak+Jones ↔ Kyler+Jones, with leader margin ≈0–1.4 pts
      across the whole sweep). So 0.30 does NOT manufacture a fake winner — it
      surfaces a genuine near-tie (the two pairs are within projection noise).
      Verdict: the right read is the optimizer's existing top-N landscape
      (present the plateau, not one name); no recalibration is forced by V2.
      The call on the 0.30 number itself is deferred to V3 (empirical backtest).
      `ceilingTilt` is now an exposed `blendPts` option (default 0.3) so the
      sweep measures the real code path; contract locked in `optimize.test.ts`.
      Ports `analysis/06_robustness.py`'s perturb-and-measure idea to the TS
      solver (tilt perturbation instead of leave-one-out).
- [x] **blendPts vs median A/B:** run the optimizer once with `pts = median`,
      once with `pts = blendPts(p)`, on the real pool. Harness:
      `analysis/ts-solver/blend-vs-median.ts` (esbuild one-liner in its header).
      **Finding: the blend IS earning its complexity — it moves the
      recommendation substantially, not barely.** At $7 backup it flips the QB
      leader (Kyler+Purdy → Dak+Jones) and makes 1 skill swap that is the
      thesis in miniature: drops David Montgomery (RB $5, veteran-floor,
      ceil212) for Breece Hall (RB $17, upside-swing, ceil297) — a strictly
      higher-ceiling RB the median-only optimizer under-valued. At $13 backup
      it makes 4 swaps, consistently toward upside profiles (Puka Nacua /
      Tyler Warren clean-symmetric → McCaffrey / Loveland compressed-elite /
      Hall). ceiling-total rises +85 ($7) to +222 ($13) pts; median-total does
      NOT fall (it rises slightly, though partly confounded by the QB-pair flip
      changing the free budget). Verdict: the blend reshapes the roster toward
      ceiling without sacrificing floor — the opposite of "barely moves."
      (Caveat: the QB-pair changes alter free budget, so the skill-roster diff
      isn't perfectly controlled — but the direction is uniformly upside, and
      the V3 backtest is where the band fractions themselves get validated.)

## V3 — Empirical calibration (the real one — the original "calibration path")

`analysis/attrition_study.py` already pulls nflverse 2021–25; the plumbing
exists. This is the only validation that addresses "are the _numbers_ right."

- [x] **Backtest the rubric bands (population-level):** harness
      `analysis/backtest_realization.py` joins nflverse realized half-PPR
      (2021–24, `player_stats_season_*`) to the league draft history and
      measures realized (actual_pts / expected) percentiles vs the rubric
      fractions. **Data substitution (explicit):** historical Gretch projections + profile tags don't exist (only 2026), so the draft-time median is
      reconstructed as the leave-one-year-out rank-bin median (P50≈1.0 — the
      expected curve is unbiased, so the floor/ceiling percentiles are
      comparable). **Finding — CEILING:** realized P90 is 1.6–1.9× across every
      position/salary cohort (RB 1.90, QB 1.67, WR/TE 1.57; robust 1.86–1.94 on
      leave-one-year-out), which EXCEEDS the rubric's steepest ceiling
      (boom-bust 1.50, upside-swing 1.35). Per V3's own rule ('if P90 ≈ 1.6×,
      retune'), the rubric ceilings are **conservative — ceiling-tilt is
      empirically justified, if anything understated.** **Finding — FLOOR:**
      realized P10 (0.34–0.75) sits below rubric floors, but this is an
      **attrition artifact** (P10 includes catastrophic-injury zeros), not a
      rubric miss: the rubric floor is a 'healthy down' shape and
      `attrition_study.py` owns the injury haircut separately — the two are not
      comparable.
- [x] **The divergence test (tiers thesis — proxy):** the literal tier-rank-vs-
      projection-rank test needs the 2026 season or a historical projections
      dataset (no historical scout tiers exist). The harness measures the
      bucket-fair foundational claim: **finish rate by draft bucket.** Finding:
      the fat right tail lives almost entirely in the cheap/late pool —
      **7% of rank13+ picks finish top-6 at their position** vs 39% of rank≤6
      (and 32% of rank7-12); the elite's median is already its expectation
      (no fat right tail), while the late pool carries all the league-winner
      upside. This is the structural justification for ceiling-tilting upside
      bets in the depth pool and NOT floor-tilting elites — and supports
      assigning the upside-swing/boom-bust profiles to depth, compressed-elite
      to the top.
- [x] **Role-weighting (the V4 gate):** did bench slots filled with
      high-ceiling/low-floor players outperform high-floor players on hit-rate /
      league-winner basis? Harness: `analysis/backtest_role_weighting.py`. Joins
      league draft → realized half-PPR → nflverse `players.csv.gz` for the two
      draft-time ceiling axes (experience + draft capital); measures each cohort
      across a tail gradient (mean pts → `E[pts·1(top12)]` startable production
      → `E[pts·1(top6)]` league-winner), with a position-level leave-one-year-
      out carrying the stability burden. **Finding — POSITION-DEPENDENT:** the
      V4 claim holds for **QB** (young backup-QBs startable ~32% vs vet ~25%; Δhit
      +17…+49 in all 4 years — robust) and **WR** (young WRs top-12 ~15% vs vet
      ~9%; Δhit > 0 all 4 years, weak in 2024 — stable), but has **NO stable
      signal at RB** — the pooled veteran-favorable reversal (Δhit −4.8) is a
      2023 artifact: one weak rookie RB class swings it from +11 (2021) to −33
      (2023) to ~0 (2024). RB bench outcomes are dominated by that year's
      rookie-class quality, which is unknowable at draft. So the **$5
      Henderson-over-Montgomery lotto-RB thesis is NOT validated** by realized
      RB outcomes. Verdict: the V4 bench/depth layer must be **position-aware**
      — ceiling-weighted at QB & WR depth (evidence-backed), median/floor at RB
      depth. Gate **passed for 2 of 3** skill positions. Open: the literal
      profile-specific test (upside-swing vs veteran-floor _tags_, not the
      age/draft-capital proxy) still needs a historical projections source or
      the 2026 season.

      **FOLLOW-UP — Gretch's OWN signal (target/fade + tier-rank), 2022–2024
          articles:** harness `analysis/backtest_gretch_signal.py`. The articles
          carry tiers + target/fade + rank order, NOT the rubric profiles — so this
          tests Gretch's *opinion* (a better draft-time signal than the age proxy),
          not the literal profile tags. **Three findings, the first two upgrade the
          verdict:**
            1. **Target/fade is a strong, UNIFORM bench signal** (league bench pool,
               matches the proxy's): targets >> non-targets >> fades across QB
               (Δhit +41.5), WR (+12.5), **and RB (+10.3)**. This RESOLVES the RB
               ambiguity — the proxy's "RB is noise" was because age/draft-capital
               is the wrong RB signal; Gretch's specific calls ARE predictive (RB
               target lw 27.7 vs none 9.0). His FADES reliably bust everywhere
               (top12% 11 vs 18).
            2. **The target edge is BENCH-SPECIFIC** — targets overperform in the
               bench (+12.4) but UNDERPERFORM at elite/starter (−29.7); QB +41.5 vs
               −73.7, WR +12.5 vs −24.1, TE +57.2 vs −11.4. (RB is the exception:
               good at both.) *Same signal, opposite value by slot* = the per-slot
               split is DATA-MOTIVATED, and adds a starter-side rule: **don't chase
               Gretch's targets at elite QB/WR/TE** (consensus elites are right;
               his contrarian elite calls lose).
            3. **Tier divergence (level-controlled, ratio) — re-cut against an
               INDEPENDENT market:** the first pass used this league's Position Rank
               (purchase order) as "the market" — but the room is Gretch-influenced,
               so that's not independent. Re-run with within-position **ADP rank**
               (consensus; populated 2021–2024). Result splits: the **sleeper side is
               CONFIRMED and stronger under ADP** — deep sleepers (market ≥+15 cheaper
               than Gretch) beat expectation **P50 1.28 / P90 2.15** (vs the room's
               0.93); mild sleepers P50 1.03. BUT **"market-higher-than-Gretch busts"
               does NOT survive ADP**: room P50 was 0.86 (looked like a bust), ADP P50
               is 0.96 (a wash). The earlier "market-higher busts (P50 0.79/0.84)"
               claim was a room artifact and is **RETRACTED** — when the broad market
               ranks a guy above Gretch, Gretch is not reliably right to fade him.
               Net: Gretch has a genuine asymmetric edge finding sleepers the market
               misses; his fades-vs-market are not predictive. (Raw top12% is level-
               confounded; the ratio is the valid cut.) Closes the V3 "divergence test
               needs historical scout tiers" open item. NOTE: 2021 parsed via a custom
               parser (no target/fade markup — pre-convention; tier lists are
               `<span>`+`<br/>`, single-player tiers are `<p>Name</p>`, QB+TE split
               at the body `<h2>Tight Ends</h2>`) — adds gretchr/tier for depth +
               divergence; target/fade cohorts stay 2022–2025.
          Caveats: 5 years (2021–2025; 2021 parsed via the custom parser above; 2025
          realized aggregated from the weekly CSV to a season-schema
          `_nfl/player_stats_season_2025.csv.gz`, REG+POST to match the loaders).
          The bench target-edge DIRECTION is robust (positive in 4 of 5 LOO drops;
          bench-specificity holds for QB/WR/TE across every year) but the MAGNITUDE
          is noisy (2024 is a down year). Still target/fade, not literal profiles.
          Net: the gate is passed at **all 3 skill positions**, the per-slot split
          has its strongest motivation yet (bench-specificity), and the divergence
          thesis clears at both mild AND deep sleeper levels (under the independent
          ADP market).

          **DONE (next-session) — unified the ADP source, and it RETRACTS the deep-
          sleeper edge.** `backtest_gretch_signal.py`'s `divergence_test_adp` was
          sourcing consensus ADP from the league-history CSV (`ADP` column, blank for
          2025); pointed it at the FantasyPros file instead —
          `~/Downloads/Avant League History - Historical ADP - Fantasy Pros (2).csv`
          (column `Avg`), exactly as `backtest_room_micromarket.py` already did.
          Clean fix: ONE shared `load_adp_posrank` now lives in `backtest_gretch_
          signal.py` and `join_all` calls it; `backtest_room_micromarket.py` dropped
          its duplicate + the redundant override. 2025 now contributes (214 new
          records w/ adp_posrank+realized; the ADP table is a full 5-year window).
          **Consequence — finding #3's headline does NOT survive the source fix.**
          The earlier "deep sleepers beat expectation P50 1.28 (n=11)" was computed
          under the league-history ADP, which is NOT the broad consensus market. A
          3-way re-cut on the ratio axis:
            - OLD league-history ADP, 2021-2024:   deep n=11 P50 1.28 / P90 2.15
            - NEW FantasyPros ADP,   2021-2024:   deep n= 1 P50 0.41          <- source effect alone
            - NEW FantasyPros ADP,   2021-2025:   deep n=12 P50 0.58 / P90 1.45
          The league-history `ADP` column and FantasyPros DISAGREE on who is a deep
          sleeper (11 vs 1 in the same window) — the league-history column is this
          league's own (Gretch-influenced) ranking, not consensus, so it manufactured
          11 "sleepers the market missed" that the real market didn't miss. Under the
          corrected independent source, **Gretch's deep-sleeper edge is NOT supported**
          (small-n, P50<1). What SURVIVES the source switch (stable, large-n):
          mild sleepers ~1.0 (1.03→0.99→1.04), consensus ~1.0 (1.00→1.01→1.03),
          market-higher ~0.9 (0.96→0.92→0.88, slight bust — stable, not the "wash"
          the old source implied). So the divergence thesis holds at the MILD-sleeper
          level (roughly fair value, not a beat) but the "asymmetric edge finding
          sleepers the market misses" claim is RETRACTED. Unaffected: TEST 1
          (target/fade) and the room-micromarket harness (both were already
          FantasyPros-sourced / ADP-independent).

## V4 — Candidate follow-up (green-lit by V3 + the $5 Montgomery analysis)

The conversation converged on a **per-slot value split** (value is player × slot,
not a single scalar), driven by the format (8 skill starters, 5 shallow bench,
$200) and a concrete failure found in the data:

- **The $5 proof.** At predicted $5, current `blendPts` ranks David Montgomery
  (veteran-floor, med 202 / ceil 212) **above** TreVeyon Henderson (upside-swing,
  med 181 / ceil 245): 205 vs 200. The review HTML is worse — median-only, so
  Montgomery tops Proj Pts (202) and Pts/$ at $5. No tilt reproduces the right
  call (need tilt > ~0.45 to flip Henderson over Montgomery, and V2 showed that
  breaks the starter solver's QB knife-edge). **Conclusion: the Dead Zone +
  ceiling signal is load-bearing — it cannot be replaced by tuning the blend.**
  The cheap stopgap shipped: review HTML now has sortable **Proj Ceil** / **Ceil/$**
  columns, so the depth call (Henderson/Tuten/Warren > Montgomery by Ceil/$) is
  visible with one click. V4 swaps that raw-ceiling column for a real value fn.

- **Starter layer — keep median-dominant, add the attrition haircut.** Starter
  value ≈ `median × attrition_retention` (from `attrition_study.py`, e.g. RB
  bellcow 0.80 vs depth 0.60 — retention is higher for elites, so this
  systematically favors buying the Gibbs tier, which is the strategy) plus a
  SMALL ceiling term whose job is **Dead Zone defense** (penalize capped
  ceilings), NOT upside-chasing. Do NOT crank the starter tilt — it pulls toward
  lotto RBs (Hampton/Jeanty) and hits the V2 knife-edge. The median is the right
  starter anchor; ceiling is a small, non-optional defensive weight.

- **Bench/depth layer — new, ceiling-weighted value function** wired into
  `valueAlert` / `nominationSuggest` (cold-market sizing) and the review HTML,
  NOT the solver (it has no bench slots). This is the real home for the
  upside-bet signal the starter objective can't express.

- **Promote `dead_zone` from display to a real penalty.** Currently its ONLY
  compute use is excluding a player from scare-nominate (`alerts.ts:540`, a
  drain tactic). It does NOT touch acquire (`coldMarket`), value (`blendPts`),
  `valueAlert` thresholds, or the review HTML. For the acquire/value path it is
  decorative. V4 makes it a value penalty.

- **The within-tier rule (the core of the bench fn).** `dead_zone` is tier-level
  (the whole $5 RB neighborhood is flagged), so it can't discriminate Henderson
  from Montgomery _within_ the tier by itself. The bench fn combines it with the
  ceiling signal as a rule: **in a Dead Zone tier, the capped-ceiling fragile-
  floor veteran (Montgomery: no starter-breaking median, no bench-lotto ceiling,
  floor that can fall out) is a dominated roster asset — prefer the ceiling-bet
  at the same cost, which at least has the breakout escape hatch.** "Less about
  the $$, more about how you spend the roster slot."

  **DONE (V4 skeleton built — per-slot value split shipped):**
  - `benchValue(p, isDeadZone, opts?)` in `optimize.ts`: ceiling-weighted
    bench-acquire score, position-aware (QB/WR/TE .7 tilt, RB median-only),
    dead-zone penalty (capped-ceiling players ×.85 in dead zones), fade
    discount. 8 tests.
  - `starterRetention(pos, positionRank)` + retention priors from
    `attrition_study.py` (RB .8 bellcow → .6 depth, QB .76→.50, WR .77→.63,
    TE .73→.53). Applied in `optPoolFromRankings` so the starter solver
    favors the Gibbs tier. 2 tests.
  - Review HTML: "Bench/$" column (benchValue / marketValue), "Bench $"
    sort mode. Table header added in `sidepanel.html`.
  - Dead-zone as value penalty: `valueAlert` gets `deadZoneDelta` (lowers
    threshold .1 for dead-zone players, `isDeadZone` field on result).
    `nominationSuggest` coldMarket sorts by benchValue (not raw marketValue),
    so dead-zone floor-backs sink below upside bets. `coldMarketDeadZone-
    Penalty` option (default .85).
  - `liveNominationHtml` passes tiers to `valueAlert`, shows dead-zone note.
  - All 175 tests pass; tsc/knip/lint clean.

Open before a full build: ~~the role-weighting test~~ (DONE — see V3 third
bullet; verdict: bench ceiling-tilt is position-aware — build the QB/WR bench
layer, NOT the RB one). ~~Still open: profile-specific realized bands~~ — those
need a historical-projections source (see V3 next-session action above for the
ADP part). The skeleton is built — the bench fn, dead-zone penalty, and starter
attrition haircut are wired.

## V5 — Live-draft sanity (final check, not primary validation)

- [ ] Watch a real draft: do cold-market picks + the QB-strategy re-solve
      surface the names Gretch calls out, or still float Dead-Zone floor-backs?
      One data point, not validation — do V3 first so the live test isn't
      confirming an unmeasured guess.
