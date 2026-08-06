// blend-vs-median.ts — V2 A/B (TODO): does T3's blendPts actually change the
// optimal roster vs the raw median, or is it not earning its complexity?
//
// Loads the real players.json, solves once with pts = raw median (pre-T3) and
// once with pts = blendPts(p) (post-T3: default tilt 0.3 + acquire fade), and
// diffs the recommended QB pair + the 6 skill starters. Reports which players
// the blend swaps IN vs OUT (is it favoring upside?) and whether chasing
// ceiling costs median pts (the fair comparison — raw totalPts is in different
// units across the two pools, so we compare the MEDIAN-total and CEILING-total
// of each optimal roster instead).
//
// QBs are median-only in players.json, so both pools have identical QB pts;
// any QB-leader change is the skill roster flipping the pair via free budget.
//
// Dev harness (run via esbuild), not part of the extension toolchain:
//   npx esbuild analysis/ts-solver/blend-vs-median.ts --bundle --format=esm \
//     --platform=node --outfile=/tmp/blend-vs-median.mjs && node /tmp/blend-vs-median.mjs
import { blendPts, optimizeRoster, type OptPlayer } from "../../src/engine/optimize.js";
import playersRaw from "../out/players.json";

interface RawPlayer {
  name?: string;
  pos?: string;
  cost?: number;
  pts?: number; // median
  ceiling?: number;
  floor?: number;
  profile?: string;
  fade?: boolean;
}

const raw = playersRaw as unknown as RawPlayer[];

interface PoolEntry {
  id: string;
  name: string;
  pos: OptPlayer["pos"];
  cost: number;
  median: number;
  ceiling?: number;
  profile?: string;
  fade: boolean;
}

const pool: PoolEntry[] = raw
  .filter((p) => p.pos && ["QB", "RB", "WR", "TE"].includes(p.pos) && typeof p.pts === "number")
  .map((p) => ({
    id: p.name ?? "",
    name: p.name ?? "",
    pos: p.pos as OptPlayer["pos"],
    cost: p.cost ?? 0,
    median: p.pts ?? 0,
    ceiling: typeof p.ceiling === "number" ? p.ceiling : undefined,
    profile: p.profile,
    fade: p.fade === true,
  }));

const lookup = new Map(pool.map((p) => [p.id, p]));

// pre-T3 baseline: raw median (no ceiling-tilt, no fade).
const medianPool: OptPlayer[] = pool.map((p) => ({
  id: p.id,
  name: p.name,
  pos: p.pos,
  cost: p.cost,
  pts: p.median,
}));
// post-T3: blendPts default (tilt 0.3 + acquire fade).
const blendPool: OptPlayer[] = pool.map((p) => ({
  id: p.id,
  name: p.name,
  pos: p.pos,
  cost: p.cost,
  pts: blendPts({ projMedian: p.median, projCeiling: p.ceiling, fade: p.fade }),
}));

interface Starter {
  name: string;
  pos: string;
  cost: number;
  median: number;
  ceiling?: number;
  profile?: string;
}

function starters(res: ReturnType<typeof optimizeRoster>): Starter[] {
  if (!res.best) {
    return [];
  }
  const out: Starter[] = [];
  for (const slot of Object.values(res.best.skill.slots)) {
    if (!slot) {
      continue;
    }
    const e = lookup.get(slot.id);
    if (!e) {
      continue;
    }
    out.push({
      name: e.name,
      pos: e.pos,
      cost: e.cost,
      median: e.median,
      ceiling: e.ceiling,
      profile: e.profile,
    });
  }
  return out;
}

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

const show = (s: Starter): string =>
  `${s.name}(${s.pos} $${s.cost} med${s.median.toFixed(0)}` +
  `${s.ceiling ? ` ceil${s.ceiling.toFixed(0)}` : ""}` +
  `${s.profile ? ` ${s.profile}` : ""})`;

const BACKUPS = [7, 13];
const withCeil = pool.filter((p) => p.ceiling !== undefined).length;
const fades = pool.filter((p) => p.fade).length;
console.log(
  `loaded ${pool.length} players (${withCeil} with ceiling, ${fades} fades — fade is a minor blend term)\n`,
);

for (const backup of BACKUPS) {
  const rm = optimizeRoster({
    players: medianPool,
    budget: 200,
    backupQbAllowance: backup,
    topN: 6,
  });
  const rb = optimizeRoster({
    players: blendPool,
    budget: 200,
    backupQbAllowance: backup,
    topN: 6,
  });
  const qbM = rm.best ? rm.best.qbs.map((q) => q.name).join(" + ") : "(none)";
  const qbB = rb.best ? rb.best.qbs.map((q) => q.name).join(" + ") : "(none)";
  const sm = starters(rm);
  const sb = starters(rb);
  const setM = new Set(sm.map((s) => s.name));
  const setB = new Set(sb.map((s) => s.name));
  const shared = sm.filter((s) => setB.has(s.name)).length;
  const onlyM = sm.filter((s) => !setB.has(s.name));
  const onlyB = sb.filter((s) => !setM.has(s.name));

  // Fair comparison: the median-total / ceiling-total of each optimal roster
  // (raw totalPts is in different units across the two pools). A median-only
  // starter contributes its median to the ceiling-total (no sourced ceiling).
  const medTotM = sum(sm.map((s) => s.median));
  const medTotB = sum(sb.map((s) => s.median));
  const ceilTotM = sum(sm.map((s) => s.ceiling ?? s.median));
  const ceilTotB = sum(sb.map((s) => s.ceiling ?? s.median));

  console.log("=".repeat(86));
  console.log(`backup-QB allowance = $${backup}`);
  console.log("=".repeat(86));
  console.log(
    `QB leader:   median=${qbM}   blend=${qbB}   ${qbM === qbB ? "(same)" : "← CHANGED"}`,
  );
  console.log(
    `skill start: ${shared}/6 shared · ${onlyM.length} median-only · ${onlyB.length} blend-only`,
  );
  if (onlyM.length > 0) {
    console.log(`  median drops: ${onlyM.map(show).join(", ")}`);
  }
  if (onlyB.length > 0) {
    console.log(`  blend adds:   ${onlyB.map(show).join(", ")}`);
  }
  console.log(
    `median-total:  median-roster ${medTotM.toFixed(0)}  vs  blend-roster ${medTotB.toFixed(0)}` +
      `   (Δ${(medTotB - medTotM).toFixed(0)} — floor cost of chasing ceiling)`,
  );
  console.log(
    `ceiling-total: median-roster ${ceilTotM.toFixed(0)}  vs  blend-roster ${ceilTotB.toFixed(0)}` +
      `   (Δ${ceilTotB - ceilTotM >= 0 ? "+" : ""}${(ceilTotB - ceilTotM).toFixed(0)} — upside gained)`,
  );

  const moved = onlyM.length > 0 || onlyB.length > 0 || qbM !== qbB;
  const cheapUpside = medTotB >= medTotM * 0.99 && ceilTotB > ceilTotM;
  const verdict = !moved
    ? "→ IDENTICAL roster: the blend is NOT moving the recommendation ⇒ not earning its complexity at the starter-selection level."
    : cheapUpside
      ? "→ blend CHANGES the roster, gaining ceiling at ~no median cost ⇒ earning its complexity."
      : "→ blend changes the roster but trades median for ceiling — confirm the swap is intentional (V3 backtest).";
  console.log(verdict);
  console.log();
}
