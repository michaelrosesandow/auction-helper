// Content script: runs authenticated inside the Yahoo draft page.
// First real job: a "DOM probe" mode so we can capture the live DOM shape
// for offline scraper development (see PLAN.md).

const PROBE = new URLSearchParams(location.search).has("probe");

function log(...args: unknown[]): void {
  console.log("[auction-helper]", ...args);
}

// Captures candidate regions. Selectors will be expanded once we see the
// real DOM; for now it grabs <body> so we have something to inspect.
function snapshotDom(): Record<string, string> {
  const selectors: Record<string, string> = { body: "body" };
  const out: Record<string, string> = {};
  for (const [key, sel] of Object.entries(selectors)) {
    const el = document.querySelector(sel);
    out[key] = el ? el.outerHTML.slice(0, 50_000) : "";
  }
  return out;
}

async function main(): Promise<void> {
  log("loaded on", location.href);
  if (!PROBE) {
    return;
  }
  const snap = snapshotDom();
  log("probe snapshot keys:", Object.keys(snap));
  await chrome.storage.local.set({ domProbe: snap });
  log("probe snapshot stored at chrome.storage.local.domProbe");
}

void main();
