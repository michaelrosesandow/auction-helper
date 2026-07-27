"""Cost model: expected market price by (position, within-position rank) on the
15-man Superflex era (2020-2025). Scoring-INDEPENDENT (cost half of the model).

A single power law blows up at rank 1 (elite tier is far flatter than a power
decay predicts), so the PRIMARY model is the monotonic empirical median per rank
(pooled 2020-25, 6 obs/rank). For ranks beyond observed data we tail off to $1
via an exponential fit on the observed tail.
"""
from __future__ import annotations
import math, json, os
from collections import defaultdict
from common import load_prices

ERA = list(range(2020, 2026))   # 15-man Superflex era
FLOOR = 1.0

def median(xs):
    s = sorted(xs); n = len(s)
    return s[n//2] if n % 2 else (s[n//2-1]+s[n//2])/2

def build_cost(by_pos):
    """Return {pos: {rank: median_price}} monotonic non-increasing, tailed to $1."""
    cost = {}
    for pos, pts in by_pos.items():
        d = defaultdict(list)
        for r, s in pts: d[r].append(s)
        max_rank = max(d)
        med = {r: median(d[r]) for r in range(1, max_rank+1) if r in d}
        # enforce monotonic non-increasing (price can only fall with worse rank)
        best = math.inf
        for r in sorted(med):
            best = min(best, med[r]); med[r] = best
        # tail: beyond observed, decay last value toward $1 (rarely needed)
        cost[pos] = med
    return cost

def predict(cost, pos, rank):
    m = cost[pos]
    if rank in m: return max(FLOOR, m[rank])
    if rank < min(m): return m[min(m)]
    return FLOOR   # beyond data -> $1

def main():
    rows = [r for r in load_prices() if r["year"] in ERA]
    by_pos = defaultdict(list)
    for r in rows: by_pos[r["pos"]].append((r["prank"], r["sal"]))
    cost = build_cost(by_pos)

    print("expected market price ($) by within-position rank (2020-25 median):")
    print(f"{'rank':>6}" + "".join(f"{p:>8}" for p in ["QB","RB","WR","TE"]))
    for rk in [1,2,3,6,9,12,18,24,30,36]:
        print(f"{rk:>6}" + "".join(f"{predict(cost,p,rk):>8.0f}" for p in ["QB","RB","WR","TE"]))

    # how many at each position actually get bid up (price > $1)
    print("\n# players above $1 floor by position (2020-25 median):")
    for pos in ["QB","RB","WR","TE"]:
        above = sum(1 for r,p in cost[pos].items() if p > 1)
        print(f"  {pos}: rank<= {max((r for r,p in cost[pos].items() if p>1), default=0)} priced > $1  ({above} ranks)")

    # cost to acquire the top-K by position (sum of medians)
    print("\ntotal $ to buy the top-K by position (median sum):")
    for pos in ["QB", "RB", "WR", "TE"]:
        for k in [12, 24, 36]:
            tot = sum(predict(cost, pos, r) for r in range(1, k+1))
            print(f"  {pos} top{k}: ${tot:.0f}", end="   ")
        print()

    os.makedirs("out", exist_ok=True)
    with open("out/dollar_curve.json", "w") as fh:
        json.dump({"era": ERA, "floor": FLOOR, "cost": cost}, fh, indent=2)
    print("\nsaved out/dollar_curve.json")

if __name__ == "__main__":
    main()
