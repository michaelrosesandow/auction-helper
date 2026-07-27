// Live-state scraper for the Yahoo auction draft room.
//
// Yahoo DraftClient uses Atomic CSS (unstable class tokens) + CSS-module
// hashes, so selectors lean on the few STABLE hooks instead:
//   .ys-team[data-id]            — each of the 12 teams
//   .ys-player                   — a player card (nomination + result rows)
//   an "Offer $N" button         — anchor for the active nomination card
//   the Results <table> thead    — "Pick | Player | Cost | Team"
// All the VALUE-parsing (money, fill counts, timer, player meta, max-bid
// math) lives in pure functions below and is unit-tested; the querySelector
// glue is kept thin and was validated against recorded DOM snapshots.

import type { Position } from "./types.js";

/* eslint-disable eslint/prefer-named-capture-group -- terse value extractors; named groups add noise without aiding these one-liners */

// ── pure parsers (unit-tested) ────────────────────────────────────────────

export function parseMoney(s: string | null | undefined): number | null {
  if (s === null || s === undefined) {
    return null;
  }
  const m = s.match(/\$([\d]+)/);
  return m ? Number(m[1]) : null;
}

export function parseFill(s: string | null | undefined): { filled: number; size: number } | null {
  if (s === null || s === undefined) {
    return null;
  }
  const m = s.match(/(\d+)\s*\/\s*(\d+)/);
  return m ? { filled: Number(m[1]), size: Number(m[2]) } : null;
}

// "00:18" -> 18s, "1:30" -> 90s
export function parseTimer(s: string | null | undefined): number | null {
  if (s === null || s === undefined) {
    return null;
  }
  const m = s.match(/(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// max bid = budget − (openSpots − 1), floored at $1. Matches Yahoo's own
// "Max Offer $N" exactly (verified: budget $12, 6/15 -> $4).
export function computeMaxBid(budget: number, filled: number, size: number): number {
  const openSpots = Math.max(size - filled, 0);
  return Math.max(budget - Math.max(openSpots - 1, 0), 1);
}

export interface PlayerMeta {
  name: string;
  pos: string;
  nfl: string;
  bye: number | null;
  proj: number | null;
}

// Classifies a player card's <abbr> texts (["WR","Chi","Bye 10","Proj $11"])
// into position / nfl team / bye / projected value.
export function parsePlayerMeta(name: string, abbrTexts: string[]): PlayerMeta {
  let pos = "";
  let nfl = "";
  let bye: number | null = null;
  let proj: number | null = null;
  for (const t of abbrTexts) {
    const pm = t.match(/^(QB|RB|WR|TE|K|DEF)$/);
    if (pm) {
      pos = pm[1] ?? "";
      continue;
    }
    const bm = t.match(/Bye\s*(\d+)/i);
    if (bm) {
      bye = Number(bm[1]);
      continue;
    }
    const prm = t.match(/Proj(?:\.|\s)\s*\$?(\d+)/i);
    if (prm) {
      proj = Number(prm[1]);
      continue;
    }
    if (nfl === "") {
      nfl = t.replace(/[().]/g, "").trim();
    }
  }
  return { name: name.trim(), pos, nfl, bye, proj };
}

const POSITIONS: readonly Position[] = ["QB", "RB", "WR", "TE", "K", "DEF"];

export function isPosition(s: string): s is Position {
  return (POSITIONS as readonly string[]).includes(s);
}

// ── result types ───────────────────────────────────────────────────────────

interface ScrapedTeam {
  id: string;
  name: string;
  isMe: boolean;
  budget: number;
  filled: number;
  rosterSize: number;
  maxBid: number;
}

export interface ScrapedNomination extends PlayerMeta {
  currentBid: number;
  leadingTeamName: string;
  yourMaxBid: number | null;
  yourBudget: number | null;
  overBudget: boolean;
}

interface ScrapedSale extends PlayerMeta {
  pick: number | null;
  price: number;
  winnerName: string;
}

interface ScrapedStatus {
  timerSeconds: number | null;
  turnText: string | null;
}

export interface ScrapedDraftRoom {
  status: ScrapedStatus;
  teams: ScrapedTeam[];
  nomination: ScrapedNomination | null;
  sold: ScrapedSale[];
}

// ── DOM glue (thin; validated against recorded snapshots) ─────────────────

function txt(el: Element | null | undefined | void): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function findPrefixed(root: Element, re: RegExp): number | null {
  const el = [...root.querySelectorAll("span")].find((sp) => re.test(txt(sp)));
  return el ? parseMoney(txt(el)) : null;
}

// Reads a player card (.ys-player): name = first span not inside an <abbr>;
// the <abbr> texts carry pos / nfl / bye / proj.
function readPlayer(playerEl: Element): PlayerMeta {
  const abbrTexts = [...playerEl.querySelectorAll("abbr")].map((a) => txt(a));
  let name = "";
  for (const sp of playerEl.querySelectorAll("span")) {
    if (!sp.closest("abbr")) {
      const t = txt(sp);
      if (t !== "") {
        name = t;
        break;
      }
    }
  }
  return parsePlayerMeta(name, abbrTexts);
}

function scrapeStatus(root: ParentNode): ScrapedStatus {
  const spans = [...root.querySelectorAll("span")];
  const turn = spans.find((s) => /nominations? until your turn/i.test(txt(s)));
  let timerSeconds: number | null = null;
  if (turn) {
    timerSeconds = parseTimer(txt(turn.previousElementSibling));
  }
  if (timerSeconds === null) {
    const t = spans.find((s) => /^\d{1,2}:\d{2}$/.test(txt(s)));
    timerSeconds = t ? parseTimer(txt(t)) : null;
  }
  return { timerSeconds, turnText: turn ? txt(turn) : null };
}

function scrapeTeams(root: ParentNode): ScrapedTeam[] {
  const seen = new Set<string>();
  const out: ScrapedTeam[] = [];
  for (const el of root.querySelectorAll(".ys-team")) {
    // eslint-disable-next-line unicorn/prefer-dom-node-dataset -- Element (not HTMLElement) has no .dataset.
    const id = el.getAttribute("data-id") ?? "";
    if (id === "" || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const name = txt(el.querySelector("div:nth-of-type(1) > span"));
    const budget =
      parseMoney(txt(el.querySelector("div:nth-of-type(2) > span:nth-of-type(1)"))) ?? 0;
    const fill = parseFill(txt(el.querySelector("div:nth-of-type(2) > span:nth-of-type(2)")));
    const filled = fill?.filled ?? 0;
    const size = fill?.size ?? 15;
    out.push({
      id,
      name,
      isMe: name === "You",
      budget,
      filled,
      rosterSize: size,
      maxBid: computeMaxBid(budget, filled, size),
    });
  }
  return out;
}

// Active nomination, anchored on the "Offer $N" bid button (only present when
// a player is on the block and it isn't your turn to nominate). Returns null
// in any state where there's nothing to bid on.
function scrapeNomination(root: ParentNode): ScrapedNomination | null {
  const offerBtn = [...root.querySelectorAll("button")].find((b) => /^Offer\s*\$\d+/i.test(txt(b)));
  if (!offerBtn) {
    return null;
  }
  let panel: Element | null = offerBtn;
  while (panel !== null && panel.querySelector(".ys-player") === null) {
    panel = panel.parentElement;
  }
  const playerEl = panel?.querySelector(".ys-player") ?? null;
  if (panel === null || playerEl === null) {
    return null;
  }
  const meta = readPlayer(playerEl);
  // Current bid = the bare "$N" span in the panel (Proj/Max/Budget/Offer are
  // all prefixed). The leading team is that span's next sibling.
  const bidSpan = [...panel.querySelectorAll("span")].find((sp) => {
    if (sp.closest("abbr") !== null || sp.closest("button") !== null) {
      return false;
    }
    return /^\$\d+$/.test(txt(sp));
  });
  const currentBid = bidSpan ? (parseMoney(txt(bidSpan)) ?? 0) : 0;
  const leadingTeamName = bidSpan ? txt(bidSpan.nextElementSibling) : "";
  const overBudget = [...panel.querySelectorAll("span")].some((sp) =>
    /over your budget/i.test(txt(sp)),
  );
  return {
    ...meta,
    currentBid,
    leadingTeamName,
    yourMaxBid: findPrefixed(panel, /Max Offer\s*\$\d+/i),
    yourBudget: findPrefixed(panel, /Budget\s*\$\d+/i),
    overBudget,
  };
}

function scrapeResults(root: ParentNode): ScrapedSale[] {
  const table = [...root.querySelectorAll("table")].find((t) => {
    const head = txt(t.querySelector("thead"));
    return /Pick/i.test(head) && /Cost/i.test(head);
  });
  if (!table) {
    return [];
  }
  const out: ScrapedSale[] = [];
  for (const tr of table.querySelectorAll("tbody tr")) {
    const tds = [...tr.children].filter((c) => c.tagName === "TD");
    if (tds.length < 4) {
      continue;
    }
    const pick = Number(txt(tds[0])) || null;
    const playerEl = tds[1]?.querySelector(".ys-player") ?? null;
    const meta = playerEl ? readPlayer(playerEl) : parsePlayerMeta(txt(tds[1]), []);
    const price = parseMoney(txt(tds[2])) ?? 0;
    const winnerName = txt(tds[3]?.querySelector("span")) || txt(tds[3]);
    out.push({ ...meta, pick, price, winnerName });
  }
  return out;
}

export function scrapeDraftRoom(root: ParentNode): ScrapedDraftRoom {
  return {
    status: scrapeStatus(root),
    teams: scrapeTeams(root),
    nomination: scrapeNomination(root),
    sold: scrapeResults(root),
  };
}
