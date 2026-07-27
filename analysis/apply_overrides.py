"""apply_overrides.py - merge my_rankings.csv into out/players.json.

Lets you inject two kinds of personal belief:

  my_rank  - your within-position rank (1 = best). Pure SIGNAL: we compute a
             "projection rank" (rank by projected pts within position) and flag
             where your rank is far ABOVE the projection (=> you see ceiling the
             median misses) or far BELOW (=> fade). my_rank does NOT change cost.

  my_price - what you expect to pay. If set, OVERRIDES the model cost for that
             player everywhere (optimizer + QB strategies + review HTML), so you
             can stress-test "what if Baker really goes $12". The original model
             cost is kept as `model_cost`.

The CSV is optional: blank lines and '#' comments are ignored; leave my_rank or
my_price blank to skip that field for a row. Always computes proj_rank (used by
the HTML even if you rank nobody). Idempotent; run after build_2026.py.

  python3 apply_overrides.py
"""
from __future__ import annotations
import os, re, json

HERE = os.path.dirname(__file__)
PLAYERS = os.path.join(HERE, "out", "players.json")
MINE = os.path.join(HERE, "my_rankings.csv")


def norm(name):
    s = re.sub(r"[.'']", "", name.lower())
    toks = [t for t in s.split() if t not in ("jr", "sr", "ii", "iii", "iv", "v", "i")]
    return " ".join(toks).strip()


def load_mine():
    out = {}
    if not os.path.exists(MINE):
        return out
    for raw in open(MINE):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = [c.strip() for c in line.split(",")]
        if len(parts) < 2 or parts[0].lower() in ("name", ""):
            continue
        name, pos = parts[0], parts[1].upper()
        my_rank = int(parts[2]) if len(parts) > 2 and parts[2].isdigit() else None
        my_price = int(parts[3]) if len(parts) > 3 and parts[3].isdigit() else None
        note = parts[4] if len(parts) > 4 else ""
        out[(norm(name), pos)] = dict(name=name, pos=pos, my_rank=my_rank,
                                      my_price=my_price, note=note)
    return out


def main():
    players = json.load(open(PLAYERS))
    mine = load_mine()

    # projection-implied rank within position (1 = most projected pts)
    by_pos = {}
    for p in players:
        by_pos.setdefault(p["pos"], []).append(p)
    for lst in by_pos.values():
        lst.sort(key=lambda p: -(p.get("pts") or 0))
        for i, p in enumerate(lst, 1):
            p["proj_rank"] = i if p.get("pts") else None

    applied = 0
    price_overrides, ceiling, fade, missing = [], [], [], []
    for p in players:
        # reset per run (idempotent)
        for k in ("my_rank", "my_price", "model_cost", "my_note"):
            p.pop(k, None)
        m = mine.get((norm(p["name"]), p["pos"]))
        if not m:
            continue
        applied += 1
        if m["my_rank"] is not None:
            p["my_rank"] = m["my_rank"]
        if m["my_price"] is not None:
            p["model_cost"] = p.get("cost")
            p["cost"] = max(1, m["my_price"])
            price_overrides.append(f"  {p['name']} ({p['pos']}): ${p['model_cost']} -> ${p['cost']}")
        if m["note"]:
            p["my_note"] = m["note"]
        pr, mr = p.get("proj_rank"), p.get("my_rank")
        if pr and mr:
            d = pr - mr                     # +ve => you rank him higher than proj (ceiling)
            (ceiling if d >= 5 else fade if d <= -5 else []).append((p, d))

    # ceiling field for the HTML
    for p in players:
        pr, mr = p.get("proj_rank"), p.get("my_rank")
        d = (pr - mr) if (pr and mr) else None
        p["ceiling"] = "up" if (d and d >= 5) else ("down" if (d and d <= -5) else "")

    # detect ranking entries that matched no player
    matched = {(norm(p["name"]), p["pos"]) for p in players}
    for key, m in mine.items():
        if key not in matched:
            missing.append(f"  {m['name']} ({m['pos']}) -- not in players.json (name mismatch?)")

    json.dump(players, open(PLAYERS, "w"), indent=2)

    print(f"applied {applied}/{len(mine)} ranking entries; proj_rank computed for all")
    if price_overrides:
        print("\nprice overrides:")
        print("\n".join(price_overrides))
    if ceiling:
        print(f"\nCEILING (you rank >> projection; {len(ceiling)}):")
        for p, d in sorted(ceiling, key=lambda x: -x[1]):
            print(f"  {p['name']:22}{p['pos']:>3}  my rk{p['my_rank']:>3}  "
                  f"proj rk{p['proj_rank']:>3}  (+{d})  {p['pts']:.0f} pts  ${p['cost']}")
    if fade:
        print(f"\nFADE (you rank << projection; {len(fade)}):")
        for p, d in sorted(fade, key=lambda x: x[1]):
            print(f"  {p['name']:22}{p['pos']:>3}  my rk{p['my_rank']:>3}  "
                  f"proj rk{p['proj_rank']:>3}  ({d})  {p['pts']:.0f} pts  ${p['cost']}")
    if missing:
        print("\n!! unmatched entries (fix the name/position or delete):")
        print("\n".join(missing))
    print(f"\nupdated {PLAYERS}")


if __name__ == "__main__":
    main()
