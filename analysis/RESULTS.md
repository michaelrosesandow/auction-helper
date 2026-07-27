# 2026 Par Sheet — Final (Avant League, Superflex, 12-team, $200)

Cost model: **within-position ADP rank → this league's historical SF auction price**
(2021–2025, monotonic medians). Ranks verified against FantasyPros 2026 consensus
(Yahoo/Sleeper/RTSports agree). Value: Ben Gretch projections, Avant scoring
(4-pt pass TD, 0.5 PPR, −1 INT, no TE premium).

## Recommended par sheet (drops into `src/par-sheet.ts` DEFAULT_WEIGHTS)

| slot | $ | intent |
|---|---|---|
| QB1 | 17 | mid QB (Kyler/Stafford tier) |
| SF  | 11 | mid QB (Love/Mayfield tier) |
| RB1 | 59 | **elite** (Gibbs/Bijan) |
| RB2 | 17 | mid (Hall) |
| WR1 | 54 | **elite** (Puka/Chase) |
| WR2 | 6  | value (Waddle/McLaurin) |
| TE  | 18 | TE2–3 (Loveland/McBride) |
| FLEX| 10 | mid RB/WR |
| K   | 1  | — |
| DST | 1  | — |
| BN1–5 | 1 each | surplus to deploy |
| **total** | **200** | |

Optimizer converged at **2073 projected starter pts** (OPTIMAL = STARS&SCRUBS =
HERO-RB all land here — global optimum). Bench = $1 baseline per Davenport.

## Strategic conclusions

1. **Don't pay up for an elite QB.** Two mid-QBs (~$11–17 ea, QB15–20 tier) project
   within ~30 season-pts of Allen/Lamar for a third of the price. Elite dollars go to
   RB1 + WR1 instead. *Caveat: this is median-only; elite-QB weekly ceilings are
   undersold — see "ceiling" question below.*
2. **Spend elite $ on RB1 + WR1** (~$55–60 each). Only place elite pricing buys real
   point separation (Bijan 290 vs RB12 218; Puka 298 vs WR12 225).
3. **TE: TE2–3 (~$18–22) or punt to $1–4.** Bowers ($32) is the worst value at the
   position — Loveland/McBride project within 15 pts for half the cost.
4. **Fill RB2/WR2/FLEX with $6–17 mid-tier values** — where projection outranks ADP most.

## Value targets (projection-rank ≫ ADP-rank — verified consensus)

**QB mid-tier (the edge):** Kyler Murray (QB17/$17/328), Jordan Love (QB18/$11/309),
Baker Mayfield (QB20/$6/304), Sam Darnold (QB22/$6/278), C.J. Stroud (QB23/$6/287).
**WR:** Jaylen Waddle, Terry McLaurin, DJ Moore, Davante Adams (~$6, 142–208 pts).
**RB:** David Montgomery ($10/202), Jaylen Warren ($7/192).

## Caveats

- **Elite-QB finding is median-only.** Allen/Lamar's value is week-winning ceilings
  a season-median undersells. If you weight ceiling, paying for one top-5 QB is
  defensible. Gretch is single-point, so this is a judgment call, not quantified.
- **1-QB ADP → SF room drift.** Cost is priced by rank against SF history (premium
  baked in), but your SF room may bid the QB12–24 tier *up* vs their 1-QB ADP rank
  (more demand, 2 QBs start). So Stroud/Baker may go ~$10–12, not $6. Structural
  finding (mid-QBs = value) holds; specific $ are a floor.
- **Re-validate ranks in August.** Spring ADP firms up. Re-paste updated FantasyPros
  ADP and re-run `build_2026.py` → `03_optimize.py`; nothing else changes.

## Reproduce
```
cd analysis
python3 build_2026.py      # cost (rank→SF price) + value → out/players.json
python3 03_optimize.py     # hill-climb optimizer → out/par_sheet.json
```
