// ─────────────────────────────────────────────────────────────────────────
// Core data models for the Yahoo Auction Helper.
// These are the contracts between the three layers:
//   PRE-DRAFT DATA  (user loads before/at draft start)
//   LIVE STATE      (scraped from the Yahoo draft room in real time)
//   ENGINE          (combines both to produce alerts / views)
// ─────────────────────────────────────────────────────────────────────────

export type Position = "QB" | "RB" | "WR" | "TE" | "K" | "DEF";

// A slot on YOUR roster that a par allocation is bound to.
export type SlotId =
  | "QB1"
  | "RB1"
  | "RB2"
  | "WR1"
  | "WR2"
  | "TE"
  | "FLEX"
  | "SF"
  | "K"
  | "DST"
  | "BN1"
  | "BN2"
  | "BN3"
  | "BN4"
  | "BN5";

// Which positions are eligible to fill a given slot. Deliberately in roster
// order (starters then bench), not alphabetical.
export const SLOT_ELIGIBILITY: Record<SlotId, Position[]> = {
  QB1: ["QB"],
  RB1: ["RB"],
  RB2: ["RB"],
  WR1: ["WR"],
  WR2: ["WR"],
  TE: ["TE"],
  FLEX: ["RB", "WR", "TE"],
  SF: ["QB", "RB", "WR", "TE"],
  K: ["K"],
  DST: ["DEF"],
  BN1: ["QB", "RB", "WR", "TE", "K", "DEF"],
  BN2: ["QB", "RB", "WR", "TE", "K", "DEF"],
  BN3: ["QB", "RB", "WR", "TE", "K", "DEF"],
  BN4: ["QB", "RB", "WR", "TE", "K", "DEF"],
  BN5: ["QB", "RB", "WR", "TE", "K", "DEF"],
};

// ── PRE-DRAFT DATA: rankings ──────────────────────────────────────────────
// Stores a projection DISTRIBUTION so ceiling is preserved, per your note
// that marginal-points alone undersells upside. Value alerts & tier logic
// can weight ceiling for starters and floor for bench.
export interface Player {
  // stable key (yahoo id if known, else slug)
  id: string;
  name: string;
  pos: Position;
  team: string;
  bye?: number;

  // Projection distribution (season points, or per-game — be consistent).
  // conservative outcome
  projFloor?: number;
  // central estimate (the "projected points")
  projMedian: number;
  // upside outcome
  projCeiling?: number;

  // Market value used by value alerts (feature #1). Pre-set from historical
  // league pricing per position/rank; recomputed live by the inflation layer.
  marketValue: number;

  // Ranking / tiering.
  // e.g. 5 for "the QB5"
  positionRank: number;
  overallRank?: number;
  // tier index within position (1 = top tier)
  tier: number;

  // Manual tags.
  target?: boolean;
  fade?: boolean;
  notes?: string;
}

export interface Tier {
  pos: Position;
  tier: number;
  label?: string;
  playerIds: string[];
}

// ── PRE-DRAFT DATA: the Par Sheet (Drew Davenport) ─────────────────────────
export interface ParSlot {
  id: SlotId;
  label: string;
  eligible: Position[];
  // budgeted amount — EDITABLE LIVE to rebalance
  par: number;
  // filled state
  playerId?: string;
  // display name (esp. for manual entry before the live scraper assigns ids)
  playerName?: string;
  // price paid
  actual?: number;
}

export interface ParSheet {
  // typically 200
  totalBudget: number;
  // one entry per SlotId above
  slots: ParSlot[];
}

// Derived Par Sheet math (computed, never stored as truth):
//   spent         = sum(actual)
//   remaining$    = totalBudget - spent
//   parRemaining  = sum(par where slot unfilled)
//   balance       = remaining$ - parRemaining   ( + surplus to deploy )
//                                                  ( − deficit to trim  )
//   slotVariance  = par - actual                 (per filled slot)

// ── LIVE STATE: scraped from the Yahoo draft room ──────────────────────────
export interface TeamState {
  id: string;
  name: string;
  isMe: boolean;
  budgetRemaining: number;
  // maxBid = budgetRemaining - (openRosterSpots - 1), floored at 1
  openRosterSpots: number;
  // Acquired players. Position is sourced from the scrape (every result row
  // carries the player's <abbr> position), so it's known even for players not
  // in your rankings — that's what feeds opponent position-of-need. Exact
  // lineup *slot* (QB1 vs Superflex) is an internal choice Yahoo never exposes
  // for rivals; the me-team's slots live in the Par Sheet, not here.
  roster: { playerId: string; pos: Position; price: number }[];
  spent: number;
}

export interface Nomination {
  playerId?: string;
  name: string;
  pos: Position;
  currentBid: number;
  leadingTeamId?: string;
  secondsLeft?: number;
}

export interface DraftState {
  phase: "PRE" | "NOMINATING" | "BIDDING" | "PAUSED" | "DONE";
  nomination?: Nomination;
  teams: TeamState[];
  sold: { playerId: string; price: number; teamId: string }[];
  // running inflation factor for recomputing market values live
  inflation: number;
}
