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
