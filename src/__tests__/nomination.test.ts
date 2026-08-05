import { describe, expect, it } from "vitest";

import { DEFAULT_MIN_FADE_DISCOUNT, nominationSuggest } from "../engine/alerts.js";
import type { DraftState, Nomination, Player, Position, TeamState } from "../types.js";

const ALL_STARTERS: Position[] = ["QB", "RB", "RB", "WR", "WR", "TE", "K", "DEF"];

function player(
  name: string,
  pos: Position,
  marketValue: number,
  overrides: Partial<Player> = {},
): Player {
  return {
    id: `${name}-${pos}`.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    name,
    pos,
    team: "",
    projMedian: 0,
    marketValue,
    positionRank: 1,
    tier: 1,
    ...overrides,
  };
}

function entry(pos: Position, id: string): { playerId: string; pos: Position; price: number } {
  return { playerId: id, pos, price: 1 };
}

// All starter floors met (mustFill === []).
function solidTeam(id: string, isMe = false, budget = 150): TeamState {
  return {
    id,
    name: isMe ? "You" : id,
    isMe,
    budgetRemaining: budget,
    openRosterSpots: 7,
    roster: ALL_STARTERS.map((p, i) => entry(p, `${id}-${p}-${i}`)),
    spent: ALL_STARTERS.length,
  };
}

// Every starter floor met EXCEPT `need` -> mustFill === [{ need, 1 }].
function rivalNeeding(id: string, need: Position): TeamState {
  const filled = ALL_STARTERS.filter((p) => p !== need);
  return {
    id,
    name: id,
    isMe: false,
    budgetRemaining: 100,
    openRosterSpots: 8,
    roster: filled.map((p, i) => entry(p, `${id}-${p}-${i}`)),
    spent: filled.length,
  };
}

const meSolid = (budget = 150): TeamState => solidTeam("me", true, budget);

function state(teams: TeamState[], sold: DraftState["sold"] = []): DraftState {
  return { phase: "NOMINATING", teams, sold, inflation: 1 };
}

describe("nominationSuggest — guards", () => {
  it("notes when there is no 'you' team", () => {
    const s = nominationSuggest(state([rivalNeeding("r1", "QB")]), [player("X", "QB", 40)]);
    expect(s.poisonPill).toEqual([]);
    expect(s.note).toMatch(/you/);
  });

  it("notes when rankings aren't loaded", () => {
    const s = nominationSuggest(state([meSolid()]), []);
    expect(s.note).toMatch(/rankings/i);
  });

  it("notes when nothing is left to nominate", () => {
    const p = player("X", "QB", 40);
    const s = nominationSuggest(state([meSolid()], [{ playerId: p.id, price: 5, teamId: "me" }]), [
      p,
    ]);
    expect(s.note).toMatch(/nothing/i);
  });
});

describe("nominationSuggest — poison-pill", () => {
  it("nominates a high-value player rivals are forced to need and I don't", () => {
    const elite = player("Elite QB", "QB", 60);
    const s = nominationSuggest(
      state([meSolid(), rivalNeeding("r1", "QB"), rivalNeeding("r2", "QB")]),
      [elite, player("My RB", "RB", 30, { target: true })],
    );
    expect(s.poisonPill.map((c) => c.name)).toContain("Elite QB");
    const pill = s.poisonPill.find((c) => c.name === "Elite QB");
    expect(pill?.reason).toMatch(/2 rivals must fill QB/);
    // Not my target, not a position I need -> not a cold-market snipe.
    expect(s.coldMarket.map((c) => c.name)).not.toContain("Elite QB");
  });

  it("excludes my own targets from the poison-pill", () => {
    const target = player("Want QB", "QB", 60, { target: true });
    const s = nominationSuggest(state([meSolid(), rivalNeeding("r1", "QB")]), [target]);
    expect(s.poisonPill).toEqual([]);
  });

  it("skips cheap players (not worth draining a rival for)", () => {
    const cheap = player("Cheap QB", "QB", 2);
    const s = nominationSuggest(state([meSolid(), rivalNeeding("r1", "QB")]), [cheap]);
    expect(s.poisonPill).toEqual([]);
  });

  it("respects the limit option", () => {
    const pool = [
      player("Q1", "QB", 60),
      player("Q2", "QB", 55),
      player("Q3", "QB", 50),
      player("Q4", "QB", 45),
    ];
    const s = nominationSuggest(
      state([meSolid(), rivalNeeding("r1", "QB"), rivalNeeding("r2", "QB")]),
      pool,
      { limit: 2 },
    );
    expect(s.poisonPill.length).toBe(2);
    expect(s.poisonPill.map((c) => c.name)).toEqual(["Q1", "Q2"]); // value order
  });
});

describe("nominationSuggest — cold-market snipe", () => {
  it("nominates my target when no rival is forced at the position", () => {
    const target = player("My WR", "WR", 30, { target: true });
    const s = nominationSuggest(state([meSolid(), rivalNeeding("r1", "QB")]), [target]);
    expect(s.coldMarket.map((c) => c.name)).toContain("My WR");
    expect(s.coldMarket.find((c) => c.name === "My WR")?.reason).toMatch(
      /no rival is forced at WR/,
    );
  });

  it("won't suggest a target I can't afford", () => {
    const pricey = player("Pricey WR", "WR", 200, { target: true });
    const s = nominationSuggest(state([meSolid(20), rivalNeeding("r1", "QB")]), [pricey]);
    expect(s.coldMarket).toEqual([]);
  });

  it("won't snipe my target when the market is hot (>= 2 rivals forced)", () => {
    const target = player("My QB", "QB", 30, { target: true });
    const s = nominationSuggest(
      state([meSolid(), rivalNeeding("r1", "QB"), rivalNeeding("r2", "QB")]),
      [target],
    );
    expect(s.coldMarket).toEqual([]);
  });

  it("also covers a position I'm forced to fill, not just flagged targets", () => {
    // I need a TE; no rival does -> cheap acquire.
    const meNeedingTe: TeamState = {
      ...meSolid(),
      roster: ALL_STARTERS.filter((p) => p !== "TE").map((p, i) => entry(p, `me-${p}-${i}`)),
    };
    const te = player("Solid TE", "TE", 12);
    const s = nominationSuggest(state([meNeedingTe, rivalNeeding("r1", "QB")]), [te]);
    expect(s.coldMarket.map((c) => c.name)).toContain("Solid TE");
    expect(s.coldMarket[0]?.reason).toMatch(/You need a TE/);
  });
});

describe("nominationSuggest — Fade handling (T4)", () => {
  // I still need a TE (floor unmet); the only TE left is a fade. Fades are
  // excluded from ACQUIRE (cold-market) but stay eligible for DRAIN
  // (poison-pill), per Gretch: a fade you don't want is an ideal poison-pill.
  function needTe(): TeamState {
    return {
      ...meSolid(),
      roster: ALL_STARTERS.filter((p) => p !== "TE").map((p, i) => entry(p, `me-${p}-${i}`)),
    };
  }
  function bidding(teams: TeamState[], nominee: Player, currentBid: number): DraftState {
    const nomination: Nomination = {
      playerId: nominee.id,
      name: nominee.name,
      pos: nominee.pos,
      currentBid,
    };
    return { ...state(teams), phase: "BIDDING", nomination };
  }

  it("default minFadeDiscount is 0.4", () => {
    expect(DEFAULT_MIN_FADE_DISCOUNT).toBe(0.4);
  });

  it("excludes a Fade from cold-market acquire even when it's a must-fill", () => {
    const fadeTe = player("Fade TE", "TE", 12, { fade: true });
    const s = nominationSuggest(state([needTe(), rivalNeeding("r1", "QB")]), [fadeTe]);
    expect(s.coldMarket).toEqual([]);
  });

  it("still suggests a Fade as a poison-pill (drain, not acquire)", () => {
    const fadeQb = player("Fade QB", "QB", 60, { fade: true });
    const s = nominationSuggest(
      state([meSolid(), rivalNeeding("r1", "QB"), rivalNeeding("r2", "QB")]),
      [fadeQb],
    );
    expect(s.poisonPill.map((c) => c.name)).toContain("Fade QB");
    expect(s.coldMarket.map((c) => c.name)).not.toContain("Fade QB");
  });

  it("admits a Fade to cold-market when the live discount is deep", () => {
    const fadeTe = player("Fade TE", "TE", 12, { fade: true });
    // bid 5 vs adjusted 12 -> discount 7/12 ≈ 0.58 ≥ 0.4.
    const s = nominationSuggest(bidding([needTe(), rivalNeeding("r1", "QB")], fadeTe, 5), [fadeTe]);
    expect(s.coldMarket.map((c) => c.name)).toContain("Fade TE");
    expect(s.coldMarket[0]?.reason).toMatch(/deep discount overrides the fade tag/);
  });

  it("keeps a Fade out of cold-market when the live discount is shallow", () => {
    const fadeTe = player("Fade TE", "TE", 12, { fade: true });
    // bid 9 vs adjusted 12 -> discount 0.25 < 0.4 -> excluded.
    const s = nominationSuggest(bidding([needTe(), rivalNeeding("r1", "QB")], fadeTe, 9), [fadeTe]);
    expect(s.coldMarket).toEqual([]);
  });

  it("honors a custom minFadeDiscount", () => {
    const fadeTe = player("Fade TE", "TE", 12, { fade: true });
    // discount 0.25; default 0.4 excludes it, but 0.2 admits it.
    const s = nominationSuggest(
      bidding([needTe(), rivalNeeding("r1", "QB")], fadeTe, 9),
      [fadeTe],
      { minFadeDiscount: 0.2 },
    );
    expect(s.coldMarket.map((c) => c.name)).toContain("Fade TE");
  });
});

describe("nominationSuggest — scare-nominate", () => {
  it("nominates the last of a thin tier that rivals still need", () => {
    // Two tier-1 QBs; sell one so the tier is down to its last player (cliff).
    const q1 = player("QB One", "QB", 55, { tier: 1, positionRank: 1 });
    const q2 = player("QB Two", "QB", 50, { tier: 1, positionRank: 2 });
    const deeper = player("QB Three", "QB", 20, { tier: 2, positionRank: 3 });
    const s = nominationSuggest(
      state([meSolid(), rivalNeeding("r1", "QB")], [{ playerId: q2.id, price: 5, teamId: "r1" }]),
      [q1, q2, deeper],
    );
    expect(s.scareNominate.map((c) => c.name)).toContain("QB One");
    expect(s.scareNominate.find((c) => c.name === "QB One")?.reason).toMatch(
      /Last of the top QB tier/,
    );
  });

  it("won't scare-nominate a tier nobody is forced to need", () => {
    const q1 = player("QB One", "QB", 55, { tier: 1, positionRank: 1 });
    const q2 = player("QB Two", "QB", 50, { tier: 1, positionRank: 2 });
    const s = nominationSuggest(
      state([meSolid(), solidTeam("r1")], [{ playerId: q2.id, price: 5, teamId: "r1" }]),
      [q1, q2],
    );
    expect(s.scareNominate).toEqual([]);
  });
});

describe("nominationSuggest — top pick + note", () => {
  it("prefers a cold-market snipe over a poison-pill when both exist", () => {
    const target = player("My WR", "WR", 30, { target: true });
    const pill = player("Elite QB", "QB", 60);
    const s = nominationSuggest(state([meSolid(), rivalNeeding("r1", "QB")]), [target, pill]);
    expect(s.top?.strategy).toBe("cold-market");
    expect(s.top?.name).toBe("My WR");
  });

  it("falls back to poison-pill when no cold-market target is available", () => {
    const pill = player("Elite QB", "QB", 60);
    const s = nominationSuggest(state([meSolid(), rivalNeeding("r1", "QB")]), [pill]);
    expect(s.top?.strategy).toBe("poison-pill");
  });

  it("leaves a note when nothing fires", () => {
    const s = nominationSuggest(state([meSolid(), solidTeam("r1")]), [player("Some QB", "QB", 40)]);
    expect(s.top).toBeUndefined();
    expect(s.note).toBeDefined();
  });
});
