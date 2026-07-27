import { describe, expect, it } from "vitest";

import {
  DEFAULT_VALUE_THRESHOLD,
  endgameLeverage,
  maxBidOf,
  opponentNeeds,
  ROSTER_FLOORS,
  tallyPositions,
  teamNeeds,
  tierCliff,
  valueAlert,
} from "../engine/alerts.js";
import type { DraftState, Nomination, Player, Position, TeamState } from "../types.js";

function player(name: string, pos: Position, marketValue: number): Player {
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

function makeTeam(id: string, overrides: Partial<Omit<TeamState, "id">> = {}): TeamState {
  return {
    id,
    name: id,
    isMe: false,
    budgetRemaining: 100,
    openRosterSpots: 5,
    roster: [],
    spent: 0,
    ...overrides,
  };
}

function tiered(name: string, pos: Position, tier: number, rank: number): Player {
  return {
    id: `${name}-${pos}`.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    name,
    pos,
    team: "",
    projMedian: 0,
    marketValue: 0,
    positionRank: rank,
    tier,
  };
}

function picked(pos: Position): { playerId: string; pos: Position; price: number } {
  return { playerId: `${pos.toLowerCase()}-pick`, pos, price: 1 };
}

function draftState(teams: TeamState[], sold: DraftState["sold"] = []): DraftState {
  return { phase: "NOMINATING", teams, sold, inflation: 1 };
}

function meState(sold: DraftState["sold"] = []): DraftState {
  return draftState([makeTeam("me", { isMe: true })], sold);
}

describe("roster floors", () => {
  it("encodes the Superflex starter minimums", () => {
    expect(ROSTER_FLOORS).toEqual({ QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DEF: 1 });
  });
});

describe("maxBidOf", () => {
  it("matches Yahoo's Max Offer (budget 12, 9 open spots -> 4)", () => {
    expect(maxBidOf(makeTeam("t", { budgetRemaining: 12, openRosterSpots: 9 }))).toBe(4);
  });

  it("floors at 1 when nearly tapped out", () => {
    expect(maxBidOf(makeTeam("t", { budgetRemaining: 2, openRosterSpots: 9 }))).toBe(1);
  });

  it("equals budget when one roster spot remains", () => {
    expect(maxBidOf(makeTeam("t", { budgetRemaining: 50, openRosterSpots: 1 }))).toBe(50);
  });
});

describe("tallyPositions", () => {
  it("counts acquired players per position", () => {
    expect(tallyPositions([picked("QB"), picked("QB"), picked("RB")])).toEqual({
      QB: 2,
      RB: 1,
      WR: 0,
      TE: 0,
      K: 0,
      DEF: 0,
    });
  });
});

describe("teamNeeds", () => {
  it("lists every required position for an empty roster", () => {
    const needs = teamNeeds(
      makeTeam("t", { budgetRemaining: 200, openRosterSpots: 15, roster: [] }),
    );
    expect(needs.mustFill).toEqual([
      { pos: "QB", count: 1 },
      { pos: "RB", count: 2 },
      { pos: "WR", count: 2 },
      { pos: "TE", count: 1 },
      { pos: "K", count: 1 },
      { pos: "DEF", count: 1 },
    ]);
    expect(needs.maxBid).toBe(186); // 200 - (15 - 1)
    expect(needs.isFull).toBe(false);
  });

  it("clears a position once its floor is met", () => {
    const roster = [
      picked("QB"),
      picked("RB"),
      picked("RB"),
      picked("WR"),
      picked("WR"),
      picked("TE"),
      picked("K"),
      picked("DEF"),
    ];
    const needs = teamNeeds(makeTeam("t", { roster, openRosterSpots: 7 }));
    expect(needs.mustFill).toEqual([]);
  });

  it("flags a boxed-in team (mustFill exceeds open spots)", () => {
    const needs = teamNeeds(
      makeTeam("t", {
        openRosterSpots: 2,
        roster: [picked("RB"), picked("RB"), picked("WR"), picked("WR"), picked("TE")],
      }),
    );
    const totalMust = needs.mustFill.reduce((acc, n) => acc + n.count, 0);
    // Needs QB + K + DEF (3) but has only 2 open spots.
    expect(totalMust).toBe(3);
    expect(totalMust).toBeGreaterThan(needs.openRosterSpots);
  });

  it("reports isFull when no roster spots remain", () => {
    const needs = teamNeeds(makeTeam("t", { openRosterSpots: 0 }));
    expect(needs.isFull).toBe(true);
    expect(needs.maxBid).toBe(0);
  });
});

describe("opponentNeeds", () => {
  it("returns needs for every non-me team, in order", () => {
    const needs = opponentNeeds(
      draftState([makeTeam("me", { isMe: true }), makeTeam("r1"), makeTeam("r2")]),
    );
    expect(needs.map((n) => n.teamId)).toEqual(["r1", "r2"]);
  });
});

describe("endgameLeverage", () => {
  const POOL = [
    player("Alpha", "QB", 60),
    player("Beta", "RB", 40),
    player("Gamma", "WR", 20),
    player("Delta", "TE", 8),
  ];

  it("flags targets only I can afford when I dominate", () => {
    const lev = endgameLeverage(
      draftState([
        makeTeam("me", { isMe: true, budgetRemaining: 50, openRosterSpots: 1 }),
        makeTeam("r1", { budgetRemaining: 10, openRosterSpots: 1 }),
        makeTeam("r2", { budgetRemaining: 5, openRosterSpots: 1 }),
      ]),
      POOL,
    );
    expect(lev.myMaxBid).toBe(50);
    expect(lev.topRivalMaxBid).toBe(10);
    expect(lev.iDominate).toBe(true);
    // Gap (10, 50]: Beta(40), Gamma(20). Alpha(60) is above my max; Delta(8) at/below the rival.
    expect(lev.uniquelyAffordable.map((p) => p.name)).toEqual(["Beta", "Gamma"]);
  });

  it("reports nothing affordable when I'm capped", () => {
    const lev = endgameLeverage(
      draftState([
        makeTeam("me", { isMe: true, budgetRemaining: 5, openRosterSpots: 1 }),
        makeTeam("r1", { budgetRemaining: 50, openRosterSpots: 1 }),
      ]),
      POOL,
    );
    expect(lev.iAmCapped).toBe(true);
    expect(lev.uniquelyAffordable).toEqual([]);
  });

  it("excludes already-sold players from the affordable set", () => {
    const lev = endgameLeverage(
      draftState(
        [
          makeTeam("me", { isMe: true, budgetRemaining: 50, openRosterSpots: 1 }),
          makeTeam("r1", { budgetRemaining: 10, openRosterSpots: 1 }),
        ],
        [{ playerId: "beta-rb", price: 5, teamId: "r1" }],
      ),
      POOL,
    );
    expect(lev.uniquelyAffordable.map((p) => p.name)).toEqual(["Gamma"]); // Beta is sold
  });
});

function withNom(
  target: Player,
  currentBid: number,
  inflation = 1,
  extra: Partial<DraftState> = {},
): DraftState {
  const nomination: Nomination = {
    playerId: target.id,
    name: target.name,
    pos: target.pos,
    currentBid,
  };
  return {
    phase: "BIDDING",
    teams: [makeTeam("me", { isMe: true })],
    sold: [],
    inflation,
    nomination,
    ...extra,
  };
}

describe("valueAlert", () => {
  const star = player("Star", "QB", 40);

  it("defaults threshold to 70% of inflation-adjusted market value", () => {
    expect(DEFAULT_VALUE_THRESHOLD).toBe(0.7);
    const a = valueAlert(withNom(star, 20), [star]);
    // adjusted = 40; ceiling = 28; bid 20 < 28 -> value
    expect(a).not.toBeNull();
    expect(a?.adjustedMarketValue).toBe(40);
    expect(a?.valueCeiling).toBeCloseTo(28, 10);
    expect(a?.isValue).toBe(true);
  });

  it("is not a value once the bid reaches or passes the ceiling", () => {
    // ceiling = 0.7 * 40 = 28; equality is NOT a value (strictly <).
    expect(valueAlert(withNom(star, 28), [star])?.isValue).toBe(false);
    expect(valueAlert(withNom(star, 35), [star])?.isValue).toBe(false);
  });

  it("applies live inflation to the market value", () => {
    // inflation 1.5 -> adjusted 60; ceiling 42; bid 30 still a value.
    const a = valueAlert(withNom(star, 30, 1.5), [star]);
    expect(a?.adjustedMarketValue).toBe(60);
    expect(a?.valueCeiling).toBeCloseTo(42, 10);
    expect(a?.isValue).toBe(true);
  });

  it("a stricter threshold can flip a non-value into a value", () => {
    // bid 30 vs value 40: default 0.7 -> ceiling 28 -> NOT a value.
    expect(valueAlert(withNom(star, 30), [star])?.isValue).toBe(false);
    // 0.9 -> ceiling 36 -> 30 < 36 -> IS a value.
    const a = valueAlert(withNom(star, 30), [star], { threshold: 0.9 });
    expect(a?.threshold).toBe(0.9);
    expect(a?.valueCeiling).toBeCloseTo(36, 10);
    expect(a?.isValue).toBe(true);
  });

  it("reports a signed discount vs the full adjusted value", () => {
    // adjusted 40: bid 30 -> +0.25 (25% under); bid 50 -> -0.25 (overpay).
    const low = valueAlert(withNom(star, 30), [star]);
    const high = valueAlert(withNom(star, 50), [star]);
    expect(low?.discount).toBeCloseTo(0.25, 10);
    expect(high?.discount).toBeCloseTo(-0.25, 10);
  });

  it("returns null when nothing is nominated", () => {
    expect(valueAlert(meState(), [star])).toBeNull();
  });

  it("returns null when the nominee is not in the rankings", () => {
    const state: DraftState = {
      phase: "BIDDING",
      teams: [makeTeam("me", { isMe: true })],
      sold: [],
      inflation: 1,
      nomination: { playerId: "unknown-qb", name: "Mystery", pos: "QB", currentBid: 5 },
    };
    expect(valueAlert(state, [star])).toBeNull();
  });

  it("returns null when the scrape failed to resolve a playerId", () => {
    const state: DraftState = {
      phase: "BIDDING",
      teams: [makeTeam("me", { isMe: true })],
      sold: [],
      inflation: 1,
      nomination: { playerId: undefined, name: "Unresolved", pos: "QB", currentBid: 5 },
    };
    expect(valueAlert(state, [star])).toBeNull();
  });

  it("ignores a player with zero market value", () => {
    const free: Player = { ...star, id: "free-qb", name: "Free", marketValue: 0 };
    expect(valueAlert(withNom(free, 1), [free])).toBeNull();
  });
});

describe("tierCliff", () => {
  const qbs = [tiered("QB1a", "QB", 1, 1), tiered("QB1b", "QB", 1, 2), tiered("QB2a", "QB", 2, 3)];
  const rbs = [tiered("RB1", "RB", 1, 1), tiered("RB2", "RB", 2, 2)];

  it("reports the top remaining tier per position with its survivors", () => {
    const cliffs = tierCliff(draftState([makeTeam("me", { isMe: true })]), [...qbs, ...rbs]);
    const qb = cliffs.find((c) => c.pos === "QB");
    expect(qb?.tier).toBe(1);
    expect(qb?.remaining).toBe(2);
    expect(qb?.players.map((p) => p.name)).toEqual(["QB1a", "QB1b"]);
    expect(qb?.isCliff).toBe(false);
  });

  it("flags a cliff when a tier is down to its last player", () => {
    const cliffs = tierCliff(draftState([makeTeam("me", { isMe: true })]), [...qbs, ...rbs]);
    const rb = cliffs.find((c) => c.pos === "RB");
    expect(rb?.tier).toBe(1);
    expect(rb?.remaining).toBe(1);
    expect(rb?.isCliff).toBe(true);
  });

  it("drops to the next tier once the top tier is fully sold", () => {
    const state = draftState(
      [makeTeam("me", { isMe: true })],
      [
        { playerId: "qb1a-qb", price: 30, teamId: "me" },
        { playerId: "qb1b-qb", price: 25, teamId: "me" },
      ],
    );
    const qb = tierCliff(state, qbs).find((c) => c.pos === "QB");
    expect(qb?.tier).toBe(2);
    expect(qb?.remaining).toBe(1);
    expect(qb?.isCliff).toBe(true);
  });

  it("keeps counting a single survivor of a deeper tier as a cliff", () => {
    // Sell one of the two tier-1 QBs; the top tier still has one left -> cliff.
    const state = draftState(
      [makeTeam("me", { isMe: true })],
      [{ playerId: "qb1a-qb", price: 30, teamId: "me" }],
    );
    const qb = tierCliff(state, qbs).find((c) => c.pos === "QB");
    expect(qb?.tier).toBe(1);
    expect(qb?.remaining).toBe(1);
    expect(qb?.players.map((p) => p.name)).toEqual(["QB1b"]);
    expect(qb?.isCliff).toBe(true);
  });

  it("omits positions with no unsold ranked players", () => {
    const cliffs = tierCliff(draftState([makeTeam("me", { isMe: true })]), qbs);
    expect(cliffs.map((c) => c.pos)).toEqual(["QB"]);
  });

  it("emits positions in canonical order", () => {
    const pool = [tiered("K1", "K", 1, 1), tiered("QB1", "QB", 1, 1)];
    const me = draftState([makeTeam("me", { isMe: true })]);
    const cliffs = tierCliff(me, pool);
    expect(cliffs.map((c) => c.pos)).toEqual(["QB", "K"]);
  });

  it("returns nothing for an empty pool", () => {
    expect(tierCliff(meState(), [])).toEqual([]);
  });
});
