import { describe, expect, it } from "vitest";

import { computeInflation, inferPhase, toDraftState } from "../engine/map-state.js";
import type { ScrapedDraftRoom, ScrapedNomination } from "../scraper.js";
import type { Player, Position } from "../types.js";

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

const NOM: ScrapedNomination = {
  name: "R. Odunze",
  pos: "WR",
  nfl: "Chi",
  bye: 10,
  proj: 11,
  currentBid: 3,
  leadingTeamName: "Billy",
  yourMaxBid: 179,
  yourBudget: 192,
  overBudget: false,
};

// A capture-accurate room: two teams, two sales, no active nomination.
function room(overrides: Partial<ScrapedDraftRoom> = {}): ScrapedDraftRoom {
  return {
    status: { timerSeconds: null, turnText: null },
    teams: [
      { id: "me", name: "You", isMe: true, budget: 192, filled: 1, rosterSize: 15, maxBid: 179 },
      { id: "b1", name: "Billy", isMe: false, budget: 188, filled: 2, rosterSize: 15, maxBid: 175 },
    ],
    nomination: null,
    sold: [
      {
        name: "J. Hurts",
        pos: "QB",
        nfl: "Phi",
        bye: 10,
        proj: null,
        pick: 1,
        price: 8,
        winnerName: "Your Team",
      },
      {
        name: "C. McCaffrey",
        pos: "RB",
        nfl: "SF",
        bye: 8,
        proj: null,
        pick: 2,
        price: 12,
        winnerName: "Billy",
      },
    ],
    ...overrides,
  };
}

describe("toDraftState", () => {
  const rankings = [player("Jalen Hurts", "QB", 60), player("Christian McCaffrey", "RB", 65)];

  it("maps winner display names to team ids (Your Team -> me)", () => {
    const ds = toDraftState(room(), { players: rankings });
    expect(ds.sold[0]).toEqual({ playerId: "jalen-hurts-qb", price: 8, teamId: "me" });
    expect(ds.sold[1]).toEqual({ playerId: "christian-mccaffrey-rb", price: 12, teamId: "b1" });
  });

  it("rebuilds the me-team's roster + spent from the sold feed", () => {
    const ds = toDraftState(room(), { players: rankings });
    const me = ds.teams.find((t) => t.isMe);
    expect(me?.budgetRemaining).toBe(192);
    expect(me?.openRosterSpots).toBe(14);
    expect(me?.spent).toBe(8);
    expect(me?.roster).toEqual([{ playerId: "jalen-hurts-qb", pos: "QB", price: 8 }]);
  });

  it("rebuilds an opponent's roster + spent from the sold feed", () => {
    const ds = toDraftState(room(), { players: rankings });
    const billy = ds.teams.find((t) => t.id === "b1");
    expect(billy?.spent).toBe(12);
    expect(billy?.roster).toEqual([{ playerId: "christian-mccaffrey-rb", pos: "RB", price: 12 }]);
  });

  it("slugs a stable id for players not present in rankings", () => {
    const ds = toDraftState(room());
    expect(ds.sold[0]?.playerId).toBe("j-hurts-qb");
    expect(ds.sold[1]?.playerId).toBe("c-mccaffrey-rb");
  });

  it("maps an active nomination with the live timer", () => {
    const ds = toDraftState(
      room({
        status: { timerSeconds: 18, turnText: "8 nominations until your turn" },
        nomination: NOM,
      }),
    );
    expect(ds.phase).toBe("BIDDING");
    expect(ds.nomination).toEqual({
      playerId: undefined,
      name: "R. Odunze",
      pos: "WR",
      currentBid: 3,
      leadingTeamId: "b1",
      secondsLeft: 18,
    });
  });

  it("defaults secondsLeft to undefined when there is no timer", () => {
    const ds = toDraftState(room({ nomination: NOM }));
    expect(ds.nomination?.secondsLeft).toBeUndefined();
  });

  it("leaves a winner teamId blank when the display name is unknown", () => {
    const ds = toDraftState(
      room({
        sold: [
          {
            name: "J. Hurts",
            pos: "QB",
            nfl: "Phi",
            bye: 10,
            proj: null,
            pick: 1,
            price: 8,
            winnerName: "Ghost Team",
          },
        ],
      }),
    );
    expect(ds.sold.at(0)?.teamId).toBe("");
  });
});

describe("inferPhase", () => {
  it("is PRE before any sale or nomination", () => {
    const r: ScrapedDraftRoom = {
      status: { timerSeconds: null, turnText: null },
      teams: [
        { id: "me", name: "You", isMe: true, budget: 200, filled: 0, rosterSize: 15, maxBid: 200 },
      ],
      nomination: null,
      sold: [],
    };
    expect(inferPhase(r, false)).toBe("PRE");
  });

  it("is BIDDING when a nomination is live", () => {
    expect(inferPhase(room({ nomination: NOM }), false)).toBe("BIDDING");
  });

  it("is DONE when every team is full", () => {
    const r: ScrapedDraftRoom = {
      status: { timerSeconds: null, turnText: null },
      teams: [
        { id: "me", name: "You", isMe: true, budget: 5, filled: 15, rosterSize: 15, maxBid: 1 },
        { id: "b1", name: "Billy", isMe: false, budget: 5, filled: 15, rosterSize: 15, maxBid: 1 },
      ],
      nomination: null,
      sold: [],
    };
    expect(inferPhase(r, true)).toBe("DONE");
  });

  it("is NOMINATING between bids (sold but nothing on the block)", () => {
    expect(inferPhase(room(), false)).toBe("NOMINATING");
  });
});

describe("computeInflation", () => {
  it("is 1.0 when there are no rankings", () => {
    expect(computeInflation([], [], 200, 12)).toBe(1);
  });

  it("is money-remaining / value-remaining", () => {
    const pool = [player("Mahomes", "QB", 95), player("Allen", "QB", 95)]; // value 190
    const sold = [{ playerId: "someone-else", price: 20, teamId: "t" }]; // not in pool
    // money 200*2 - 20 = 380; value 190 -> 2.0
    expect(computeInflation(sold, pool, 200, 2)).toBeCloseTo(2, 5);
  });

  it("excludes already-sold players' value from the remaining pool", () => {
    const pool = [player("Mahomes", "QB", 70), player("Allen", "QB", 70)];
    const sold = [{ playerId: "mahomes-qb", price: 20, teamId: "t" }];
    // money 380; unsold value 70 (Allen only) -> 380/70
    expect(computeInflation(sold, pool, 200, 2)).toBeCloseTo(380 / 70, 5);
  });

  it("floors to 1 when no unsold value remains", () => {
    expect(computeInflation([], [player("A", "QB", 0)], 200, 12)).toBe(1);
  });
});
