// Par Sheet engine — pure functions over ParSheet. The financial core.
// (Drew Davenport par-per-slot budgeting: see PLAN.md.)

import {
  type ParSheet,
  type ParSlot,
  type Position,
  type SlotId,
  SLOT_ELIGIBILITY,
} from "./types.js";

const DEFAULT_TOTAL_BUDGET = 200;

// A reasonable 12-team Superflex default: starter-heavy, bench/K/DST cheap,
// two QBs funded (QB1 + Superflex). Base weights sum to exactly 200.
const DEFAULT_WEIGHTS: Record<SlotId, number> = {
  QB1: 35,
  RB1: 38,
  RB2: 22,
  WR1: 30,
  WR2: 20,
  TE: 8,
  FLEX: 10,
  SF: 25,
  K: 1,
  DST: 1,
  BN1: 5,
  BN2: 2,
  BN3: 1,
  BN4: 1,
  BN5: 1,
};

const SLOT_ORDER: SlotId[] = Object.keys(DEFAULT_WEIGHTS) as SlotId[];

// Distribute `total` across `count` integer shares, summing exactly to `total`.
function distributeEvenly(total: number, count: number): number[] {
  if (count <= 0) {
    return [];
  }
  const base = Math.floor(total / count);
  const shares: number[] = Array.from({ length: count }, () => base);
  let leftover = total - base * count;
  for (let i = 0; i < shares.length && leftover > 0; i++) {
    shares[i] = (shares[i] ?? 0) + 1;
    leftover -= 1;
  }
  return shares;
}

// Scale base weights to a target total without losing dollars to rounding.
function normalizePars(weights: Record<SlotId, number>, total: number): Record<SlotId, number> {
  const sum = SLOT_ORDER.reduce((acc, id) => acc + weights[id], 0);
  const raw = SLOT_ORDER.map((id) => ({ id, v: weights[id] * (total / sum) }));
  const out: Partial<Record<SlotId, number>> = {};
  for (const r of raw) {
    out[r.id] = Math.floor(r.v);
  }
  const leftover = total - SLOT_ORDER.reduce((acc, id) => acc + (out[id] ?? 0), 0);
  const remainders = [...raw]
    .map((r) => ({ id: r.id, frac: r.v - Math.floor(r.v) }))
    .sort((a, b) => b.frac - a.frac);
  for (const r of remainders) {
    if (leftover <= 0) {
      break;
    }
    out[r.id] = (out[r.id] ?? 0) + 1;
  }
  return out as Record<SlotId, number>;
}

export function defaultParSheet(totalBudget: number = DEFAULT_TOTAL_BUDGET): ParSheet {
  const pars = normalizePars(DEFAULT_WEIGHTS, totalBudget);
  const slots: ParSlot[] = SLOT_ORDER.map((id) => ({
    id,
    label: id,
    eligible: SLOT_ELIGIBILITY[id],
    par: pars[id],
  }));
  return { totalBudget, slots };
}

export interface SlotView {
  id: SlotId;
  label: string;
  eligible: Position[];
  par: number;
  playerId?: string;
  playerName?: string;
  actual?: number;
  filled: boolean;
  variance: number | null;
}

export interface ParState {
  totalBudget: number;
  spent: number;
  remaining: number;
  parTotal: number;
  parRemaining: number;
  balance: number;
  filledSlots: number;
  openSlots: number;
  maxBid: number;
  slots: SlotView[];
}

const isFilled = (s: ParSlot): boolean => s.playerId !== undefined && s.actual !== undefined;

export function computeParState(sheet: ParSheet): ParState {
  const slots: SlotView[] = sheet.slots.map((s) => {
    const filled = isFilled(s);
    return {
      id: s.id,
      label: s.label,
      eligible: s.eligible,
      par: s.par,
      playerId: s.playerId,
      playerName: s.playerName,
      actual: s.actual,
      filled,
      variance: filled ? s.par - (s.actual ?? 0) : null,
    };
  });
  const spent = sheet.slots.reduce((acc, s) => acc + (s.actual ?? 0), 0);
  const remaining = sheet.totalBudget - spent;
  const parTotal = sheet.slots.reduce((acc, s) => acc + s.par, 0);
  const openSlots = slots.filter((sv) => !sv.filled);
  const parRemaining = openSlots.reduce((acc, s) => acc + s.par, 0);
  const balance = remaining - parRemaining;
  const maxBid = Math.max(1, remaining - (openSlots.length - 1));
  return {
    totalBudget: sheet.totalBudget,
    spent,
    remaining,
    parTotal,
    parRemaining,
    balance,
    filledSlots: slots.length - openSlots.length,
    openSlots: openSlots.length,
    maxBid,
    slots,
  };
}

export function setPar(sheet: ParSheet, id: SlotId, par: number): ParSheet {
  const slots = sheet.slots.map((s) =>
    s.id === id ? { ...s, par: Math.max(0, Math.round(par)) } : s,
  );
  return { ...sheet, slots };
}

export function assignSlot(
  sheet: ParSheet,
  id: SlotId,
  playerId: string,
  actual: number,
  playerName?: string,
): ParSheet {
  const slots = sheet.slots.map((s) =>
    s.id === id ? { ...s, playerId, playerName, actual: Math.max(0, Math.round(actual)) } : s,
  );
  return { ...sheet, slots };
}

export function unassignSlot(sheet: ParSheet, id: SlotId): ParSheet {
  const slots = sheet.slots.map((s) =>
    s.id === id ? { ...s, playerId: undefined, playerName: undefined, actual: undefined } : s,
  );
  return { ...sheet, slots };
}

// One-click rebalance: forget prior open-slot pars and spread the remaining
// budget evenly across currently-open slots. Filled slots are untouched.
export function redistributeBalance(sheet: ParSheet): ParSheet {
  const state = computeParState(sheet);
  const openIds = state.slots.filter((s) => !s.filled).map((s) => s.id);
  if (openIds.length === 0) {
    return sheet;
  }
  const shares = distributeEvenly(state.remaining, openIds.length);
  const shareById = new Map<SlotId, number>();
  openIds.forEach((id, i) => shareById.set(id, shares[i] ?? 0));
  const slots = sheet.slots.map((s) => ({ ...s, par: shareById.get(s.id) ?? s.par }));
  return { ...sheet, slots };
}
