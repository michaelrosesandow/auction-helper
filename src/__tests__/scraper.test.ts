import { describe, expect, it } from "vitest";

import {
  computeMaxBid,
  isPosition,
  parseFill,
  parseMoney,
  parsePlayerMeta,
  parseTimer,
} from "../scraper.js";

describe("parseMoney", () => {
  it("parses bare dollar amounts", () => {
    expect(parseMoney("$15")).toBe(15);
    expect(parseMoney("$190")).toBe(190);
    expect(parseMoney("$2")).toBe(2);
  });

  it("extracts the amount out of prefixed labels", () => {
    // Real captured strings: "Proj $11", "Max Offer $4", "Budget $12", "Offer $10"
    expect(parseMoney("Proj $11")).toBe(11);
    expect(parseMoney("Max Offer $4")).toBe(4);
    expect(parseMoney("Budget $12")).toBe(12);
    expect(parseMoney("Offer $10")).toBe(10);
  });

  it("returns null when there is no dollar amount", () => {
    expect(parseMoney("You")).toBeNull();
    expect(parseMoney("6/15")).toBeNull();
    expect(parseMoney(null)).toBeNull();
  });
});

describe("parseFill", () => {
  it("splits filled / roster size", () => {
    expect(parseFill("6/15")).toEqual({ filled: 6, size: 15 });
    expect(parseFill("10/15")).toEqual({ filled: 10, size: 15 });
    expect(parseFill("1 / 15")).toEqual({ filled: 1, size: 15 });
  });

  it("returns null for non-fill text", () => {
    expect(parseFill("$12")).toBeNull();
    expect(parseFill("Billy")).toBeNull();
  });
});

describe("parseTimer", () => {
  it("converts MM:SS to seconds", () => {
    // Real captured value: the nomination countdown "00:18".
    expect(parseTimer("00:18")).toBe(18);
    expect(parseTimer("1:30")).toBe(90);
    expect(parseTimer("0:05")).toBe(5);
  });

  it("returns null for non-timer text", () => {
    expect(parseTimer("8 nominations until your turn")).toBeNull();
    expect(parseTimer("$15")).toBeNull();
  });
});

describe("computeMaxBid", () => {
  it("matches Yahoo's own Max Offer (budget $12, 6/15 -> $4)", () => {
    expect(computeMaxBid(12, 6, 15)).toBe(4);
  });

  it("floors at $1 when nearly tapped out", () => {
    // budget $2 with many open slots still must reserve $1 per empty slot
    expect(computeMaxBid(2, 6, 15)).toBe(1);
  });

  it("equals budget when one roster spot remains", () => {
    expect(computeMaxBid(50, 14, 15)).toBe(50);
  });

  it("handles a full roster", () => {
    expect(computeMaxBid(0, 15, 15)).toBe(1);
  });
});

describe("parsePlayerMeta", () => {
  it("decodes a nomination card (R. Odunze)", () => {
    // abbr texts straight off the captured .ys-player card
    const meta = parsePlayerMeta("R. Odunze", ["WR", "Chi", "Bye 10", "Proj $11"]);
    expect(meta).toEqual({ name: "R. Odunze", pos: "WR", nfl: "Chi", bye: 10, proj: 11 });
  });

  it("decodes a result row with no projection (J. Hurts)", () => {
    const meta = parsePlayerMeta("J. Hurts", ["QB", "Phi", "Bye 10"]);
    expect(meta).toEqual({ name: "J. Hurts", pos: "QB", nfl: "Phi", bye: 10, proj: null });
  });

  it("decodes a DST row (name is the city, no bye-style abbr)", () => {
    const meta = parsePlayerMeta("Rams", ["DEF", "Bye 11"]);
    expect(meta.pos).toBe("DEF");
    expect(meta.bye).toBe(11);
  });

  it("tolerates messy input without throwing", () => {
    const meta = parsePlayerMeta("", []);
    expect(meta).toEqual({ name: "", pos: "", nfl: "", bye: null, proj: null });
  });
});

describe("isPosition", () => {
  it("narrows the fantasy positions", () => {
    expect(isPosition("WR")).toBe(true);
    expect(isPosition("QB")).toBe(true);
    expect(isPosition("LAR")).toBe(false);
    expect(isPosition("")).toBe(false);
  });
});
