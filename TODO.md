# TODO — Fold Tiers into the Recommendation Engine

Status of the problem: the engine runs **median-only**. `Player` already has
`projFloor` / `projMedian` / `projCeiling` + `tier` / `target` / `fade`, but
`ceiling` is blank in `players.json`, and `optimize.ts` / `solver.ts` maximize
Σ`projMedian`. Gretch's tiers carry signal the median cannot (distribution
shape, price-sensitivity, structural cliffs). These tasks wire that signal in
**without corrupting the median** — the tiers become an overlay, not a
re-sort. See the design summary that produced this list (kept in chat /
CHECKPOINT context) for the full rationale.

## Design principles (read before touching any task)

1. **Don't merge tier rank into the median.** Gretch explicitly diverges from
   his own projections (Hampton = RB5 in tiers, "nowhere near RB5" in
   projections; Kyren "basically in a dead heat with Jaylen Warren" in
   projections but ADP far higher). The median is the base rate; tiers supply
   the shape + overlay around it.
2. **Keep the axes separate.** Realization (role/injury, CHECKPOINT item 6) ≠
   ceiling ≠ target/fade. Don't double-discount elite bellcows for injury
   (Gibbs/Bijan are the _stable_ tier, retention 0.80). The Barkley/Henry/Achane
   fades are about _receiving upside + efficiency regression_, a different axis.
3. **Role-weight the objective, not the base rate.** Keep `projMedian` as the
   displayed value; compute an internal blended pts for optimization only.
4. **Acquire vs drain.** `nominationSuggest` has two intents: ACQUIRE
   (`cold-market`) and DRAIN (`poison-pill`, `scare-nominate`). Fades are
   excluded from _acquire_ only — they're preferred for _drain_ (you won't be
   stuck with them if you win).

---

## T1 — Extend the data model + import for distribution shape & structural flags

**Files:** `src/types.ts`, `src/rankings.ts`, `data/rankings.example.csv`
**Depends on:** nothing (foundational; T2–T5 all build on this)
**Type:** code

`Player` / `Tier` mostly already have the fields. Add what's missing:

- **Sub-tier.** Gretch uses 1a/1b, 3a/3b mini-breaks to mark "near-equal
  clusters" — the human version of `optimize.ts`'s plateau view. Cheapest
  encoding: let `tier` carry a decimal (e.g. `3.1`, `3.2`) **or** add
  `subtier?: number` (1, 2…). Pick one and use it consistently.
- **Big Tier Break.** A cliff after which value falls off hard. Store as a
  flag on `Tier` (`bigBreakAfter?: boolean`) — "the tier _after_ which the
  cliff drops." RB example: after Gibbs (T1→T2), arguably after Taylor (T2→T3a).
- **Dead Zone.** The tier that _follows_ a Big Break — the worst place to pay
  for floor. Store as `deadZone?: boolean` on `Tier`. RB example: Tier 4a.
- **Floor/ceiling are already fields** — no type change, just a sourcing
  discipline (T2) and a note in the CSV schema that they're now _expected_,
  not optional filler.

Then extend `rankings.ts`:

- Add `subtier`, `bigbreak`/`big-break`, `deadzone`/`dead-zone` to the `Field`
  union + `ALIASES`.
- `Tier` grouping currently keys on `${pos}:${tier}` — decide how sub-tiers
  participate (probably keep tier grouping for cliff logic, carry subtier on
  the player for display/landscape only).
- Update `data/rankings.example.csv` as the living schema reference (add the
  new columns, even if blank for QB/WR/TE initially).

**Acceptance:** importing a CSV with `Subtier,BigBreak,DeadZone` columns
populates the fields; types compile; existing rankings tests still pass.

---

## T2 — Tier-assessment authoring (YAML) + assembly pipeline (greenfield)

**Files:** `data/tiers/{pos}.yml` (author), `analysis/rubric.py`,
`analysis/assemble.py`; retires `analysis/apply_overrides.py`.
**Depends on:** T1 (the `Player`/`Tier` fields + the assembled-CSV import).
**Type:** code + data

Greenfield the tier-data layer rather than extending `my_rankings.csv` +
`apply_overrides.py` (those conflate three different concerns and use a rank-gap
proxy for ceiling). Separate by **origin**, join once:

| Concern                                                                      | Origin                       | Artifact                                                  |
| ---------------------------------------------------------------------------- | ---------------------------- | --------------------------------------------------------- |
| Base data (median pts, cost, rank)                                           | stat xlsx + price curve      | `out/players.json` from `build_2026.py` (unchanged)       |
| Tier assessment (tier, subtier, profile, target, fade, big-break, dead-zone) | you reading Gretch's article | `data/tiers/{pos}.yml`                                    |
| Scenarios (what-if price levers)                                             | you stress-testing           | `analysis/scenarios.csv` (optional, applied at optimizer) |

One assembly joins base + tiers + rubric → **one canonical table** consumed by
_both_ the analysis optimizer and the extension. Kills the players.json-vs-
rankings-CSV drift seam.

### Authoring format — `data/tiers/{pos}.yml`

Per-position YAML (honors the `Player`/`Tier` type split: tier-level flags live
at the tier level, player-level attrs at the player level). This is the only
recurring human input — re-author it when a new article drops. RB example:

```yaml
# data/tiers/rb.yml
position: RB
source: "Ben Gretch RB Tiers, 2026-08-03"
tiers:
  - tier: 1
    big_break_after: true # cliff drops after this tier
    players:
      - {
          name: Jahmyr Gibbs,
          profile: compressed-elite,
          target: true,
          note: "floor is top-5 overall",
        }
  - tier: 2
    players:
      - { name: Bijan Robinson, profile: compressed-elite }
      - { name: Christian McCaffrey, profile: upside-swing, note: "injury is the only real risk" }
      - { name: Jonathan Taylor, profile: upside-swing }
  - tier: 3
    subtier: 1 # 3a
    players:
      - { name: Omarion Hampton, profile: upside-swing, note: "proj far below tier rank" }
      - { name: Chase Brown, profile: clean-symmetric }
  - tier: 4
    subtier: 1 # 4a = the Dead Zone
    dead_zone: true
    players:
      - { name: Bhayshul Tuten, profile: upside-swing }
      - { name: Saquon Barkley, profile: efficiency-fade, fade: true }
  - tier: 4
    subtier: 2 # 4b
    players:
      - { name: Jonathon Brooks, profile: boom-bust, note: "generational bet or huge mistake" }
```

`target`/`fade` are transcribed straight from the article's **bold**/italics —
no judgment call. `profile` is the one thing you derive from the prose (see
rubric). Sub-tiers (3a/3b) encode as `tier: 3, subtier: 1|2`.

### Profile rubric — `analysis/rubric.py`

Six categories, each `(floor_frac, ceil_frac)` as a multiple of median. This
dict is the **single calibration source** — retune here, re-run, all bands
update. Maps Gretch's own language:

| Profile            | floor×med | ceil×med | shape                                             | RB examples                                                             |
| ------------------ | --------- | -------- | ------------------------------------------------- | ----------------------------------------------------------------------- |
| `compressed-elite` | 0.92      | 1.18     | tight band, shifted up                            | Gibbs ("floor is top-5")                                                |
| `clean-symmetric`  | 0.88      | 1.12     | tight, balanced — median trustworthy              | Chase Brown ("straightforwardly projected really well")                 |
| `veteran-floor`    | 0.90      | 1.05     | high floor, low ceiling — "take the early points" | Dobbins, Rachaad White, Jordan Mason                                    |
| `efficiency-fade`  | 0.78      | 1.10     | fat left tail                                     | Barkley, Henry, Achane, Cook ("overly dependent on rushing efficiency") |
| `upside-swing`     | 0.85      | 1.35     | fat right tail — the reason to draft them         | Tuten, Walker, Hampton, Jeanty, Skattebo, Judkins, Henderson, Love      |
| `boom-bust`        | 0.65      | 1.50     | wide, bimodal — median itself low-confidence      | Brooks ("generational bet or huge mistake")                             |

Fractions are defensible starting points, not measured. Calibration path (do
once): reconstruct draft-time-median vs final-season points from the historical
ADP/projection data (2021–25) and measure the actual P10/P50/P90 spread by draft
tier; `attrition_study.py` already pulls nflverse data so the plumbing exists.

### Anchoring rule (prevents corruption)

- **Median = the stat projection** (`build_2026.py` `pts`). Tiers shape the
  band; they never move the median. This preserves the Hampton signal: stat
  median stays low, tagged `upside-swing`, engine sees low-median + high-ceiling
  (the divergence IS the signal — a fudged-high median would lose it).
- **Floor/ceiling are health-conditional.** Gretch's "Gibbs floor is top-5"
  means _assuming he plays._ Injury stays on the **realization** axis
  (CHECKPOINT item 6) — don't crush the floor for injury risk; that's
  double-discounting and contradicts the article (bellcow RBs are the _stable_
  tier, retention 0.80). The Barkley/Henry fades are efficiency/receiving-upside,
  a different axis.

### Assembly — `analysis/assemble.py`

Single join: `players.json` (median, cost, rank) + `data/tiers/*.yml` +
`rubric.py` → canonical `out/players.json` (all `Player` fields populated:
`floor`, `ceiling`, `tier`, `subtier`, `target`, `fade`, `big_break_after`,
`dead_zone`) + `out/players.csv` (the one artifact the extension imports via
`rankings.ts`). `floor = pts × floor_frac[profile]`, `ceiling = pts ×
ceil_frac[profile]`. Both the analysis optimizer and the live engine consume
the same table.

**Edge case:** a player with `pts=None` (not in the xlsx) can't get a
fractional band — leave floor/ceiling undefined (engine treats as median-only,
or fall back to a position/rank default median). These are bench fliers;
median-only is fine.

### Incoming structured tiers CSV (TBD, later this week)

A more structured tiers/rankings export is coming (CSV, possibly from a Google
Doc). When it lands, decide based on its schema: either (a) a small **seeder**
converts it into the YAML tier skeleton (tier/subtier/ordering/target/fade),
and you hand-add `profile` + `notes` from Gretch's prose; or (b) it joins as a
second assembly input alongside the YAML. The prose-derived `profile`/`note`
stays hand-authored either way. If the export refreshes often, make the seeder
**merge-aware** (preserve hand-authored profiles across re-seeds) or split
profiles into their own name-keyed file. Don't over-specify the join until the
schema is known.

### Retire `apply_overrides.py`

- The rank-gap `ceiling = "up"/"down"` heuristic → **deleted** (`profile`
  replaces it; expresses skew and width the rank gap can't).
- `my_price` → **`analysis/scenarios.csv`** (a what-if lever, applied at the
  optimizer, not baked into the canonical table).
- Its join logic folds into `assemble.py`.

### Validation / acceptance

- Spot-checks: Hampton `ceiling ≫ median`; Gibbs `floor ≈ median`;
  Barkley `floor < median`; Brooks band width (ceil−floor) ≫ Brown's.
- Aggregate: avg ceil/floor ratio per profile matches `rubric.py` (catches
  transcription drift).
- Sorting RBs by ceiling floats the upside-swing names (Tuten, Hampton, Walker)
  toward the top — if not, the rubric is too tight.
- `assemble.py` produces `out/players.json` + `out/players.csv`; parity diff vs
  the old `players.json` on overlapping fields (cost, median, rank) shows only
  intended changes.
- `data/tiers/rb.yml` covers all ranked RBs with profile + flags.

---

## T3 — Role-weighted blended projection in the optimizer

**Files:** `src/engine/optimize.ts` (`OptPlayer`), `src/engine/solver.ts`
(`SolverPlayer`)
**Depends on:** T1 (fields) + T2 (data) — partial value without data, full
value with it. This is CHECKPOINT open item #4 (ceiling-tilted variant), now
data-fed.
**Type:** code

Today both use `pts = projMedian`. Replace with a role-weighted blend computed
by the caller (keep the solver pure: it just takes `pts`). The role rules
(refined — bench QB is floor, not ceiling):

| Slot role                            | Weighting                                          | Why                                                                                                                                                       |
| ------------------------------------ | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core starters (QB1/SF, RB1, WR1, TE) | ceiling-tilt (`w_med·med + w_ceil·ceil`, w_ceil>0) | paying up; upside justifies the price                                                                                                                     |
| Bench skill (RB/WR/TE)               | ceiling-tilt **hard**                              | upside swings; "get similar bets later"                                                                                                                   |
| Bench QB (the 1 insurance backup)    | **floor-weighted**                                 | insurance = "usable if QB1 goes down" (a floor question); gold-strike ceiling is a bonus. Consistent with `BENCH_NEED` QB=0.15 + exactly-1-bench-QB rule. |

Also: apply a **Fade discount** to the blended pts (a Fade you're forced to
consider is worth less than its raw projection suggests) — but only on the
_acquire_ evaluation, never inflating a poison-pill target's drain value.

Keep `projMedian` as the displayed base rate; the blend is internal. This
_improves_ the `optimize.ts` landscape (`priceSwing`/`gapToBest`): two
same-median players with different ceilings (Dead-Zone fade vs Year-2 swing)
now separate.

**Acceptance:** given Hampton (low median, high ceiling) and a Dead-Zone
floor-back (high median, low ceiling) at equal cost, the ceiling-tilted
objective prefers Hampton for a bench/upside slot; the backup-QB slot
floor-weights. Existing solver tests updated to pass blended pts where they
currently pass medians.

---

## T4 — Fold target/fade into the value layer (acquire only)

**Files:** `src/engine/alerts.ts` (`valueAlert`, `nominationSuggest`)
**Depends on:** nothing strict (target/fade already exist) — can ship before T1.
**Type:** code

Target/fade are **price-sensitivity** signals, not point adjustments — the
article is explicit ("a Target even if the market is aggressive … be
price-sensitive"). So they modulate value-at-cost, never `projMedian`.

- **`valueAlert()`**: shift the per-player `threshold` (default 0.7) — a
  Target raises `valueCeiling` (accept a smaller `discount`, pay closer to
  fair value); a Fade lowers it (require a steeper discount before `isValue`
  fires). Concretely: `threshold_target = threshold + delta`, `threshold_fade
= threshold - delta`.
- **`nominationSuggest()` acquire path (`cold-market`)**: exclude Fades even
  if the position is a must-fill, _unless_ the live discount is deep (new
  `minFadeDiscount` option).
- **Drain paths (`poison-pill`, `scare-nominate`)**: leave Fades eligible —
  confirmed correct. A Fade you don't want is an _ideal_ poison-pill: you
  nominate it to drain a rival's money + roster slot, and you won't be stuck
  with a player you dislike if you win. (Today `poison-pill` already requires
  `!p.target`; it does not require `!p.fade` — keep it that way.)

**Acceptance:** a Target shows as a value buy at a smaller discount than a
neutral player; a Fade only flags as value at a steep discount; a Fade is still
suggestable as a poison-pill nomination.

---

## T5 — Big Tier Break + Dead Zone → cliff logic & (optional) optimizer penalty

**Files:** `src/engine/alerts.ts` (`tierCliff`), optionally
`src/engine/optimize.ts`
**Depends on:** T1 (the flags)
**Type:** code

Today `tierCliff()` only flags _in-draft_ scarcity ("this tier is down to its
last player"). Big Break / Dead Zone are **ex ante structural** facts about the
board — the cliff exists before anyone is drafted.

- Extend `tierCliff()` (or add a sibling `tierStructure()` view) to report:
  "the next tier is a Dead Zone — secure a starter now or punt the position."
  This is the article's single most actionable structural lesson.
- Surface it in the nomination logic: don't `scare-nominate` _into your own_
  Dead Zone (you'd be feeding rivals a cheap tier you want them to avoid).
- **Optional optimizer tie-in:** a soft penalty for starters drawn from a Dead
  Zone tier, or a premium for completing a position _before_ its Big Break.
  Gate behind a flag (off by default) until T3's role-weighting is validated —
  don't stack two behavior changes at once.

**Acceptance:** with RB loaded, the panel warns "RB Dead Zone next" when the
last Tier-3 player is sold; `tierCliff` still reports the within-tier scarcity
flag as before.

---

## Suggested order

1. **T1** (model + import) — unblocks everything.
2. **T2** (YAML authoring + `assemble.py` + `rubric.py`; retire
   `apply_overrides.py`) — unblocks T3/T5's data and gives the extension one
   canonical table; T4 can ship in parallel (target/fade already exist).
3. **T4** (target/fade → value layer) — independent, small, high signal.
4. **T5** (big-break/dead-zone → cliff logic) — independent of T3.
5. **T3** (role-weighted objective) — biggest change; do last once the data
   (T2) and the smaller wirings (T4/T5) have de-risked the behavior.
