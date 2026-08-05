// Rankings CSV importer — tolerant parser that maps a variety of column
// headers to the Player model and preserves a projection distribution
// (floor / median / ceiling) so ceiling info is available downstream.

import type { Player, Position, Tier } from "./types.js";

const POSITIONS: readonly Position[] = ["QB", "RB", "WR", "TE", "K", "DEF"];

export interface ImportResult {
  players: Player[];
  tiers: Tier[];
  errors: string[];
}

type Field =
  | "name"
  | "pos"
  | "team"
  | "bye"
  | "tier"
  | "subtier"
  | "market"
  | "floor"
  | "median"
  | "ceiling"
  | "target"
  | "fade"
  | "notes"
  | "bigBreak"
  | "deadZone";

const ALIASES: Record<Field, string[]> = {
  name: ["playername", "name", "player"],
  pos: ["position", "pos"],
  team: ["team", "tm", "club", "nflteam"],
  bye: ["bye", "byeweek"],
  tier: ["tier", "t"],
  subtier: ["subtier", "st"],
  market: ["marketvalue", "market", "value", "price", "cost", "adj", "avg"],
  floor: ["floor", "low"],
  median: ["median", "points", "proj", "projection", "projectedpoints", "pts", "fp"],
  ceiling: ["ceiling", "ceil", "high"],
  target: ["target", "tgt", "buy"],
  fade: ["fade", "avoid", "sell"],
  notes: ["notes", "note", "comment"],
  bigBreak: ["bigbreak", "bigbreakafter", "cliff"],
  deadZone: ["deadzone", "dz"],
};

export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normHeader(h: string): string {
  return h
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

// Minimal RFC-4180-ish CSV parser: handles quoted fields, embedded commas,
// and CRLF line endings.
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const text = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === undefined) {
      break;
    }
    if (inQuotes) {
      if (ch === '"') {
        const next = text[i + 1];
        if (next === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

function resolveHeader(header: string[]): Partial<Record<Field, number>> {
  const out: Partial<Record<Field, number>> = {};
  header.forEach((h, i) => {
    const n = normHeader(h);
    for (const f of Object.keys(ALIASES) as Field[]) {
      if (out[f] === undefined && ALIASES[f].includes(n)) {
        out[f] = i;
      }
    }
  });
  return out;
}

function cell(row: string[], index: number | undefined): string | undefined {
  if (index === undefined) {
    return undefined;
  }
  const v = row[index];
  return v === undefined ? undefined : v.trim();
}

function parseNumber(v: string | undefined): number | undefined {
  if (v === undefined || v.trim() === "") {
    return undefined;
  }
  const cleaned = v.replace(/[$,%\s]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

function parseBool(v: string | undefined): boolean {
  if (v === undefined) {
    return false;
  }
  const s = v.trim().toLowerCase();
  return ["1", "true", "yes", "y", "x", "t"].includes(s);
}

function parsePos(v: string | undefined): Position | undefined {
  if (v === undefined) {
    return undefined;
  }
  const n = v.toUpperCase().replace(/[^A-Z]/g, "");
  if (n === "DST" || n === "DEF" || n === "D") {
    return "DEF";
  }
  return (POSITIONS as readonly string[]).includes(n) ? (n as Position) : undefined;
}

// Structural flags folded up from per-row CSV columns into a per-(pos,tier)
// bucket. bigBreakAfter = cliff drops after this tier; deadZone = the tier
// following a Big Break (worst place to pay for floor). See TODO T1/T2.
interface TierFlags {
  bigBreakAfter: boolean;
  deadZone: boolean;
}

// Fold a single row's tier-level flags into the bucket (any row marking the
// tier wins). A flat CSV repeats these per player row; the YAML assembly
// (T2) is the precise source for sub-tier-level flags.
function foldTierFlags(
  map: Map<string, TierFlags>,
  pos: Position,
  tier: number,
  bigBreakAfter: boolean,
  deadZone: boolean,
): void {
  const key = `${pos}:${tier}`;
  let f = map.get(key);
  if (!f) {
    f = { bigBreakAfter: false, deadZone: false };
    map.set(key, f);
  }
  f.bigBreakAfter ||= bigBreakAfter;
  f.deadZone ||= deadZone;
}

// Apply folded flags onto a Tier, but only when true — an unflagged tier keeps
// the fields absent so it reads as "no structural claim".
function applyTierFlags(t: Tier, f?: TierFlags): void {
  if (f?.bigBreakAfter) {
    t.bigBreakAfter = true;
  }
  if (f?.deadZone) {
    t.deadZone = true;
  }
}

export function importRankings(csv: string): ImportResult {
  const errors: string[] = [];
  const rows = parseCsv(csv);
  if (rows.length === 0) {
    return { players: [], tiers: [], errors: ["empty input"] };
  }
  const cols = resolveHeader(rows[0] ?? []);
  if (cols.name === undefined) {
    return { players: [], tiers: [], errors: ["no name column found"] };
  }

  const players: Player[] = [];
  // Per-(pos,tier) structural flags, OR'd from any row that marks the tier.
  const tierFlags = new Map<string, TierFlags>();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row === undefined) {
      continue;
    }
    const name = cell(row, cols.name);
    const pos = parsePos(cell(row, cols.pos));
    if (!name || name === "") {
      errors.push(`row ${r + 1}: missing name`);
      continue;
    }
    if (!pos) {
      errors.push(`row ${r + 1}: invalid position "${cell(row, cols.pos) ?? ""}"`);
      continue;
    }
    const median = parseNumber(cell(row, cols.median)) ?? 0;
    const tier = parseNumber(cell(row, cols.tier)) ?? 1;
    // Tier-level flags repeat on each row of a tier in a flat CSV; fold any
    // row that marks the tier into the per-(pos,tier) bucket. The YAML
    // assembly (T2) is the precise source for sub-tier-level flags.
    foldTierFlags(
      tierFlags,
      pos,
      tier,
      parseBool(cell(row, cols.bigBreak)),
      parseBool(cell(row, cols.deadZone)),
    );
    players.push({
      id: slugify(`${name}-${pos}`),
      name,
      pos,
      team: cell(row, cols.team) ?? "",
      bye: parseNumber(cell(row, cols.bye)),
      projFloor: parseNumber(cell(row, cols.floor)),
      projMedian: median,
      projCeiling: parseNumber(cell(row, cols.ceiling)),
      marketValue: parseNumber(cell(row, cols.market)) ?? 0,
      positionRank: 0,
      tier,
      subtier: parseNumber(cell(row, cols.subtier)),
      target: parseBool(cell(row, cols.target)),
      fade: parseBool(cell(row, cols.fade)),
      notes: cell(row, cols.notes),
    });
  }

  // Rank within position by median desc (tie-break market value desc).
  const byPos: Record<Position, Player[]> = { QB: [], RB: [], WR: [], TE: [], K: [], DEF: [] };
  for (const p of players) {
    byPos[p.pos].push(p);
  }
  for (const pos of POSITIONS) {
    byPos[pos]
      .sort((a, b) => b.projMedian - a.projMedian || b.marketValue - a.marketValue)
      .forEach((p, i) => {
        p.positionRank = i + 1;
      });
  }

  // Group tiers by (position, tier). Sub-tiers deliberately stay a
  // player-level attribute (`subtier`) — they are NOT split into separate
  // Tier objects, so cliff logic (which keys on the integer `tier`) keeps
  // treating 3a + 3b as one tier.
  const tierMap = new Map<string, Tier>();
  for (const p of players) {
    const key = `${p.pos}:${p.tier}`;
    const existing = tierMap.get(key);
    if (existing) {
      existing.playerIds.push(p.id);
    } else {
      tierMap.set(key, { pos: p.pos, tier: p.tier, playerIds: [p.id] });
    }
  }
  const tiers = [...tierMap.values()]
    .map((t) => {
      // Only set the flags when true; leave them absent otherwise so an
      // unflagged tier reads as "no structural claim".
      applyTierFlags(t, tierFlags.get(`${t.pos}:${t.tier}`));
      return t;
    })
    .sort((a, b) => a.pos.localeCompare(b.pos) || a.tier - b.tier);

  return { players, tiers, errors };
}
