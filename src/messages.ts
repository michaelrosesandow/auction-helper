// Shared types for the cross-context DOM probe. Kept dependency-free so it
// pulls nothing else into the content or side-panel bundle.

// chrome.storage.local key the snapshot is written under.
export const DOM_PROBE_KEY = "domProbe";

// chrome.storage.local key for the mapped live draft state. Written
// continuously by the content-script poll loop (src/content.ts) and read by
// the side panel's Live tab. Value shape: PollPayload (src/engine/poll.ts).
export const DRAFT_STATE_KEY = "draftState";
// Raw ScrapedDraftRoom from a one-shot probe (parity/debugging).
export const DRAFT_ROOM_KEY = "draftRoom";

export interface ProbeMeta {
  url: string;
  title: string;
  capturedAt: number;
  elementCount: number;
  iframeCount: number;
  skeletonChars: number;
  textEntries: number;
  htmlChars: number;
  htmlTruncated: boolean;
}

// One text-bearing element with a selector-ish path built from its stable
// ancestors (id > data-tst > role > aria-label > kept class > nth-of-type).
// Grep this for "Mahomes" / "$42" / "Budget" to find where live values live.
export interface TextEntry {
  path: string;
  text: string;
  role?: string;
  aria?: string;
  dataTst?: string;
}

// The full artifact stored under DOM_PROBE_KEY.
//   skeleton  — indented selector-surface tree (atomic/hashed classes stripped)
//   textMap   — flat, greppable list of every text node + its anchor path
//   html      — capped raw backup for testing selectors against real markup
export interface DomProbe {
  meta: ProbeMeta;
  skeleton: string;
  textMap: TextEntry[];
  html: string;
}

export type ProbeResponse = { ok: true; meta: ProbeMeta } | { ok: false; error: string };
