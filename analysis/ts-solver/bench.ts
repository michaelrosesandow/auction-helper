/**
 * Isolated benchmark + correctness check for the TS knapsack port.
 *
 * Run via:
 *   npx esbuild analysis/ts-solver/bench.ts --bundle --format=esm \
 *     --platform=node --outfile=/tmp/solver-bench.mjs && node /tmp/solver-bench.mjs
 *
 * Validates the port reproduces the Python opt_skill results
 * (1465.7 / 1396.6 / 1361.6 pts at budgets 165/140/120), then times the live
 * per-tick hot paths. This file is a dev harness (run via esbuild), not part
 * of the extension's tsc/oxlint/knip toolchain.
 */
import { performance } from "node:perf_hooks";

import playersRaw from "../out/players.json";
import { buildFronts, optSkill, type Player } from "./solver.js";

interface RawPlayer {
  name?: string;
  pos?: string;
  cost?: number;
  pts?: number;
  rank?: number;
}

const raw = playersRaw as unknown as RawPlayer[];
const skill: Player[] = raw
  .filter((p) => (p.pos === "RB" || p.pos === "WR" || p.pos === "TE") && typeof p.pts === "number")
  .map((p) => ({
    name: p.name ?? "",
    pos: p.pos as Player["pos"],
    cost: p.cost ?? 0,
    pts: p.pts ?? 0,
    rank: p.rank ?? 0,
  }));

const SLOT_ORDER = ["RB1", "RB2", "WR1", "WR2", "TE", "FLEX"] as const;

// ── VALIDATION vs Python (04_qb_strategies.py opt_skill) ────────────────────
console.log(`loaded ${skill.length} skill players (RB/WR/TE with projections)\n`);
const fronts = buildFronts(skill, 200);
const checks: Array<[number, number]> = [
  [165, 1465.7],
  [140, 1396.6],
  [120, 1361.6],
];
let ok = true;
for (const [budget, expected] of checks) {
  const res = optSkill(fronts, budget);
  const pass = Math.abs(res.pts - expected) < 0.5;
  ok = ok && pass;
  console.log(
    `${pass ? "PASS" : "FAIL"}  optSkill(${budget}) = ${res.pts.toFixed(1)} pts  (Python: ${expected})  cost $${res.cost}`,
  );
  for (const s of SLOT_ORDER) {
    const pl = res.slots[s];
    console.log(`      ${s.padEnd(5)} ${(pl?.name ?? "—").padEnd(24)} $${pl?.cost ?? 0}`);
  }
}
if (!ok) {
  throw new Error("VALIDATION FAILED — port is wrong; do not trust the timings below.");
}
console.log("\n=== TS solver benchmark (Node, single thread, back-pointer DP) ===\n");

// ── timing helper ───────────────────────────────────────────────────────────
function bench(fn: () => void, iters: number): { median: number; min: number; mean: number } {
  const warm = Math.min(iters, 25);
  for (let i = 0; i < warm; i++) fn();
  const times: number[] = [];
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const mean = times.reduce((s, t) => s + t, 0) / times.length;
  const median = times[Math.floor(times.length / 2)]!;
  return { median, min: times[0]!, mean };
}

const f2 = (ms: number): string => (ms < 0.01 ? " <0.01" : ms.toFixed(3));

// deterministic shrinking (LCG) so reruns are stable
function shrink(arr: Player[], removeRatio: number, seed = 1): Player[] {
  let s = seed >>> 0;
  const rng = (): number => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  return arr.filter(() => rng() > removeRatio);
}

// 1) full frontier rebuild — worst case (nobody sold yet)
const b1 = bench(() => buildFronts(skill, 200), 300);
console.log(`1) buildFronts FULL pool (${skill.length}, no exclusions):`);
console.log(`     median ${f2(b1.median)} ms   min ${f2(b1.min)} ms   mean ${f2(b1.mean)} ms`);

// 2) shrinking pools (draft progressing → fewer players → faster)
for (const ratio of [0.25, 0.5, 0.75]) {
  const pool = shrink(skill, ratio);
  const r = bench(() => buildFronts(pool, 200), 300);
  const pct = Math.round((1 - ratio) * 100);
  console.log(
    `   buildFronts ${pct}% remaining (${String(pool.length).padStart(3)} players):` +
      ` median ${f2(r.median)} ms   min ${f2(r.min)} ms`,
  );
}

// 3) optSkill with cached frontiers (the cheap path when board is unchanged)
const cached = buildFronts(skill, 200);
const b3 = bench(() => optSkill(cached, 140), 50000);
console.log(`\n2) optSkill(140) with CACHED frontiers:`);
console.log(`     median ${f2(b3.median)} ms   min ${f2(b3.min)} ms   mean ${f2(b3.mean)} ms`);

// 4) FULL TICK = rebuild frontiers (simulating exclude-set) + solve
const b4 = bench(() => {
  const ff = buildFronts(skill, 200);
  optSkill(ff, 140);
}, 300);
console.log(`\n3) FULL TICK = buildFronts + optSkill (worst case, full pool):`);
console.log(`     median ${f2(b4.median)} ms   min ${f2(b4.min)} ms   mean ${f2(b4.mean)} ms`);

// 5) full tick with a realistic mid-draft exclude set (~20% sold)
const soldNames = raw.filter((_, i) => i % 5 === 0).map((p) => p.name ?? "");
const sold = new Set<string>(soldNames);
const b4b = bench(() => {
  const ff = buildFronts(skill, 200, sold);
  optSkill(ff, 140);
}, 300);
console.log(`   FULL TICK with ~20% sold excluded (${sold.size} names):`);
console.log(`     median ${f2(b4b.median)} ms   min ${f2(b4b.min)} ms   mean ${f2(b4.mean)} ms`);

// 6) 50-target value-ceiling sweep, naive (rebuild per target) — upper bound
const targets = skill.slice(0, 50);
const b5 = bench(() => {
  for (const t of targets) {
    const ff = buildFronts(skill, 200, new Set<string>([t.name]));
    optSkill(ff, 140);
  }
}, 20);
console.log(`\n4) 50-target value-ceiling sweep, naive (rebuild each):`);
console.log(
  `     median ${f2(b5.median)} ms   min ${f2(b5.min)} ms   (upper bound; smart impl ≪ this)`,
);

console.log(
  `\nverdict: poll loop = 2000 ms; full-tick median ${f2(b4.median)} ms` +
    ` => ${((b4.median / 2000) * 100).toFixed(3)}% of one poll interval.`,
);
