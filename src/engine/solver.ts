// Exact 0/1-knapsack skill-starter solver — port of
// analysis/ts-solver/solver.ts, re-tooled for the project's oxlint rules
// (no non-null assertions; no `any`). Pure: no I/O, no chrome.
//
// Picks the optimal 2 RB + 2 WR + 1 TE + 1 FLEX starter set within a budget,
// maximizing projected points. Exact DP, not heuristic. Used by the live
// roster optimizer (./optimize.ts) to score each candidate QB pairing.
//
// Reconstruction uses O(1) back-pointers (each DP entry stores its
// predecessor node + the player added) instead of copying player arrays,
// keeping the hot loop allocation-light. A full solve over a ~425-player pool
// measures <1 ms (see analysis/ts-solver/bench.ts), so this is cheap to run
// on every poll tick.

export type SkillPos = "RB" | "WR" | "TE";

/** A skill starter slot on the lineup. */
type SkillSlot = "RB1" | "RB2" | "WR1" | "WR2" | "TE" | "FLEX";

/** A player the solver operates on (cost/pts are pre-resolved by the caller). */
export interface SolverPlayer {
  id: string;
  name: string;
  pos: SkillPos;
  /** expected price (inflation-adjusted marketValue for unsold; actual for won) */
  cost: number;
  /** projected season points (median) */
  pts: number;
}

export interface RosterResult {
  pts: number;
  cost: number;
  slots: Partial<Record<SkillSlot, SolverPlayer>>;
}

interface Node {
  player: SolverPlayer;
  prev: Node | null;
}

/** A point on a position Pareto frontier: at `cost`, `pts`, via the `head` chain. */
export interface FrontPoint {
  cost: number;
  pts: number;
  head: Node | null;
}

interface Entry {
  pts: number;
  node: Node | null;
}

export interface Fronts {
  RB: FrontPoint[][];
  WR: FrontPoint[][];
  TE: FrontPoint[][];
}

// FLEX position → (RB count, WR count, TE count) for the 2RB+2WR+1TE+1FLEX set.
const CASES: readonly (readonly [SkillPos, number, number, number])[] = [
  ["RB", 3, 2, 1],
  ["WR", 2, 3, 1],
  ["TE", 2, 2, 2],
];

// Guaranteed-defined array access: the DP arrays are constructed to fixed
// lengths, so indexing in-range is always defined. This narrows the type
// without a non-null assertion and throws if the invariant ever breaks.
function nth<T>(arr: readonly T[], i: number): T {
  const v = arr[i];
  if (v === undefined) {
    throw new Error(`internal: missing array element at ${i}`);
  }
  return v;
}

/**
 * Pareto frontier: best pts picking EXACTLY `count` distinct players from
 * `pool`, over cost (pts strictly rising). 0/1 knapsack, count-descending so
 * each player is used at most once. Faithful port of `_pos_frontier`.
 */
export function posFrontier(
  pool: readonly SolverPlayer[],
  count: number,
  costCap: number,
  exclude?: ReadonlySet<string>,
): FrontPoint[] {
  // dp[c] = row indexed by cost (0..costCap) of the best entry picking exactly c players.
  const dp: (Entry | null)[][] = [];
  for (let c = 0; c <= count; c++) {
    const row: (Entry | null)[] = [];
    for (let ci = 0; ci <= costCap; ci++) {
      row.push(null);
    }
    dp.push(row);
  }
  nth(dp, 0)[0] = { pts: 0, node: null };
  for (const p of pool) {
    if (exclude?.has(p.id)) {
      continue;
    }
    const cost = p.cost;
    if (cost > costCap || cost < 1) {
      continue; // $0/garbage can't help; over-cap can't fit
    }
    for (let c = count; c >= 1; c--) {
      const prev = nth(dp, c - 1);
      const cur = nth(dp, c);
      const limit = costCap - cost;
      for (let pc = 0; pc <= limit; pc++) {
        const e = prev[pc];
        if (!e) {
          continue;
        }
        const nc = pc + cost;
        const npts = e.pts + p.pts;
        const ex = cur[nc];
        if (!ex || npts > ex.pts) {
          cur[nc] = { pts: npts, node: { player: p, prev: e.node } };
        }
      }
    }
  }
  const out: FrontPoint[] = [];
  const finalRow = nth(dp, count);
  let best = -Infinity;
  for (let cost = 0; cost <= costCap; cost++) {
    const e = finalRow[cost];
    if (!e) {
      continue;
    }
    if (e.pts > best) {
      best = e.pts;
      out.push({ cost, pts: e.pts, head: e.node });
    }
  }
  return out;
}

/** Build all position frontiers (k = 0..3) over `pool`, optionally excluding ids. */
export function buildFronts(
  pool: readonly SolverPlayer[],
  costCap: number,
  exclude?: ReadonlySet<string>,
): Fronts {
  const byPos: Record<SkillPos, SolverPlayer[]> = { RB: [], WR: [], TE: [] };
  for (const p of pool) {
    byPos[p.pos].push(p);
  }
  const make = (pos: SkillPos): FrontPoint[][] => {
    const arr: FrontPoint[][] = [];
    for (let k = 0; k <= 3; k++) {
      arr.push(posFrontier(byPos[pos], k, costCap, exclude));
    }
    return arr;
  };
  return { RB: make("RB"), WR: make("WR"), TE: make("TE") };
}

function collect(head: Node | null): SolverPlayer[] {
  const out: SolverPlayer[] = [];
  for (let n: Node | null = head; n !== null; n = n.prev) {
    out.push(n.player);
  }
  return out;
}

function byPtsDesc(a: SolverPlayer, b: SolverPlayer): number {
  return b.pts - a.pts;
}

function flexPlayer(fpos: SkillPos, rbs: SolverPlayer[], wrs: SolverPlayer[], tes: SolverPlayer[]): SolverPlayer {
  if (fpos === "RB") {
    return nth(rbs, 2);
  }
  if (fpos === "WR") {
    return nth(wrs, 2);
  }
  return nth(tes, 1);
}

/**
 * Exact max non-QB starter pts ≤ `budget`, given prebuilt `fronts`.
 * Faithful port of `optSkill`. Returns pts, cost, and the slot→player map.
 */
export function optSkill(fronts: Fronts, budget: number): RosterResult {
  let bestPts = -Infinity;
  let bestCost = 0;
  let best: { r: Node | null; w: Node | null; t: Node | null; fpos: SkillPos } | null = null;
  for (const [fpos, rn, wn, tn] of CASES) {
    const frb = nth(fronts.RB, rn);
    const fwr = nth(fronts.WR, wn);
    const fte = nth(fronts.TE, tn);
    for (const r of frb) {
      if (r.cost > budget) {
        continue;
      }
      for (const w of fwr) {
        const rw = r.cost + w.cost;
        if (rw > budget) {
          continue;
        }
        for (const t of fte) {
          const c = rw + t.cost;
          if (c > budget) {
            continue;
          }
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
  if (!best) {
    return { pts: 0, cost: 0, slots: {} };
  }
  const rbs = collect(best.r).sort(byPtsDesc);
  const wrs = collect(best.w).sort(byPtsDesc);
  const tes = collect(best.t).sort(byPtsDesc);
  return {
    pts: bestPts,
    cost: bestCost,
    slots: { RB1: nth(rbs, 0), RB2: nth(rbs, 1), WR1: nth(wrs, 0), WR2: nth(wrs, 1), TE: nth(tes, 0), FLEX: flexPlayer(best.fpos, rbs, wrs, tes) },
  };
}

