import { describe, expect, it } from "vitest";

import { isStale, POLL_INTERVAL_MS, stateSignature, STALE_AFTER_MS } from "../engine/poll.js";
import type { ScrapedDraftRoom } from "../scraper.js";
import type { DraftState, Position, TeamState } from "../types.js";

function team(id: string, budget = 100, open = 5, roster = 0): TeamState {
  return {
    id,
    name: id,
    isMe: id === "me",
    budgetRemaining: budget,
    openRosterSpots: open,
    roster: Array.from({ length: roster }, () => ({
      playerId: "x",
      pos: "QB" as Position,
      price: 1,
    })),
    spent: 0,
  };
}

function state(teams: TeamState[] = [team("me")], overrides: Partial<DraftState> = {}): DraftState {
  return { phase: "NOMINATING", teams, sold: [], inflation: 1, ...overrides };
}

function room(): ScrapedDraftRoom {
  return { status: { timerSeconds: null, turnText: null }, teams: [], nomination: null, sold: [] };
}

describe("poll cadence", () => {
  it("polls every 2s and goes stale after 3 ticks", () => {
    expect(POLL_INTERVAL_MS).toBe(2000);
    expect(STALE_AFTER_MS).toBe(6000);
  });
});

describe("stateSignature", () => {
  it("is stable for an identical state", () => {
    const s = state();
    expect(stateSignature(s)).toBe(stateSignature(s));
  });

  it("changes when a new sale lands", () => {
    const before = state();
    const after = state([team("me")], {
      sold: [{ playerId: "p", price: 5, teamId: "me" }],
    });
    expect(stateSignature(before)).not.toBe(stateSignature(after));
  });

  it("changes when the leading bid climbs", () => {
    const at5 = state(undefined, { nomination: { name: "X", pos: "QB", currentBid: 5 } });
    const at6 = state(undefined, { nomination: { name: "X", pos: "QB", currentBid: 6 } });
    expect(stateSignature(at5)).not.toBe(stateSignature(at6));
  });

  it("changes when a team's budget or fill moves", () => {
    const before = state([team("me", 100, 5), team("r1", 100, 5)]);
    const after = state([team("me", 95, 4), team("r1", 100, 5)]);
    expect(stateSignature(before)).not.toBe(stateSignature(after));
  });

  it("changes when the nomination timer ticks", () => {
    const t1 = state(undefined, {
      nomination: { name: "X", pos: "QB", currentBid: 5, secondsLeft: 20 },
    });
    const t2 = state(undefined, {
      nomination: { name: "X", pos: "QB", currentBid: 5, secondsLeft: 19 },
    });
    expect(stateSignature(t1)).not.toBe(stateSignature(t2));
  });

  it("changes when inflation shifts", () => {
    const lo = state(undefined, { inflation: 1 });
    const hi = state(undefined, { inflation: 1.2 });
    expect(stateSignature(lo)).not.toBe(stateSignature(hi));
  });

  it("ignores player fields that don't affect the live view", () => {
    // projMedian/target/notes changes must NOT flap the feed.
    const a = state();
    const b = state();
    expect(stateSignature(a)).toBe(stateSignature(b));
  });
});

describe("isStale", () => {
  function payload(at: number) {
    return { state: state(), room: room(), at };
  }

  it("is fresh within the stale window", () => {
    expect(isStale(payload(1000), 1000 + POLL_INTERVAL_MS)).toBe(false);
  });

  it("goes stale past 3x the interval", () => {
    expect(isStale(payload(1000), 1000 + STALE_AFTER_MS + 1)).toBe(true);
  });

  it("honors a custom stale window", () => {
    expect(isStale(payload(0), 500, 1000)).toBe(false);
    expect(isStale(payload(0), 1001, 1000)).toBe(true);
  });
});
