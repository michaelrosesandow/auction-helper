// Pure helpers for the live poll loop (the glue lives in src/content.ts).
// The loop is chrome/DOM; these are the testable decisions: how often to
// poll, what counts as a material change (so the UI doesn't thrash on
// identical ticks), and whether the latest payload is stale (the poll may
// have stopped because the draft tab was closed/navigated).
//
// Each tick scrapes the DOM, maps it to a DraftState via toDraftState()
// (using the current league's rankings for name->id + inflation), and — only
// when stateSignature() changes — writes the PollPayload below under
// DRAFT_STATE_KEY. The side panel's Live tab renders it.

import type { ScrapedDraftRoom } from "../scraper.js";
import type { DraftState } from "../types.js";

export const POLL_INTERVAL_MS = 2000;
// A payload older than this is "stale": the poll loop has likely stopped (draft
// tab closed/navigated away) and the UI should say so rather than look live.
export const STALE_AFTER_MS = POLL_INTERVAL_MS * 3;

// What the poll loop writes to chrome.storage.local under DRAFT_STATE_KEY.
export interface PollPayload {
  state: DraftState;
  // Raw scrape kept so the panel can re-map after a rankings change without
  // waiting for the next tick, and for offline debugging.
  room: ScrapedDraftRoom;
  // Date.now() of the tick that produced this payload.
  at: number;
}

// Compact, deterministic fingerprint of the fields that matter for
// re-rendering. The poll loop compares this to the previous tick and skips
// the storage write (and the storage.onChanged storm it would trigger) when
// nothing material changed — e.g. idle stretches between nominations.
//
// Captures: phase, the live nomination (nominee + bid + leader + timer),
// each team's budget/open-spots/roster-size, the full sold feed, and
// inflation. Any of those flipping is a real update worth persisting.
export function stateSignature(s: DraftState): string {
  const nom = s.nomination
    ? [
        s.nomination.playerId ?? "?",
        s.nomination.currentBid,
        s.nomination.leadingTeamId ?? "?",
        s.nomination.secondsLeft ?? "-",
      ].join("|")
    : "-";
  const sold = s.sold.map((x) => `${x.playerId}@${x.price}:${x.teamId}`).join(",");
  const teams = s.teams
    .map((t) => `${t.id}=${t.budgetRemaining}/${t.openRosterSpots}/${t.roster.length}`)
    .join(",");
  return `${s.phase}|${nom}|${teams}|${sold}|${s.inflation}`;
}

// True when the payload is older than staleAfterMs (default 3x poll interval).
export function isStale(payload: PollPayload, now: number, staleAfterMs = STALE_AFTER_MS): boolean {
  return now - payload.at > staleAfterMs;
}
