"""06_robustness.py - How player-specific is the optimal roster?

Question (user): the QB-pair optimum flips with the backup-QB price
(Baker $13 -> Kyler+Love; <=$8 -> Dak+Purdy). But does that optimum then RELY on
specific non-QB players (e.g. "must have Loveland at TE")? In a live auction
players are nominated far apart in time; "waiting around" for one guy is the
trap (the Bowers problem: sat on cash, overspent, missed QBs).

This script answers: is the optimum a BUDGET ALLOCATION (robust -- many
interchangeable players per tier, miss one and a near-equivalent replaces him
for ~0 pts) or a PLAYER COMBINATION (fragile -- relies on uniquely-priced
values)?

Method:
  1. Reproduce the QB-backup flip + pin the Dak+Purdy(+cheap backup) scenario.
  2. Leave-one-out: for each non-QB starter, exclude him and RE-SOLVE; report
     the point loss and his replacement. (Marginal value of each player.)
  3. TE deep-dive: Loveland available / excluded / forced $1 punt.
  4. Skill frontier: pts vs budget, + marginal pts/$ (plateaus vs cliffs).
  5. Per-position "menu": at each tier, how many interchangeable options exist?

Run:  python3 06_robustness.py
"""
from __future__ import annotations
import json, os
import importlib.util

_HERE = os.path.dirname(__file__)
_spec = importlib.util.spec_from_file_location("opt", os.path.join(_HERE, "03_optimize.py"))
opt = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(opt)
P, by_pos = opt.load_players()

TOTAL = 200
K_DST = 2
BENCH_SLOTS = 5


def find(name):
    for p in P:
        if p["name"].lower() == name.lower():
            return p
    raise KeyError(name)


SKILL_POOL = {pos: list(by_pos[pos]) for pos in ("RB", "WR", "TE")}


def _pareto(d):
    out, best = [], -1.0
    for cost in sorted(d):
        pts, pls = d[cost]
        if pts > best:
            best = pts
            out.append((cost, pts, pls))
    return out


def _pos_frontier(pos, count, cost_cap, exclude=()):
    """Best pts picking EXACTLY `count` distinct players from pos, excluding
    named players. Pareto frontier over cost."""
    ex = {e.lower() for e in exclude}
    dp = [dict() for _ in range(count + 1)]
    dp[0][0] = (0.0, [])
    for p in SKILL_POOL[pos]:
        if p["name"].lower() in ex:
            continue
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


def _front(exclude=(), cap=TOTAL):
    return {pos: {k: _pos_frontier(pos, k, cap, exclude) for k in range(0, 4)}
            for pos in ("RB", "WR", "TE")}


_CASES = [("RB", 3, 2, 1), ("WR", 2, 3, 1), ("TE", 2, 2, 2)]


def opt_skill(budget, exclude=()):
    """Exact max non-QB starter pts <= budget. Returns (pts, slot_dict)."""
    budget = int(budget)
    front = _front(exclude)
    best_pts, best_combo = -1.0, None
    for fpos, rn, wn, tn in _CASES:
        frb, fwr, fte = front["RB"][rn], front["WR"][wn], front["TE"][tn]
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
    rbs = sorted(rbs, key=lambda p: -p["pts"])
    wrs = sorted(wrs, key=lambda p: -p["pts"])
    tes = sorted(tes, key=lambda p: -p["pts"])
    slot = {"RB1": rbs[0], "RB2": rbs[1], "WR1": wrs[0], "WR2": wrs[1], "TE": tes[0]}
    if fpos == "RB":
        slot["FLEX"] = rbs[2]
    elif fpos == "WR":
        slot["FLEX"] = wrs[2]
    else:
        slot["FLEX"] = tes[1]
    return best_pts, slot


def free_budget(qb_cost):
    return TOTAL - K_DST - qb_cost - (BENCH_SLOTS - 1) * 1  # 1 bench is the backup QB


def qb_pts(name_a, name_b):
    return find(name_a)["pts"] + find(name_b)["pts"]


def row(slot):
    p = slot
    return f"{p['name']:<22}({p['pos']:>2} ${p['cost']:>2} / {p['pts']:>5.1f}pts)"


# ──────────────────────────────────────────────────────────────────────────
# 1. Reproduce the QB-backup flip
# ──────────────────────────────────────────────────────────────────────────
print("=" * 78)
print("1. QB-BACKUP FLIP  (does backup price flip Kyler+Love <-> Dak+Purdy?)")
print("=" * 78)
pairs = [("Kyler Murray", "Jordan Love"), ("Dak Prescott", "Brock Purdy")]
backups = [("Baker Mayfield", 13), ("Tyler Shough", 8), ("C.J. Stroud", 7),
           ("Sam Darnold", 7), ("Cam Ward", 4), ("Bryce Young", 4)]
print(f"\n{'pair':<26}{'backup':<16}{'bk$':>4}{'qbcost':>7}{'free':>6}"
      f"{'QBpts':>7}{'skill':>7}{'TOT':>7}")
print("-" * 80)
results = {}
for s1, s2 in pairs:
    for bn, bn_cost in backups:
        qc = find(s1)["cost"] + find(s2)["cost"] + bn_cost
        fb = free_budget(qc)
        qpts = qb_pts(s1, s2)
        spts, _ = opt_skill(fb)
        tot = qpts + spts
        results[(s1, s2, bn)] = (qc, fb, qpts, spts, tot)
        print(f"{s1+'+'+s2:<26}{bn:<16}{bn_cost:>4}{qc:>7}{fb:>6}"
              f"{qpts:>7.0f}{spts:>7.0f}{tot:>7.0f}")
    print()

print("Winner by backup:")
for bn, _ in backups:
    k = results[("Kyler Murray", "Jordan Love", bn)][4]
    d = results[("Dak Prescott", "Brock Purdy", bn)][4]
    win = "Kyler+Love" if k > d else ("Dak+Purdy" if d > k else "tie")
    print(f"  {bn:<16} Kyler+Love={k:.0f}  Dak+Purdy={d:.0f}  -> {win}  (gap {abs(d-k):.0f})")

# ──────────────────────────────────────────────────────────────────────────
# 2. Pin scenario: Dak+Purdy + cheap backup (Stroud $7). Optimal roster.
# ──────────────────────────────────────────────────────────────────────────
print("\n" + "=" * 78)
print("2. SCENARIO: Dak + Purdy + Stroud(backup). Optimal skill roster.")
print("=" * 78)
SCN_S1, SCN_S2, SCN_BN = "Dak Prescott", "Brock Purdy", "C.J. Stroud"
qc = find(SCN_S1)["cost"] + find(SCN_S2)["cost"] + find(SCN_BN)["cost"]
fb = free_budget(qc)
qpts = qb_pts(SCN_S1, SCN_S2)
base_skill, base_slot = opt_skill(fb)
base_tot = qpts + base_skill
print(f"\nQB starters: {SCN_S1} + {SCN_S2} = {qpts:.1f} pts, ${find(SCN_S1)['cost']+find(SCN_S2)['cost']}")
print(f"Backup QB:   {SCN_BN} (${find(SCN_BN)['cost']})")
print(f"Free skill budget: ${fb}   skill pts: {base_skill:.1f}   TOTAL starters: {base_tot:.1f}\n")
print("Optimal skill starters:")
for s in ["RB1", "RB2", "WR1", "WR2", "TE", "FLEX"]:
    print(f"  {s:<5} {row(base_slot[s])}")

# ──────────────────────────────────────────────────────────────────────────
# 3. Leave-one-out: exclude each starter, re-solve, report loss + replacement
# ──────────────────────────────────────────────────────────────────────────
print("\n" + "=" * 78)
print("3. LEAVE-ONE-OUT  (exclude each starter; how many pts lost? who replaces?)")
print("=" * 78)
print(f"\n{'slot':<5}{'excluded player':<24}{'re-opt skill':>13}{'pts LOST':>10}"
      f"   replacement roster")
print("-" * 100)
loo = []
for s in ["RB1", "RB2", "WR1", "WR2", "TE", "FLEX"]:
    excluded = base_slot[s]["name"]
    spts, slot = opt_skill(fb, exclude=(excluded,))
    loss = base_skill - spts
    new_names = ", ".join(f"{slot[x]['name']}(${slot[x]['cost']})" for x in
                          ["RB1", "RB2", "WR1", "WR2", "TE", "FLEX"])
    print(f"{s:<5}{excluded:<24}{spts:>13.1f}{loss:>10.1f}   {new_names}")
    loo.append((s, excluded, loss))
print(f"\n  (If a player's exclusion costs ~0 pts, the optimum does NOT depend on him.)")
print(f"  Sum of single-player exposures (not additive): max single = "
      f"{max(l for _,_,l in loo):.1f} pts, min = {min(l for _,_,l in loo):.1f} pts")

# ──────────────────────────────────────────────────────────────────────────
# 4. TE deep-dive: Loveland available / excluded / forced $1 punt
# ──────────────────────────────────────────────────────────────────────────
print("\n" + "=" * 78)
print("4. TE DEEP-DIVE  (the user's specific worry: must I have Loveland?)")
print("=" * 78)
def skill_summary(label, exclude=(), force_te_dollar=False):
    spts, slot = opt_skill(fb, exclude=exclude)
    te = slot["TE"]
    print(f"\n  {label}:")
    print(f"    skill pts = {spts:.1f}  (optimum {base_skill:.1f}, "
          f"loss {base_skill - spts:+.1f})")
    for s in ["RB1", "RB2", "WR1", "WR2", "TE", "FLEX"]:
        print(f"      {s:<5} {row(slot[s])}")
    return spts, slot

skill_summary("(a) baseline (Loveland available)")
skill_summary("(b) Loveland EXCLUDED", exclude=("Colston Loveland",))
# force TE to a $1 scrub: exclude all TEs costing >1, but keep Loveland comparison
dollar_tes = [p["name"] for p in by_pos["TE"] if p["cost"] > 1]
skill_summary("(c) TE forced to $1 punt (all >$1 TEs excluded)", exclude=tuple(dollar_tes))

# ──────────────────────────────────────────────────────────────────────────
# 5. Skill frontier + marginal pts/$
# ──────────────────────────────────────────────────────────────────────────
print("\n" + "=" * 78)
print("5. SKILL FRONTIER  (pts vs budget; marginal pts/$ -- plateaus vs cliffs)")
print("=" * 78)
print(f"\n{'budget':>8}{'skill pts':>11}{'marg pts/$ (from prev)':>24}")
print("-" * 50)
prev_pts, prev_b = None, None
for b in range(60, fb + 1, 5):
    spts, _ = opt_skill(b)
    marg = "" if prev_pts is None else f"{(spts-prev_pts)/(b-prev_b):+.2f}"
    star = "  <- scenario ($%d)" % fb if b == fb else ""
    print(f"{b:>8}{spts:>11.1f}{marg:>24}{star}")
    prev_pts, prev_b = spts, b

# ──────────────────────────────────────────────────────────────────────────
# 6. Per-position "menu": interchangeable options near each tier
# ──────────────────────────────────────────────────────────────────────────
print("\n" + "=" * 78)
print("6. POSITION MENUS  (how many interchangeable options near each tier?)")
print("=" * 78)
target = {s: base_slot[s] for s in ["RB1", "RB2", "WR1", "WR2", "TE", "FLEX"]}
for s in ["RB1", "RB2", "WR1", "WR2", "TE", "FLEX"]:
    p = target[s]
    pos = p["pos"]
    pool = sorted(by_pos[pos], key=lambda q: q["cost"])
    # options within +/- $4 of the target cost, sorted by pts desc
    near = [q for q in pool if abs(q["cost"] - p["cost"]) <= 4 and q["cost"] >= 1]
    near.sort(key=lambda q: -q["pts"])
    print(f"\n  {s} target = {p['name']} (${p['cost']}/{p['pts']:.0f}pts). "
          f"Alternatives within +/-$4:")
    for q in near[:6]:
        dpts = q["pts"] - p["pts"]
        flag = "  <- picked" if q["name"] == p["name"] else ""
        print(f"    {q['name']:<22} ${q['cost']:>2} / {q['pts']:>5.1f}pts  "
              f"({dpts:+.1f} vs picked){flag}")

print("\n" + "=" * 78)
print("DONE")
print("=" * 78)
