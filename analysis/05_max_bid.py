"""05_max_bid.py — Max-bid calculator for target players.

For each target, finds the highest auction price at which the optimal roster
STILL includes that player, vs. the best roster that EXCLUDES them (the pivot).
Above that price you're better off with the pivot — so don't outbid yourself
just because you love a guy.

Method (reuses 03_optimize.py for load/math/candidates; local FAST 1-opt climb):
  with(c)  = best roster objective when target is committed at cost c
             (target placed in its primary starter slot, anchor locked; rest
              optimized over the remaining budget)
  without  = best roster objective with target removed from the pool entirely
  max_bid  = largest c where with(c) >= without   (objective is ~monotonic in c)

Same optimizer for both sides, so the crossover is meaningful even though 1-opt
isn't globally optimal (relative comparison is what matters for a bid ceiling).

Reports max_bid under two objectives:
  RAW  : median points only          (no attrition haircut)
  REAL : median x realization factor (attrition study analysis/attrition_study.py)
         tiers by position-rank approximating snap-share cohorts:
         QB .76/.50 | RB bellcow .80 / shared-WH .76 / committee .71 / depth .60
         WR .77/.63 | TE .73/.53

Both objectives use the optionality bench model from 03_optimize.py (no flat
BENCH_W): bench value = pts×P(needed), with EXACTLY 1 bench QB required (3 QBs
total: 2 start + 1 backup) — inherited via the imports below.

Edit TARGETS. --all computes for every projected starter.
"""
from __future__ import annotations
import importlib.util, os, random, sys

_HERE = os.path.dirname(__file__)
_spec = importlib.util.spec_from_file_location("opt", os.path.join(_HERE, "03_optimize.py"))
opt = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(opt)
sys.modules["opt"] = opt
from opt import (load_players, roster_cost, roster_obj, seed, _repair,
                 cand_players, W, ALLSLOTS, ELIG, BENCH_ELIG, STARTERS,
                 _bench_qb_ok, _bench_cap_ok)

ORIG_BUDGET = opt.SKILL_BUDGET
PRIMARY = {"QB": "QB1", "RB": "RB1", "WR": "WR1", "TE": "TE", "K": "K", "DEF": "DST"}

TARGETS = [
    "Jahmyr Gibbs", "Bijan Robinson",            # elite bellcows
    "Chase Brown", "Kenneth Walker III", "David Montgomery",  # good workhorses
    "Jayden Daniels", "Brock Bowers", "Malik Nabers", "De'Von Achane",  # your 2025 core
]

def realization(p):
    pos, rk = p["pos"], p.get("rank", 999)
    if pos == "QB": return 0.76 if rk <= 16 else 0.50
    if pos == "RB": return 0.80 if rk <= 6 else 0.76 if rk <= 16 else 0.71 if rk <= 30 else 0.60
    if pos == "WR": return 0.77 if rk <= 12 else 0.63 if rk <= 36 else 0.55
    if pos == "TE": return 0.73 if rk <= 6 else 0.53
    return 0.70

def climb1(r, pool, lock=None):
    """Fast first-best 1-opt hill climb. Slot `lock` (if set) is frozen."""
    while True:
        base_cost, base_obj = roster_cost(r), roster_obj(r)
        ids = {id(r[s]) for s in ALLSLOTS}
        best, best_obj = None, base_obj
        for s in ALLSLOTS:
            if s == lock: continue
            cur = r[s]; cur_w = W(s, cur); cur_contrib = cur_w * cur["pts"]
            for p in cand_players(pool, ELIG.get(s, BENCH_ELIG)):
                if id(p) in ids and id(p) != id(cur): continue
                if not _bench_qb_ok(r, s, p): continue       # bench-QB cap
                dc = p["cost"] - cur["cost"]
                if base_cost + dc > ORIG_BUDGET: continue
                obj = base_obj - cur_contrib + W(s, p) * p["pts"]
                if obj > best_obj + 1e-9: best_obj, best = obj, (s, p)
        if best: r[best[0]] = best[1]
        else: return r

def fast_opt(pool, restarts, kicks, lock=None, anchor=None):
    best_r = None; best = -1e9
    free = [s for s in ALLSLOTS if s != lock]
    for rs in range(restarts):
        r = seed(pool, cheap=(rs % 2 == 0))
        if lock: r[lock] = anchor
        r = _repair(r, pool)
        if lock: r[lock] = anchor
        r = climb1(r, pool, lock)
        if (not lock or r[lock] is anchor) and roster_cost(r) <= ORIG_BUDGET and _bench_cap_ok(r):
            v = roster_obj(r)
            if v > best: best, best_r = v, dict(r)
        if best_r is None: continue
        for _ in range(kicks):
            rk = dict(best_r)
            for _ in range(random.randint(3, 5)):
                s = random.choice(free)
                p = random.choice(cand_players(pool, ELIG.get(s, BENCH_ELIG)))
                if all(id(rk[x]) != id(p) for x in ALLSLOTS if x != s): rk[s] = p
            if lock: rk[lock] = anchor
            rk = _repair(rk, pool)
            if lock: rk[lock] = anchor
            rk = climb1(rk, pool, lock)
            if (not lock or rk[lock] is anchor) and roster_cost(rk) <= ORIG_BUDGET and _bench_cap_ok(rk):
                v = roster_obj(rk)
                if v > best: best, best_r = v, dict(rk)
    return best_r

def pool_without(by_pos, name, pos):
    return {p: [x for x in lst if not (x["name"] == name and x["pos"] == pos)]
            for p, lst in by_pos.items()}

def max_bid(by_pos, target, restarts=6, kicks=14, span=30, step=2):
    """Returns (max_bid, without_obj, without_roster).

    Looks the target up IN the supplied pool so the anchor's pts match the
    pool's realization (otherwise an unrealized target in a realized pool gets
    credited full median and inflates the bid)."""
    pool_target = None
    for lst in by_pos.values():
        for p in lst:
            if p["name"] == target["name"] and p["pos"] == target["pos"]:
                pool_target = p; break
        if pool_target: break
    target = pool_target or target
    pool_wo = pool_without(by_pos, target["name"], target["pos"])
    wo_r = fast_opt(pool_wo, restarts, kicks)
    wo = roster_obj(wo_r) if wo_r else -1e9
    slot = PRIMARY[target["pos"]]
    hi = target["cost"] + span
    best_c = 0
    for c in range(1, hi + 1, step):
        anchor = dict(target); anchor["cost"] = c
        pool = pool_without(by_pos, target["name"], target["pos"])
        r = fast_opt(pool, restarts, kicks, lock=slot, anchor=anchor)
        if r and roster_obj(r) >= wo - 1e-6:
            best_c = c
    pivot = max((wo_r[s] for s in STARTERS), key=lambda p: p["pts"]) if wo_r else None
    return best_c, wo, pivot

def realize_pool(by_pos):
    return {pos: [dict(p, pts=round(p["pts"] * realization(p), 1)) for p in lst]
            for pos, lst in by_pos.items()}

def main():
    random.seed(42)
    P, by_pos = load_players()
    real_pos = realize_pool(by_pos)
    by_name = {p["name"]: p for p in P if p.get("pts")}
    print(f"{'TARGET':22}{'pos':>4}{'rk':>3}{'mkt':>5} | {'RAW':>4} {'REAL':>4} | {'gap':>4}  call  pivot (best starter w/o target)")
    print("-" * 98)
    for nm in TARGETS:
        t = by_name.get(nm)
        if not t: print(f"{nm:22}  NOT FOUND"); continue
        mb_raw, _, piv_raw = max_bid(by_pos, t)
        mb_real, _, piv_real = max_bid(real_pos, t)
        gap = mb_real - t["cost"]
        call = "BUY " if gap >= 3 else ("OK " if gap >= -2 else "SKIP")
        piv = piv_real or piv_raw
        pn = f"{piv['name']} ({piv['pos']})" if piv else "-"
        print(f"{nm:22}{t['pos']:>4}{t['rank']:>3}{t['cost']:>5} | {mb_raw:>4} {mb_real:>4} | {gap:>+4} {call:<4} {pn}")
    print("\nlegend: mkt=predicted price  RAW=max-bid on median  REAL=max-bid w/ attrition")
    print("        gap=REAL-mkt   BUY=room to spend  OK=~fair  SKIP=even at mkt the pivot is better")
    print("        pivot = best single starter on the roster that excludes the target")

if __name__ == "__main__":
    main()
