"""Attrition / realization study — derives the per-position realization factors
used by 05_max_bid.py (and portable into the TS optimizer objective).

Source: nflverse snap_counts (2018-2024), one row per player-game with
offense_snaps / offense_pct. Ground truth for "did this guy actually play."
  https://github.com/nflverse/nflverse-data/releases/download/snap_counts/snap_counts_YYYY.csv.gz

Method:
  cohort   = "expected starters" = top-N on own team by Weeks 1-3 offense snaps
             (N: QB1, RB2, WR3, TE1 per team — maps to NFL/fantasy starters)
  AVAIL    = games appeared / season games        (pure injury/absence)
  ROLE     = weeks still a top-N guy / season games  (injury + demotion + role loss)
  season games = 16 (2018-20) / 17 (2021+)        (max REG week minus the bye week)

Why ROLE not AVAIL for the optimizer: median projections already ASSUME the
role, so a demoted player delivers below median. ROLE retention is the right
haircut on median pts.

Run:  python3 analysis/attrition_study.py
      (re-fetches nflverse to ./_nfl/ — cached; safe to re-run)
"""
from __future__ import annotations
import csv, gzip, os, statistics as st, urllib.request
from collections import defaultdict, Counter

HERE = os.path.dirname(__file__)
CACHE = os.path.join(HERE, "_nfl")
YEARS = range(2018, 2025)
POS = ["QB", "RB", "WR", "TE"]
TOPN = {"QB": 1, "RB": 2, "WR": 3, "TE": 1}
EARLY = {1, 2, 3}
URL = "https://github.com/nflverse/nflverse-data/releases/download/snap_counts/snap_counts_{}.csv.gz"

def fetch(year):
    os.makedirs(CACHE, exist_ok=True)
    f = os.path.join(CACHE, f"snap_counts_{year}.csv.gz")
    if not os.path.exists(f):
        print(f"  fetching {year}..."); urllib.request.urlretrieve(URL.format(year), f)
    return f

def load():
    acc = defaultdict(list); sl = {}
    for y in YEARS:
        ply = {}; weeks = set(); tpw = defaultdict(list)
        with gzip.open(fetch(y), "rt") as fh:
            for r in csv.DictReader(fh):
                if r["game_type"] != "REG" or r["position"] not in POS: continue
                try: wk = int(r["week"])
                except ValueError: continue
                weeks.add(wk)
                key = (y, r["pfr_player_id"]) or (y, "N:" + r["player"])
                rec = ply.setdefault(key, {"pos": r["position"], "team": Counter(),
                                           "snaps": {}, "pct": {}})
                rec["team"][r["team"]] += 1
                rec["snaps"][wk] = int(r["offense_snaps"] or 0)
                try: rec["pct"][wk] = float(r["offense_pct"])
                except ValueError: rec["pct"][wk] = 0.0
                tpw[(r["team"], r["position"], wk)].append((rec["snaps"][wk], key))
        n = max(weeks) - 1; sl[y] = n
        early = defaultdict(lambda: defaultdict(int))
        for (team, pos, wk), lst in tpw.items():
            if wk in EARLY:
                for s, k in lst: early[(team, pos)][k] += s
        cohort = set()
        for (team, pos), m in early.items():
            for k, _ in sorted(m.items(), key=lambda kv: kv[1], reverse=True)[:TOPN[pos]]:
                cohort.add(k)
        topn_wk = {(t, p, w): set(k for _, k in sorted(l, key=lambda x: x[0], reverse=True)[:TOPN[p]])
                   for (t, p, w), l in tpw.items()}
        for k in cohort:
            rec = ply[k]; team = rec["team"].most_common(1)[0][0]; pos = rec["pos"]
            app = len(rec["snaps"])
            role = sum(1 for w in range(1, n + 1) if k in topn_wk.get((team, pos, w), set()))
            ep = [rec["pct"][w] for w in EARLY if w in rec["pct"]]
            acc[pos].append(dict(avail=app / n, role=role / n, ep=st.mean(ep) if ep else 0.0))
    return acc, sl

def tier(pos, e):
    if pos == "RB":  return "bellcow>=.70" if e >= .70 else "shared-WH .55-.70" if e >= .55 else "committee .35-.55" if e >= .35 else "depth<.35"
    if pos == "WR":  return "WR1>=.75" if e >= .75 else "WR2/3<.75"
    if pos == "TE":  return "TE1>=.70" if e >= .70 else "TE2+<.70"
    if pos == "QB":  return "QB1>=.80" if e >= .80 else "backup<.80"

if __name__ == "__main__":
    acc, sl = load()
    print(f"season games by year: {sl}\n")
    print("POOLED (cohort = top-N on own team by wks 1-3 offense snaps)")
    print(f"{'POS':4} {'N':>5} {'AVAIL':>6} {'ROLE':>6}   <- ROLE is the optimizer haircut")
    for pos in POS:
        r = acc[pos]; n = len(r)
        print(f"{pos:4} {n:>5} {st.mean(x['avail'] for x in r)*100:>5.0f}% {st.mean(x['role'] for x in r)*100:>5.0f}%")
    print("\nTIERED (role retention by early-season snap share):")
    for pos in POS:
        g = defaultdict(list)
        for x in acc[pos]: g[tier(pos, x["ep"])].append(x)
        print(f"  {pos}:")
        for t in sorted(g):
            print(f"     {t:18} n={len(g[t]):>3}  role {st.mean(x['role'] for x in g[t])*100:>4.0f}%")
    print("\nRECOMMENDED REALIZATION PRIORS (role retention; rank-proxy for tier):")
    print("  QB  0.76 (rk<=16) / 0.50")
    print("  RB  0.80 bellcow(rk<=6) / 0.76 shared-WH(rk<=16) / 0.71 committee(rk<=30) / 0.60 depth")
    print("  WR  0.77 (rk<=12) / 0.63")
    print("  TE  0.73 (rk<=6) / 0.53")
    print("\nBase-rate (any-position starter, miss>=4 games ~30%): for a 4-stud core,")
    print("P(>=1 misses time)~74%, P(>=2)~33%, P(>=3)~7% (~1 team/yr in a 12-teamer).")
