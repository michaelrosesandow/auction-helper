"""Value half: project points (Avant scoring), rank within position, attach
expected market cost (from 01), compute VORP + fair $ value, and cross-check
fair $ against realized 2025 prices.

Outputs out/players.json: every projected player with points, pos-rank, cost
(expected market price), vorp, fair$.
"""
from __future__ import annotations
import json, os
from collections import defaultdict
from common import load_projections, load_prices, points, LeagueConfig

CFG = LeagueConfig()   # Avant defaults baked into common.py

def main():
    proj = load_projections()
    for p in proj:
        p["pts"] = points(p["pos"], p.get("payds",0), p.get("patd",0), p.get("int",0),
                          p.get("ruyds",0), p.get("rutd",0), p.get("rec",0),
                          p.get("reyds",0), p.get("retd",0), CFG)
    # rank within position
    proj.sort(key=lambda x: -x["pts"])
    for pos in ["QB","RB","WR","TE"]:
        ps = [p for p in proj if p["pos"]==pos]
        for i,p in enumerate(ps,1): p["rank"]=i

    # attach cost: prefer user-supplied 2026 prices (out/prices_2026.csv), else
    # rank-based fallback. User's model handles name/ADP effects (Tua/Stroud).
    user_prices = {}
    upath = "out/prices_2026.csv"
    if os.path.exists(upath):
        import csv as _csv
        with open(upath) as fh:
            for row in _csv.DictReader(fh):
                key = (row.get("name") or row.get("Name") or "").strip()
                if not key: continue
                val = row.get("predicted_price") or row.get("price") or row.get("Predicted") or row.get("Prediction")
                try: user_prices[key] = float(val)
                except (TypeError, ValueError): pass
        print(f"loaded {len(user_prices)} user 2026 prices from {upath}")
    cost = json.load(open("out/dollar_curve.json"))["cost"]
    def price_of(pos, rank):
        m = cost[pos]
        if str(rank) in m: return max(1.0, m[str(rank)])
        return 1.0
    for p in proj:
        p["cost"] = round(user_prices.get(p["name"], price_of(p["pos"], p["rank"])))

    # replacement level = pts at the rank where price hits $1 (free-availability)
    repl = {}
    for pos in ["QB","RB","WR","TE"]:
        m = cost[pos]
        cliff = max(int(r) for r,v in m.items() if v > 1)   # last rank priced >$1
        repl[pos] = round(next(p["pts"] for p in proj if p["pos"]==pos and p["rank"]==cliff+1),1)
        # fallback if projection runs out
    print("replacement-level points (pts of first $1 player):", repl)

    for p in proj:
        p["vorp"] = round(max(0.0, p["pts"] - repl.get(p["pos"], 0)), 1)

    # fair $ = vorp share of the marginal-dollar pool.
    # marginal pool = $2400 − 180 rostered × $1 floor = $2220 (K/DST sit at ~$1).
    total_vorp = sum(p["vorp"] for p in proj)
    pool = 2400 - 180
    for p in proj:
        p["fair"] = round(1 + (p["vorp"]/total_vorp)*pool, 1) if p["vorp"]>0 else 1.0

    # cross-check: fair$ vs realized 2025 price (top 30 by pts each pos)
    print("\nfair$ vs 2025 actual (sanity check, top of board):")
    by_name = {p["name"]: p for p in proj}
    rows25 = [r for r in load_prices() if r["year"]==2025]
    name25 = {r["name"]: r["sal"] for r in rows25}
    hits=[]; 
    for p in sorted(proj, key=lambda x:-x["pts"])[:40]:
        act = name25.get(p["name"])
        if act is not None: hits.append((p["name"],p["pos"],p["rank"],p["fair"],act))
    print(f"  {'player':22}{'pos':>4}{'rk':>4}{'fair$':>7}{'act25':>7}{'diff':>7}")
    for n,pos,rk,f,a in hits[:25]:
        print(f"  {n:22}{pos:>4}{rk:>4}{f:>7.0f}{a:>7}{f-a:>7.0f}")
    mae = sum(abs(f-a) for _,_,_,f,a in hits)/len(hits)
    print(f"  MAE fair-vs-act (top-40 with a match, n={len(hits)}): ${mae:.1f}")

    os.makedirs("out", exist_ok=True)
    json.dump([dict(name=p["name"],pos=p["pos"],team=p.get("team",""),rank=p["rank"],
                    pts=p["pts"],cost=p["cost"],vorp=p["vorp"],fair=p["fair"])
               for p in proj], open("out/players.json","w"), indent=2)
    print(f"\nsaved out/players.json ({len(proj)} players)")

    # quick value leaders: best pts-per-$ (fair$) to preview edge
    print("\ntop value plays (pts per fair-$, min 8 fair$):")
    cand = [p for p in proj if p["fair"]>=8]
    cand.sort(key=lambda x: -(x["pts"]/x["fair"]))
    for p in cand[:10]:
        print(f"  {p['name']:22}{p['pos']:>3} rk{p['rank']:>2} pts{p['pts']:>6.1f} "
              f"fair${p['fair']:>5.0f}  {p['pts']/p['fair']:.2f}pts/$")

if __name__=="__main__":
    main()
