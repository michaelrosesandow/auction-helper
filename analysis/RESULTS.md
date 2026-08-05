# 2026 Par Sheet — Final (Avant League, Superflex, 12-team, $200)

Cost model: **within-position ADP rank → this league's historical SF auction price**
(2021–2025, **recency-weighted** monotonic medians, `YEAR_WEIGHTS={21:1,22:1,23:2,24:3,25:4}`
— the room's valuations shifted QB↑/RB↓ since 2021, so the flat median lagged).
Ranks verified against FantasyPros 2026 consensus (Yahoo/Sleeper/RTSports agree).
Value: Ben Gretch projections, Avant scoring (4-pt pass TD, 0.5 PPR, −1 INT, no TE premium).

## Recommended par sheet (drops into `src/par-sheet.ts` DEFAULT_WEIGHTS)

| slot      | $       | intent                                    |
| --------- | ------- | ----------------------------------------- |
| QB1       | 24      | mid+ QB (Dak tier) — starts               |
| SF        | 19      | mid QB (Kyler tier) — starts              |
| RB1       | 5       | value RB (Montgomery) — RBs repriced DOWN |
| RB2       | 56      | **elite** (Gibbs/Bijan)                   |
| WR1       | 37      | top-8 (Amon-Ra tier)                      |
| WR2       | 6       | value (Waddle/McLaurin)                   |
| TE        | 18      | TE2–3 (Loveland)                          |
| FLEX      | 17      | mid RB (Hall)                             |
| K         | 1       | —                                         |
| DST       | 1       | —                                         |
| BN1       | 1       | RB handcuff                               |
| BN2       | 1       | RB handcuff                               |
| BN3       | 1       | RB depth                                  |
| BN4       | 7       | **backup QB** (Stroud/Shough) — insurance |
| BN5       | 6       | upside WR (Moore)                         |
| **total** | **200** |                                           |

**Every build rosters 3 QBs** (2 start in QB1+SF + 1 backup on the bench) per
the insurance rule: 2 QBs is too much bye/injury risk unless you pay for 2
elites (shown suboptimal on medians). The optimizer picks a **$7 value backup**
(Stroud/Shough tier).

Objective = starter pts + optionality-weighted bench (see CHECKPOINT.md
"Objective"). Under the recency-weighted curve OPTIMAL = **2058 starter + ~170
bench-value = 2229 obj**. The big shift vs the stale curve: **starting-QB spend
UP ($23→$43)** (mid-QBs repriced up, less of a steal) and **RB1 repriced DOWN
($59→$5)** — RBs are now the better values, so the elite RB (Gibbs) is paired
with cheap mid RBs (Montgomery $5, Hall $17) rather than two elites.

## Strategic conclusions

1. **Pay for one solid starting QB (~~$19–24), not two elites.** Recency repriced
   mid-QBs up (Baker $6→$13, Kyler $17→$19), so the "two $6 QBs" steal is gone;
   the optimum is Dak+Kyler (~~$43 total) — one QB1-tier + one mid. Two elites
   (Allen+Lamar $122) still scores ~125 fewer starter pts. _Median-only; elite
   ceilings undersold — see caveat._
2. **RBs are now the values** (repriced DOWN: Bijan $67→$59, Kyren $26→$21, Swift
   $10→$5). Take one elite RB (~$56, Gibbs) + fill RB2/FLEX with cheap mid values
   (Montgomery $5, Hall $17). Gibbs max-bid gap widened to **+$29** (strong BUY).
3. **WR2/FLEX: $6–17 mid-tier** — Waddle/McLaurin/Moore (~$6), Amon-Ra/Hall (~$17–37).
4. **TE: Loveland (~$18) or punt to $1–4.** Bowers ($32) remains the worst value.

## Value targets (projection-rank ≫ ADP-rank — verified consensus)

**QB mid-tier (still the edge, even repriced):** Kyler Murray (QB17/$19/328),
Jordan Love (QB18/$13/309), C.J. Stroud (QB23/$7/287), Sam Darnold (QB22/$7/278),
Baker Mayfield (QB20/$13/304).
**RB (the new edge — repriced down):** David Montgomery ($5/202), Breece Hall
($17/220), Chase Brown ($31/237), Bucky Irving ($10/195), Kyren Williams ($21/225).
**WR:** Jaylen Waddle, Terry McLaurin, DJ Moore, Davante Adams (~$6, 142–208 pts).

## Caveats

- **Elite-QB finding is median-only.** Allen/Lamar's value is week-winning ceilings
  a season-median undersells. If you weight ceiling, paying for one top-5 QB is
  defensible. Gretch is single-point, so this is a judgment call, not quantified.
- **1-QB ADP → SF room drift.** Cost is priced by rank against SF history (premium
  baked in), but your SF room may bid the QB12–24 tier _up_ vs their 1-QB ADP rank
  (more demand, 2 QBs start). The recency weights already capture the room's
  recent QB-premium behavior, but live 2026 bidding could overshoot it; treat the
  mid-QB $ as a floor still.
- **Recency weights are a judgment call.** `1,1,2,3,4` lands near 2024 behavior.
  If 2025 is more representative (or an outlier), re-tune `YEAR_WEIGHTS` in
  `build_2026.py` and re-run. 2024-25-only was rejected (n=2/rank, too noisy).
- **Re-validate ranks in August.** Spring ADP firms up. Re-paste updated FantasyPros
  ADP and re-run `build_2026.py` → `03_optimize.py`; nothing else changes.

## Reproduce

```
cd analysis
python3 build_2026.py      # cost (rank→SF price) + value → out/players.json
python3 03_optimize.py     # hill-climb optimizer → out/par_sheet.json
python3 05_max_bid.py      # per-target bid ceilings (RAW / REAL)
```
