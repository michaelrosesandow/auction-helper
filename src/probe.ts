// The DOM probe, written as ONE self-contained function so it can be shipped
// to any tab via chrome.scripting.executeScript({ func }) — which serializes
// func.toString() and drops the closure. That means NO module-scope bindings
// may be referenced from inside (constants live inline), and the helpers are
// nested (hence the file-wide scoping disable below). The content script
// also calls this for its keyboard shortcut / ?probe=1 paths.

/* eslint-disable unicorn/consistent-function-scoping, eslint/max-lines-per-function, import/prefer-default-export --
   captureDomProbe must be ONE self-contained function (constants inline,
   helpers nested) so chrome.scripting.executeScript({ func }) can serialize it
   via toString() without losing its closure. Splitting or hoisting breaks it. */

import type { DomProbe, ProbeMeta, TextEntry } from "./messages.js";

export function captureDomProbe(): DomProbe {
  const HTML_MAX = 1_500_000;
  const SKELETON_MAX = 1_000_000;
  const SKELETON_DEPTH = 40;
  const TEXT_MAX = 5000;
  // Atomic CSS tokens (D(f), Bdrs(16px), W(100%), ...) and CSS-module hashes
  // (_ys_17bhdbw) — unstable noise, stripped from the selector surface.
  const NOISE_ATOMIC = /^[A-Za-z]+\([^)]*\)$/;
  const NOISE_HASHED = /^_ys_/;

  function keptClasses(raw: string): string[] {
    const out: string[] = [];
    for (const token of raw.split(/\s+/)) {
      if (token === "" || NOISE_ATOMIC.test(token) || NOISE_HASHED.test(token)) {
        continue;
      }
      out.push(token);
    }
    return out;
  }

  function directText(el: Element): string {
    let text = "";
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent ?? "";
      }
    }
    return text.replace(/\s+/g, " ").trim();
  }

  function describe(el: Element): string {
    const parts: string[] = [el.tagName.toLowerCase()];
    if (el.id !== "") {
      parts.push(`#${el.id}`);
    }
    const cls = keptClasses(el.getAttribute("class") ?? "").join(".");
    if (cls !== "") {
      parts.push(`.${cls}`);
    }
    const role = el.getAttribute("role");
    if (role) {
      parts.push(`[role=${role}]`);
    }
    const aria = el.getAttribute("aria-label");
    if (aria) {
      parts.push(`[aria-label="${aria.slice(0, 40)}"]`);
    }
    for (const attr of el.attributes) {
      if (attr.name.startsWith("data-")) {
        parts.push(`[${attr.name}="${attr.value.slice(0, 40)}"]`);
      }
    }
    const text = directText(el);
    if (text !== "") {
      parts.push(`"${text.slice(0, 48)}"`);
    }
    return parts.join("");
  }

  function anchor(el: Element): string {
    if (el.id !== "") {
      return `#${el.id}`;
    }
    // eslint-disable-next-line unicorn/prefer-dom-node-dataset -- Element has no .dataset.
    const tst = el.getAttribute("data-tst");
    if (tst) {
      return `[data-tst="${tst}"]`;
    }
    const role = el.getAttribute("role");
    if (role) {
      return `[role=${role}]`;
    }
    const aria = el.getAttribute("aria-label");
    if (aria) {
      return `[aria-label="${aria.slice(0, 30)}"]`;
    }
    const first = keptClasses(el.getAttribute("class") ?? "")[0];
    if (first) {
      return `.${first}`;
    }
    const tag = el.tagName.toLowerCase();
    const parent = el.parentElement;
    if (!parent) {
      return tag;
    }
    let index = 0;
    for (const sib of parent.children) {
      if (sib === el) {
        break;
      }
      if (sib.tagName === el.tagName) {
        index += 1;
      }
    }
    return `${tag}:nth-of-type(${index + 1})`;
  }

  function pathOf(el: Element): string {
    const parts: string[] = [];
    let cur: Element | null = el;
    let depth = 0;
    while (cur && cur !== document.body && depth < 16) {
      parts.push(anchor(cur));
      cur = cur.parentElement;
      depth += 1;
    }
    return parts.toReversed().join(" > ");
  }

  function skeleton(root: Element): string {
    const lines: string[] = [];
    let size = 0;
    let truncated = false;

    function walk(el: Element, depth: number): void {
      if (truncated || depth > SKELETON_DEPTH) {
        return;
      }
      const line = `${"  ".repeat(depth)}${describe(el)}`;
      if (size + line.length + 1 > SKELETON_MAX) {
        truncated = true;
        return;
      }
      lines.push(line);
      size += line.length + 1;
      for (const child of el.children) {
        walk(child, depth + 1);
      }
    }

    walk(root, 0);
    if (truncated) {
      lines.push("…[skeleton truncated]");
    }
    return lines.join("\n");
  }

  function buildTextMap(root: Element, max: number): TextEntry[] {
    const out: TextEntry[] = [];

    function walk(el: Element): void {
      if (out.length >= max) {
        return;
      }
      const text = directText(el);
      if (text !== "") {
        const entry: TextEntry = { path: pathOf(el), text: text.slice(0, 80) };
        const role = el.getAttribute("role");
        const aria = el.getAttribute("aria-label");
        // eslint-disable-next-line unicorn/prefer-dom-node-dataset -- Element has no .dataset.
        const tst = el.getAttribute("data-tst");
        if (role) {
          entry.role = role;
        }
        if (aria) {
          entry.aria = aria;
        }
        if (tst) {
          entry.dataTst = tst;
        }
        out.push(entry);
      }
      for (const child of el.children) {
        walk(child);
      }
    }

    walk(root);
    return out;
  }

  const body = document.body;
  const html = body.outerHTML;
  const htmlTruncated = html.length > HTML_MAX;
  const skel = skeleton(body);
  const textMap = buildTextMap(body, TEXT_MAX);
  const meta: ProbeMeta = {
    url: location.href,
    title: document.title,
    capturedAt: Date.now(),
    elementCount: body.getElementsByTagName("*").length,
    iframeCount: body.getElementsByTagName("iframe").length,
    skeletonChars: skel.length,
    textEntries: textMap.length,
    htmlChars: Math.min(html.length, HTML_MAX),
    htmlTruncated,
  };
  return {
    meta,
    skeleton: skel,
    textMap,
    html: htmlTruncated ? `${html.slice(0, HTML_MAX)}\n…[html truncated]` : html,
  };
}
