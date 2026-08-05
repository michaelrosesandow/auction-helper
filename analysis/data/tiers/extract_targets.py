#!/usr/bin/env python3
"""extract_targets.py - pull bold=target / italics=fade off a Gretch tiers HTML.

The article convention (stated in every piece): **Bold** = target, *italics* =
fade, applied to the ranked list items under each "Tier N" heading. This walks
the HTML linearly, tracking an open-tag stack (<strong>/<em>), and for every
`<N>. Name` chunk records the formatting active on it.

Reusable across RB/TE/WR/QB -- the formatting convention is fixed, so each
article is just another HTML file.

Two modes:
    # 1) human-readable audit (default) -- prints the tier -> target/fade map:
    python3 extract_targets.py "Path/To/RB Targets and Fades.html"

    # 2) YAML skeleton -> redirect into a tier file, then hand-fill profiles:
    python3 extract_targets.py "QB Article.html" --yaml > data/tiers/qb.yml
    python3 extract_targets.py "QB Article.html" --yaml --position QB > qb.yml

The --yaml mode emits a VALID, assemble-able skeleton: tiers, subtiers (parsed
from 1a/1b/3a/3b headings), ordering, and target/fade are transcribed verbatim.
It deliberately OMITS `profile` (a prose judgment -> rubric.py), `note`, and the
tier-level `big_break_after`/`dead_zone` flags -- those are the hand-author
TODOs, called out in the generated header. Until profiles are added, players
are median-only (no floor/ceiling); fill them in and re-run assemble.py.
"""
from __future__ import annotations
import re
import sys


def fmt_of(stack: list[str]) -> str:
    # strong wins if both somehow nest (never happens in practice)
    if "strong" in stack:
        return "target"
    if "em" in stack:
        return "fade"
    return ""


def tokenize(seg: str):
    """Yield (text, fmt) chunks, tracking <strong>/<em> as we walk the string.

    Flush rules (the subtle part -- Substack wraps partial names in <span>):
      - <br>            -> flush (it's the line/entry separator)
      - <strong>/<em>   -> flush, THEN push/pop (so the fmt captured is the one
                           active WHILE the text accumulated, not after the tag)
      - every other tag  -> strip silently, NO flush, NO state change. This is
                           what keeps `<span>6. </span>Ashton Jeanty` intact as
                           one chunk "6. Ashton Jeanty".
    Verified on `<strong>1. Brock Bowers<br>2. Trey McBride</strong><br>...`
    (both target) and `<strong>18. Juwan Johnson<br></strong>19. ...` (18 target,
    19 none)."""
    stack: list[str] = []
    buf = ""
    i = 0
    n = len(seg)

    def flush():
        nonlocal buf
        if buf:
            yield_buf = buf
            buf = ""
            return (yield_buf, fmt_of(stack))
        return None

    while i < n:
        if seg[i] == "<":
            j = seg.find(">", i)
            if j == -1:
                break
            t = seg[i + 1:j].strip().split("/")[-1].split()[0].lower() if seg[i + 1:j].strip() else ""
            # normalize: t is now 'strong'|'em'|'br'|'span'|'a'|... (leading '/' dropped)
            raw = seg[i + 1:j].strip().lower()
            is_close = raw.startswith("/")
            name = raw.lstrip("/").split()[0] if raw.lstrip("/").split() else ""
            if name in ("strong", "em"):
                chunk = flush()
                if chunk:
                    yield chunk
                if is_close:
                    if stack and stack[-1] == name:
                        stack.pop()
                    elif name in stack:
                        stack.remove(name)
                else:
                    stack.append(name)
            elif name == "br":
                chunk = flush()
                if chunk:
                    yield chunk
            # else: span/a/p/etc -> ignored, no flush, no state change
            i = j + 1
        else:
            buf += seg[i]
            i += 1
    chunk = flush()
    if chunk:
        yield chunk


NUM_RE = re.compile(r"^\s*(\d{1,2})\.\s+(.+?)\s*$")


def extract(html: str):
    """Return [(tier_label, [(num, name, fmt), ...]), ...] in document order."""
    # Split the doc into segments by tier heading. Headings look like
    # <h2>Tier 1a</h2> ... up to the next tier heading or end of tier section.
    # We slice the whole article and walk headings.
    heading_re = re.compile(
        r"<h[1-6][^>]*>\s*(Tier\s+\d+[a-z]?)\s*</h[1-6]>", re.I
    )
    heads = list(heading_re.finditer(html))
    out = []
    for idx, m in enumerate(heads):
        label = m.group(1)
        start = m.end()
        end = heads[idx + 1].start() if idx + 1 < len(heads) else len(html)
        # the ranked list lives in the first <p>...</p> after the heading
        p = re.search(r"<p>(.*?)</p>", html[start:end], re.S)
        if not p:
            continue
        seg = p.group(1)
        # Merge pass: Substack sometimes splits an entry across two same-format
        # tags, e.g. `<strong>68.</strong> <strong><span>Tahj Brooks</span>
        # </strong>` -- the bare number and the name land in separate chunks
        # (with a whitespace chunk between) and neither matches `N. Name`. Glue
        # a bare-number chunk onto the next non-empty chunk; the NAME chunk's
        # fmt is authoritative for the entry's target/fade designation.
        chunks = [(t, f) for (t, f) in tokenize(seg) if t.strip()]
        merged = []
        pend = None
        for text, fmt in chunks:
            if re.match(r"^\s*\d{1,2}\.\s*$", text):
                pend = (text, fmt)
                continue
            if pend:
                text = pend[0].strip() + " " + text.strip()
                pend = None
            merged.append((text, fmt))
        entries = []
        for text, fmt in merged:
            for line in text.split("\n"):
                mm = NUM_RE.match(line)
                if mm:
                    num = int(mm.group(1))
                    name = re.sub(r"\s+", " ", mm.group(2).strip())
                    entries.append((num, name, fmt))
        out.append((label, entries))
    return out


LABEL = {"target": "TARGET", "fade": "FADE ", "": "  -  "}

# YAML-special chars that force a flow-scalar to be double-quoted (an
# unquoted apostrophe in `{name: De'Von Achane, ...}` would swallow the comma
# in yamlmini's quote-aware splitter -- see rb.yml/te.yml for the convention).
_YAML_QUOTE_CHARS = "'", "\"", ",", ":", "#"


def yaml_name(name: str) -> str:
    """Normalize unicode ' to ASCII ' (so norm() in assemble.py matches base)
    and double-quote if the name contains any YAML-special char.

    Saved-HTML quirk: Substack embeds the apostrophe as the LITERAL text
    `\u2019` (six ASCII chars), not the unicode codepoint, so handle both."""
    name = (name.replace("\\u2019", "'").replace("\\u2018", "'")  # literal escape text
                .replace("\u2019", "'").replace("\u2018", "'"))    # actual unicode char
    if any(c in name for c in _YAML_QUOTE_CHARS):
        return '"' + name + '"'
    return name


def parse_tier_label(label: str):
    """'Tier 3a' -> (3, 1); 'Tier 2' -> (2, None). Letter a/b/c -> 1/2/3."""
    m = re.match(r"Tier\s*(\d+)([a-z])?$", label, re.I)
    if not m:
        return None, None
    tier = int(m.group(1))
    letter = m.group(2)
    subtier = (ord(letter.lower()) - ord("a") + 1) if letter else None
    return tier, subtier


def detect_position(html: str):
    """Best-effort position from the <title> ('RB Targets and Fades' -> RB)."""
    m = re.search(r"<title[^>]*>([^<]*)</title>", html, re.I)
    if not m:
        return None
    pm = re.search(r"\b(QB|RB|WR|TE)\b", m.group(1))
    return pm.group(1) if pm else None


def print_table(tiers):
    for label, entries in tiers:
        print(f"\n== {label} ==")
        for num, name, fmt in entries:
            print(f"  {num:>2}. {LABEL[fmt]}  {name}")


def print_yaml(position, html, tiers):
    print(
        f"# data/tiers/{position.lower()}.yml -- AUTO-GENERATED SKELETON by "
        f"extract_targets.py --yaml. EDIT FREELY.\n"
        f"#\n"
        f"# Transcribed verbatim from the article's bold/italics: tiers, subtiers\n"
        f"# (1a/1b/3a/3b -> tier + subtier), ordering, and target/fade. STILL TODO\n"
        f"# (hand-author from the prose -- these are the judgment calls the parser\n"
        f"# can't make):\n"
        f"#   - profile:  map each player's writeup to a rubric.py band shape\n"
        f"#              (compressed-elite | clean-symmetric | veteran-floor |\n"
        f"#              efficiency-fade | upside-swing | boom-bust). OMITTED here;\n"
        f"#              until added, players are median-only (no floor/ceiling).\n"
        f"#   - note:     optional terse prose cue per player.\n"
        f"#   - big_break_after / dead_zone: tier-level flags. Add to the relevant\n"
        f"#              tier entries (big_break_after = cliff drops AFTER that tier;\n"
        f"#              dead_zone = the worst-place-to-pay-for-floor tier).\n"
        f"#\n"
        f"# Median is never moved by tiers; profile only shapes the band\n"
        f"# (floor = pts*floor_frac, ceiling = pts*ceil_frac). See rubric.py +\n"
        f"# assemble.py. After hand-filling, run: python3 analysis/assemble.py\n"
        f"position: {position}\n"
        f"source: \"Ben Gretch {position} Tiers -- TODO date/source\"\n"
        f"tiers:"
    )
    for label, entries in tiers:
        tier, subtier = parse_tier_label(label)
        if tier is None:
            print(f"  # !! couldn't parse tier label {label!r}; skipped", file=sys.stderr)
            continue
        print(f"  - tier: {tier}")
        if subtier is not None:
            print(f"    subtier: {subtier}  # {label.split()[-1]}")
        print("    players:")
        for num, name, fmt in entries:
            parts = [f"name: {yaml_name(name)}"]
            if fmt == "target":
                parts.append("target: true")
            elif fmt == "fade":
                parts.append("fade: true")
            print("      - {" + ", ".join(parts) + "}")


def main():
    import argparse

    ap = argparse.ArgumentParser(
        description="Extract target/fade (and optionally a YAML skeleton) from a "
                    "Gretch tiers HTML article.",
    )
    ap.add_argument("html", help="path to the saved article .html")
    ap.add_argument("--position", choices=["QB", "RB", "WR", "TE"],
                    help="position for --yaml (auto-detected from <title> if omitted)")
    ap.add_argument("--yaml", action="store_true",
                    help="emit a data/tiers/{pos}.yml skeleton instead of the "
                         "human-readable table (redirect with > to write a file)")
    args = ap.parse_args()

    html = open(args.html, encoding="utf-8").read()
    tiers = extract(html)

    if args.yaml:
        position = args.position or detect_position(html)
        if not position:
            print("error: could not detect position from <title>; "
                  "pass --position {QB,RB,WR,TE}", file=sys.stderr)
            sys.exit(1)
        print_yaml(position, html, tiers)
    else:
        print_table(tiers)


if __name__ == "__main__":
    main()
