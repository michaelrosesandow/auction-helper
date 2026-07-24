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
  | "market"
  | "floor"
  | "median"
  | "ceiling"
  | "target"
  | "fade"
  | "notes";

const ALIASES: Record<Field, string[]> = {
  name: ["playername", "name", "player"],
  pos: ["position", "pos"],
  team: ["team", "tm", "club", "nflteam"],
  bye: ["bye", "byeweek"],
  tier: ["tier", "t"],
  market: ["marketvalue", "market", "value", "price", "cost", "adj", "avg"],
  floor: ["floor", "low"],
  median: ["median", "points", "proj", "projection", "projectedpoints", "pts", "fp"],
  ceiling: ["ceiling", "ceil", "high"],
  target: ["target", "tgt", "buy"],
  fade: ["fade", "avoid", "sell"],
  notes: ["notes", "note", "comment"],
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
      tier: parseNumber(cell(row, cols.tier)) ?? 1,
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

  // Group tiers by (position, tier).
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
  const tiers = [...tierMap.values()].sort((a, b) => a.pos.localeCompare(b.pos) || a.tier - b.tier);

  return { players, tiers, errors };
}
