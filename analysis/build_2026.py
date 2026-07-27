"""Build the 2026 player table with the user's framing:
  COST  = historical price for the player's ADP position-rank (market rank)
  VALUE = projected points (Gretch + Avant scoring)

Decoupling market-rank (cost) from projection (value) is what surfaces real
edges: projection-rank < ADP-rank  =>  market undervalues them.

Sources:
  ADP   ~/Downloads/Avant League History - Historical ADP - Fantasy Pros (2).csv
  PROJ  ~/Downloads/Ben Gretch 2026 Projections (7_23).xlsx
Writes out/players.json (consumed by 03_optimize.py).
"""
from __future__ import annotations
import csv, os, re, json
from collections import defaultdict
from common import load_projections, points, LeagueConfig

ADP_CSV = os.path.expanduser("~/Downloads/Avant League History - Historical ADP - Fantasy Pros (2).csv")
HIST_YEARS = list(range(2021, 2026))

def norm(name):
    s = name.lower()
    s = re.sub(r"[.'']", "", s)
    toks = [t for t in s.split() if t not in ("jr","sr","ii","iii","iv","v","i")]
    return " ".join(toks).strip()

def load_adp():
    rows=[]
    with open(ADP_CSV) as fh:
        for r in csv.DictReader(fh):
            try:
                year=int(r["Year"]); prank=int(r["Position Rank"])
            except (ValueError, KeyError, TypeError):
                continue
            paid = r.get("Auction Paid","").replace("$","").strip()
            try: paid=int(paid)
            except ValueError: paid=0
            rows.append(dict(year=year, pos=r["Position"], prank=prank,
                             name=r["Player_Name"].strip(), paid=paid))
    return rows

def cost_curve(rows):
    """monotonic median price by (pos, position-rank) on historical years."""
    d=defaultdict(lambda: defaultdict(list))
    for r in rows:
        if r["year"] in HIST_YEARS and r["paid"]>0:
            d[r["pos"]][r["prank"]].append(r["paid"])
    cost={}
    for pos in ["QB","RB","WR","TE"]:
        med={k: sorted(v)[len(v)//2] for k,v in d[pos].items()}
        best=float("inf")
        for k in sorted(med): best=min(best,med[k]); med[k]=best   # monotonic
        cost[pos]=med
    return cost

def main():
    adp=load_adp()
    cost=cost_curve(adp)
    proj=load_projections()
    cfg=LeagueConfig()
    for p in proj:
        p["pts"]=points(p["pos"], p.get("payds",0), p.get("patd",0), p.get("int",0),
                        p.get("ruyds",0), p.get("rutd",0), p.get("rec",0),
                        p.get("reyds",0), p.get("retd",0), cfg)
    proj_by_norm={norm(p["name"]):p for p in proj}

    y26=[r for r in adp if r["year"]==2026 and r["pos"] in ("QB","RB","WR","TE")]
    matched=0; out=[]
    for r in sorted(y26, key=lambda x:(x["pos"], x["prank"])):
        pm=proj_by_norm.get(norm(r["name"]))
        pts=pm["pts"] if pm else None
        c=cost[r["pos"]].get(r["prank"], 1)
        out.append(dict(name=r["name"], pos=r["pos"], rank=r["prank"], prank=r["prank"],
                        cost=int(round(max(1,c))), pts=round(pts,1) if pts else None))
        if pm: matched+=1
    # also keep projected players NOT in ADP (deep) at $1 cost
    seen={norm(r["name"]) for r in y26}
    for p in proj:
        if norm(p["name"]) not in seen:
            out.append(dict(name=p["name"], pos=p["pos"], rank=999, prank=999, cost=1, pts=round(p["pts"],1)))
    print(f"2026 players: {len(y26)} from ADP, {matched} matched to projections; "
          f"{len(out)} total in table")

    json.dump(out, open("out/players.json","w"), indent=2)

    # ── THE VALUE TABLE: what the user asked for ──────────────────────────────
    print("\nPOSITION-RANK  →  historical price, 2026 player, projected pts, pts/$")
    print(f"{'pos':4}{'rk':>4}{'$price':>8}  {'player':22}{'pts':>7}{'pts/$':>8}")
    for pos in ["QB","RB","WR","TE"]:
        rows=[o for o in out if o["pos"]==pos and o["pts"]]
        for rk in [1,2,3,5,8,10,12,15,18,24,30]:
            cand=[o for o in rows if o["prank"]==rk]
            if not cand: continue
            o=cand[0]
            ppo=f"{o['pts']/o['cost']:.2f}" if o["cost"]>0 else "-"
            print(f"{pos:4}{rk:>4}{o['cost']:>8}  {o['name']:22}{o['pts']:>7}{ppo:>8}")
        print()

    # ── best values: projection-rank far better than ADP-rank ─────────────────
    print("VALUE TARGETS (projected pts per market-$, among starters-tier):")
    cand=[o for o in out if o["pts"] and 6<=o["cost"]<=30]
    cand.sort(key=lambda o:-o["pts"]/o["cost"])
    for o in cand[:12]:
        print(f"  {o['name']:22}{o['pos']:>3} ADP-rk{o['prank']:>3} ${o['cost']:>3} "
              f"pts{o['pts']:>6.1f}  {o['pts']/o['cost']:.2f}pts/$")
    print("\nsaved out/players.json")

if __name__=="__main__":
    main()
