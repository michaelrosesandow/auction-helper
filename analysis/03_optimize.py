"""Optimize the 2026 roster / par sheet via hill-climbing local search.

The decision is which RANK to target at each starter slot (you can't afford the
best everywhere). Points & cost are monotonic in rank, so the landscape is smooth
and single-slot rank-swaps (which reallocate budget between positions) converge
to the optimum. Multiple restarts + archetype constraints.

Roster (15): QB1,RB1,RB2,WR1,WR2,TE,FLEX,SF,K,DST + 5 bench.
Objective: starter pts + optionality-weighted bench pts (see BENCH_NEED).
Budget $200; K+DST sink $2.

Bench model (replaces the flat BENCH_W=0 / =0.25 knobs — BOTH were wrong):
  BENCH_W=0     forced stars-and-scrubs (bench had no opportunity cost → all $1).
  BENCH_W=0.25  stuffed the bench with cheap QBs (raw-pts distortion: a 5th QB
                never plays but 0.25×300 > 0.25×60 scrub WR).
  Fix: value a bench player as INSURANCE = pts × P(needed) × (season share),
  where P(needed) = 1 − retention^n for n starters ahead (attrition-study
  priors, analysis/attrition_study.py) and ~0.5 season is realized on a
  mid-season promotion. AND require EXACTLY 1 bench QB (3 QBs total: 2 start in
  QB1+SF + 1 backup) — the user's roster rule: 2 QBs is too much bye/injury
  risk unless you pay for 2 elites (shown suboptimal on medians). The exactly-1
  target also kills stuffing (can't exceed 1), so the backup QB now carries its
  honest optionality weight instead of the old weight-0 hack.
"""
from __future__ import annotations
import json, random
from common import LeagueConfig

BUDGET = 200
# Bench optionality weight by position = pts × weight. Derived from attrition
# priors: P(needed) = 1 − retention^n for n starters ahead, ×0.5 season realized.
# RB 1−.78²=.39×.5=.20 | WR 1−.70²=.51×.5=.25 | TE 1−.73=.27×.5=.14
# QB ≈1−.84²=.29 (injury to 1 of 2 starters)×.5=.15 — a backup's value is real
# but modest; the exactly-1 rule below means it can't be stuffed (no >1).
BENCH_NEED = {"RB": 0.20, "WR": 0.25, "TE": 0.14, "QB": 0.15}
BENCH_QBS = 1   # EXACTLY N bench QBs: 2 start (QB1+SF) + 1 backup = 3 total.
                # Insurance rule (user): 2 QBs is too risky unless 2 elites.
FIXED = {"K":1, "DST":1}                     # $2 sunk
SKILL_BUDGET = BUDGET - sum(FIXED.values())  # $198 for 13 skill slots
STARTERS = ["QB1","RB1","RB2","WR1","WR2","TE","FLEX","SF"]
BENCH = ["BN1","BN2","BN3","BN4","BN5"]
ELIG = {"QB1":["QB"],"RB1":["RB"],"RB2":["RB"],"WR1":["WR"],"WR2":["WR"],
        "TE":["TE"],"FLEX":["RB","WR","TE"],"SF":["QB","RB","WR","TE"]}
ALLSLOTS = STARTERS + BENCH
BENCH_ELIG = ["QB","RB","WR","TE"]

def load_players():
    P = json.load(open("out/players.json"))
    P = [p for p in P if p.get("pts") is not None]   # drop unmatched (no projection)
    P.sort(key=lambda p:(p["pos"], p["rank"]))
    by_pos = {pos:[p for p in P if p["pos"]==pos] for pos in ["QB","RB","WR","TE"]}
    return P, by_pos

def roster_cost(roster):
    return sum(roster[s]["cost"] for s in ALLSLOTS)

def starter_pts(roster): return sum(roster[s]["pts"] for s in STARTERS)
def bench_pts(roster):   return sum(roster[s]["pts"] for s in BENCH)            # raw, for display
def bench_value(roster):                                                  # optionality-weighted (objective's bench term)
    return sum(BENCH_NEED.get(roster[s]["pos"], 0.0) * roster[s]["pts"] for s in BENCH)
def roster_obj(roster):  return starter_pts(roster) + bench_value(roster)

def seed(by_pos, cheap=True):
    """A feasible roster: cheap seed fills each slot with the cheapest eligible
    distinct player; then we climb. cheap=False -> mid-tier seed."""
    roster={}; used=set()
    def pick(elig, rank_idx):
        for p in (by_pos[pos] for pos in elig):
            pass
        # iterate players in eligible positions by rank; pick first unused
        for pos in elig:
            lst = by_pos[pos]
            i = rank_idx if rank_idx < len(lst) else len(lst)-1
            # search outward for an unused one near index i
            for off in range(len(lst)):
                idx = min(len(lst)-1, max(0, i+ (off if off%2==0 else -off)))
                if id(lst[idx]) not in used: return lst[idx]
        return None
    for s in STARTERS:
        # cheap: pick near the tail (high rank). index = len-2 to leave some slack
        idx = len(by_pos[ELIG[s][0]])-3 if cheap else 8
        p = pick(ELIG[s], idx); used.add(id(p)); roster[s]=p
    # bench: exactly BENCH_QBS backup QB(s) + the rest cheap WR/RB/TE depth
    bench_qbs=0
    for s in BENCH:
        if bench_qbs < BENCH_QBS:
            p = pick(["QB"], len(by_pos["QB"])-3)                # cheap backup QB
        else:
            p = pick([pos for pos in BENCH_ELIG if pos!="QB"], len(by_pos["WR"])-3)
        used.add(id(p)); roster[s]=p
        if p["pos"]=="QB": bench_qbs+=1
    return roster

TOPK = 24  # candidate ranks per position for starter search

def cand_players(by_pos, elig):
    out=[]
    for pos in elig:
        lst=by_pos[pos]
        out += lst[:TOPK]
        if lst[-1]["cost"]<=2: out += [lst[-1]]   # + a $1 punt option
    return out

def W(s, p):
    """Objective weight of player `p` in slot `s`: 1.0 for starters, the
    position's optionality weight for bench (see BENCH_NEED)."""
    return 1.0 if s in STARTERS else BENCH_NEED.get(p["pos"], 0.0)

def _bench_cap_ok(r):
    return sum(1 for s in BENCH if r[s]["pos"] == "QB") == BENCH_QBS

def _bench_qb_ok(r, slot, p):
    """Per-move guard: would placing `p` in bench `slot` keep bench-QB count
    <= BENCH_QBS? (Blocks EXCEEDING. The exactly-=BENCH_QBS requirement is
    enforced globally by _bench_cap_ok at feasibility, so a move that drops the
    count below target is allowed here and restored/filtered later.)"""
    if slot not in BENCH or p["pos"] != "QB": return True
    others = sum(1 for s in BENCH if s != slot and r[s]["pos"] == "QB")
    return others < BENCH_QBS

def climb(r, by_pos, constraint):
    """1-opt (all slots) + 2-opt rebudget (starter pairs), incremental eval."""
    while True:
        improved=False
        base_cost=roster_cost(r); base_obj=roster_obj(r)
        ids={id(r[s]) for s in ALLSLOTS}
        # ── 1-opt ──
        best=None; best_obj=base_obj
        for s in ALLSLOTS:
            cur=r[s]; cur_w=W(s,cur); cur_contrib=cur_w*cur["pts"]
            for p in cand_players(by_pos, ELIG.get(s,BENCH_ELIG)):
                if id(p) in ids and id(p)!=id(cur): continue   # used elsewhere
                if not _bench_qb_ok(r, s, p): continue          # bench-QB cap
                dc=p["cost"]-cur["cost"]
                if base_cost+dc>SKILL_BUDGET: continue
                obj=base_obj - cur_contrib + W(s,p)*p["pts"]
                if obj<=best_obj+1e-9: continue
                r[s]=p
                ok = constraint(r)
                r[s]=cur
                if ok: best_obj=obj; best=(s,p)
        if best:
            r[best[0]]=best[1]; improved=True; continue
        # ── 2-opt rebudget between two STARTER slots ──
        bestpair=None; bestpair_obj=base_obj
        for i,si in enumerate(STARTERS):
            ci=r[si]
            for sj in STARTERS[i+1:]:
                cj=r[sj]
                others=ids-{id(ci),id(cj)}
                ci_cost_cj_cost=ci["cost"]+cj["cost"]; ci_pts_cj_pts=ci["pts"]+cj["pts"]
                for a in cand_players(by_pos,ELIG[si]):
                    if id(a) in others or id(a)==id(cj): continue
                    for b in cand_players(by_pos,ELIG[sj]):
                        if id(b)==id(a) or id(b) in others or id(b)==id(ci): continue
                        nc=base_cost - ci_cost_cj_cost + a["cost"]+b["cost"]
                        if nc>SKILL_BUDGET: continue
                        obj=base_obj - ci_pts_cj_pts + a["pts"]+b["pts"]
                        if obj<=bestpair_obj+1e-9: continue
                        r[si]=a; r[sj]=b; ok=constraint(r); r[si]=ci; r[sj]=cj
                        if ok: bestpair_obj=obj; bestpair=(si,sj,a,b)
        if bestpair:
            si,sj,a,b=bestpair; r[si]=a; r[sj]=b; improved=True
        if not improved: return r

def _repair(r, by_pos):
    for s in sorted(BENCH, key=lambda z:-r[z]["cost"]):
        if roster_cost(r)<=SKILL_BUDGET: break
        if r[s]["pos"]=="QB": continue                              # preserve exactly-BENCH_QBS
        for pos in BENCH_ELIG:
            if pos=="QB" and not _bench_qb_ok(r, s, {"pos":"QB"}): continue   # cap
            for p in by_pos[pos]:
                if p["cost"]<=1 and all(id(r[sl])!=id(p) for sl in ALLSLOTS if sl!=s):
                    r[s]=p; break
            else: continue
            break
    return r

def optimize(by_pos, constraint=lambda r: True, restarts=12, kicks=40):
    con = lambda r: _bench_cap_ok(r) and constraint(r)    # fold in the bench-QB cap
    best=None
    for rs in range(restarts):
        r = seed(by_pos, cheap=(rs%2==0))
        for _ in range(5):
            s=random.choice(ALLSLOTS)
            p=random.choice(cand_players(by_pos,ELIG.get(s,BENCH_ELIG)))
            if all(id(r[sl])!=id(p) for sl in ALLSLOTS if sl!=s): r[s]=p
        r=_repair(r,by_pos); r=climb(r,by_pos,con)
        if con(r) and roster_cost(r)<=SKILL_BUDGET:
            if best is None or roster_obj(r)>roster_obj(best): best=dict(r)
        if best is None: continue
        for _ in range(kicks):                 # basin hopping
            rk=dict(best)
            for _ in range(random.randint(3,5)):
                s=random.choice(STARTERS)
                p=random.choice(cand_players(by_pos,ELIG[s]))
                if all(id(rk[sl])!=id(p) for sl in ALLSLOTS if sl!=s): rk[s]=p
            rk=_repair(rk,by_pos); rk=climb(rk,by_pos,con)
            if con(rk) and roster_cost(rk)<=SKILL_BUDGET and roster_obj(rk)>roster_obj(best):
                best=dict(rk)
    return best

# ── archetype constraints ───────────────────────────────────────────────────
def c_stars(r):
    return sum(1 for s in STARTERS if r[s]["cost"]>=45)>=2
def c_balanced(r):
    return all(r[s]["cost"]<45 for s in STARTERS) and sum(1 for s in STARTERS if 15<=r[s]["cost"]<=40)>=4
def c_qbheavy(r):
    qbs=[r[s] for s in STARTERS if r[s]["pos"]=="QB"]
    return len(qbs)>=2 and sum(1 for p in qbs if p["rank"]<=12)>=2
def c_herorb(r):
    rbs=[r[s] for s in STARTERS if r[s]["pos"]=="RB"]
    top6=sum(1 for p in rbs if p["rank"]<=6)
    return top6==1 and any(p["rank"]>=18 for p in rbs)

def fmt(roster, label, counts_fn=None):
    sc=starter_pts(roster); bc=bench_pts(roster); cost=roster_cost(roster)+2
    print(f"\n=== {label} ===")
    extra=""
    if counts_fn: extra="  "+counts_fn(roster)
    print(f"   cost ${cost}  | starter {sc:.0f}  bench {bc:.0f}  obj {roster_obj(roster):.0f}{extra}")
    for s in ALLSLOTS:
        p=roster[s]; tag="start" if s in STARTERS else "bench"
        print(f"   {s:5} ${p['cost']:>3}  {p['name']:22}{p['pos']:>3} rk{p['rank']:>2} {p['pts']:>6.1f}  [{tag}]")
    print(f"   K    $  1   (kicker)\n   DST  $  1   (defense)")

def counts_str(r):
    from collections import Counter
    c=Counter(r[s]["pos"] for s in ALLSLOTS)
    return f"QB{c['QB']}/RB{c['RB']}/WR{c['WR']}/TE{c['TE']}"

def par_sheet(roster):
    order=["QB1","RB1","RB2","WR1","WR2","TE","FLEX","SF","K","DST","BN1","BN2","BN3","BN4","BN5"]
    par=dict(FIXED)
    for s in STARTERS+BENCH: par[s]=roster[s]["cost"]
    return order, par

def main():
    random.seed(42)
    P, by_pos = load_players()
    print(f"loaded {len(P)} players; optimizing (hill-climb, restarts)\n")

    results={}
    specs=[("OPTIMAL", None),
           ("STARS & SCRUBS", c_stars),
           ("BALANCED", c_balanced),
           ("QB-HEAVY", c_qbheavy),
           ("HERO RB", c_herorb)]
    for label, con in specs:
        fn = (lambda r: True) if con is None else con
        r = optimize(by_pos, fn, restarts=10, kicks=35)
        if r: results[label]=r; fmt(r, label, counts_str)
        else: print(f"\n=== {label}: no feasible build ===")

    rec = results["OPTIMAL"]
    order, par = par_sheet(rec)
    print("\n=== RECOMMENDED PAR SHEET (optimal → drop into DEFAULT_WEIGHTS) ===")
    print(f"   {'slot':5} {'$':>3}")
    for s in order: print(f"   {s:5} {par[s]:>3}")
    print(f"   TOTAL ${sum(par.values())}")

    summary={label:dict(starter=round(starter_pts(r)), bench=round(bench_pts(r)),
                        cost=roster_cost(r)+2, obj=round(roster_obj(r)),
                        par=dict(par_sheet(r)[1])) for label,r in results.items()}
    summary["_bench_model"]=dict(bench_need=BENCH_NEED, bench_qbs=BENCH_QBS,
        note="bench = pts×optionality (P(needed)×0.5season); exactly 1 bench QB (3 total)")
    json.dump(summary, open("out/par_sheet.json","w"), indent=2)
    print("\nsaved out/par_sheet.json")

if __name__=="__main__":
    main()
