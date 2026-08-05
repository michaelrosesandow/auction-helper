import { describe, expect, it } from "vitest";

import {
  blendPts,
  optimizeRoster,
  type BlendInput,
  type BlendPtsOptions,
  type OptPlayer,
  type QBOption,
} from "../engine/optimize.js";

function q(name: string, cost: number, pts: number): OptPlayer {
  return { id: name, name, pos: "QB", cost, pts };
}
function s(name: string, pos: OptPlayer["pos"], cost: number, pts: number): OptPlayer {
  return { id: name, name, pos, cost, pts };
}

// A small but realistic pool: two plausible starter pairs + enough skill
// depth that the knapsack is non-trivial.
function basePool(): OptPlayer[] {
  return [
    q("Dak", 24, 339),
    q("Purdy", 20, 328),
    q("Kyler", 19, 328),
    q("Love", 13, 309),
    s("Gibbs", "RB", 56, 343),
    s("Montgomery", "RB", 5, 202),
    s("Hall", "RB", 17, 220),
    s("Scruba", "RB", 1, 60),
    s("Scrubb", "RB", 1, 55),
    s("McLaurin", "WR", 6, 208),
    s("JWilliams", "WR", 6, 199),
    s("Downs", "WR", 1, 172),
    s("Scrubw", "WR", 1, 60),
    s("Loveland", "TE", 18, 190),
    s("Warren", "TE", 11, 168),
    s("Scrube", "TE", 1, 120),
  ];
}

// Narrow a nullable best to non-null, failing the test clearly if absent.
function requireBest(res: { best: QBOption | null }): QBOption {
  if (!res.best) {
    throw new Error("expected a best pair but got null");
  }
  return res.best;
}

// Minimal projection distribution for blend tests. Player satisfies BlendInput,
// so this stands in for a full Player without the boilerplate.
function dist(median: number, floor?: number, ceil?: number, fade = false): BlendInput {
  return { projMedian: median, projFloor: floor, projCeiling: ceil, fade };
}

describe("optimizeRoster", () => {
  it("returns a best pair and ranks the rest by total pts (descending)", () => {
    const res = optimizeRoster({ players: basePool(), budget: 200 });
    requireBest(res);
    expect(res.topPairs.length).toBeGreaterThan(1);
    for (let i = 1; i < res.topPairs.length; i++) {
      const cur = res.topPairs[i];
      const prev = res.topPairs[i - 1];
      expect(cur?.totalPts).toBeLessThanOrEqual(prev?.totalPts ?? Number.POSITIVE_INFINITY);
    }
  });

  it("reports gapToBest = 0 for the leader; every pair is ≤ 0", () => {
    const res = optimizeRoster({ players: basePool(), budget: 200 });
    const best = requireBest(res);
    expect(best.gapToBest).toBe(0);
    for (const opt of res.topPairs) {
      expect(opt.gapToBest).toBeLessThanOrEqual(0);
    }
    const last = res.topPairs.at(-1);
    expect(last?.gapToBest).toBeLessThan(0);
  });

  it("leader priceSwing is non-negative headroom; challengers are ≤ 0", () => {
    const res = optimizeRoster({ players: basePool(), budget: 200 });
    const best = requireBest(res);
    expect(best.priceSwing).toBeGreaterThanOrEqual(0);
    for (const opt of res.topPairs.filter((o) => o.gapToBest < 0)) {
      expect(opt.priceSwing).toBeLessThanOrEqual(0);
    }
  });

  it("the implied skill roster is valid (2RB/2WR/1TE/FLEX, distinct)", () => {
    const res = optimizeRoster({ players: basePool(), budget: 200 });
    const slots = requireBest(res).skill.slots;
    const ids = Object.values(slots).map((p) => p?.id);
    expect(new Set(ids).size).toBe(6);
    expect(slots.RB1?.pos).toBe("RB");
    expect(slots.WR1?.pos).toBe("WR");
    expect(slots.TE?.pos).toBe("TE");
  });

  it("excludes sold players when the caller omits them from the pool", () => {
    const pool = basePool().filter((p) => p.id !== "Dak"); // Dak "sold"
    const res = optimizeRoster({ players: pool, budget: 200 });
    for (const opt of res.topPairs) {
      expect(opt.qbs.map((x) => x.id)).not.toContain("Dak");
    }
  });

  it("reacts to price: pricing a QB out removes him from the top pairs", () => {
    const base = optimizeRoster({ players: basePool(), budget: 200 });
    const hasDakAtBase = base.topPairs.some((o) => o.qbs.some((x) => x.id === "Dak"));
    expect(hasDakAtBase).toBe(true);
    // Hike Dak to $180 — even with the cheapest partner ($13) the pair can't
    // leave the $6 minimum to field skill starters, so it's dropped.
    const priceyPool = basePool().map((p) =>
      p.id === "Dak" ? ({ ...p, cost: 180 } as OptPlayer) : p,
    );
    const pricey = optimizeRoster({ players: priceyPool, budget: 200 });
    for (const opt of pricey.topPairs) {
      expect(opt.qbs.map((x) => x.id)).not.toContain("Dak");
    }
  });

  it("returns a note when fewer than 2 QBs are available", () => {
    const pool = basePool().filter((p) => p.pos !== "QB");
    pool.push(q("Only", 5, 200));
    const res = optimizeRoster({ players: pool, budget: 200 });
    expect(res.best).toBeNull();
    expect(res.note).toMatch(/one QB/i);
  });

  it("respects the backup-QB allowance knob (more reserve ⇒ fewer pts)", () => {
    const cheap = optimizeRoster({ players: basePool(), budget: 200, backupQbAllowance: 7 });
    const pricey = optimizeRoster({ players: basePool(), budget: 200, backupQbAllowance: 13 });
    expect(cheap.backupQbAllowance).toBe(7);
    expect(pricey.backupQbAllowance).toBe(13);
    expect(requireBest(pricey).totalPts).toBeLessThanOrEqual(requireBest(cheap).totalPts);
  });
});

// ── Blended projection (starter ceiling-tilt) ──────────────────────────────
// blendPts replaces the raw median as the optimizer's pts. Weights sum to 1.0
// (symmetric player → median; no base-rate corruption); a missing ceiling
// degrades to the median; a Fade is acquire-discounted. Float-noise from the
// 0.7/0.3 weights is absorbed with toBeCloseTo.
describe("blendPts", () => {
  it("returns the median for a symmetric player (no base-rate corruption)", () => {
    expect(blendPts(dist(200, 200, 200))).toBeCloseTo(200, 6);
  });

  it("starter ceiling-tilt raises an upside player above its median", () => {
    const swing = dist(200, 150, 300); // median 200, ceiling 300
    expect(blendPts(swing)).toBeCloseTo(0.7 * 200 + 0.3 * 300, 6); // 230
    expect(blendPts(swing)).toBeGreaterThan(swing.projMedian);
  });

  it("starter tilt is gentle — a high-median Dead-Zone floor-back beats a low-median upside swing (signal lives in the target flag, not the blend)", () => {
    const hampton = dist(200, 150, 300); // low median, huge ceiling (upside-swing)
    const floorback = dist(240, 230, 250); // high median, compressed (dead-zone floor-back)
    // 0.3 ceiling-tilt can't overcome the 40-pt median gap, so the floor-back
    // correctly wins at a starter slot. This documents WHY the upside-bet
    // signal is carried by the `target` flag → nominationSuggest, not the blend
    // (see TODO.md V4). If a bench-valuation layer is reintroduced, this is the
    // assertion that flips — add it there, not here.
    expect(blendPts(hampton)).toBeLessThan(blendPts(floorback));
  });

  it("degrades to the median when the ceiling is unsourced (e.g. current QB data)", () => {
    expect(blendPts(dist(300))).toBe(300);
    // a sourced floor but no ceiling still degrades the ceiling-tilt
    expect(blendPts(dist(300, 250))).toBe(300);
  });

  it("applies an acquire Fade discount; default 0.9, configurable", () => {
    const swing = dist(200, 150, 300); // starter blend = 230
    const faded = dist(200, 150, 300, true);
    const deep: BlendPtsOptions = { fadeDiscount: 0.8 };
    expect(blendPts(swing)).toBeCloseTo(230, 6);
    expect(blendPts(faded)).toBeCloseTo(230 * 0.9, 6); // 207 — acquire penalty
    expect(blendPts(faded)).toBeLessThan(blendPts(swing));
    expect(blendPts(faded, deep)).toBeCloseTo(230 * 0.8, 6); // 184 — tunable
  });
});

// End-to-end: the live caller's pool is now valued by the blend, so an upside
// player (ceiling ≫ median) raises the optimizer's objective above what raw
// medians would score — and gets rostered. Proves blendPts flows through to
// optimizeRoster without changing the solver's pts-maximizing math.
describe("optimizeRoster × blendPts", () => {
  it("values an upside RB higher than its raw median, raising the objective", () => {
    // Two RBs: identical median + cost, different ceilings. Cheap fills so the
    // lineup is legal and both RBs fit.
    const blended: OptPlayer[] = [
      q("QA", 5, 300),
      q("QB", 5, 290),
      s("swing", "RB", 5, blendPts(dist(200, 150, 300))), // ceiling ≫ median
      s("flat", "RB", 5, blendPts(dist(200, 190, 210))), // ceiling ≈ median
      s("RB3", "RB", 1, 50),
      s("RB4", "RB", 1, 50),
      s("W1", "WR", 1, 50),
      s("W2", "WR", 1, 50),
      s("W3", "WR", 1, 50),
      s("T1", "TE", 1, 50),
      s("T2", "TE", 1, 50),
    ];
    // Pre-T3 behavior: skill pts = raw median.
    const raw: OptPlayer[] = blended.map((p) =>
      p.id === "swing" || p.id === "flat" ? { ...p, pts: 200 } : p,
    );
    const blendedBest = requireBest(optimizeRoster({ players: blended, budget: 200 }));
    const rawBest = requireBest(optimizeRoster({ players: raw, budget: 200 }));
    // The ceiling-tilt makes the upside RB worth strictly more, so the blended
    // objective beats the raw-median one — and the upside RB is rostered.
    expect(blendedBest.totalPts).toBeGreaterThan(rawBest.totalPts);
    const rostered = Object.values(blendedBest.skill.slots).map((slot) => slot?.id);
    expect(rostered).toContain("swing");
  });
});
