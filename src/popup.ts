// Popup controller: league switching, Par Sheet editor, rankings import.
// State lives in chrome.storage.local (per league); this UI is the editor.

import {
  assignSlot,
  computeParState,
  defaultParSheet,
  redistributeBalance,
  setPar,
  unassignSlot,
  type ParState,
  type SlotView,
} from "./par-sheet.js";
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
import type { ParSheet, SlotId } from "./types.js";

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
      const elig = s.eligible.join("/");
      const varCell = s.variance === null ? "&mdash;" : fmtSigned(s.variance);
      const name = escapeAttr(nameForSlot(s));
      const actual = s.actual ?? "";
      return `<tr data-slot="${s.id}">
          <td><b>${s.id}</b><br /><small>${elig}</small></td>
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
  renderParSheet();
  renderRankings();
  renderPlayerList();
}

function showTab(name: "par" | "rank"): void {
  byId("tab-par").hidden = name !== "par";
  byId("tab-rank").hidden = name !== "rank";
  byId("tab-btn-par").classList.toggle("active", name === "par");
  byId("tab-btn-rank").classList.toggle("active", name === "rank");
}

function wireTabs(): void {
  byId("tab-btn-par").addEventListener("click", () => showTab("par"));
  byId("tab-btn-rank").addEventListener("click", () => showTab("rank"));
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
}

async function init(): Promise<void> {
  state.league = await getCurrentLeague();
  state.parSheet = (await loadParSheet(state.league)) ?? defaultParSheet();
  state.rankings = await loadRankings(state.league);
  await renderLeagueSelector();
  renderParSheet();
  renderRankings();
  renderPlayerList();
  wireTabs();
  wireEvents();
}

void init();
