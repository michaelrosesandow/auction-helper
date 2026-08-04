import { describe, expect, it } from "vitest";

import { optimizeRoster, type OptPlayer, type QBOption } from "../engine/optimize.js";

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
