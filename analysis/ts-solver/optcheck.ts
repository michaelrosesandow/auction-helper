/**
 * End-to-end sanity check: run the live optimizer (src/engine/optimize.ts)
 * against the analysis players.json and confirm it matches the Python
 * 04_qb_strategies / 06_robustness results (Dak+Purdy+cheap-backup ≈ 2094).
 *
 * Dev harness (run via esbuild), not part of the extension toolchain:
 *   npx esbuild analysis/ts-solver/optcheck.ts --bundle --format=esm \
 *     --platform=node --outfile=/tmp/optcheck.mjs && node /tmp/optcheck.mjs
 */
import playersRaw from "../out/players.json";
import { optimizeRoster, type OptPlayer } from "../../src/engine/optimize.js";

interface RawPlayer {
  name?: string;
  pos?: string;
  cost?: number;
  pts?: number;
}

const raw = playersRaw as unknown as RawPlayer[];
const pool: OptPlayer[] = raw
  .filter((p) => p.pos && ["QB", "RB", "WR", "TE"].includes(p.pos) && typeof p.pts === "number")
  .map((p) => ({
    id: p.name ?? "",
    name: p.name ?? "",
    pos: p.pos as OptPlayer["pos"],
    cost: p.cost ?? 0,
    pts: p.pts ?? 0,
  }));

console.log(`loaded ${pool.length} players\n`);

for (const [label, backup] of [
  ["cheap backup ($7 = Stroud tier)", 7],
  ["pricy backup ($13 = Baker)", 13],
] as const) {
  const res = optimizeRoster({ players: pool, budget: 200, backupQbAllowance: backup, topN: 6 });
  console.log(`=== ${label} ===`);
  for (const o of res.topPairs) {
    const sw =
      o.priceSwing > 0
        ? `+$${o.priceSwing} room`
        : o.priceSwing < 0
          ? `-$${-o.priceSwing} to tie`
          : "";
    console.log(
      `  ${o.qbs.map((q) => q.name).join(" + ").padEnd(28)} $${String(o.qbCost).padStart(3)}  ` +
        `${o.totalPts.toFixed(0)}pts  Δ${o.gapToBest.toFixed(0).padStart(3)}  ${sw}`,
    );
  }
  console.log();
}
