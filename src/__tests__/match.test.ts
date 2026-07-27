import { describe, expect, it } from "vitest";

import { createNameResolver, normalizeName } from "../engine/match.js";
import type { Player, Position } from "../types.js";

function player(name: string, pos: Position, marketValue = 10): Player {
  return {
    id: `${name}-${pos}`.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    name,
    pos,
    team: "",
    projMedian: 0,
    marketValue,
    positionRank: 1,
    tier: 1,
  };
}

// Mirrors real capture shapes: full names in rankings, abbreviated in Yahoo.
const POOL: Player[] = [
  player("Jalen Hurts", "QB"),
  player("Christian McCaffrey", "RB"),
  player("Davante Adams", "WR"),
  player("Ja'Marr Chase", "WR"),
  player("Los Angeles Rams", "DEF"),
  player("Ravens", "DEF"),
  player("John Smith", "QB"), // ambiguous last name
  player("Jack Smith", "RB"), // ambiguous last name
];

describe("normalizeName", () => {
  it("lowercases and collapses non-alphanumerics to single spaces", () => {
    expect(normalizeName("J. Hurts")).toBe("j hurts");
    expect(normalizeName("Ja'Marr Chase")).toBe("ja marr chase");
    expect(normalizeName("  D.   Adams  ")).toBe("d adams");
    expect(normalizeName("49ers")).toBe("49ers");
  });
});

describe("createNameResolver", () => {
  const resolve = createNameResolver(POOL);

  it("matches exact full names", () => {
    expect(resolve("Jalen Hurts")?.name).toBe("Jalen Hurts");
    expect(resolve("Ja'Marr Chase")?.name).toBe("Ja'Marr Chase");
  });

  it("resolves Yahoo's abbreviated 'F. Last' format", () => {
    expect(resolve("J. Hurts")?.name).toBe("Jalen Hurts");
    expect(resolve("D. Adams")?.name).toBe("Davante Adams");
    expect(resolve("C. McCaffrey")?.name).toBe("Christian McCaffrey");
  });

  it("resolves DST nicknames via the last token", () => {
    expect(resolve("Rams")?.name).toBe("Los Angeles Rams");
    expect(resolve("Ravens")?.name).toBe("Ravens");
  });

  it("returns undefined for unknown players", () => {
    expect(resolve("Nobody Match")).toBeUndefined();
  });

  it("returns undefined for an ambiguous last name with no position hint", () => {
    expect(resolve("Smith")).toBeUndefined();
  });

  it("narrows ambiguity by position", () => {
    expect(resolve("Smith", "QB")?.name).toBe("John Smith");
    expect(resolve("Smith", "RB")?.name).toBe("Jack Smith");
  });

  it("returns undefined when the position hint matches nobody", () => {
    expect(resolve("Smith", "DEF")).toBeUndefined();
  });

  it("disambiguates initial+last only with a position hint", () => {
    // John & Jack Smith both initial 'J' -> still ambiguous without pos.
    expect(resolve("J. Smith")).toBeUndefined();
    expect(resolve("J. Smith", "QB")?.name).toBe("John Smith");
  });

  it("works on an empty pool", () => {
    expect(createNameResolver([])("Anyone")).toBeUndefined();
  });
});
