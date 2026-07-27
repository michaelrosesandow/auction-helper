// Engine mapping: ScrapedDraftRoom (Yahoo DOM scrape) -> DraftState (the
// engine's currency). Pure + unit-testable. Loaded rankings (Player[]) are
// optional: when present they enable name -> Player.id resolution and live
// inflation; when absent, ids are slugged from the scraped name and inflation
// falls back to 1.0.
//
// Known limitations (see CHECKPOINT.md):
//   - "NOMINATING" should mean *my* turn to nominate, but that state is not
//     yet observable from the DOM; the phase currently means "in progress,
//     nothing on the block".
//   - roster entries carry each player's *position* (from the scrape) but not
//     their lineup *slot* — Yahoo never exposes a rival's QB1-vs-Superflex
//     choice. Position is enough for opponent position-of-need; your own slots
//     live in the Par Sheet.

import { slugify } from "../rankings.js";
import { isPosition, type ScrapedDraftRoom } from "../scraper.js";
import type { DraftState, Nomination, Player, TeamState } from "../types.js";
import { createNameResolver, type PlayerResolver } from "./match.js";

const DEFAULT_BUDGET_PER_TEAM = 200;

export interface MapOptions {
  /** Rankings players — enables name -> id resolution and live inflation. */
  players?: Player[];
  /** Per-team budget; only feeds the inflation denominator. Default 200. */
  budgetPerTeam?: number;
}

// Yahoo labels the user "You" in the team list but "Your Team" in the results
// table; map both to the me-team's data-id so sales reconcile correctly.
function buildWinnerIdMap(room: ScrapedDraftRoom): Map<string, string> {
  const map = new Map<string, string>();
  let meId: string | undefined;
  for (const t of room.teams) {
    map.set(t.name.trim().toLowerCase(), t.id);
    if (t.isMe) {
      meId = t.id;
    }
  }
  if (meId !== undefined) {
    map.set("your team", meId);
    map.set("you", meId);
  }
  return map;
}

export function inferPhase(room: ScrapedDraftRoom, allFull: boolean): DraftState["phase"] {
  if (allFull) {
    return "DONE";
  }
  if (room.nomination !== null) {
    return "BIDDING";
  }
  if (room.sold.length === 0) {
    return "PRE";
  }
  // Between nominations. See file header re: the my-turn limitation.
  return "NOMINATING";
}

// money-remaining : value-remaining. >1 means remaining players tend to cost
// above par (classic late-auction inflation); <1 means deflation. Returns 1
// when rankings are absent or no unsold value remains.
export function computeInflation(
  sold: readonly { playerId: string; price: number }[],
  players: Player[],
  budgetPerTeam: number,
  numTeams: number,
): number {
  if (players.length === 0 || numTeams <= 0) {
    return 1;
  }
  const moneyRemaining = budgetPerTeam * numTeams - sold.reduce((acc, s) => acc + s.price, 0);
  const soldIds = new Set(sold.map((s) => s.playerId));
  const valueRemaining = players
    .filter((p) => !soldIds.has(p.id))
    .reduce((acc, p) => acc + p.marketValue, 0);
  if (valueRemaining <= 0) {
    return 1;
  }
  return moneyRemaining / valueRemaining;
}

export function toDraftState(room: ScrapedDraftRoom, opts: MapOptions = {}): DraftState {
  const players = opts.players ?? [];
  const budgetPerTeam = opts.budgetPerTeam ?? DEFAULT_BUDGET_PER_TEAM;
  const resolve: PlayerResolver = createNameResolver(players);
  const winnerId = buildWinnerIdMap(room);

  const resolved = room.sold.map((s) => {
    const posHint = isPosition(s.pos) ? s.pos : undefined;
    const player = resolve(s.name, posHint);
    const pos = player?.pos ?? (isPosition(s.pos) ? s.pos : "DEF");
    return {
      playerId: player?.id ?? slugify(`${s.name}-${s.pos}`),
      price: s.price,
      teamId: winnerId.get(s.winnerName.trim().toLowerCase()) ?? "",
      pos,
    };
  });

  // DraftState.sold is the lean history feed; rosters keep each player's
  // position so opponent position-of-need is derivable without rankings.
  const sold = resolved.map(({ playerId, price, teamId }) => ({ playerId, price, teamId }));

  const teams: TeamState[] = room.teams.map((t) => {
    const roster = resolved
      .filter((r) => r.teamId === t.id)
      .map((r) => ({ playerId: r.playerId, pos: r.pos, price: r.price }));
    return {
      id: t.id,
      name: t.name,
      isMe: t.isMe,
      budgetRemaining: t.budget,
      openRosterSpots: Math.max(t.rosterSize - t.filled, 0),
      roster,
      spent: roster.reduce((acc, r) => acc + r.price, 0),
    };
  });

  let nomination: Nomination | undefined;
  if (room.nomination !== null) {
    const n = room.nomination;
    const posHint = isPosition(n.pos) ? n.pos : undefined;
    const player = resolve(n.name, posHint);
    nomination = {
      playerId: player?.id,
      name: n.name,
      // A real nomination card always carries a position; the DEF fallback
      // only triggers for an unobserved malformed scrape.
      pos: player?.pos ?? (isPosition(n.pos) ? n.pos : "DEF"),
      currentBid: n.currentBid,
      leadingTeamId: winnerId.get(n.leadingTeamName.trim().toLowerCase()),
      secondsLeft: room.status.timerSeconds ?? undefined,
    };
  }

  const allFull = teams.length > 0 && teams.every((t) => t.openRosterSpots === 0);

  return {
    phase: inferPhase(room, allFull),
    nomination,
    teams,
    sold,
    inflation: computeInflation(sold, players, budgetPerTeam, room.teams.length),
  };
}
