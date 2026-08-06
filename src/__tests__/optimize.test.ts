import { describe, expect, it } from "vitest";

import {
  benchValue,
  type BenchValueInput,
  blendPts,
  optimizeRoster,
  starterRetention,
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

// Minimal input for benchValue tests — same shape + a pos string.
function benchDist(
  median: number,
  ceil: number | undefined,
  pos: string,
  fade = false,
): BenchValueInput {
  return { projMedian: median, projCeiling: ceil, pos, fade };
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

  // Double-discount guard (TODO V1): the Fade is a SINGLE multiplicative
  // discount on the WHOLE blend — never entangled with the ceiling term. So
  // a Fade's blend must equal the identical non-fade blend × fadeDiscount,
  // for every band shape. A buggy "discount the ceiling term" impl would
  // under-penalize high-ceiling Fades; a buggy "discount ceiling then whole"
  // impl would over-penalize them. Asserting the ratio holds across band
  // shapes (incl. a low ceiling) is what makes this a property test rather
  // than a spot check — any impl that ties the discount to the ceiling fails
  // for at least one distribution in the sweep.
  it("applies the Fade discount exactly once, regardless of ceiling height", () => {
    const D = 0.9;
    // Vary the ceiling across band shapes: symmetric, compressed (low),
    // upside-swing, and a degenerate ceil < median. floor is irrelevant to
    // the blend (only median + ceiling feed it) but included for realism.
    const cases: BlendInput[] = [
      dist(200, 200, 200), // symmetric — blend = median
      dist(200, 190, 205), // low / compressed ceiling (dead-zone floor-back)
      dist(200, 150, 300), // upside-swing (ceiling ≫ median)
      dist(200, 150, 400), // extreme upside
      dist(200, 120, 180), // degenerate: ceiling BELOW median
    ];
    for (const base of cases) {
      const unfaded = blendPts(base);
      const faded = blendPts({ ...base, fade: true });
      // single multiplicative application — the core invariant
      expect(faded).toBeCloseTo(unfaded * D, 6);
      // the discount RATE is constant across band shapes: a low-ceiling Fade
      // gets the same relative haircut as a high-ceiling one. If the discount
      // leaked into the ceiling term this ratio would vary with the ceiling.
      expect(faded / unfaded).toBeCloseTo(D, 6);
    }
    // a custom discount travels through the same single-application path
    for (const base of cases) {
      const unfaded = blendPts(base);
      expect(blendPts({ ...base, fade: true }, { fadeDiscount: 0.75 })).toBeCloseTo(
        unfaded * 0.75,
        6,
      );
    }
  });

  it("a low-ceiling Fade is discounted once, not twice (concrete guard)", () => {
    // The TODO's specific scenario: a compressed Fade (a dead-zone floor-back
    // you're forced to consider). blend = 0.7·200 + 0.3·205 = 201.5; the
    // correct faded value is 201.5 · 0.9. The double-discount bug would score
    // this as (0.7·med + 0.3·ceil·0.9)·0.9 — strictly lower — and the
    // ceiling-only bug as 0.7·med + 0.3·ceil·0.9 — strictly higher. Pin the
    // exact value and bound it on both sides.
    const low = dist(200, 190, 205, true);
    const blend = 0.7 * 200 + 0.3 * 205; // 201.5
    expect(blendPts(low)).toBeCloseTo(blend * 0.9, 6);
    expect(blendPts(low)).toBeGreaterThan((0.7 * 200 + 0.3 * 205 * 0.9) * 0.9); // not double
    expect(blendPts(low)).toBeLessThan(0.7 * 200 + 0.3 * 205 * 0.9); // not ceiling-only
  });

  // ceilingTilt contract (TODO V2): the tilt is now the single knob the weight
  // sweep + V3 calibration tune, so lock its math — the sweep must measure the
  // real blend, not a drift. tilt 0 → pure median, tilt 1 → pure ceiling,
  // monotonic + linear between, default (omitted) == explicit 0.3, and the
  // weights sum to 1.0 at any tilt (symmetric player → median always).
  it("ceilingTilt: 0 → pure median, 1 → pure ceiling, linear between", () => {
    const swing = dist(200, 150, 300); // median 200, ceiling 300
    expect(blendPts(swing, { ceilingTilt: 0 })).toBeCloseTo(200, 6); // pure median
    expect(blendPts(swing, { ceilingTilt: 1 })).toBeCloseTo(300, 6); // pure ceiling
    // monotonic: any interior tilt lands strictly between the endpoints
    const at = (t: number) => blendPts(swing, { ceilingTilt: t });
    for (const t of [0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.9]) {
      expect(at(t)).toBeGreaterThan(at(0));
      expect(at(t)).toBeLessThan(at(1));
    }
    // linear: blend = (1−t)·med + t·ceil
    expect(blendPts(swing, { ceilingTilt: 0.25 })).toBeCloseTo(0.75 * 200 + 0.25 * 300, 6);
    expect(blendPts(swing, { ceilingTilt: 0.4 })).toBeCloseTo(0.6 * 200 + 0.4 * 300, 6);
  });

  it("ceilingTilt default (omitted) == explicit 0.3; weights sum to 1.0 at any tilt", () => {
    const swing = dist(200, 150, 300);
    expect(blendPts(swing)).toBeCloseTo(blendPts(swing, { ceilingTilt: 0.3 }), 9);
    // a symmetric player blends to its median at ANY tilt (weights sum to 1.0)
    const sym = dist(220, 220, 220);
    for (const t of [0, 0.2, 0.3, 0.5, 1]) {
      expect(blendPts(sym, { ceilingTilt: t })).toBeCloseTo(220, 6);
    }
  });

  it("ceilingTilt composes with the Fade discount across the sweep range", () => {
    // faded(t) == unfaded(t) · fadeDiscount for any tilt — the single-
    // application invariant (above) must hold across the whole sweep, not just
    // the default tilt.
    const swing = dist(200, 150, 300);
    const faded = { ...swing, fade: true };
    for (const t of [0.2, 0.3, 0.4]) {
      expect(blendPts(faded, { ceilingTilt: t })).toBeCloseTo(
        blendPts(swing, { ceilingTilt: t }) * 0.9,
        6,
      );
    }
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

// ── benchValue (V4) ─────────────────────────────────────────────────────────
// The bench/depth value function: ceiling-weighted, position-aware,
// dead-zone-penalized. The starter blendPts is median-dominant (0.3 tilt) and
// correctly ranks a high-median floor-back above a low-median upside bet for
// a STARTER slot. benchValue inverts this for depth: a $5 bench lotto ticket
// should prefer the ceiling-bet over the floor-back when the tier is dead.
//
// Key assertions:
//   1. Position-aware tilt: QB/WR/TE get ceiling-weighted (0.7); RB is median.
//   2. Dead Zone penalty: capped-ceiling players in a dead zone are penalized.
//   3. The $5 Montgomery-vs-Henderson problem: benchValue flips the order.
//   4. Missing ceiling degrades gracefully (no penalty, median-only for RB).
//   5. Fade discount applies multiplicatively, same as blendPts.
describe("benchValue", () => {
  it("QB/WR/TE are ceiling-weighted (0.7 tilt); RB is median-only", () => {
    const sw = benchDist(200, 300, "WR");
    const rb = benchDist(200, 300, "RB");
    // WR: 0.3·200 + 0.7·300 = 270
    expect(benchValue(sw, false)).toBeCloseTo(270, 6);
    // RB: median-only = 200
    expect(benchValue(rb, false)).toBeCloseTo(200, 6);
  });

  it("TE is ceiling-weighted like QB/WR", () => {
    const te = benchDist(180, 250, "TE");
    expect(benchValue(te, false)).toBeCloseTo(0.3 * 180 + 0.7 * 250, 6);
  });

  it("the $5 Montgomery-vs-Henderson problem: benchValue flips the order (RB, dead zone)", () => {
    // Montgomery: veteran-floor, med 202, ceil 212, ratio 1.05 → capped → penalized
    // Henderson:  upside-swing,  med 181, ceil 245, ratio 1.35 → not capped
    const mont = benchDist(202, 212, "RB");
    const hend = benchDist(181, 245, "RB");

    // In a dead zone: Montgomery's capped ceiling triggers the penalty
    const mv = benchValue(mont, true);
    const hv = benchValue(hend, true);
    // Montgomery: 202 × 0.85 = 171.7
    expect(mv).toBeCloseTo(202 * 0.85, 6);
    // Henderson: 181 (no tilt, no penalty — ratio 1.35 > 1.15)
    expect(hv).toBeCloseTo(181, 6);
    expect(hv).toBeGreaterThan(mv); // Henderson > Montgomery in dead zone

    // Outside a dead zone: no penalty — Montgomery's higher median wins (202 > 181)
    const mvSafe = benchValue(mont, false);
    const hvSafe = benchValue(hend, false);
    expect(mvSafe).toBeCloseTo(202, 6);
    expect(hvSafe).toBeCloseTo(181, 6);
    expect(mvSafe).toBeGreaterThan(hvSafe); // Montgomery wins outside dead zone
  });

  it("a QB/WR dead-zone floor-back is penalized by BOTH the capped-ceiling penalty AND ceiling tilt — the ceiling-bet pulls further ahead", () => {
    // WR version: floor-back med220/ceil235 (ratio 1.07, capped) vs upside med200/ceil300 (ratio 1.50)
    const floor = benchDist(220, 235, "WR");
    const swing = benchDist(200, 300, "WR");
    const fv = benchValue(floor, true);
    const sv = benchValue(swing, true);
    // floor: (0.3·220 + 0.7·235) × 0.85 = (66 + 164.5) × 0.85 = 230.5 × 0.85 = 195.9
    expect(fv).toBeCloseTo(230.5 * 0.85, 6);
    // swing: 0.3·200 + 0.7·300 = 60 + 210 = 270 (no penalty, ratio 1.50 > 1.15)
    expect(sv).toBeCloseTo(270, 6);
    expect(sv).toBeGreaterThan(fv);
  });

  it("QB with missing ceiling degrades to median (no penalty, no tilt for RB-style)", () => {
    // QB without explicit ceiling: blend degrades to median, no dead-zone
    // penalty (we can't call it capped if we don't have the data).
    const qb = benchDist(350, undefined, "QB");
    // Even in a dead zone, missing ceiling means no penalty.
    expect(benchValue(qb, true)).toBeCloseTo(350, 6);
    expect(benchValue(qb, false)).toBeCloseTo(350, 6);
  });

  it("Fade discount applies multiplicatively (same invariant as blendPts)", () => {
    const base = benchDist(200, 300, "WR");
    const faded = benchDist(200, 300, "WR", true);
    const bv = benchValue(base, false);
    const fv = benchValue(faded, false);
    expect(fv).toBeCloseTo(bv * 0.9, 6);
    // custom fadeDiscount
    expect(benchValue(faded, false, { fadeDiscount: 0.75 })).toBeCloseTo(bv * 0.75, 6);
  });

  it("tunable: benchCeilingTilt, deadZonePenalty, deadZoneCeilingCap", () => {
    const rb = benchDist(200, 220, "RB");
    // default: RB → median-only, ratio 1.10 < 1.15 → penalized in dead zone
    expect(benchValue(rb, true)).toBeCloseTo(200 * 0.85, 6);
    // lower the cap to 1.05: ratio 1.10 > 1.05 → no penalty
    expect(benchValue(rb, true, { deadZoneCeilingCap: 1.05 })).toBeCloseTo(200, 6);
    // higher penalty
    expect(benchValue(rb, true, { deadZonePenalty: 0.7 })).toBeCloseTo(200 * 0.7, 6);
    // RB with benchTilt configured still applies it
    expect(benchValue(rb, false, { benchCeilingTilt: 0.5 })).toBeCloseTo(0.5 * 200 + 0.5 * 220, 6);
  });
});

// ── starterRetention (V4) ──────────────────────────────────────────────────
describe("starterRetention", () => {
  it("returns the right retention prior by position and rank", () => {
    // RB tiers from attrition_study.py
    expect(starterRetention("RB", 3)).toBeCloseTo(0.8); // bellcow rk≤6
    expect(starterRetention("RB", 6)).toBeCloseTo(0.8); // boundary
    expect(starterRetention("RB", 7)).toBeCloseTo(0.76); // shared-WH rk≤16
    expect(starterRetention("RB", 16)).toBeCloseTo(0.76);
    expect(starterRetention("RB", 17)).toBeCloseTo(0.71); // committee rk≤30
    expect(starterRetention("RB", 30)).toBeCloseTo(0.71);
    expect(starterRetention("RB", 31)).toBeCloseTo(0.6); // depth
    expect(starterRetention("RB", 99)).toBeCloseTo(0.6);

    // QB
    expect(starterRetention("QB", 1)).toBeCloseTo(0.76);
    expect(starterRetention("QB", 16)).toBeCloseTo(0.76);
    expect(starterRetention("QB", 17)).toBeCloseTo(0.5);

    // WR
    expect(starterRetention("WR", 12)).toBeCloseTo(0.77);
    expect(starterRetention("WR", 13)).toBeCloseTo(0.63);

    // TE
    expect(starterRetention("TE", 6)).toBeCloseTo(0.73);
    expect(starterRetention("TE", 7)).toBeCloseTo(0.53);
  });

  it("K and DEF return 1.0 (not in the study)", () => {
    expect(starterRetention("K", 1)).toBe(1.0);
    expect(starterRetention("DEF", 5)).toBe(1.0);
  });
});
