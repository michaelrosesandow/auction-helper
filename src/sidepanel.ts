// Popup controller: league switching, Par Sheet editor, rankings import.
// State lives in chrome.storage.local (per league); this UI is the editor.

import {
  endgameLeverage,
  maxBidOf,
  nominationSuggest,
  teamNeeds,
  tierCliff,
  valueAlert,
} from "./engine/alerts.js";
import type { NominationCandidate, NominationStrategy } from "./engine/alerts.js";
import { optimizeRoster, type OptPlayer, type QBOption } from "./engine/optimize.js";
import { isStale, POLL_INTERVAL_MS, type PollPayload } from "./engine/poll.js";
import {
  DOM_PROBE_KEY,
  DRAFT_STATE_KEY,
  type DomProbe,
  type ProbeMeta,
  type ProbeResponse,
} from "./messages.js";
import {
  assignSlot,
  computeParState,
  defaultParSheet,
  reconcileParSheet,
  redistributeBalance,
  setPar,
  unassignSlot,
  type ParState,
  type SlotView,
} from "./par-sheet.js";
import { captureDomProbe } from "./probe.js";
import { importRankings, slugify } from "./rankings.js";
import {
  getCurrentLeague,
  getLeagues,
  loadParSheet,
  loadRankings,
  saveParSheet,
  saveRankings,
  setCurrentLeague,
  type RankingsData,
} from "./storage.js";
import type { DraftState, ParSheet, Player, Position, SlotId } from "./types.js";

// A tiny sample so the importer can be exercised without a real CSV on hand.
const SAMPLE_CSV = `Player Name,Position,Team,Tier,Market Value,Floor,Median,Ceiling,Target,Fade
Josh Allen,QB,BUF,1,68,330,385,420,1,
Bijan Robinson,RB,ATL,1,62,240,290,340,1,
Ja'Marr Chase,WR,CIN,1,58,230,275,325,,
Justin Jefferson,WR,MIN,1,57,225,270,325,,
Travis Kelce,TE,KC,1,28,150,180,215,1,
`;

interface PopupState {
  league: string;
  parSheet: ParSheet;
  rankings: RankingsData | undefined;
}

const state: PopupState = {
  league: "",
  parSheet: defaultParSheet(),
  rankings: undefined,
};

// Board UI state (filter + sort). In-memory only; resets when the panel closes.
type SortMode = "tier" | "value" | "ceiling" | "rank";
const POS_ORDER: Record<Position, number> = { QB: 0, RB: 1, WR: 2, TE: 3, K: 4, DEF: 5 };
let boardFilter: Position | "ALL" = "ALL";
let boardSort: SortMode = "tier";

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`missing element #${id}`);
  }
  return el;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

function fmtSigned(n: number): string {
  return n >= 0 ? `+$${n}` : `-$${Math.abs(n)}`;
}

function nameForSlot(s: SlotView): string {
  if (s.playerName) {
    return s.playerName;
  }
  if (s.playerId && state.rankings) {
    const found = state.rankings.players.find((p) => p.id === s.playerId);
    if (found) {
      return found.name;
    }
  }
  return "";
}

function balanceClass(balance: number): string {
  if (balance > 0) {
    return "pos";
  }
  if (balance < 0) {
    return "neg";
  }
  return "";
}

function summaryHtml(st: ParState): string {
  const balClass = balanceClass(st.balance);
  return `
      <div><span>Budget</span><b>$${st.totalBudget}</b></div>
      <div><span>Spent</span><b>$${st.spent}</b></div>
      <div><span>Remaining</span><b>$${st.remaining}</b></div>
      <div><span>Par left</span><b>$${st.parRemaining}</b></div>
      <div class="${balClass}"><span>Balance</span><b>${fmtSigned(st.balance)}</b></div>
      <div><span>Max bid</span><b>$${st.maxBid}</b></div>
      <div><span>Open</span><b>${st.openSlots}</b></div>
      <div><span>Filled</span><b>${st.filledSlots}</b></div>`;
}

function rowsHtml(st: ParState): string {
  return st.slots
    .map((s) => {
      const varCell = s.variance === null ? "&mdash;" : fmtSigned(s.variance);
      const name = escapeAttr(nameForSlot(s));
      const actual = s.actual ?? "";
      return `<tr data-slot="${s.id}">
          <td><b>${s.id}</b></td>
          <td><input type="number" class="par-input" value="${s.par}" min="0" step="1" /></td>
          <td><input type="text" class="player-input" list="player-list" value="${name}" placeholder="—" /></td>
          <td><input type="number" class="actual-input" value="${actual}" min="0" step="1" /></td>
          <td class="var">${varCell}</td>
          <td><button class="clear ghost" title="Clear slot">✕</button></td>
        </tr>`;
    })
    .join("");
}

function renderParSheet(): void {
  const st = computeParState(state.parSheet);
  byId("par-summary").innerHTML = summaryHtml(st);
  byId("par-rows").innerHTML = rowsHtml(st);
}

function renderPlayerList(): void {
  const names = state.rankings?.players.map((p) => p.name) ?? [];
  byId("player-list").innerHTML = names.map((n) => `<option value="${escapeAttr(n)}">`).join("");
}

function renderRankings(): void {
  const summary = byId("rank-summary");
  if (!state.rankings) {
    summary.textContent = "No rankings loaded for this league.";
    return;
  }
  const targets = state.rankings.players.filter((p) => p.target).length;
  const fades = state.rankings.players.filter((p) => p.fade).length;
  summary.textContent =
    `${state.rankings.players.length} players · ${state.rankings.tiers.length} tiers · ` +
    `${targets} targets · ${fades} fades`;
}

// Players considered "off the board". Today the only live signal is your own
// Par Sheet assignments; merge DraftState.sold here once the scraper lands.
function soldPlayerIds(): Set<string> {
  const ids = new Set<string>();
  for (const slot of state.parSheet.slots) {
    if (slot.playerId) {
      ids.add(slot.playerId);
    }
  }
  return ids;
}

const COMPARATORS: Record<SortMode, (a: Player, b: Player) => number> = {
  tier: (a, b) =>
    POS_ORDER[a.pos] - POS_ORDER[b.pos] || a.tier - b.tier || a.positionRank - b.positionRank,
  value: (a, b) => b.marketValue - a.marketValue || a.positionRank - b.positionRank,
  ceiling: (a, b) =>
    (b.projCeiling ?? b.projMedian) - (a.projCeiling ?? a.projMedian) ||
    a.positionRank - b.positionRank,
  rank: (a, b) => POS_ORDER[a.pos] - POS_ORDER[b.pos] || a.positionRank - b.positionRank,
};

function boardRowHtml(p: Player, sold: Set<string>): string {
  const cls = sold.has(p.id) ? "sold" : "";
  const star = p.target ? '<span class="tgt" title="target">★</span> ' : "";
  const team = p.team ? escapeHtml(p.team) : "—";
  const ceil = p.projCeiling ?? "—";
  return `<tr class="${cls}">
        <td><span class="pos-tag pos-${p.pos}">${p.pos}</span>${star}<b>${escapeHtml(p.name)}</b> <small>· ${team}</small></td>
        <td class="num">T${p.tier}</td>
        <td class="num">$${p.marketValue}</td>
        <td class="num">${ceil}</td>
      </tr>`;
}

function renderBoard(): void {
  const area = byId("board-area");
  const tbody = byId("board-rows");
  const count = byId("board-count");
  const rankings = state.rankings;
  const hasData = rankings !== undefined && rankings.players.length > 0;
  area.hidden = !hasData;
  (byId("rank-import") as HTMLDetailsElement).open = !hasData;
  if (!hasData || !rankings) {
    return;
  }
  const sold = soldPlayerIds();
  const filtered =
    boardFilter === "ALL"
      ? rankings.players
      : rankings.players.filter((p) => p.pos === boardFilter);
  const rows = [...filtered].sort(COMPARATORS[boardSort]).map((p) => boardRowHtml(p, sold));
  tbody.innerHTML = rows.join("");
  count.textContent = `${rows.length} shown · ${sold.size} off board`;
}

function onChipClick(e: Event): void {
  const btn = e.target;
  if (!(btn instanceof HTMLButtonElement) || !btn.dataset["pos"]) {
    return;
  }
  boardFilter = btn.dataset["pos"] as Position | "ALL";
  byId("pos-chips")
    .querySelectorAll(".chip")
    .forEach((c) => c.classList.toggle("active", c === btn));
  renderBoard();
}

function onSortChange(e: Event): void {
  boardSort = (e.target as HTMLSelectElement).value as SortMode;
  renderBoard();
}

async function renderLeagueSelector(): Promise<void> {
  const sel = byId("league") as HTMLSelectElement;
  const leagues = await getLeagues();
  sel.innerHTML = leagues
    .map((l) => `<option value="${escapeAttr(l)}">${escapeHtml(l)}</option>`)
    .join("");
  sel.value = state.league;
}

function savePar(): void {
  void saveParSheet(state.league, state.parSheet);
}

// Full re-render of the par section (reset / redistribute / league switch).
function persistPar(): void {
  renderParSheet();
  savePar();
}

// Targeted updates that leave input values and focus intact. Rebuilding the
// whole table on every change is what blanked the name on Tab and stole focus.
function refreshSummary(): void {
  byId("par-summary").innerHTML = summaryHtml(computeParState(state.parSheet));
}

function refreshVariance(slotId: SlotId): void {
  const sv = computeParState(state.parSheet).slots.find((s) => s.id === slotId);
  const cell = document.querySelector(`tr[data-slot="${slotId}"] .var`);
  if (sv && cell) {
    cell.innerHTML = sv.variance === null ? "&mdash;" : fmtSigned(sv.variance);
  }
}

function afterParEdit(slotId: SlotId): void {
  refreshSummary();
  refreshVariance(slotId);
  savePar();
}

function onParRowsChange(e: Event): void {
  const target = e.target;
  if (!(target instanceof HTMLInputElement)) {
    return;
  }
  const tr = target.closest("tr");
  const slotId = tr?.dataset["slot"];
  if (!slotId) {
    return;
  }
  if (target.classList.contains("par-input")) {
    state.parSheet = setPar(state.parSheet, slotId as SlotId, Number(target.value));
    afterParEdit(slotId as SlotId);
    return;
  }
  // player / price inputs
  if (handleAssignment(tr, slotId as SlotId)) {
    afterParEdit(slotId as SlotId);
  }
}

// Returns true when state changed (so the row + summary need refreshing).
// A name with no price yet is treated as in-progress and left alone, which is
// what stops Tab from name → price from blanking the name.
function handleAssignment(tr: Element | null, slotId: SlotId): boolean {
  if (!tr) {
    return false;
  }
  const nameInput = tr.querySelector<HTMLInputElement>(".player-input");
  const actualInput = tr.querySelector<HTMLInputElement>(".actual-input");
  const name = nameInput?.value.trim() ?? "";
  const actual = actualInput?.value.trim() ?? "";
  if (name === "" && actual === "") {
    state.parSheet = unassignSlot(state.parSheet, slotId);
    return true;
  }
  if (name !== "" && actual !== "") {
    const player = state.rankings?.players.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (player && nameInput) {
      nameInput.value = player.name; // normalize to canonical spelling
    }
    state.parSheet = assignSlot(
      state.parSheet,
      slotId,
      player?.id ?? slugify(name),
      Number(actual),
      player?.name ?? name,
    );
    return true;
  }
  // one field is still pending — leave the slot and the inputs as they are
  return false;
}

function onParRowsClick(e: Event): void {
  const target = e.target;
  if (!(target instanceof HTMLButtonElement) || !target.classList.contains("clear")) {
    return;
  }
  const tr = target.closest("tr");
  const slotId = tr?.dataset["slot"];
  if (!slotId) {
    return;
  }
  state.parSheet = unassignSlot(state.parSheet, slotId as SlotId);
  const nameInput = tr?.querySelector<HTMLInputElement>(".player-input");
  const actualInput = tr?.querySelector<HTMLInputElement>(".actual-input");
  if (nameInput) {
    nameInput.value = "";
  }
  if (actualInput) {
    actualInput.value = "";
  }
  afterParEdit(slotId as SlotId);
}

function onResetPar(): void {
  state.parSheet = defaultParSheet();
  persistPar();
}

function onRedistribute(): void {
  state.parSheet = redistributeBalance(state.parSheet);
  persistPar();
}

function onImport(): void {
  const textarea = byId("csv-input") as HTMLTextAreaElement;
  const status = byId("rank-status");
  const result = importRankings(textarea.value);
  if (result.players.length === 0) {
    status.textContent = `No players imported. ${result.errors.join("; ")}`;
    status.className = "err";
    return;
  }
  const data: RankingsData = {
    players: result.players,
    tiers: result.tiers,
    meta: { source: "paste", importedAt: Date.now() },
  };
  state.rankings = data;
  void saveRankings(state.league, data).then(() => {
    renderRankings();
    renderPlayerList();
    renderBoard();
  });
  const skipped = result.errors.length > 0 ? ` (${result.errors.length} rows skipped)` : "";
  status.textContent = `Imported ${result.players.length} players, ${result.tiers.length} tiers${skipped}.`;
  status.className = "ok";
}

function onLoadExample(): void {
  (byId("csv-input") as HTMLTextAreaElement).value = SAMPLE_CSV;
}

function onFile(e: Event): void {
  const input = e.target;
  if (!(input instanceof HTMLInputElement) || !input.files) {
    return;
  }
  const file = input.files[0];
  if (!file) {
    return;
  }
  void file.text().then((text) => {
    (byId("csv-input") as HTMLTextAreaElement).value = text;
  });
}

async function onLeagueChange(e: Event): Promise<void> {
  const sel = e.target as HTMLSelectElement;
  state.league = sel.value;
  await setCurrentLeague(state.league);
  state.parSheet = (await loadParSheet(state.league)) ?? defaultParSheet();
  state.rankings = await loadRankings(state.league);
  boardFilter = "ALL"; // fresh view per league
  renderParSheet();
  renderRankings();
  renderPlayerList();
  renderBoard();
}

type TabName = "par" | "rank" | "live" | "probe";

function showTab(name: TabName): void {
  byId("tab-par").hidden = name !== "par";
  byId("tab-rank").hidden = name !== "rank";
  byId("tab-live").hidden = name !== "live";
  byId("tab-probe").hidden = name !== "probe";
  byId("tab-btn-par").classList.toggle("active", name === "par");
  byId("tab-btn-rank").classList.toggle("active", name === "rank");
  byId("tab-btn-live").classList.toggle("active", name === "live");
  byId("tab-btn-probe").classList.toggle("active", name === "probe");
  if (name === "rank") {
    renderBoard(); // refresh sold state from the Par Sheet
  }
  if (name === "live") {
    renderLive(); // refresh "updated Ns ago" / stale badge on focus
  }
  if (name === "probe") {
    void refreshProbeStatus();
  }
}

function wireTabs(): void {
  byId("tab-btn-par").addEventListener("click", () => showTab("par"));
  byId("tab-btn-rank").addEventListener("click", () => showTab("rank"));
  byId("tab-btn-live").addEventListener("click", () => showTab("live"));
  byId("tab-btn-probe").addEventListener("click", () => showTab("probe"));
}

function wireEvents(): void {
  byId("league").addEventListener("change", (e) => {
    void onLeagueChange(e);
  });
  const rows = byId("par-rows");
  rows.addEventListener("change", onParRowsChange);
  rows.addEventListener("click", onParRowsClick);
  byId("reset-par").addEventListener("click", onResetPar);
  byId("redistribute").addEventListener("click", onRedistribute);
  byId("import").addEventListener("click", onImport);
  byId("load-example").addEventListener("click", onLoadExample);
  byId("csv-file").addEventListener("change", onFile);
  byId("pos-chips").addEventListener("click", onChipClick);
  byId("sort-select").addEventListener("change", onSortChange);
  byId("probe-capture").addEventListener("click", () => void onProbeCapture());
  byId("probe-download").addEventListener("click", () => void onProbeDownload());
  byId("probe-copy").addEventListener("click", () => void onProbeCopy());
}

// ── Live tab ─────────────────────────────────────────────────────────────
// Read-only view of the poll loop's output (src/content.ts writes
// DRAFT_STATE_KEY). Renders status/freshness, the active nomination, and a
// per-team budget grid. Surfacing the rest of the alert suite (tier cliffs,
// opponent position-of-need, endgame leverage) onto this view is the next
// step (CHECKPOINT item #3); the value flag on the nomination is wired now.

let lastLive: PollPayload | undefined;

async function readLive(): Promise<PollPayload | undefined> {
  const result = await chrome.storage.local.get(DRAFT_STATE_KEY);
  return result[DRAFT_STATE_KEY] as PollPayload | undefined;
}

function fmtClock(seconds: number): string {
  const safe = Math.max(0, seconds);
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}

function liveTeamName(s: DraftState, id: string): string {
  return s.teams.find((t) => t.id === id)?.name ?? id;
}

function liveStatusHtml(payload: PollPayload | undefined, now: number): string {
  if (!payload) {
    return `Waiting for the draft tab — open a Yahoo auction and the feed starts automatically.`;
  }
  const age = now - payload.at;
  if (isStale(payload, now)) {
    return `Stale — last update ${Math.round(age / 1000)}s ago. Is the draft tab still open?`;
  }
  return `Live — updated ${Math.max(0, Math.round(age / 1000))}s ago`;
}

function liveStatusClass(payload: PollPayload | undefined): string {
  if (!payload) {
    return "muted";
  }
  return isStale(payload, Date.now()) ? "err" : "ok";
}

function liveMetaHtml(s: DraftState): string {
  return `
      <div><span>Phase</span><b>${s.phase}</b></div>
      <div><span>Inflation</span><b>${s.inflation.toFixed(2)}×</b></div>
      <div><span>Teams</span><b>${s.teams.length}</b></div>
      <div><span>Sold</span><b>${s.sold.length}</b></div>`;
}

function nomLabel(strategy: NominationStrategy): string {
  if (strategy === "cold-market") {
    return "snipe";
  }
  if (strategy === "poison-pill") {
    return "drain";
  }
  return "scare";
}

// Nomination prep: what to put up when your turn comes. Shown between
// nominations (not while a player is on the block or the draft is done). It's
// labeled conditional because the engine can't yet see whose turn it is — the
// live "my turn" detector is pending a DOM capture (CHECKPOINT.md gaps).
function liveNomPrepHtml(s: DraftState, players: Player[]): string {
  if (players.length === 0 || s.phase === "BIDDING" || s.phase === "DONE") {
    return "";
  }
  const sug = nominationSuggest(s, players);
  if (sug.note) {
    return `<div class="muted" style="margin: 6px 0">Nomination: ${escapeHtml(sug.note)}</div>`;
  }
  // Priority order (cold-market > poison-pill > scare), de-duped by player.
  const ordered = [...sug.coldMarket, ...sug.poisonPill, ...sug.scareNominate];
  const seen = new Set<string>();
  const picks: NominationCandidate[] = [];
  for (const c of ordered) {
    if (seen.has(c.playerId)) {
      continue;
    }
    seen.add(c.playerId);
    picks.push(c);
    if (picks.length >= 3) {
      break;
    }
  }
  const rows = picks
    .map(
      (c) =>
        `<li><span class="nom-tag nom-${c.strategy}">${nomLabel(c.strategy)}</span>` +
        `<b>${escapeHtml(c.name)}</b> <span class="pos-tag pos-${c.pos}">${c.pos}</span> — ${escapeHtml(c.reason)}</li>`,
    )
    .join("");
  return `<div style="margin: 6px 0"><div class="muted" style="font-size: 11px; margin-bottom: 2px">Nomination prep (when it's your turn):</div><ul class="nom-list">${rows}</ul></div>`;
}

function liveNominationHtml(s: DraftState): string {
  const n = s.nomination;
  if (!n) {
    return `<p class="muted">No active nomination.</p>`;
  }
  const timer = n.secondsLeft === undefined ? "" : ` · ${fmtClock(n.secondsLeft)}`;
  const leader = escapeHtml(liveTeamName(s, n.leadingTeamId ?? ""));
  let value = "";
  const players = state.rankings?.players ?? [];
  const va = players.length > 0 ? valueAlert(s, players) : null;
  if (va?.isValue) {
    value = ` <span class="ok">VALUE — fair $${Math.round(va.adjustedMarketValue)}, bid to $${Math.round(va.valueCeiling)}</span>`;
  }
  return `<p><b>${escapeHtml(n.name)}</b> <span class="pos-tag pos-${n.pos}">${n.pos}</span> — <b>$${n.currentBid}</b> (${leader})${timer}${value}</p>`;
}

function liveLeverageHtml(s: DraftState, players: Player[]): string {
  const lev = endgameLeverage(s, players);
  if (lev.iDominate && lev.uniquelyAffordable.length > 0) {
    const shown = lev.uniquelyAffordable
      .slice(0, 5)
      .map((p) => escapeHtml(p.name))
      .join(", ");
    const more = lev.uniquelyAffordable.length > 5 ? " …" : "";
    return `<div class="leverage ok"><b>You set the price.</b> Rivals cap at $${lev.topRivalMaxBid}; you can reach $${lev.myMaxBid}. Only you can afford: ${shown}${more}</div>`;
  }
  // Only surface the cap when the gap is meaningful (avoids early-draft flicker
  // on $1 budget differences).
  if (lev.iAmCapped && lev.topRivalMaxBid - lev.myMaxBid >= 5) {
    return `<div class="leverage warn"><b>You're capped at $${lev.myMaxBid}.</b> A rival can reach $${lev.topRivalMaxBid} — avoid bidding wars, snipe the cold market.</div>`;
  }
  return "";
}

function liveTierHtml(s: DraftState, players: Player[]): string {
  if (players.length === 0) {
    return "";
  }
  const cliffs = tierCliff(s, players);
  if (cliffs.length === 0) {
    return "";
  }
  const rows = cliffs
    .map((c) => {
      const cls = c.isCliff ? "tier-row cliff" : "tier-row";
      const label = c.isCliff ? "last!" : `${c.remaining} left`;
      return `<span class="${cls}"><b>${c.pos}${c.tier}</b> ${label}</span>`;
    })
    .join("");
  return `<div class="tiers">${rows}</div>`;
}

function liveTeamsHtml(s: DraftState): string {
  const header =
    '<tr><th>Team</th><th class="num">$</th><th class="num">Open</th><th class="num">Max</th><th>Needs</th></tr>';
  const needs = new Map(s.teams.map((t) => [t.id, teamNeeds(t)]));
  const rows = s.teams
    .map((t) => {
      const me = t.isMe ? ' class="me"' : "";
      const label = `${escapeHtml(t.name)}${t.isMe ? " (you)" : ""}`;
      const need = needs.get(t.id);
      let cell = '<span class="muted">—</span>';
      if (need?.isFull) {
        cell = '<span class="muted">full</span>';
      } else if (need && need.mustFill.length > 0) {
        // Boxed in: forced-to-fill spots exceed open roster spots — can't field
        // a legal lineup without trading. The strongest endgame signal.
        const totalMust = need.mustFill.reduce((acc, m) => acc + m.count, 0);
        const boxed = totalMust > t.openRosterSpots;
        cell = need.mustFill
          .map(
            (m) =>
              `<span class="need-chip${boxed ? " boxed" : ""}">${m.pos}${m.count > 1 ? `×${m.count}` : ""}</span>`,
          )
          .join("");
      }
      return `<tr${me}><td>${label}</td><td class="num">$${t.budgetRemaining}</td><td class="num">${t.openRosterSpots}</td><td class="num">$${maxBidOf(t)}</td><td>${cell}</td></tr>`;
    })
    .join("");
  return header + rows;
}

// ── QB strategy (live re-solve) ─────────────────────────────────────────────
// Maps the loaded rankings (marketValue × inflation → expected price,
// projMedian → pts) into the optimizer's pool, excludes sold players, and
// re-solves the optimal QB starter pair + skill roster against your remaining
// budget. Renders the top near-equal pairs with a price headroom so you can
// see the landscape (not one brittle "answer") react as QBs sell/get bid up.
function optPoolFromRankings(s: DraftState, players: readonly Player[]): OptPlayer[] {
  const inflation = Number.isFinite(s.inflation) ? s.inflation : 1;
  const sold = new Set(s.sold.map((row) => row.playerId));
  const out: OptPlayer[] = [];
  for (const p of players) {
    if (p.pos !== "QB" && p.pos !== "RB" && p.pos !== "WR" && p.pos !== "TE") {
      continue;
    }
    if (sold.has(p.id)) {
      continue;
    }
    const cost = Math.max(1, Math.round(p.marketValue * inflation));
    out.push({ id: p.id, name: p.name, pos: p.pos, cost, pts: p.projMedian });
  }
  return out;
}

function swingHtml(opt: QBOption): string {
  if (opt.priceSwing > 0) {
    return `<span class="swing-pos">+\$${opt.priceSwing} room</span>`;
  }
  if (opt.priceSwing < 0) {
    return `<span class="swing-neg">\$${-opt.priceSwing} cheaper</span>`;
  }
  return "";
}

function qbStratRowHtml(rank: number, opt: QBOption, isLeader: boolean): string {
  const cls = isLeader ? ' class="lead"' : "";
  const pair = opt.qbs.map((q) => escapeHtml(q.name)).join(" + ");
  const gap = opt.gapToBest === 0 ? "—" : `${opt.gapToBest.toFixed(0)}`;
  return `<tr${cls}><td>${rank}</td><td>${pair}</td><td class="num">\$${opt.qbCost}</td><td class="num">${opt.totalPts.toFixed(0)}</td><td class="num">${gap}</td><td>${swingHtml(opt)}</td></tr>`;
}

function liveQbStratHtml(s: DraftState, players: readonly Player[]): string {
  if (players.length === 0) {
    return '<div class="muted" style="font-size:11px;margin:4px 0">Load rankings to see the live QB-strategy re-solve.</div>';
  }
  const me = s.teams.find((t) => t.isMe);
  if (!me) {
    return "";
  }
  const res = optimizeRoster({
    players: optPoolFromRankings(s, players),
    budget: me.budgetRemaining,
  });
  const head = `<div class="qs-head muted">QB strategy — your $${me.budgetRemaining}, backup QB ~$${res.backupQbAllowance}</div>`;
  if (!res.best || res.topPairs.length === 0) {
    return `<div class="qbstrat">${head}<div class="muted">${escapeHtml(res.note ?? "No solution.")}</div></div>`;
  }
  const bestTotal = res.best.totalPts;
  const rows = res.topPairs
    .map((opt, i) => qbStratRowHtml(i + 1, opt, opt.totalPts === bestTotal))
    .join("");
  const tbl =
    `<table><thead><tr><th>#</th><th>QB pair</th><th class="num">$</th>` +
    `<th class="num">Pts</th><th class="num">Δ</th><th>vs best</th></tr></thead><tbody>${rows}</tbody></table>`;
  return `<div class="qbstrat">${head}${tbl}</div>`;
}

function renderLive(): void {
  const payload = lastLive;
  const status = byId("live-status");
  status.textContent = liveStatusHtml(payload, Date.now());
  status.className = liveStatusClass(payload);
  const leverage = byId("live-leverage");
  const qbstrat = byId("live-qbstrat");
  const meta = byId("live-meta");
  const nomprep = byId("live-nomprep");
  const nom = byId("live-nomination");
  const tiers = byId("live-tiers");
  const teams = byId("live-teams");
  if (!payload) {
    leverage.innerHTML = "";
    qbstrat.innerHTML = "";
    meta.innerHTML = "";
    nomprep.innerHTML = "";
    nom.innerHTML = "";
    tiers.innerHTML = "";
    teams.innerHTML = "";
    return;
  }
  const s = payload.state;
  const players = state.rankings?.players ?? [];
  leverage.innerHTML = liveLeverageHtml(s, players);
  qbstrat.innerHTML = liveQbStratHtml(s, players);
  meta.innerHTML = liveMetaHtml(s);
  nomprep.innerHTML = liveNomPrepHtml(s, players);
  nom.innerHTML = liveNominationHtml(s);
  tiers.innerHTML = liveTierHtml(s, players);
  teams.innerHTML = liveTeamsHtml(s);
}

async function refreshLive(): Promise<void> {
  lastLive = await readLive();
  renderLive();
  applyLiveToParSheet();
}

// Auto-fill the Par Sheet from the live sold feed: assign each player I've
// won (and haven't placed yet) into their best empty eligible slot, then
// persist + re-render only when something actually landed. reconcileParSheet
// is add-only and idempotent, so manual placements and par edits are safe and
// there's no write loop.
function applyLiveToParSheet(): void {
  const me = lastLive?.state.teams.find((t) => t.isMe);
  if (!me) {
    return;
  }
  const before = state.parSheet;
  const after = reconcileParSheet(before, me.roster);
  if (after === before) {
    return;
  }
  state.parSheet = after;
  void saveParSheet(state.league, after);
  renderParSheet();
}

// ── Probe tab ───────────────────────────────────────────────────────────
// Capture/export the live Yahoo draft-room DOM snapshot written by the
// content script (see src/content.ts).

function fmtSize(n: number): string {
  if (n < 1024) {
    return `${n} B`;
  }
  if (n < 1_048_576) {
    return `${(n / 1024).toFixed(1)} KB`;
  }
  return `${(n / 1_048_576).toFixed(2)} MB`;
}

function truncateStr(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function probeMetaHtml(meta: ProbeMeta): string {
  const htmlLabel = meta.htmlTruncated ? "HTML ✂" : "HTML";
  return `
      <div><span>URL</span><b title="${escapeAttr(meta.url)}">${escapeHtml(truncateStr(meta.url, 34))}</b></div>
      <div><span>At</span><b>${escapeHtml(new Date(meta.capturedAt).toLocaleTimeString())}</b></div>
      <div><span>Elements</span><b>${meta.elementCount}</b></div>
      <div><span>Iframes</span><b>${meta.iframeCount}</b></div>
      <div><span>Skeleton</span><b>${fmtSize(meta.skeletonChars)}</b></div>
      <div><span>Text nodes</span><b>${meta.textEntries}</b></div>
      <div><span>${htmlLabel}</span><b>${fmtSize(meta.htmlChars)}</b></div>`;
}

async function readProbe(): Promise<DomProbe | undefined> {
  const result = await chrome.storage.local.get(DOM_PROBE_KEY);
  return result[DOM_PROBE_KEY] as DomProbe | undefined;
}

function renderProbe(probe: DomProbe | undefined): void {
  const status = byId("probe-status");
  const meta = byId("probe-meta");
  const download = byId("probe-download") as HTMLButtonElement;
  const copy = byId("probe-copy") as HTMLButtonElement;
  if (!probe) {
    status.textContent = "No snapshot yet.";
    status.className = "muted";
    meta.innerHTML = "";
    download.disabled = true;
    copy.disabled = true;
    return;
  }
  status.textContent = `Captured ${new Date(probe.meta.capturedAt).toLocaleString()}.`;
  status.className = "ok";
  meta.innerHTML = probeMetaHtml(probe.meta);
  download.disabled = false;
  copy.disabled = false;
}

async function refreshProbeStatus(): Promise<void> {
  renderProbe(await readProbe());
}

// The side panel and the draft tab may be in different windows; prefer the
// active tab if it's a Yahoo draft page, else the first matching tab.
async function findYahooTab(): Promise<chrome.tabs.Tab | undefined> {
  const root = "https://football.fantasysports.yahoo.com/";
  const active = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeMatch = active.find((t) => t.url?.startsWith(root));
  if (activeMatch) {
    return activeMatch;
  }
  const matches = await chrome.tabs.query({ url: `${root}*` });
  return matches[0];
}

async function sendProbe(): Promise<ProbeResponse | undefined> {
  const tab = await findYahooTab();
  if (!tab || tab.id === undefined) {
    return undefined;
  }
  // Inject the probe directly into the tab. This does NOT depend on the
  // content script being present (the old "Receiving end does not exist"
  // failure mode) — executeScript runs the function fresh in the page.
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: captureDomProbe,
    });
    const probe = results[0]?.result as DomProbe | undefined;
    if (!probe) {
      return { ok: false, error: "Probe returned no data from the page." };
    }
    await chrome.storage.local.set({ [DOM_PROBE_KEY]: probe });
    return { ok: true, meta: probe.meta };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function onProbeCapture(): Promise<void> {
  const status = byId("probe-status");
  status.textContent = "Capturing...";
  status.className = "muted";
  const response = await sendProbe();
  if (response === undefined) {
    status.textContent =
      "No Yahoo draft tab reachable (reload the draft tab with the extension loaded).";
    status.className = "err";
    return;
  }
  if (!response.ok) {
    status.textContent = `Capture failed: ${response.error}`;
    status.className = "err";
    return;
  }
  await refreshProbeStatus();
}

async function onProbeDownload(): Promise<void> {
  const probe = await readProbe();
  if (!probe) {
    return;
  }
  const blob = new Blob([JSON.stringify(probe, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `yahoo-domprobe-${probe.meta.capturedAt}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function onProbeCopy(): Promise<void> {
  const probe = await readProbe();
  if (!probe || probe.skeleton === "") {
    return;
  }
  const status = byId("probe-status");
  try {
    await navigator.clipboard.writeText(probe.skeleton);
    status.textContent = "Skeleton copied to clipboard.";
    status.className = "ok";
  } catch {
    status.textContent = "Couldn't copy (clipboard blocked).";
    status.className = "err";
  }
}

async function init(): Promise<void> {
  state.league = await getCurrentLeague();
  state.parSheet = (await loadParSheet(state.league)) ?? defaultParSheet();
  state.rankings = await loadRankings(state.league);
  await renderLeagueSelector();
  renderParSheet();
  renderRankings();
  renderPlayerList();
  renderBoard();
  wireTabs();
  wireEvents();
  // Live updates from the draft tab: the poll loop writes DRAFT_STATE_KEY,
  // and shortcut/URL captures write DOM_PROBE_KEY. Re-render the affected tab.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") {
      return;
    }
    if (changes[DOM_PROBE_KEY]) {
      void refreshProbeStatus();
    }
    if (changes[DRAFT_STATE_KEY]) {
      lastLive = changes[DRAFT_STATE_KEY].newValue as PollPayload | undefined;
      renderLive();
      applyLiveToParSheet();
    }
  });
  // Refresh the Live tab's "updated Ns ago" / stale badge even when the poll
  // is idle (so staleness surfaces without a new write).
  setInterval(renderLive, POLL_INTERVAL_MS);
  void refreshLive();
  void refreshProbeStatus();
}

void init();
