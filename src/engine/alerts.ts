// Engine alerts: pure functions over DraftState (+ Rankings where needed)
// that produce the in-draft "edge". No DOM; fully unit-testable.
//
// Implemented:
//   - teamNeeds() / opponentNeeds(): per-rival max bid + positions they are
//     FORCED to draft to field a legal lineup.
//   - endgameLeverage(): "money off the board" — am I the only team who can
//     still afford a top remaining target?
//   - valueAlert(): flag the live nomination going for < X% of its
//     inflation-adjusted market value (the "buy" signal).
//   - tierCliff(): per position, the top remaining tier + a scarcity-premium
//     flag when that tier is down to its last player.
// nominationSuggest() is implemented (pure) and assumes it's the user's turn;
// the live "my turn" DOM detector is still pending a capture (CHECKPOINT.md
// gaps). Everything here is pure + unit-tested.

import type { DraftState, Player, Position, TeamState } from "../types.js";

// Minimum starters a legal Superflex lineup MUST field at each position.
// FLEX (RB/WR/TE) and Superflex (QB/RB/WR/TE) are flexible, so they add no
// position floor; the 5 bench slots are position-agnostic. These are the
// hard floors — "draft this or your roster is illegal".
export const ROSTER_FLOORS: Record<Position, number> = {
  QB: 1,
  RB: 2,
  WR: 2,
  TE: 1,
  K: 1,
  DEF: 1,
};

const POSITIONS: readonly Position[] = ["QB", "RB", "WR", "TE", "K", "DEF"];

// maxBid = budgetRemaining − (openRosterSpots − 1), floored at $1. A full
// roster can't acquire anyone, so it returns 0 (Yahoo's bid UI is gone by
// then). Otherwise matches Yahoo's "Max Offer" and the scraper's computeMaxBid.
export function maxBidOf(team: TeamState): number {
  if (team.openRosterSpots <= 0) {
    return 0;
  }
  return Math.max(team.budgetRemaining - (team.openRosterSpots - 1), 1);
}

export function tallyPositions(roster: readonly { pos: Position }[]): Record<Position, number> {
  const counts: Record<Position, number> = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0 };
  for (const r of roster) {
    counts[r.pos]++;
  }
  return counts;
}

interface PositionNeed {
  pos: Position;
  count: number;
}

export interface TeamNeeds {
  teamId: string;
  name: string;
  maxBid: number;
  openRosterSpots: number;
  // Positions the team is FORCED to draft to field a legal lineup, with how
  // many of each. When these sum above openRosterSpots the team is boxed in
  // (cannot legally fill) — a strong endgame-leverage signal.
  mustFill: PositionNeed[];
  isFull: boolean;
}

export function teamNeeds(team: TeamState): TeamNeeds {
  const counts = tallyPositions(team.roster);
  const mustFill: PositionNeed[] = [];
  for (const pos of POSITIONS) {
    const need = ROSTER_FLOORS[pos] - counts[pos];
    if (need > 0) {
      mustFill.push({ pos, count: need });
    }
  }
  return {
    teamId: team.id,
    name: team.name,
    maxBid: maxBidOf(team),
    openRosterSpots: team.openRosterSpots,
    mustFill,
    isFull: team.openRosterSpots === 0,
  };
}

// Needs for every rival (non-me) team, in draft order.
export function opponentNeeds(state: DraftState): TeamNeeds[] {
  return state.teams.filter((t) => !t.isMe).map((t) => teamNeeds(t));
}

// ── Endgame leverage ──────────────────────────────────────────────────────

interface RivalBid {
  teamId: string;
  name: string;
  maxBid: number;
}

export interface Leverage {
  myMaxBid: number;
  topRivalMaxBid: number;
  rivalBids: RivalBid[];
  // True when I can outbid every rival — I set the endgame price.
  iDominate: boolean;
  // True when the deepest rival can outbid me — avoid bidding wars, snipe cheap.
  iAmCapped: boolean;
  // Remaining ranked targets no rival can afford (marketValue in
  // (topRivalMaxBid, myMaxBid]): I win these for topRivalMaxBid + 1.
  // Empty unless I dominate. Uses raw marketValue for now; an
  // inflation-adjusted variant belongs with valueAlert().
  uniquelyAffordable: Player[];
}

function unsoldPlayers(state: DraftState, players: Player[]): Player[] {
  const sold = new Set(state.sold.map((s) => s.playerId));
  return players.filter((p) => !sold.has(p.id));
}

// ── Value alert ───────────────────────────────────────────────────────────

// Default 70%: flag any live nomination going for under 70% of its
// inflation-adjusted market value. Tunable via ValueAlertOptions.
export const DEFAULT_VALUE_THRESHOLD = 0.7;

export interface ValueAlertOptions {
  /** Fraction of inflation-adjusted market value at/below which the live
   * nomination counts as a value. Default 0.7 (i.e. <70% of market). */
  threshold?: number;
}

export interface ValueAlert {
  playerId: string;
  name: string;
  pos: Position;
  // The current leading bid on the nomination card.
  currentBid: number;
  marketValue: number;
  inflation: number;
  // marketValue × inflation — what this player "should" cost right now.
  adjustedMarketValue: number;
  threshold: number;
  // The most you can pay and still call it a value: threshold × adjusted.
  // Actionable as a hard stop ("bid up to $X").
  valueCeiling: number;
  // Signed discount vs. the FULL adjusted value: +0.3 = 30% under fair value
  // (a deal); −0.2 = 20% over fair value (an overpay). 0 when the player has
  // no market value to compare against.
  discount: number;
  isValue: boolean;
}

// Evaluate the live nomination as a value buy. Returns null when nothing is
// up for bid, the nominee wasn't resolved to a ranked Player, or the player
// has no market value to compare against.
export function valueAlert(
  state: DraftState,
  players: Player[],
  opts: ValueAlertOptions = {},
): ValueAlert | null {
  const nomination = state.nomination;
  if (!nomination || nomination.playerId === undefined) {
    return null;
  }
  const player = players.find((p) => p.id === nomination.playerId);
  if (!player || player.marketValue <= 0) {
    return null;
  }
  const threshold = opts.threshold ?? DEFAULT_VALUE_THRESHOLD;
  const inflation = Number.isFinite(state.inflation) ? state.inflation : 1;
  const adjustedMarketValue = player.marketValue * inflation;
  const valueCeiling = threshold * adjustedMarketValue;
  const currentBid = nomination.currentBid;
  const discount = (adjustedMarketValue - currentBid) / adjustedMarketValue;
  return {
    playerId: player.id,
    name: player.name,
    pos: player.pos,
    currentBid,
    marketValue: player.marketValue,
    inflation,
    adjustedMarketValue,
    threshold,
    valueCeiling,
    discount,
    isValue: currentBid < valueCeiling,
  };
}

// ── Tier / cliff tracking ─────────────────────────────────────────────────

export interface TierCliff {
  pos: Position;
  // The best (lowest-numbered) tier at this position that still has unsold
  // players — "the tier you're currently drafting out of".
  tier: number;
  remaining: number;
  players: Player[];
  // True when only one player is left — the scarcity-premium cliff. Pay up
  // or nominate to secure the last of the tier before it's gone.
  isCliff: boolean;
}

// Per position, the top remaining tier with its survivors and a cliff flag
// when that tier is down to its last player. Positions with no unsold ranked
// players are omitted; output is in canonical position order.
export function tierCliff(state: DraftState, players: Player[]): TierCliff[] {
  const unsold = unsoldPlayers(state, players);
  const byPos = new Map<Position, Player[]>();
  for (const p of unsold) {
    const arr = byPos.get(p.pos);
    if (arr) {
      arr.push(p);
    } else {
      byPos.set(p.pos, [p]);
    }
  }
  const cliffs: TierCliff[] = [];
  for (const pos of POSITIONS) {
    const pool = byPos.get(pos);
    if (!pool || pool.length === 0) {
      continue;
    }
    const topTier = pool.reduce((min, p) => Math.min(min, p.tier), Number.POSITIVE_INFINITY);
    const inTier = pool
      .filter((p) => p.tier === topTier)
      .sort((a, b) => a.positionRank - b.positionRank);
    cliffs.push({
      pos,
      tier: topTier,
      remaining: inTier.length,
      players: inTier,
      isCliff: inTier.length === 1,
    });
  }
  return cliffs;
}

export function endgameLeverage(state: DraftState, players: Player[]): Leverage {
  const me = state.teams.find((t) => t.isMe);
  const rivals = state.teams.filter((t) => !t.isMe);
  const rivalBids: RivalBid[] = rivals.map((t) => ({
    teamId: t.id,
    name: t.name,
    maxBid: maxBidOf(t),
  }));
  const topRivalMaxBid = rivalBids.reduce((top, r) => Math.max(top, r.maxBid), 0);
  const myMaxBid = me ? maxBidOf(me) : 0;

  const uniquelyAffordable =
    myMaxBid > topRivalMaxBid
      ? unsoldPlayers(state, players)
          .filter((p) => p.marketValue > topRivalMaxBid && p.marketValue <= myMaxBid)
          .sort((a, b) => b.marketValue - a.marketValue)
      : [];

  return {
    myMaxBid,
    topRivalMaxBid,
    rivalBids,
    iDominate: myMaxBid > topRivalMaxBid,
    iAmCapped: myMaxBid < topRivalMaxBid,
    uniquelyAffordable,
  };
}

// ── Nomination suggestions ─────────────────────────────────────────────────
// Assumes it is the user's turn to nominate — the caller must gate on the
// live "my turn" signal (pending a DOM capture; see CHECKPOINT.md). Produces
// categorized candidates from three sound auction strategies, each with a
// plain-English reason the UI can show verbatim. All inputs come from the
// already-live engine: rival must-fills (opponentNeeds), tier scarcity
// (tierCliff), your targets, your max bid (maxBidOf).

export type NominationStrategy = "poison-pill" | "cold-market" | "scare-nominate";

export interface NominationCandidate {
  playerId: string;
  name: string;
  pos: Position;
  strategy: NominationStrategy;
  marketValue: number;
  reason: string;
}

export interface NominationSuggestions {
  // Best overall pick by stated priority: cold-market > poison-pill > scare.
  top?: NominationCandidate;
  poisonPill: NominationCandidate[];
  coldMarket: NominationCandidate[];
  scareNominate: NominationCandidate[];
  // Set when there's nothing to suggest (and why).
  note?: string;
}

export interface NominationSuggestOptions {
  /** Max candidates per category. Default 3. */
  limit?: number;
  /** Minimum market value for a "drain" nomination (poison-pill / scare).
   * Below this, a rival winning it doesn't meaningfully drain them. Default 5. */
  minDrainValue?: number;
  /** A position counts as "cold" for your target when at most this many rivals
   * are FORCED to fill it. Default 1 (none, or one desperate rival). */
  coldMarketMaxForced?: number;
}

// Total forced-to-fill slots across all rivals, per position. A position with
// demand >= 2 is primed for a bidding war (poison-pill / scare-nominate).
function forcedDemand(rivals: readonly TeamNeeds[]): Map<Position, number> {
  const counts = new Map<Position, number>();
  for (const r of rivals) {
    for (const m of r.mustFill) {
      counts.set(m.pos, (counts.get(m.pos) ?? 0) + m.count);
    }
  }
  return counts;
}

function mkCandidate(p: Player, strategy: NominationStrategy, reason: string): NominationCandidate {
  return {
    playerId: p.id,
    name: p.name,
    pos: p.pos,
    strategy,
    marketValue: p.marketValue,
    reason,
  };
}

export function nominationSuggest(
  state: DraftState,
  players: Player[],
  opts: NominationSuggestOptions = {},
): NominationSuggestions {
  const empty: NominationSuggestions = { poisonPill: [], coldMarket: [], scareNominate: [] };
  const limit = opts.limit ?? 3;
  const minDrainValue = opts.minDrainValue ?? 5;
  const coldMarketMaxForced = opts.coldMarketMaxForced ?? 1;

  const me = state.teams.find((t) => t.isMe);
  if (!me) {
    return { ...empty, note: "No 'you' team in the live state — can't suggest." };
  }
  if (players.length === 0) {
    return { ...empty, note: "Load rankings to get nomination suggestions." };
  }
  const unsold = unsoldPlayers(state, players);
  if (unsold.length === 0) {
    return { ...empty, note: "Nothing left to nominate." };
  }

  const myMaxBid = maxBidOf(me);
  const myMustFill = new Set(teamNeeds(me).mustFill.map((m) => m.pos));
  const demand = forcedDemand(opponentNeeds(state));
  const demandAt = (pos: Position): number => demand.get(pos) ?? 0;
  const cliffPlayers = tierCliff(state, players)
    .filter((c) => c.isCliff)
    .flatMap((c) => c.players);

  // Poison-pill — DRAIN. High-value, not wanted by me, at a position >= 1
  // rival is forced to fill. Ranked by forced demand, then value.
  const poisonPill = unsold
    .filter(
      (p) =>
        p.marketValue >= minDrainValue &&
        !p.target &&
        !myMustFill.has(p.pos) &&
        demandAt(p.pos) > 0,
    )
    .map((p) => {
      const n = demandAt(p.pos);
      const reason =
        n >= 2
          ? `${n} rivals must fill ${p.pos} — likely bidding war.`
          : `A rival must fill ${p.pos}.`;
      return { c: mkCandidate(p, "poison-pill", reason), n, mv: p.marketValue };
    })
    .sort((a, b) => b.n - a.n || b.mv - a.mv)
    .slice(0, limit)
    .map((x) => x.c);

  // Cold-market snipe — ACQUIRE. Your target or must-fill, in a low-contest
  // market, and affordable. Ranked: targets first, then by value.
  const coldMarket = unsold
    .filter(
      (p) =>
        (p.target || myMustFill.has(p.pos)) &&
        demandAt(p.pos) <= coldMarketMaxForced &&
        p.marketValue <= myMaxBid,
    )
    .map((p) => {
      const n = demandAt(p.pos);
      const who = p.target ? "Your target" : `You need a ${p.pos}`;
      const reason =
        n === 0
          ? `${who}; no rival is forced at ${p.pos} — likely cheap.`
          : `${who}; only one desperate rival at ${p.pos}.`;
      return {
        c: mkCandidate(p, "cold-market", reason),
        target: p.target ? 1 : 0,
        mv: p.marketValue,
      };
    })
    .sort((a, b) => b.target - a.target || b.mv - a.mv)
    .slice(0, limit)
    .map((x) => x.c);

  // Scare-nominate — SCARCITY. The last of a thin tier at a position rivals
  // still need: nominating it forces them to bid now or lose the tier.
  const scareNominate = cliffPlayers
    .filter((p) => p.marketValue >= minDrainValue && !p.target && demandAt(p.pos) > 0)
    .map((p) => {
      const n = demandAt(p.pos);
      const reason = `Last of the top ${p.pos} tier; ${n} rival${n === 1 ? "" : "s"} still need ${p.pos}.`;
      return { c: mkCandidate(p, "scare-nominate", reason), n, mv: p.marketValue };
    })
    .sort((a, b) => b.n - a.n || b.mv - a.mv)
    .slice(0, limit)
    .map((x) => x.c);

  const top = coldMarket[0] ?? poisonPill[0] ?? scareNominate[0];
  const result: NominationSuggestions = { top, poisonPill, coldMarket, scareNominate };
  if (!top) {
    result.note =
      "No strong signal — nominate a target you can afford, or a $1 filler to burn a turn.";
  }
  return result;
}
