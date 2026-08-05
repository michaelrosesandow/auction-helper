import { describe, expect, it } from "vitest";

import {
  DEFAULT_TARGET_FADE_DELTA,
  DEFAULT_VALUE_THRESHOLD,
  endgameLeverage,
  indexTierFlags,
  maxBidOf,
  opponentNeeds,
  ROSTER_FLOORS,
  tallyPositions,
  teamNeeds,
  tierCliff,
  valueAlert,
} from "../engine/alerts.js";
import type { DraftState, Nomination, Player, Position, TeamState, Tier } from "../types.js";

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

describe("valueAlert — Target/Fade price-sensitivity (T4)", () => {
  // Same market value (40) so only the tag differs; adjusted market = 40 at
  // inflation 1. Neutral ceiling = 0.7*40 = 28.
  const neutral = player("Neutral", "QB", 40);
  const target = { ...player("Target", "QB", 40), target: true };
  const fade = { ...player("Fade", "QB", 40), fade: true };

  it("default delta is 0.1 (10 percentage points)", () => {
    expect(DEFAULT_TARGET_FADE_DELTA).toBe(0.1);
  });

  it("a Target flags as value at a smaller discount than a neutral player", () => {
    // bid 30 = 25% off. Neutral ceiling 28 -> not value; Target ceiling 32 -> value.
    expect(valueAlert(withNom(neutral, 30), [neutral])?.isValue).toBe(false);
    const a = valueAlert(withNom(target, 30), [target]);
    expect(a?.threshold).toBeCloseTo(0.8, 10);
    expect(a?.valueCeiling).toBeCloseTo(32, 10);
    expect(a?.isValue).toBe(true);
  });

  it("a Fade only flags as value at a steep discount", () => {
    // Fade ceiling 0.6*40 = 24. bid 26 (35% off) still not value; bid 20 (50%) is.
    expect(valueAlert(withNom(fade, 26), [fade])?.isValue).toBe(false);
    const a = valueAlert(withNom(fade, 20), [fade]);
    expect(a?.threshold).toBeCloseTo(0.6, 10);
    expect(a?.valueCeiling).toBeCloseTo(24, 10);
    expect(a?.isValue).toBe(true);
  });

  it("honors a custom targetFadeDelta", () => {
    // delta 0.2 -> Target threshold 0.9 -> ceiling 36; bid 34 now a value.
    const a = valueAlert(withNom(target, 34), [target], { targetFadeDelta: 0.2 });
    expect(a?.threshold).toBeCloseTo(0.9, 10);
    expect(a?.isValue).toBe(true);
    // Same bid, default delta 0.1 -> ceiling 32 -> not value.
    expect(valueAlert(withNom(target, 34), [target])?.isValue).toBe(false);
  });

  it("clamps the effective threshold to [0, 1]", () => {
    // Target delta 0.5 -> 1.2 clamped to 1.0 -> ceiling = adjusted (40).
    const up = valueAlert(withNom(target, 38), [target], { targetFadeDelta: 0.5 });
    expect(up?.threshold).toBe(1);
    expect(up?.valueCeiling).toBeCloseTo(40, 10);
    expect(up?.isValue).toBe(true);
    // Fade delta 0.9 -> -0.2 clamped to 0 -> ceiling 0 -> never value.
    const down = valueAlert(withNom(fade, 1), [fade], { targetFadeDelta: 0.9 });
    expect(down?.threshold).toBe(0);
    expect(down?.isValue).toBe(false);
  });

  it("does not move the median projection (threshold-only adjustment)", () => {
    // The shift changes the ceiling/threshold, never the adjusted market value.
    const n = valueAlert(withNom(neutral, 10), [neutral]);
    const t = valueAlert(withNom(target, 10), [target]);
    const f = valueAlert(withNom(fade, 10), [fade]);
    expect(n?.adjustedMarketValue).toBe(40);
    expect(t?.adjustedMarketValue).toBe(40);
    expect(f?.adjustedMarketValue).toBe(40);
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

describe("indexTierFlags (T5)", () => {
  it("indexes only tiers carrying a structural flag", () => {
    const idx = indexTierFlags([
      { pos: "RB", tier: 1, playerIds: [] },
      { pos: "RB", tier: 3, playerIds: [], bigBreakAfter: true },
      { pos: "RB", tier: 4, playerIds: [], deadZone: true },
    ]);
    expect(idx.has("RB:1")).toBe(false);
    expect(idx.get("RB:3")).toEqual({ bigBreakAfter: true, deadZone: false });
    expect(idx.get("RB:4")).toEqual({ bigBreakAfter: false, deadZone: true });
  });
});

describe("tierCliff — structural flags (T5)", () => {
  // RB: tier 3 carries a Big Break; tier 4 is the Dead Zone that follows it.
  const rbs = [
    tiered("RB3a", "RB", 3, 5),
    tiered("RB3b", "RB", 3, 6),
    tiered("RB4a", "RB", 4, 7),
    tiered("RB4b", "RB", 4, 8),
  ];
  const tiers: Tier[] = [
    { pos: "RB", tier: 3, playerIds: ["rb3a-rb", "rb3b-rb"], bigBreakAfter: true },
    { pos: "RB", tier: 4, playerIds: ["rb4a-rb", "rb4b-rb"], deadZone: true },
  ];
  const me = draftState([makeTeam("me", { isMe: true })]);

  it("flags beforeDeadZone when the top remaining tier carries a Big Break", () => {
    const rb = tierCliff(me, rbs, tiers).find((c) => c.pos === "RB");
    expect(rb?.tier).toBe(3);
    expect(rb?.beforeDeadZone).toBe(true);
    expect(rb?.inDeadZone).toBeUndefined();
  });

  it("flags inDeadZone once the board drops into the Dead Zone tier", () => {
    const state = draftState(
      [makeTeam("me", { isMe: true })],
      [
        { playerId: "rb3a-rb", price: 20, teamId: "me" },
        { playerId: "rb3b-rb", price: 18, teamId: "me" },
      ],
    );
    const rb = tierCliff(state, rbs, tiers).find((c) => c.pos === "RB");
    expect(rb?.tier).toBe(4);
    expect(rb?.inDeadZone).toBe(true);
    expect(rb?.beforeDeadZone).toBeUndefined();
  });

  it("leaves structural fields unset when no tier data is supplied (back-compat)", () => {
    const rb = tierCliff(me, rbs).find((c) => c.pos === "RB");
    expect(rb?.beforeDeadZone).toBeUndefined();
    expect(rb?.inDeadZone).toBeUndefined();
    // Scarcity flag still works unchanged.
    expect(rb?.isCliff).toBe(false);
  });

  it("keeps the scarcity cliff flag independent of the structural flags", () => {
    // Sell one of the two tier-3 RBs -> tier 3 is down to its last player
    // (isCliff) AND still carries the Big Break (beforeDeadZone).
    const state = draftState(
      [makeTeam("me", { isMe: true })],
      [{ playerId: "rb3a-rb", price: 20, teamId: "me" }],
    );
    const rb = tierCliff(state, rbs, tiers).find((c) => c.pos === "RB");
    expect(rb?.tier).toBe(3);
    expect(rb?.remaining).toBe(1);
    expect(rb?.isCliff).toBe(true);
    expect(rb?.beforeDeadZone).toBe(true);
  });
});
