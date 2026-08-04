// Live roster optimizer — the "QB strategy" engine.
//
// Given the unsold player pool (priced by the caller at inflation-adjusted
// market value) and your remaining budget, find the optimal QB STARTER pair
// and the skill roster it implies — and, crucially, show the LANDSCAPE of
// near-equal pairs with a price headroom each (how many $ a pair can absorb
// before it stops being optimal). This is the live version of
// analysis/04_qb_strategies.py, reacting to real prices as QBs sell.
//
// Why a landscape, not "the answer": the QB tier is flat (Lawrence QB11 →
// Kyler QB17 ≈ 10 pts) and projections are median-only with real uncertainty,
// so differences of a few points are within noise. Showing the top N pairs
// makes a plateau visible and keeps you from chasing one "optimal" name.
//
// Pure: no I/O, no chrome. Built on ./solver.ts (exact skill knapsack).

import {
  buildFronts,
  optSkill,
  type Fronts,
  type RosterResult,
  type SkillPos,
  type SolverPlayer,
} from "./solver.js";

/** Any position the optimizer considers (QB + skill). */
type OptPos = "QB" | SkillPos;

/** A player in the optimizer's pool. QBs compete for the 2 starter slots;
 *  skill players (RB/WR/TE) feed the knapsack. cost = expected live price
 *  (the caller applies inflation), pts = median projection. */
export interface OptPlayer {
  id: string;
  name: string;
  pos: OptPos;
  cost: number;
  pts: number;
}

/** A scored QB starter pair + the skill roster it implies. */
export interface QBOption {
  /** The two starting QBs (QB1, Superflex), sorted by pts desc. */
  qbs: readonly [OptPlayer, OptPlayer];
  qbCost: number;
  qbPts: number;
  /** budget left for the 6 skill starters after QBs + reserves. */
  freeBudget: number;
  /** qbPts + skill.pts — the figure pairs are ranked by. */
  totalPts: number;
  /** the optimal 2RB+2WR+1TE+1FLEX set at this free budget. */
  skill: RosterResult;
  /** totalPts − bestTotal. 0 for the leader, negative otherwise. */
  gapToBest: number;
  /**
   * Signed $ swing vs the best pair at current prices. POSITIVE = the leader's
   * headroom (how much more its QBs can cost before the runner-up overtakes);
   * NEGATIVE = how much cheaper this pair must get to tie the leader.
   * Actionable as "Dak+Purdy is safe until the pair costs $X more."
   */
  priceSwing: number;
}

export interface OptimizeInput {
  /** All unsold skill + QB players (sold already excluded by the caller),
   * priced at the expected live price (marketValue × inflation). */
  players: readonly OptPlayer[];
  /** your remaining budget ($). */
  budget: number;
  /** $ reserved for K + DST + 4 bench scrubs (the backup QB is separate).
   *  Default 6 ($2 K/DST + $1 × 4 bench). */
  reserves?: number;
  /** $ reserved for the backup QB (the 3rd QB on the bench). Default 7
   *  (Stroud/Shough value tier). This is the knob that flips the starter-pair
   *  answer — raise it toward a $13 Baker and the optimum tilts to cheaper
   *  starters; drop it and pricier starters win. */
  backupQbAllowance?: number;
  /** how many top pairs to return. Default 6. */
  topN?: number;
}

export interface OptimizeResult {
  best: QBOption | null;
  topPairs: QBOption[];
  /** the assumed $ reserved for the backup QB (for display). */
  backupQbAllowance: number;
  note?: string;
}

// Minimum $ to field 6 skill starters (2RB+2WR+1TE+1FLEX at ≥$1 each). Pairs
// that leave less than this are skipped — they can't complete a lineup.
const MIN_SKILL_BUDGET = 6;

function isSkill(p: OptPlayer): p is SolverPlayer {
  return p.pos !== "QB";
}

function skillPlayers(players: readonly OptPlayer[]): SolverPlayer[] {
  return players.filter((p) => isSkill(p));
}

function qbPlayers(players: readonly OptPlayer[]): OptPlayer[] {
  return players.filter((p) => p.pos === "QB").sort((a, b) => b.pts - a.pts);
}

// total pts for a pair if its QBs cost `extra` more (=> free budget drops).
function totalAt(fronts: Fronts, qbPts: number, freeBudget: number, extra: number): number {
  const fb = freeBudget - extra;
  if (fb < MIN_SKILL_BUDGET) {
    return qbPts; // can't field skill starters; only QB pts count
  }
  return qbPts + optSkill(fronts, fb).pts;
}

// Smallest non-negative `extra` at which `totalAt(qbPts, freeBudget, extra)`
// crosses below `threshold`. Returns `freeBudget` (the practical max) if it
// never crosses (pair stays above threshold even when QBs are "free"-ishly
// priced... actually extra maxes at freeBudget-MIN). Used for leader headroom.
function headroomAbove(
  fronts: Fronts,
  qbPts: number,
  freeBudget: number,
  threshold: number,
): number {
  for (let extra = 0; extra <= freeBudget - MIN_SKILL_BUDGET; extra++) {
    if (totalAt(fronts, qbPts, freeBudget, extra) < threshold) {
      return Math.max(0, extra - 1); // last extra that still held
    }
  }
  return freeBudget - MIN_SKILL_BUDGET; // never crossed — full headroom
}

// Smallest non-negative `cut` (price reduction) at which the pair TIES or beats
// `threshold` (a higher pair's current total). 0 if already at/above. A price
// cut raises the free budget, so it scans `cut` upward (capped at `maxCut`).
function catchupBelow(
  fronts: Fronts,
  qbPts: number,
  freeBudget: number,
  threshold: number,
  maxCut: number,
): number {
  if (totalAt(fronts, qbPts, freeBudget, 0) >= threshold) {
    return 0;
  }
  for (let cut = 1; cut <= maxCut; cut++) {
    if (totalAt(fronts, qbPts, freeBudget, -cut) >= threshold) {
      return cut;
    }
  }
  return maxCut; // never reached within the cap (pairs are near each other)
}

// Enumerate every starter pair; solve skill once per distinct free budget
// (many pairs share a cost → same free budget → same skill roster).
function enumeratePairs(
  qbs: readonly OptPlayer[],
  fronts: Fronts,
  budget: number,
  fixedReserve: number,
): QBOption[] {
  const seenBudget = new Map<number, RosterResult>();
  const raw: QBOption[] = [];
  for (let i = 0; i < qbs.length; i++) {
    const a = qbs[i];
    if (!a) {
      continue;
    }
    for (let j = i + 1; j < qbs.length; j++) {
      const b = qbs[j];
      if (!b) {
        continue;
      }
      const freeBudget = budget - fixedReserve - (a.cost + b.cost);
      if (freeBudget < MIN_SKILL_BUDGET) {
        continue; // too pricey to complete a lineup
      }
      const roster = seenBudget.get(freeBudget) ?? optSkill(fronts, freeBudget);
      if (!seenBudget.has(freeBudget)) {
        seenBudget.set(freeBudget, roster);
      }
      const qbPts = a.pts + b.pts;
      const pair: readonly [OptPlayer, OptPlayer] = a.pts >= b.pts ? [a, b] : [b, a];
      raw.push({
        qbs: pair,
        qbCost: a.cost + b.cost,
        qbPts,
        freeBudget,
        totalPts: qbPts + roster.pts,
        skill: roster,
        gapToBest: 0,
        priceSwing: 0,
      });
    }
  }
  return raw;
}

export function optimizeRoster(input: OptimizeInput): OptimizeResult {
  const budget = input.budget;
  const reserves = input.reserves ?? 6;
  const backupQbAllowance = input.backupQbAllowance ?? 7;
  const topN = input.topN ?? 6;

  const skill = skillPlayers(input.players);
  const qbs = qbPlayers(input.players);

  if (qbs.length < 2) {
    return {
      best: null,
      topPairs: [],
      backupQbAllowance,
      note: qbs.length === 0 ? "No QBs available." : "Only one QB available — need two starters.",
    };
  }
  if (skill.length === 0) {
    return { best: null, topPairs: [], backupQbAllowance, note: "No skill players available." };
  }

  const fronts = buildFronts(skill, Math.max(0, budget));
  const raw = enumeratePairs(qbs, fronts, budget, reserves + backupQbAllowance);
  if (raw.length === 0) {
    return {
      best: null,
      topPairs: [],
      backupQbAllowance,
      note: "No affordable QB pair leaves enough to field a lineup.",
    };
  }

  raw.sort((x, y) => y.totalPts - x.totalPts);
  const leader = raw[0];
  if (!leader) {
    return { best: null, topPairs: [], backupQbAllowance, note: "No affordable QB pair." };
  }
  const bestTotal = leader.totalPts;
  const runnerUp = raw[1];
  const runnerUpTotal = runnerUp ? runnerUp.totalPts : bestTotal;

  const top = raw.slice(0, topN);
  for (const opt of top) {
    opt.gapToBest = opt.totalPts - bestTotal;
    // Leader: how much more can its QBs cost before the runner-up overtakes?
    // Challenger: how much cheaper must it get to tie the leader (negated).
    opt.priceSwing =
      opt.totalPts === bestTotal
        ? headroomAbove(fronts, opt.qbPts, opt.freeBudget, runnerUpTotal)
        : -catchupBelow(fronts, opt.qbPts, opt.freeBudget, bestTotal, budget);
  }

  return { best: top[0] ?? null, topPairs: top, backupQbAllowance };
}
