// Content script: runs authenticated inside the Yahoo draft page.
//
// Two roles:
//   1. PROBE triggers — one-shot DOM snapshot for offline selector work:
//        - Alt+Shift+P keyboard shortcut
//        - ?probe=1 URL flag (waits for the SPA to render first)
//      These also store the parsed live state (DRAFT_ROOM_KEY).
//      The side panel's "Capture now" button does NOT depend on this script
//      — it injects the probe on demand via chrome.scripting.executeScript —
//      so a missing/failed content script never blocks a capture.
//   2. POLL LOOP — the live engine feed. A resident setInterval scrapes the
//      DOM every POLL_INTERVAL_MS, maps it to a DraftState via toDraftState
//      (using the current league's rankings for name->id + inflation), and —
//      only when the state materially changed — writes { state, room, at }
//      under DRAFT_STATE_KEY. The side panel's Live tab renders this. The
//      loop lives here (not the panel) so it keeps running with the panel
//      closed; only closing/navigating the draft tab stops it.

import { toDraftState } from "./engine/map-state.js";
import { POLL_INTERVAL_MS, stateSignature } from "./engine/poll.js";
import { DOM_PROBE_KEY, DRAFT_ROOM_KEY, DRAFT_STATE_KEY } from "./messages.js";
import { captureDomProbe } from "./probe.js";
import { scrapeDraftRoom } from "./scraper.js";
import { getCurrentLeague, loadRankings } from "./storage.js";
import type { Player } from "./types.js";

const PROBE = new URLSearchParams(location.search).has("probe");
const RENDER_POLL_MS = 500;
const RENDER_SETTLE_MS = 2500;
const RENDER_TIMEOUT_MS = 15_000;
// Below this <body> element count the SPA is assumed still loading.
const RENDER_MIN_ELEMENTS = 50;

function log(...args: unknown[]): void {
  console.log("[auction-helper]", ...args);
}

function sleep(ms: number): Promise<void> {
  // eslint-disable-next-line promise/avoid-new -- setTimeout is callback-based; this is the canonical promisification.
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function runProbe(): Promise<void> {
  // Raw probe (for offline selector work) + parsed live state (for the engine).
  const probe = captureDomProbe();
  const room = scrapeDraftRoom(document);
  await chrome.storage.local.set({ [DOM_PROBE_KEY]: probe, [DRAFT_ROOM_KEY]: room });
  log("probe stored", probe.meta, "| teams:", room.teams.length, "sold:", room.sold.length);
}

// Don't snapshot an empty SPA shell: wait until <body> has a plausible number
// of elements, then settle one more tick. Recursive so the sequential awaits
// read as intentional polling.
async function waitForRender(deadline: number): Promise<void> {
  if (document.body.getElementsByTagName("*").length >= RENDER_MIN_ELEMENTS) {
    await sleep(RENDER_SETTLE_MS);
    return;
  }
  if (Date.now() >= deadline) {
    return;
  }
  await sleep(RENDER_POLL_MS);
  await waitForRender(deadline);
}

// ── Poll loop ────────────────────────────────────────────────────────────

// Rankings for the current league, used to resolve scraped names -> Player
// ids and to compute live inflation. Refreshed on load and whenever the
// league selection or its rankings change in storage (so a mid-draft import
// or league switch propagates without a reload).
let players: Player[] = [];
// Signature of the last emitted DraftState; suppresses redundant writes when
// the room hasn't materially changed (idle stretches between nominations).
let lastSignature = "";

async function refreshPlayers(): Promise<void> {
  try {
    const league = await getCurrentLeague();
    const data = await loadRankings(league);
    players = data?.players ?? [];
    // Rankings may have changed name->id resolution and inflation; force the
    // next tick to re-emit even if the room itself is unchanged.
    lastSignature = "";
  } catch (error) {
    log("rankings load failed", error);
  }
}

// One poll tick: scrape -> map -> diff -> persist. Thin glue around the pure
// scrape/mapper/signature; no business logic lives here.
async function tick(): Promise<void> {
  const room = scrapeDraftRoom(document);
  const draft = toDraftState(room, { players });
  if (stateSignature(draft) === lastSignature) {
    return;
  }
  lastSignature = stateSignature(draft);
  await chrome.storage.local.set({
    [DRAFT_STATE_KEY]: { state: draft, room, at: Date.now() },
  });
}

// Trigger 1: keyboard shortcut (works without the panel open).
document.addEventListener("keydown", (event) => {
  if (event.altKey && event.shiftKey && (event.key === "P" || event.key === "p")) {
    event.preventDefault();
    void runProbe();
  }
});

async function main(): Promise<void> {
  log("loaded on", location.href);
  await refreshPlayers();
  // Keep the mapper's rankings in sync with the side panel: league switches
  // and (re)imports both flow through chrome.storage. The poll's own
  // DRAFT_STATE_KEY writes don't match here, so there's no feedback loop.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") {
      return;
    }
    if (changes["currentLeague"] || Object.keys(changes).some((k) => k.startsWith("rankings:"))) {
      void refreshPlayers();
    }
  });
  // Trigger 2: ?probe=1 (e.g. loading a recorded/mock draft with the flag).
  if (PROBE) {
    log("probe flag set; waiting for room to render...");
    await waitForRender(Date.now() + RENDER_TIMEOUT_MS);
    await runProbe();
  }
  // Start the live feed. Tick immediately so the panel shows data without
  // waiting a full interval.
  void tick();
  setInterval(() => void tick(), POLL_INTERVAL_MS);
  log("poll loop running every", POLL_INTERVAL_MS, "ms");
}

void main();
