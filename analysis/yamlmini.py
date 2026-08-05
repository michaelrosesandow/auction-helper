"""yamlmini.py - a minimal YAML-subset parser for tier files. Zero deps.

The tier files (data/tiers/{pos}.yml) use a small, fixed slice of YAML:

  - top-level `key: value` scalars (position, source)
  - a block sequence of tier mappings under `tiers:`
  - each tier mapping: scalar fields (tier, subtier, big_break_after,
    dead_zone) + a `players:` block sequence
  - each player: a flow mapping `{name: ..., profile: ..., target: true, ...}`
    (block-style `- name: ...` mappings are also accepted)

This is NOT a general YAML parser -- it handles exactly that subset. It exists
because analysis/ is pure-stdlib (no PyYAML). If you ever add PyYAML, swap the
body of `parse()` for `yaml.safe_load`.

Scalars: quoted strings ("..." / '...'), true/false, ints, floats, null.
Comments: `#` to end of line (an unquoted `#` starts a comment; quote any value
that contains `#`).
"""
from __future__ import annotations


def _strip_comment(raw: str) -> str:
    """Return the line up to the first unquoted `#`."""
    quote = None
    for i, ch in enumerate(raw):
        if quote:
            if ch == quote:
                quote = None
        elif ch in ('"', "'"):
            quote = ch
        elif ch == "#":
            return raw[:i]
    return raw


def _scalar(s: str):
    """Parse a scalar token: quoted string, bool, int, float, or bare string."""
    s = s.strip()
    if len(s) >= 2 and s[0] == s[-1] and s[0] in ('"', "'"):
        return s[1:-1]
    if s == "true":
        return True
    if s == "false":
        return False
    if s in ("null", "~", ""):
        return None
    try:
        return int(s)
    except ValueError:
        pass
    try:
        return float(s)
    except ValueError:
        pass
    return s


def _flow(s: str) -> dict:
    """Parse a `{k: v, k: v, ...}` flow mapping into a dict.

    Values may be quoted and may contain commas/colons (the splitter respects
    quotes); each pair splits on its first colon.
    """
    s = s.strip()
    if not (s.startswith("{") and s.endswith("}")):
        raise ValueError(f"not a flow mapping: {s!r}")
    inner = s[1:-1]
    out: dict = {}
    parts: list[str] = []
    buf = ""
    quote = None
    for ch in inner:
        if quote:
            buf += ch
            if ch == quote:
                quote = None
        elif ch in ('"', "'"):
            quote = ch
            buf += ch
        elif ch == ",":
            parts.append(buf)
            buf = ""
        else:
            buf += ch
    if buf.strip():
        parts.append(buf)
    for part in parts:
        if ":" not in part:
            continue
        k, v = part.split(":", 1)
        out[k.strip()] = _scalar(v)
    return out


def _value(token: str):
    token = token.strip()
    if token.startswith("{") and token.endswith("}"):
        return _flow(token)
    return _scalar(token)


def _tokenize(text: str):
    """Lines as (indent, content) with comments stripped, blanks dropped."""
    out = []
    for raw in text.splitlines():
        line = _strip_comment(raw)
        if line.strip() == "":
            continue
        indent = len(line) - len(line.lstrip(" "))
        out.append((indent, line.strip()))
    return out


def _parse_map(lines, i, indent):
    out: dict = {}
    n = len(lines)
    while i < n:
        ind, content = lines[i]
        if ind < indent:
            break
        if ind > indent:
            i += 1  # stray deeper line at map scope -- skip defensively
            continue
        if content.startswith("- "):
            break  # a sibling sequence, not part of this map
        key, sep, val = content.partition(":")
        if sep != ":":
            i += 1
            continue
        key = key.strip()
        val = val.strip()
        if val == "":
            # nested value on following lines
            if i + 1 < n:
                nind, ncontent = lines[i + 1]
                if nind > indent:
                    nested, i = _parse_node(lines, i + 1, nind)
                    out[key] = nested
                    continue
                if nind == indent and ncontent.startswith("- "):
                    seq, i = _parse_seq(lines, i + 1, indent)
                    out[key] = seq
                    continue
            out[key] = None
            i += 1
        else:
            out[key] = _value(val)
            i += 1
    return out, i


def _parse_seq(lines, i, indent):
    out: list = []
    n = len(lines)
    while i < n:
        ind, content = lines[i]
        if ind < indent:
            break
        if ind > indent:
            i += 1
            continue
        if not content.startswith("- "):
            break
        item = content[2:].strip()
        if item.startswith("{") and item.endswith("}"):
            out.append(_flow(item))
            i += 1
        elif ":" in item:
            # `- key: value` mapping item; first field on this line, the rest on
            # deeper continuation lines. item_indent = where content sits after
            # the dash (dash + space = 2 cols).
            item_indent = indent + 2
            first_key, sep, first_val = item.partition(":")
            mp: dict = {}
            if sep == ":":
                first_key = first_key.strip()
                first_val = first_val.strip()
                mp[first_key] = _value(first_val) if first_val != "" else None
                rest, i = _parse_map(lines, i + 1, item_indent)
                mp.update(rest)
            else:
                out.append(_value(item))
                i += 1
                continue
            out.append(mp)
        else:
            out.append(_value(item))
            i += 1
    return out, i


def _parse_node(lines, i, indent):
    if lines[i][1].startswith("- "):
        return _parse_seq(lines, i, indent)
    return _parse_map(lines, i, indent)


def parse(text: str):
    """Parse a YAML-subset document into nested dict/list/scalar."""
    lines = _tokenize(text)
    if not lines:
        return {}
    value, _ = _parse_node(lines, 0, lines[0][0])
    return value


if __name__ == "__main__":
    import sys
    doc = parse(open(sys.argv[1]).read()) if len(sys.argv) > 1 else parse(
        """position: RB
source: "test"
tiers:
  - tier: 1
    big_break_after: true
    players:
      - {name: Jahmyr Gibbs, profile: compressed-elite, note: "floor is top-5"}
      - {name: Bijan Robinson, profile: compressed-elite}
  - tier: 4
    subtier: 1
    dead_zone: true
    players:
      - {name: Bhayshul Tuten, profile: upside-swing}
      - {name: Saquon Barkley, profile: efficiency-fade, fade: true}
""")
    import json
    print(json.dumps(doc, indent=2))
