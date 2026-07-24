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
