# Yahoo Auction Helper

Chrome MV3 extension for Yahoo fantasy football **Superflex auction drafts**.
Roster: QB, RB, RB, WR, WR, TE, Flex, Superflex, K, DST + 5 bench. Budget $200.

See `PLAN.md` for full scope, architecture, and data models.

## Project conventions (for agents)

- **Toolchain** (per the `sow` skill): `tsc --noEmit` for types, `oxlint` lint,
  `oxfmt` format, `knip` dead-code/dep hygiene, `prek` pre-commit hook.
- **Module resolution is `NodeNext`.** Relative/alias imports MUST use the `.js`
  extension (e.g. `import { Player } from "./types.js"`), even though the source
  is `.ts`. esbuild resolves these to the `.ts` files at build time.
- **Build:** `npm run build` bundles `src/{content,background,sidepanel}.ts` to
  `dist/` via esbuild (format `iife`), copies `manifest.json` + `sidepanel.html`.
  **Load unpacked from `dist/`.** `npm run watch` for rebuild-on-save.
- **Browser globals:** content/background/sidepanel use the `chrome.*` APIs
  (`@types/chrome`) and DOM (`lib: DOM`). oxlint runs with `env: browser+node`
  (build scripts are Node).
- **Rankings are runtime data, not build data.** Import via the side panel
  (file/paste CSV) into `chrome.storage.local`; `data/rankings.example.csv` is a
  schema reference + test fixture only.
- **No runtime deps in the extension bundle.** Everything is dev-only; the
  shipped `dist/*.js` files must be self-contained.

## Dependency policy

- Prefer the standard library and existing dependencies over adding new ones.
- Before adding a dependency, justify why a library is needed and consider its
  maintenance status and security.
- Keep production dependencies minimal; this project targets zero runtime deps.
- If your changes affect the project graph (new entry points, moved files, new
  deps), run `npm run knip` before handoff and resolve or justify findings.
- Do not commit `package-lock.json` changes without running `npm install`.

## Verify

```bash
npm install
npm run format     # normalize once
npm run check      # tsc
npm run lint       # oxlint
npm run knip       # dead code / deps
npm run build      # -> dist/
```
