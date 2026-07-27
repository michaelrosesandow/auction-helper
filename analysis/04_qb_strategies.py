"""04_qb_strategies.py - Compare QB roster-construction strategies (3-QB).

In superflex you roster 3 QBs (2 start in QB1+SF; the 3rd is cheap bench
insurance for bye/injury). So EVERY plan here carries 3 QBs. The only open
question is which 2 START - i.e. how much to spend on the starting QB pair.

For each plan we FIX the 3 QBs, then solve EXACTLY for the best 6 non-QB skill
starters (RB1,RB2,WR1,WR2,TE,FLEX) within the leftover budget. Because QBs never
compete with RB/WR/TE slots, the skill optimum is a pure function of budget, so
we solve it once with an exact 0/1 knapsack DP (the old hill-climb got stuck on
TE/RB tier cliffs). This is the fair apples-to-apples test of the QB decision.

Objective = starter points (bench weight 0, same as 03_optimize). A bench QB
costs $ vs a $1 scrub but adds 0 starter pts - its value is insurance, noted
separately, not counted in the objective.

Run:  python3 04_qb_strategies.py   ->  out/qb_strategies.json
"""
from __future__ import annotations
import json, os

_HERE = os.path.dirname(__file__)

# load players (reuse the optimizer's loader)
import importlib.util
_spec = importlib.util.spec_from_file_location("opt", os.path.join(_HERE, "03_optimize.py"))
opt = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(opt)
P, by_pos = opt.load_players()

TOTAL = 200
K_DST = 2
BENCH_SLOTS = 5
QB_SLOTS = {"QB1", "SF"}
ASK_TAGS = {"HERO-DAN-CHP", "HERO-DAN-VAL"}
REC_TAG = "MID-3"


def find(name: str):
    for p in P:
        if p["name"].lower() == name.lower():
            return p
    raise KeyError(f"player not found: {name}")


# ── EXACT skill-starter solver ───────────────────────────────────────────────
# Roster needs: 2 RB (RB1,RB2) + 2 WR (WR1,WR2) + 1 TE + 1 FLEX(RB|WR|TE).
# => pick 2 RB + 2 WR + 1 TE + 1 FLEX, all distinct, max pts <= budget.
# Position pools are disjoint so distinctness is automatic. We branch on the
# FLEX's position and solve "pick exactly k from a position pool" with a 0/1
# knapsack DP, then convolve the three positions' Pareto frontiers.
SKILL_POOL = {pos: list(by_pos[pos]) for pos in ("RB", "WR", "TE")}   # rank-asc, incl $1 scrubs


def _pareto(d):
    """{cost: (pts, players)} -> Pareto frontier [(cost, pts, players)], pts strictly rising."""
    out, best = [], -1.0
    for cost in sorted(d):
        pts, pls = d[cost]
        if pts > best:
            best = pts
            out.append((cost, pts, pls))
    return out


def _pos_frontier(pos, count, cost_cap):
    """Best pts picking EXACTLY `count` distinct players from pos, as a Pareto
    frontier over cost. 0/1 knapsack, items processed one-by-one, count desc."""
    dp = [dict() for _ in range(count + 1)]
    dp[0][0] = (0.0, [])
    for p in SKILL_POOL[pos]:
        for c in range(count, 0, -1):
            prev = dp[c - 1]
            for cost, (pts, pls) in list(prev.items()):
                nc = cost + p["cost"]
                if nc > cost_cap:
                    continue
                npts = pts + p["pts"]
                cur = dp[c].get(nc)
                if cur is None or npts > cur[0]:
                    dp[c][nc] = (npts, pls + [p])
    return _pareto(dp[count])


# compute frontiers ONCE (cost cap = whole budget); combine per-plan budget
_FRONT = {pos: {k: _pos_frontier(pos, k, TOTAL) for k in range(0, 4)}
          for pos in ("RB", "WR", "TE")}
# FLEX position -> (RB count, WR count, TE count)
_CASES = [("RB", 3, 2, 1), ("WR", 2, 3, 1), ("TE", 2, 2, 2)]
_skill_cache = {}


def opt_skill(budget):
    """Exact max non-QB starter pts <= budget. Returns (pts, {slot: player})."""
    budget = int(budget)
    if budget in _skill_cache:
        return _skill_cache[budget]
    best_pts, best_combo = -1.0, None
    for fpos, rn, wn, tn in _CASES:
        frb, fwr, fte = _FRONT["RB"][rn], _FRONT["WR"][wn], _FRONT["TE"][tn]
        for rc, rpt, rpl in frb:
            if rc > budget:
                continue
            for wc, wpt, wpl in fwr:
                if rc + wc > budget:
                    continue
                for tc, tpt, tpl in fte:
                    if rc + wc + tc > budget:
                        continue
                    tot = rpt + wpt + tpt
                    if tot > best_pts:
                        best_pts, best_combo = tot, (rpl, wpl, tpl, fpos)
    rbs, wrs, tes, fpos = best_combo
    rbs, wrs, tes = (sorted(rbs, key=lambda p: -p["pts"]),
                     sorted(wrs, key=lambda p: -p["pts"]),
                     sorted(tes, key=lambda p: -p["pts"]))
    slot = {"RB1": rbs[0], "RB2": rbs[1], "WR1": wrs[0], "WR2": wrs[1], "TE": tes[0]}
    if fpos == "RB":      slot["FLEX"] = rbs[2]   # 3 RBs picked
    elif fpos == "WR":    slot["FLEX"] = wrs[2]   # 3 WRs picked
    else:                 slot["FLEX"] = tes[1]   # 2 TEs picked
    _skill_cache[budget] = (best_pts, slot)
    return best_pts, slot


# ── the QB plans under test ──────────────────────────────────────────────────
# EVERY build carries 3 QBs (2 start in QB1+SF; BN1 is cheap bench insurance).
# Bench QB = a $6 value guy (Baker/Stroud); a $4 (Ward/Young/Jones) saves ~$2.
PLANS = [
    # ── aggressively cheap: 3 QBs at ~$3-4 (rank 24+). The "punt QB to the floor" bet. ──
    {"tag": "AGGRO-BEST",   "name": "Aggro cheap - Jones + Rodgers + Young  (3x ~$3-4 punt)",
     "qbs": {"QB1": "Daniel Jones", "SF": "Aaron Rodgers", "BN1": "Bryce Young"}},
    {"tag": "AGGRO-YOUNG",  "name": "Aggro cheap (upside) - Jones + Young + Ward",
     "qbs": {"QB1": "Daniel Jones", "SF": "Bryce Young", "BN1": "Cam Ward"}},
    {"tag": "AGGRO-FLOOR",  "name": "Aggro cheap (w/ Mendoza) - Jones + Rodgers + Mendoza",
     "qbs": {"QB1": "Daniel Jones", "SF": "Aaron Rodgers", "BN1": "Fernando Mendoza"}},
    # ── the rest of the spectrum ──
    {"tag": "CHEAP-3",      "name": "3 Cheap QBs - Love + Baker + Stroud",
     "qbs": {"QB1": "Jordan Love", "SF": "Baker Mayfield", "BN1": "C.J. Stroud"}},
    {"tag": "MID-3",        "name": "2 Mid + insurance - Kyler + Love + Baker  (median optimum)",
     "qbs": {"QB1": "Kyler Murray", "SF": "Jordan Love", "BN1": "Baker Mayfield"}},
    {"tag": "HERO-DAN-CHP", "name": "Hero (cheapest) - Daniels + Baker + Stroud  \u2605 your ask",
     "qbs": {"QB1": "Jayden Daniels", "SF": "Baker Mayfield", "BN1": "C.J. Stroud"}},
    {"tag": "HERO-DAN-VAL", "name": "Hero (value) - Daniels + Love + Baker  \u2605 your ask",
     "qbs": {"QB1": "Jayden Daniels", "SF": "Jordan Love", "BN1": "Baker Mayfield"}},
    {"tag": "HERO-HURTS",   "name": "Hero (value) - Hurts + Love + Baker",
     "qbs": {"QB1": "Jalen Hurts", "SF": "Jordan Love", "BN1": "Baker Mayfield"}},
    {"tag": "BAL-MID-3",    "name": "Balanced + insurance - Dak + Purdy + Baker",
     "qbs": {"QB1": "Dak Prescott", "SF": "Brock Purdy", "BN1": "Baker Mayfield"}},
    {"tag": "BAL-HI-3",     "name": "Balanced (hi) + insurance - Herbert + Mahomes + Baker",
     "qbs": {"QB1": "Justin Herbert", "SF": "Patrick Mahomes II", "BN1": "Baker Mayfield"}},
    {"tag": "ELITE-VAL-3",  "name": "2 Elite (value) + insurance - Daniels + Hurts + Baker",
     "qbs": {"QB1": "Jayden Daniels", "SF": "Jalen Hurts", "BN1": "Baker Mayfield"}},
    {"tag": "HERO-ALLEN-3", "name": "Hero (elite) + insurance - Allen + Kyler + Baker",
     "qbs": {"QB1": "Josh Allen", "SF": "Kyler Murray", "BN1": "Baker Mayfield"}},
    {"tag": "ELITE-TOP-3",  "name": "2 Elite (top) + insurance - Allen + Lamar + Baker",
     "qbs": {"QB1": "Josh Allen", "SF": "Lamar Jackson", "BN1": "Baker Mayfield"}},
]


def _row(slot, p, role):
    return {"slot": slot, "name": p["name"], "pos": p["pos"], "rank": p["rank"],
            "cost": p["cost"], "pts": round(p["pts"], 1), "role": role}


def evaluate(plan):
    placed = {}
    for slot, name in plan["qbs"].items():
        placed[slot] = find(name)
    bench_qb_slots = [s for s in plan["qbs"] if s.startswith("BN")]
    qb_cost = sum(p["cost"] for p in placed.values())
    qb_starter_pts = sum(placed[s]["pts"] for s in placed if s in QB_SLOTS)
    bench_scrub_dollars = (BENCH_SLOTS - len(bench_qb_slots)) * 1
    free_budget = TOTAL - K_DST - qb_cost - bench_scrub_dollars

    non_qb_pts, skill = opt_skill(free_budget)
    starter_pts = qb_starter_pts + non_qb_pts

    order = ["QB1", "RB1", "RB2", "WR1", "WR2", "TE", "FLEX", "SF", "K", "DST",
             "BN1", "BN2", "BN3", "BN4", "BN5"]
    roster = []
    for s in order:
        if s in placed:
            roster.append(_row(s, placed[s], "QB-plan"))
        elif s in skill:
            roster.append(_row(s, skill[s], "start"))
        elif s in ("K", "DST"):
            roster.append({"slot": s, "name": "(kicker)" if s == "K" else "(defense)",
                           "pos": s, "rank": None, "cost": 1, "pts": 0, "role": "fixed"})
        else:
            roster.append({"slot": s, "name": "$1 scrub", "pos": "-", "rank": None,
                           "cost": 1, "pts": 0, "role": "bench"})
    total_cost = K_DST + qb_cost + sum(skill[s]["cost"] for s in skill) + bench_scrub_dollars
    return {
        "tag": plan["tag"], "name": plan["name"], "is_ask": plan["tag"] in ASK_TAGS,
        "qb_cost": qb_cost,
        "qb_starter_pts": round(qb_starter_pts, 1),
        "non_qb_starter_pts": round(non_qb_pts, 1),
        "starter_pts": round(starter_pts, 1),
        "free_budget": free_budget,
        "bench_qbs": [{"slot": s, "name": placed[s]["name"], "cost": placed[s]["cost"],
                       "pts": round(placed[s]["pts"], 1)} for s in bench_qb_slots],
        "total_cost": total_cost,
        "roster": roster,
    }


def main():
    results = [evaluate(p) for p in PLANS]
    results.sort(key=lambda r: -r["starter_pts"])
    best = results[0]["starter_pts"]

    # sanity: the skill solver is exact, so a 2-QB plan at $165 free budget must
    # reproduce (or beat) the hill-climb global optimum of 1436 non-QB pts.
    chk_pts, _ = opt_skill(165)
    print(f"[check] exact skill @ $165 = {chk_pts:.1f} non-QB pts (hill-climb found 1436)")
    assert chk_pts >= 1436 - 0.5, "exact solver regressed vs hill-climb!"

    print(f"\n{'strategy':<62}{'QB$':>5}{'QBpts':>7}{'nonQB':>7}{'TOT':>7}{'$':>5}")
    print("-" * 94)
    for r in results:
        mark = "  <- median optimum" if r["tag"] == REC_TAG else ("  * your ask" if r["is_ask"] else "")
        print(f"{r['name']:<62}{r['qb_cost']:>5}{r['qb_starter_pts']:>7.0f}"
              f"{r['non_qb_starter_pts']:>7.0f}{r['starter_pts']:>7.0f}{r['total_cost']:>5}{mark}")
    print(f"\n(all builds carry 3 QBs: 2 start + 1 cheap bench. EXACT skill solver. "
          f"BENCH_W=0. best = {best:.0f})")

    out = {"strategies": results, "bench_weight": 0.0, "best_starter_pts": round(best, 1),
           "rec_tag": REC_TAG, "ask_tags": sorted(ASK_TAGS),
           "note": "All builds carry 3 QBs (2 start + 1 cheap bench insurance). "
                   "Starter pts only (bench weight 0), solved EXACTLY by knapsack DP. "
                   "The bench QB costs $ vs a $1 scrub but adds 0 starter pts; its value "
                   "is bye/injury coverage + trade equity."}
    json.dump(out, open(os.path.join(_HERE, "out", "qb_strategies.json"), "w"), indent=2)
    print("\nsaved out/qb_strategies.json")


if __name__ == "__main__":
    main()
