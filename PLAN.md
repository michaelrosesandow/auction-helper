# Yahoo Auction Helper — Plan

A Chrome MV3 extension that gives a real-time edge in Yahoo fantasy football
**Superflex auction drafts** (12-team). Roster:
`QB, RB, RB, WR, WR, TE, Flex, Superflex, K, DST` + 5 bench.

## Scope

### In (core)

1. **Par Sheet (financial core)** — Drew Davenport par-per-slot budgeting.
   Pre-allocate budget across roster slots; track per-slot variance and the
   running balance (remaining$ − par for unfilled slots). Surplus deploys,
   deficit trims. Drives a live "what can I still afford?" view.
2. **Value alerts** — flag a player going for < X% of _inflation-adjusted_
   market value (threshold configurable, default 70%).
3. **Tier / cliff tracking** — fed by loaded rankings+tiers; show players
   remaining in the top remaining tier per position; warn on the last player
   of a tier (scarcity premium).
4. **Opponent max-bid & position-of-need** — per rival team: max bid
   (`budget − (openSpots − 1)`) and highlighted positions they still must fill.
5. **Endgame leverage** — "money off the board": detect when you are the only
   team who can still afford a top remaining target (you set the price), and
   the inverse (you're capped, a rival isn't).
6. **Nomination strategy** — when it's your turn to nominate, suggest:
   poison-pill (drain rivals), cold-market snipe (your target while room is
   spent), or scare-nominate from a thin tier.

### In (supporting / data)

- **Rankings loader** — import players with tiers, targets/fades, and a
  projection _distribution_ (floor / median / ceiling) so ceiling info is
  preserved for value & tier logic (addresses the "marginal points ignores
  ceiling" concern).
- **Live inflation engine** — recompute market values from the
  money-remaining : value-remaining ratio so the 70% threshold stays meaningful
  as the draft evolves.
- Bonus monitors: positional depletion rate, opponent punt detection,
  ADP/time drift, "$1 fallers" endgame map.

### Out (decided)

- ~~Roster-fill / "$1 trap" guard~~ — dropped.
- ~~Marginal projected points per dollar~~ — dropped for now (ceiling problem).
  Reconsider later; the projection distribution is captured now so it's easy
  to reintroduce with a ceiling-weighted value metric.

## Architecture (3 layers)

```
PRE-DRAFT DATA (loaded)          LIVE STATE (scraped)         ENGINE (alerts/views)
─────────────────────            ──────────────────           ─────────────────────
ParSheet                         DraftState                    valueAlert()
Rankings (Player[], Tier[])      Nomination                    tierCliff()
(projection distribution,        teams: budgets/rosters        opponentNeeds()
 marketValue, target/fade)       inflation                    endgameLeverage()
                                                              nominationSuggest()
                                                              parSheet.balance
```

- **Pre-draft data** lives in `chrome.storage` (set via the side panel) so it
  survives reloads and can be tweaked mid-draft.
- **Live state** is scraped from the Yahoo draft DOM by the content script,
  diffed each tick, and emitted to the engine + a panel UI.
- **Engine** is pure functions over `(ParSheet, Rankings, DraftState)` — easy
  to unit test offline with a recorded draft.

## Data models

See `src/types.ts`. Key types: `Player`, `Tier`, `ParSlot`/`ParSheet`,
`TeamState`, `Nomination`, `DraftState`.

Par Sheet math (derived, not stored):

- `spent        = Σ actual`
- `remaining$   = totalBudget − spent`
- `parRemaining = Σ par (unfilled slots)`
- `balance      = remaining$ − parRemaining` → + surplus, − deficit
- `slotVariance = par − actual` (per filled slot)

## Decisions (resolved)

1. **Build tooling:** TypeScript + esbuild (per the `sow` skill: `tsc` +
   `oxlint` + `oxfmt` + `knip` + `prek`). npm. Load unpacked from `dist/`.
2. **Budget total:** $200 in both leagues. Hardcoded as the Par Sheet default.
3. **Rankings:** **runtime import** into `chrome.storage.local` via the side panel
   (file picker **and** paste textarea) — this is what you'll actually use
   during drafts, and it lets you keep separate sheets per league. A committed
   `data/rankings.example.csv` is the **schema reference + test fixture** only.
   Schema: `Player Name, Position, Team, Bye, Tier, Market Value, Floor,
Median, Ceiling, Target, Fade, Notes` (optional cols tolerated). Rankings
   carry a projection _distribution_ so ceiling survives (addresses the
   "marginal points ignores ceiling" concern).
4. **Live DOM:** **no MCP.** pi intentionally has no MCP support. Instead the
   content script ships a **DOM probe mode** (`?probe=1`) that snapshots the
   page (it already runs authenticated in your Yahoo session) into
   `chrome.storage.local.domProbe`. You run a Yahoo mock draft, trigger the
   probe, share the snapshot, and I write scrapers against real selectors.
   (If a live browser tool is ever wanted: the pi-native path is a TypeScript
   extension that wraps a CDP connection to your running Chrome — heavier.)

## Open

- Live Yahoo draft room URL + real DOM selectors — capture via the probe once
  you're in a mock draft.

## Status

- [x] `.gitignore` (protects `.env`), `manifest.json` (MV3), `src/types.ts`
- [x] TS toolchain (tsc/oxlint/oxfmt/knip/prek) + esbuild build → `dist/`
- [x] content script with DOM probe scaffold (`?probe=1`)
- [x] `data/rankings.example.csv` schema reference
- [x] par sheet engine + storage (pure, unit-tested)
- [x] rankings CSV importer (parse + validate + tiers + per-league store)
- [x] side panel UI: league switcher, par-sheet editor, rankings import
- [ ] live scraper (content script) — pending real DOM via `?probe=1`
- [ ] engine modules (value, tier/cliff, opponent, leverage, nomination)
- [ ] in-draft panel + alert delivery
- [ ] live scraper (content script) — pending real DOM
- [ ] engine modules + panel UI
- [ ] alert delivery (panel badges + chrome.notifications)
