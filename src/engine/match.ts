// Player name resolver: bridges Yahoo-scraped names (abbreviated, e.g.
// "J. Hurts", "R. Odunze", or a DST nickname like "Rams") to the canonical
// Player records loaded from rankings. Pure + unit-testable; no DOM.
//
// Yahoo renders skill players as "<first-initial>. <last>"; rankings carry
// full names. We index rankings by normalized full name, last name, and
// "first-initial + last name", then resolve a scraped name through those
// keys, narrowing by position when the scrape also captured it (it usually
// does, via the card's <abbr> tags). Both sides normalize identically, so an
// apostrophe name like "Ja'Marr Chase" matches itself exactly even though the
// normalizer splits it into tokens.

import type { Player, Position } from "../types.js";

export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export type PlayerResolver = (name: string, pos?: Position) => Player | undefined;

function addToList(map: Map<string, Player[]>, key: string, p: Player): void {
  const arr = map.get(key);
  if (arr) {
    arr.push(p);
  } else {
    map.set(key, [p]);
  }
}

// Build an index over a rankings pool and return a closure that resolves a
// scraped name to a single Player (or undefined when no confident match).
export function createNameResolver(players: Player[]): PlayerResolver {
  const byFull = new Map<string, Player>();
  const byInitialLast = new Map<string, Player[]>();
  const byLast = new Map<string, Player[]>();

  for (const p of players) {
    const tokens = normalizeName(p.name)
      .split(" ")
      .filter((t) => t.length > 0);
    if (tokens.length === 0) {
      continue;
    }
    byFull.set(tokens.join(" "), p);
    const firstInitial = (tokens.at(0) ?? "").slice(0, 1);
    const last = tokens.at(-1) ?? "";
    if (last !== "") {
      addToList(byLast, last, p);
      if (firstInitial !== "") {
        addToList(byInitialLast, `${firstInitial} ${last}`, p);
      }
    }
  }

  // All plausible candidates for a scraped name, before position narrowing.
  function candidates(name: string): Player[] {
    const q = normalizeName(name);
    if (q === "") {
      return [];
    }
    const exact = byFull.get(q);
    if (exact) {
      return [exact];
    }
    const tokens = q.split(" ").filter((t) => t.length > 0);
    const head = tokens.at(0) ?? "";
    const last = tokens.at(-1) ?? "";
    // Yahoo's "F. Last" abbreviation (e.g. "J. Hurts").
    if (tokens.length >= 2 && head.length === 1) {
      const hits = byInitialLast.get(`${head} ${last}`);
      if (hits) {
        return hits;
      }
    }
    // Bare last name (or a full name whose first token isn't a single letter).
    if (last !== "") {
      const hits = byLast.get(last);
      if (hits) {
        return hits;
      }
    }
    return [];
  }

  return (name: string, pos?: Position): Player | undefined => {
    const hits = candidates(name);
    if (hits.length === 0) {
      return undefined;
    }
    if (pos) {
      const narrowed = hits.filter((p) => p.pos === pos);
      // Exactly one match wins; zero (mismatch) or >1 (ambiguous) both bail.
      return narrowed.length === 1 ? narrowed.at(0) : undefined;
    }
    return hits.length === 1 ? hits.at(0) : undefined;
  };
}
