/**
 * Exact 0/1-knapsack roster solver — TypeScript port of the Python
 * `opt_skill` (analysis/04_qb_strategies.py).
 *
 * Solves: given a pool of skill players (RB/WR/TE) and a budget, pick the
 * optimal 2 RB + 2 WR + 1 TE + 1 FLEX (RB|WR|TE) starter set that maximizes
 * projected points within budget. Exact (DP), not heuristic.
 *
 * Reconstruction uses O(1) back-pointers (each entry stores its predecessor
 * node + the player added) instead of copying player arrays at every DP
 * update — keeps the hot loop allocation-light.
 *
 * Pure: no I/O, no chrome. Safe to unit-test and to run in any JS context.
 *
 * NOTE: this is the isolated proof-of-concept (see bench.ts for the latency
 * harness). When wired into src/engine/ it will be re-tooled to satisfy the
 * project's oxlint rules (notably no-non-null-assertion).
 */
export type SkillPos = "RB" | "WR" | "TE";
export type Pos = SkillPos | "QB";

export interface Player {
  name: string;
  pos: Pos;
  cost: number;
  pts: number;
  rank: number;
  team?: string;
}

export interface RosterResult {
  pts: number;
  cost: number;
  slots: Record<string, Player>;
}

interface Node {
  player: Player;
  prev: Node | null; // predecessor (count − 1); null at count 0
}

/** A point on a position Pareto frontier: at `cost`, `pts`, reachable via the `head` chain. */
export interface FrontPoint {
  cost: number;
  pts: number;
  head: Node | null;
}

interface Entry {
  pts: number;
  node: Node | null;
}

/**
 * Pareto frontier: best pts picking EXACTLY `count` distinct players from
 * `pool`, over cost (pts strictly rising). 0/1 knapsack, count-descending so
 * each player is used at most once. Faithful port of `_pos_frontier`.
 */
export function posFrontier(pool: readonly Player[], count: number, costCap: number): FrontPoint[] {
  // dp[c] = array indexed by cost (0..costCap) of best entry picking exactly c players.
  const dp: (Entry | null)[][] = [];
  for (let c = 0; c <= count; c++) {
    dp.push(new Array<Entry | null>(costCap + 1).fill(null));
  }
  const dp0 = dp[0]!; // Array.from-style fill guarantees dp[0] exists
  dp0[0] = { pts: 0, node: null };
  for (const p of pool) {
    const cost = p.cost;
    if (cost > costCap || cost < 1) continue; // $0/garbage can't help
    for (let c = count; c >= 1; c--) {
      const prev = dp[c - 1]!;
      const cur = dp[c]!;
      const limit = costCap - cost;
      for (let pc = 0; pc <= limit; pc++) {
        const e = prev[pc];
        if (!e) continue;
        const nc = pc + cost;
        const npts = e.pts + p.pts;
        const ex = cur[nc];
        if (!ex || npts > ex.pts) {
          cur[nc] = { pts: npts, node: { player: p, prev: e.node } };
        }
      }
    }
  }
  const row = dp[count]!;
  const out: FrontPoint[] = [];
  let best = -Infinity;
  for (let cost = 0; cost <= costCap; cost++) {
    const e = row[cost];
    if (!e) continue;
    if (e.pts > best) {
      best = e.pts;
      out.push({ cost, pts: e.pts, head: e.node });
    }
  }
  return out;
}

export interface Fronts {
  RB: FrontPoint[][];
  WR: FrontPoint[][];
  TE: FrontPoint[][];
}

/** Build all position frontiers (k = 0..3) over `pool`, optionally excluding names. */
export function buildFronts(
  pool: readonly Player[],
  costCap: number,
  exclude?: ReadonlySet<string>,
): Fronts {
  const byPos: Record<SkillPos, Player[]> = { RB: [], WR: [], TE: [] };
  for (const p of pool) {
    if (p.pos !== "RB" && p.pos !== "WR" && p.pos !== "TE") continue;
    if (exclude?.has(p.name)) continue;
    byPos[p.pos].push(p);
  }
  const make = (pos: SkillPos): FrontPoint[][] => {
    const arr: FrontPoint[][] = [];
    for (let k = 0; k <= 3; k++) arr.push(posFrontier(byPos[pos], k, costCap));
    return arr;
  };
  return { RB: make("RB"), WR: make("WR"), TE: make("TE") };
}

// FLEX position → (RB count, WR count, TE count) for the 2RB+2WR+1TE+1FLEX starters.
const CASES: readonly (readonly [SkillPos, number, number, number])[] = [
  ["RB", 3, 2, 1],
  ["WR", 2, 3, 1],
  ["TE", 2, 2, 2],
];

function collect(head: Node | null): Player[] {
  const out: Player[] = [];
  for (let n: Node | null = head; n !== null; n = n.prev) out.push(n.player);
  return out;
}

/**
 * Exact max non-QB starter pts ≤ budget, given prebuilt frontiers.
 * Faithful port of `opt_skill`. Returns pts, cost, and the slot→player map.
 */
export function optSkill(fronts: Fronts, budget: number): RosterResult {
  let bestPts = -Infinity;
  let bestCost = 0;
  let best: { r: Node | null; w: Node | null; t: Node | null; fpos: SkillPos } | null = null;
  for (const [fpos, rn, wn, tn] of CASES) {
    const frb = fronts.RB[rn]!;
    const fwr = fronts.WR[wn]!;
    const fte = fronts.TE[tn]!;
    for (const r of frb) {
      if (r.cost > budget) continue;
      for (const w of fwr) {
        const rw = r.cost + w.cost;
        if (rw > budget) continue;
        for (const t of fte) {
          const c = rw + t.cost;
          if (c > budget) continue;
          const pts = r.pts + w.pts + t.pts;
          if (pts > bestPts) {
            bestPts = pts;
            bestCost = c;
            best = { r: r.head, w: w.head, t: t.head, fpos };
          }
        }
      }
    }
  }
  if (!best) return { pts: 0, cost: 0, slots: {} };
  const byPtsDesc = (a: Player, b: Player): number => b.pts - a.pts;
  const rbs = collect(best.r).sort(byPtsDesc);
  const wrs = collect(best.w).sort(byPtsDesc);
  const tes = collect(best.t).sort(byPtsDesc);
  const slots: Record<string, Player> = {
    RB1: rbs[0]!,
    RB2: rbs[1]!,
    WR1: wrs[0]!,
    WR2: wrs[1]!,
    TE: tes[0]!,
  };
  slots["FLEX"] = best.fpos === "RB" ? rbs[2]! : best.fpos === "WR" ? wrs[2]! : tes[1]!;
  return { pts: bestPts, cost: bestCost, slots };
}
