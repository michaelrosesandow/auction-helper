import { describe, expect, it } from "vitest";

import { buildFronts, optSkill, posFrontier, type SolverPlayer } from "../engine/solver.js";

function p(name: string, pos: SolverPlayer["pos"], cost: number, pts: number): SolverPlayer {
  return { id: name, name, pos, cost, pts };
}

// All unordered pairs (i<j) of a small array — used by the brute-force reference.
function pairs<T>(arr: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) {
      out.push([arr[i] as T, arr[j] as T]);
    }
  }
  return out;
}

// Brute-force reference: enumerate every 2RB + 2WR + 1TE + 1FLEX combo, take
// the max pts ≤ budget. Used to validate the DP on small pools.
function bruteSkill(pool: SolverPlayer[], budget: number): number {
  const rb = pool.filter((q) => q.pos === "RB");
  const wr = pool.filter((q) => q.pos === "WR");
  const te = pool.filter((q) => q.pos === "TE");
  let best = 0;
  for (const rbs of pairs(rb)) {
    for (const wrs of pairs(wr)) {
      for (const t of te) {
        const used = new Set([rbs[0]?.id, rbs[1]?.id, wrs[0]?.id, wrs[1]?.id, t.id]);
        const baseCost = (rbs[0]?.cost ?? 0) + (rbs[1]?.cost ?? 0) + (wrs[0]?.cost ?? 0) + (wrs[1]?.cost ?? 0) + t.cost;
        const basePts = (rbs[0]?.pts ?? 0) + (rbs[1]?.pts ?? 0) + (wrs[0]?.pts ?? 0) + (wrs[1]?.pts ?? 0) + t.pts;
        for (const f of pool) {
          if (used.has(f.id)) {
            continue;
          }
          if (baseCost + f.cost <= budget && basePts + f.pts > best) {
            best = basePts + f.pts;
          }
        }
      }
    }
  }
  return best;
}

describe("posFrontier", () => {
  it("builds a monotonically rising Pareto frontier (pts strictly increasing)", () => {
    const pool = [p("a", "RB", 5, 50), p("b", "RB", 3, 30), p("c", "RB", 1, 10)];
    const front = posFrontier(pool, 2, 20);
    expect(front.length).toBeGreaterThan(0);
    for (let i = 1; i < front.length; i++) {
      const cur = front[i];
      const prev = front[i - 1];
      expect(cur?.cost).toBeGreaterThan(prev?.cost ?? -1);
      expect(cur?.pts).toBeGreaterThan(prev?.pts ?? -1);
    }
  });

  it("returns an empty frontier when count exceeds pool size", () => {
    expect(posFrontier([p("a", "RB", 1, 1)], 2, 20)).toHaveLength(0);
  });
});

describe("optSkill", () => {
  const pool: SolverPlayer[] = [
    p("R1", "RB", 5, 50),
    p("R2", "RB", 4, 44),
    p("R3", "RB", 2, 20),
    p("R4", "RB", 1, 8),
    p("W1", "WR", 5, 50),
    p("W2", "WR", 4, 44),
    p("W3", "WR", 2, 20),
    p("W4", "WR", 1, 8),
    p("T1", "TE", 5, 50),
    p("T2", "TE", 3, 30),
    p("T3", "TE", 1, 9),
  ];

  it("matches brute force across a range of budgets", () => {
    const fronts = buildFronts(pool, 60);
    for (const budget of [10, 12, 15, 20, 25, 30, 40, 50]) {
      const got = optSkill(fronts, budget);
      const want = bruteSkill(pool, budget);
      expect(got.pts).toBe(want);
    }
  });

  it("returns a valid roster: 2 RB, 2 WR, 1 TE, 1 FLEX, all distinct, ≤ budget", () => {
    const res = optSkill(buildFronts(pool, 60), 30);
    const slots = res.slots;
    const ids = Object.values(slots).map((q) => q?.id);
    expect(new Set(ids).size).toBe(6); // all distinct
    expect(slots.RB1?.pos).toBe("RB");
    expect(slots.RB2?.pos).toBe("RB");
    expect(slots.WR1?.pos).toBe("WR");
    expect(slots.WR2?.pos).toBe("WR");
    expect(slots.TE?.pos).toBe("TE");
    expect(["RB", "WR", "TE"]).toContain(slots.FLEX?.pos);
    expect(res.cost).toBeLessThanOrEqual(30);
  });

  it("returns an empty result when the budget cannot field a lineup", () => {
    expect(optSkill(buildFronts(pool, 60), 3)).toEqual({ pts: 0, cost: 0, slots: {} });
  });

  it("respects the exclude set (sold players are unavailable)", () => {
    const exclude = new Set(["R1", "W1"]); // remove the two best values
    const fronts = buildFronts(pool, 60, exclude);
    const res = optSkill(fronts, 30);
    expect(res.slots.RB1?.id).not.toBe("R1");
    expect(res.slots.RB2?.id).not.toBe("R1");
    expect(res.slots.WR1?.id).not.toBe("W1");
    expect(res.slots.WR2?.id).not.toBe("W1");
  });
});
