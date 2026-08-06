import { describe, expect, it } from "vitest";

import { importRankings, parseCsv } from "../rankings.js";

const CSV = `Player Name,Position,Team,Tier,Market Value,Floor,Median,Ceiling,Target,Fade
Josh Allen,QB,BUF,1,68,330,385,420,1,
Bijan Robinson,RB,ATL,1,62,240,290,340,1,
Ja'Marr Chase,WR,CIN,1,58,230,275,325,,
Justin Jefferson,WR,MIN,1,57,225,270,325,,
Travis Kelce,TE,KC,1,28,150,180,215,1,
Bad Row,XX,NOWHERE,1,1,,,,,`;

describe("parseCsv", () => {
  it("handles quoted fields and skips blank rows", () => {
    const rows = parseCsv('a,b,c\n,"x,y",z\n\n');
    expect(rows).toEqual([
      ["a", "b", "c"],
      ["", "x,y", "z"],
    ]);
  });
});

describe("importRankings", () => {
  const res = importRankings(CSV);

  it("parses players and skips invalid positions", () => {
    expect(res.players.length).toBe(5);
    expect(res.errors.length).toBe(1);
  });

  it("parses money, projections, and target/fade tags", () => {
    const allen = res.players.find((p) => p.name === "Josh Allen");
    expect(allen?.marketValue).toBe(68);
    expect(allen?.projFloor).toBe(330);
    expect(allen?.projCeiling).toBe(420);
    expect(allen?.target).toBe(true);
    expect(allen?.fade).toBe(false);
  });

  it("ranks within position by median desc", () => {
    const wrs = res.players.filter((p) => p.pos === "WR");
    expect(wrs[0]?.name).toBe("Ja'Marr Chase"); // 275 > 270
    expect(wrs[0]?.positionRank).toBe(1);
    expect(wrs[1]?.positionRank).toBe(2);
  });

  it("groups tiers by position + tier", () => {
    expect(res.tiers.length).toBe(4); // QB, RB, WR (2 players), TE
    const wrTier = res.tiers.find((t) => t.pos === "WR");
    expect(wrTier?.playerIds.length).toBe(2);
  });
});

describe("importRankings — distribution & structural flags (T1)", () => {
  // Subtier is a player attribute; BigBreak/DeadZone are tier-level, repeated
  // per row and folded into the (pos, tier) bucket. Tier 1 RBs carry a
  // BigBreak; the tier-2 RB is a Dead Zone. Subtiers 1/2 split tier 1 into
  // 1a/1b.
  const FLAG_CSV = `Player Name,Position,Tier,Subtier,BigBreak,DeadZone,Median,Target,Fade
A,RB,1,1,1,,100,1,
B,RB,1,1,1,,95,,
C,RB,1,2,1,,90,,
D,RB,2,,,1,50,,1`;

  const res = importRankings(FLAG_CSV);

  it("carries subtier on the player", () => {
    expect(res.players.find((p) => p.name === "A")?.subtier).toBe(1);
    expect(res.players.find((p) => p.name === "C")?.subtier).toBe(2);
    expect(res.players.find((p) => p.name === "D")?.subtier).toBeUndefined();
  });

  it("folds BigBreak/DeadZone onto the tier (grouped by integer tier)", () => {
    const rbTiers = res.tiers.filter((t) => t.pos === "RB");
    const t1 = rbTiers[0]; // sorted: tier 1 before tier 2
    const t2 = rbTiers[1];
    expect(t1?.bigBreakAfter).toBe(true);
    expect(t1?.deadZone).toBeUndefined();
    expect(t2?.deadZone).toBe(true);
    expect(t2?.bigBreakAfter).toBeUndefined();
  });

  it("does not split sub-tiers into separate Tier objects", () => {
    const rbTiers = res.tiers.filter((t) => t.pos === "RB");
    expect(rbTiers.length).toBe(2); // tier 1 (1a + 1b) + tier 2
    expect(rbTiers.find((t) => t.tier === 1)?.playerIds.length).toBe(3);
  });
});

describe("importRankings — anchoring (tiers never move the median)", () => {
  // The "tiers never move the median" rule (analysis/assemble.py header;
  // engine/optimize.ts anchoring comment): tiers shape the band
  // (floor/ceiling) and carry structural flags, but projMedian is the anchor
  // — the raw median from the CSV, byte-identical regardless of tier / subtier
  // / flags / band. T3's blendPts tilts the optimizer's objective from
  // projMedian + ceiling; it must never feed back into projMedian. Enforced
  // here at the importer, where projMedian is born and the tier assembly runs.
  // (TODO V1 anchoring/parity.)

  it("projMedian is byte-identical to the raw median cell (decimals preserved, no rounding)", () => {
    const csv = `Player Name,Position,Tier,Median
A,RB,1,200
B,RB,2,247.5
C,WR,1,199.9
D,TE,3,0`;
    const want: Record<string, number> = { A: 200, B: 247.5, C: 199.9, D: 0 };
    const { players } = importRankings(csv);
    for (const p of players) {
      // exact (===), NOT toBeCloseTo — the median passes through untouched.
      expect(p.projMedian).toBe(want[p.name]);
    }
  });

  it("tier / subtier / flag / band context never move projMedian (the property)", () => {
    // Four players, IDENTICAL median (200), maximally different context:
    // tier1+sub1+BigBreak+target+full band; tier2+DeadZone+fade+compressed;
    // tier5+no flags+median-only; different POS+sub2+huge ceiling. If any
    // tier/distribution logic fed back into the median, these would diverge.
    const csv = `Player Name,Position,Tier,Subtier,BigBreak,DeadZone,Floor,Median,Ceiling,Target,Fade
AnchorA,RB,1,1,1,,180,200,260,1,
AnchorB,RB,2,,,1,195,200,205,,1
AnchorC,RB,5,,,,,200,,,
AnchorD,WR,1,2,1,,170,200,300,1,`;
    const { players, tiers } = importRankings(csv);
    const byName = new Map(players.map((p) => [p.name, p]));
    const tierOf = new Map(tiers.map((t) => [`${t.pos}:${t.tier}`, t]));

    // Sanity — the assembly ran and produced varying context (else the
    // anchoring assertion below is vacuous): tier flags folded + the band
    // spans median-only → huge-ceiling, which is exactly what T3's tilt acts on.
    expect(tierOf.get("RB:1")?.bigBreakAfter).toBe(true);
    expect(tierOf.get("RB:2")?.deadZone).toBe(true);
    expect(byName.get("AnchorC")?.projCeiling).toBeUndefined();
    expect(byName.get("AnchorD")?.projCeiling).toBe(300);

    // The rule itself: projMedian is byte-identical across all four despite
    // the wildly different tier / band context. (toBe, not toBeCloseTo.)
    for (const p of players) {
      expect(p.projMedian).toBe(200);
    }
  });
});
