"""Rigorous cost model: SF auction price ~ f(FantasyPros AVG ADP, position),
calibrated on this league's 2021-2025 data, predicted onto 2026 real ADP.

Apples-to-apples: both training ADP and 2026 ADP are FantasyPros (1-QB), and
the TARGET prices are this league's actual Superflex auction results -- so the
SF premium is baked into the learned relationship. No manual SF conversion.

Empirical monotonic medians by ADP bucket per position (robust to the top-end
blowup that power-laws suffer).
"""
from __future__ import annotations
import csv, os, re, json
from collections import defaultdict
from common import load_projections, points, LeagueConfig

HIST = os.path.expanduser("~/Downloads/Avant League History - Historical ADP - Fantasy Pros (2).csv")
ADP26 = os.path.expanduser("~/Downloads/FantasyPros_2026_Overall_ADP_Rankings.csv")
TRAIN_YEARS = list(range(2021, 2026))

def norm(name):
    s = re.sub(r"[.'']", "", name.lower())
    return " ".join(t for t in s.split() if t not in ("jr","sr","ii","iii","iv","v","i")).strip()

def load_hist():
    rows=[]
    with open(HIST) as fh:
        for r in csv.DictReader(fh):
            try: y=int(r["Year"]); adp=float(r["Avg"]); paid=int(r["Auction Paid"].replace("$",""))
            except (ValueError,KeyError): continue
            if y in TRAIN_YEARS and adp>0 and paid>0 and r["Position"] in ("QB","RB","WR","TE"):
                rows.append((r["Position"], adp, paid))
    return rows

def bucket(adp): return int(adp)//4*4   # width-4 ADP buckets

def build_cost(rows):
    d=defaultdict(lambda: defaultdict(list))
    for pos,adp,paid in rows: d[pos][bucket(adp)].append(paid)
    cost={}
    for pos in ["QB","RB","WR","TE"]:
        med={b:sorted(v)[len(v)//2] for b,v in d[pos].items()}
        best=float("inf")
        for b in sorted(med): best=min(best,med[b]); med[b]=best   # monotonic
        cost[pos]=med
    return cost

def predict(cost, pos, adp):
    m=cost[pos]; b=bucket(adp)
    if b in m: return max(1.0, m[b])
    # extrapolate: below min bucket -> that bucket; above max -> $1
    if b<min(m): return max(1.0,m[min(m)])
    return 1.0

def pos_of(s):
    m=re.match(r"[A-Z]+", s); return m.group() if m else ""

def load_2026():
    out=[]
    with open(ADP26) as fh:
        for r in csv.DictReader(fh):
            pos=pos_of(r["POS"])
            if pos not in ("QB","RB","WR","TE"): continue
            try: adp=float(r["AVG"])
            except ValueError: continue
            name=re.sub(r"\s+[A-Z]{2,4}\s*\(\d+\)\s*$","",r["Player (Bye)"]).strip()
            out.append(dict(pos=pos, adp=adp, name=name))
    return out

def main():
    hist=load_hist(); cost=build_cost(hist)
    print(f"trained on {len(hist)} (pos,adp,price) rows, 2021-2025")

    # fit check: MAE of bucket-median model on training
    err=0
    for pos,adp,paid in hist: err+=abs(predict(cost,pos,adp)-paid)
    print(f"in-sample MAE: ${err/len(hist):.1f}")

    proj=load_projections(); cfg=LeagueConfig()
    for p in proj:
        p["pts"]=points(p["pos"], p.get("payds",0), p.get("patd",0), p.get("int",0),
                        p.get("ruyds",0), p.get("rutd",0), p.get("rec",0),
                        p.get("reyds",0), p.get("retd",0), cfg)
    pbn={norm(p["name"]):p for p in proj}

    a26=load_2026()
    # within-position rank by ADP (for display + fallback)
    for pos in ["QB","RB","WR","TE"]:
        ps=sorted([x for x in a26 if x["pos"]==pos], key=lambda z:z["adp"])
        for i,x in enumerate(ps,1): x["rank"]=i

    out=[]; matched=0
    for x in a26:
        pm=pbn.get(norm(x["name"]))
        c=predict(cost, x["pos"], x["adp"])
        out.append(dict(name=x["name"], pos=x["pos"], rank=x["rank"], adp=x["adp"],
                        cost=int(round(max(1,c))),
                        pts=round(pm["pts"],1) if pm else None))
        if pm: matched+=1
    seen={norm(x["name"]) for x in a26}
    for p in proj:
        if norm(p["name"]) not in seen:
            out.append(dict(name=p["name"], pos=p["pos"], rank=999, adp=999, cost=1, pts=round(p["pts"],1)))
    print(f"2026: {len(a26)} ADP players, {matched} matched to projections, {len(out)} total")

    json.dump(out, open("out/players.json","w"), indent=2)

    # value table: ADP-rank -> predicted SF price, player, pts, pts/$
    print("\nADP-rank -> predicted SF price | player | proj pts | pts/$")
    print(f"{'pos':4}{'rk':>4}{'adp':>6}{'$price':>8}  {'player':22}{'pts':>7}{'pts/$':>8}")
    for pos in ["QB","RB","WR","TE"]:
        for rk in [1,2,3,5,8,10,12,15,18,24,30]:
            c=[o for o in out if o["pos"]==pos and o["rank"]==rk and o["pts"]]
            if not c: continue
            o=c[0]; ppo=f"{o['pts']/o['cost']:.2f}" if o["cost"]>0 else "-"
            print(f"{pos:4}{rk:>4}{o['adp']:>6.0f}{o['cost']:>8}  {o['name']:22}{o['pts']:>7}{ppo:>8}")
        print()
    print("saved out/players.json (ADP-based cost)")

if __name__=="__main__":
    main()
