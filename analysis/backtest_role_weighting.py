"""V3 backtest — role-weighting (the V4 gate): does a bench slot value the
high-ceiling / low-floor profile MORE than a starter slot does?

THE QUESTION (TODO.md V3 bullet 3, the named gate for V4):
    V4 proposes a PER-SLOT value split: keep starters median-dominant, but make
    the bench/depth layer ceiling-weighted (valueAlert / nominationSuggest /
    review HTML). The claim behind ANY bench ceiling-tilt > starter tilt is:
        "bench slots filled with high-ceiling/low-floor players outperform
         high-floor players on hit-rate / league-winner basis."
    Without evidence that is just a guess. This backtest answers it.

THE MECHANISM WE ARE TESTING (why it is a slot question, not a player question):
    A high-ceiling/low-floor profile is NOT unconditionally better. Its edge
    (higher median + ceiling) comes WITH a floor cost (worse P10 / more busts).
    That tradeoff is SLOT-DEPENDENT:
      - STARTER slot pays the floor cost (a bust starter sinks your week).
      - BENCH slot does NOT (a bust bench player is droppable ~= 0 cost; only
        the upside tail matters -- the whole point of carrying depth).
    So the SAME profile edge is worth more per slot on the bench. If the data
    confirms this asymmetry, V4's per-slot split is justified. If the floor
    cost is not actually material (or youth has no edge to begin with), the
    starter-style median valuation should simply extend to the bench.

THE DISCRIMINATING DESIGN (H1 vs H2):
      H1 (bench tilt justified):  youth's edge GROWS when you zero the floor
          (bench-value metric > starter-value metric).
      H2 (no split needed):       youth's edge is the SAME or REVERSES under a
          floor-truncated metric (the floor cost isn't free / the edge is
          illusory).
    We measure each cohort across a TAIL GRADIENT, from floor-sensitive to
    floor-insensitive:
      starter_val = mean realized pts                       (symmetric; floor-sensitive)
      hit_val      = mean of pts * 1(rrank<=12)               (production from startable
                                                                outcomes only -- the bench
                                                                asymmetry, PARAMETER-FREE)
      lw_val       = mean of pts * 1(rrank<=6)                (league-winner tail)
      + top6% / top12% finish rates (the literal claim, parameter-free)
    The PIVOT: does the youth edge GROW as we move out the tail (mean -> hit ->
    league-winner)? H1 says yes (edge concentrates where the bench cares);
    H2 says no (edge is uniform / mid-range / reverses).

THE DATA SUBSTITUTION (read this):
    Same wall as backtest_realization.py: NO historical Gretch projections OR
    profile tags (both 2026-only). So "high-ceiling/low-floor profile" is
    PROXIED at draft time by two independent, draft-time-observable axes:
      1. EXPERIENCE       (nflverse players.rookie_season -> years into career):
                            rook/2nd(0-1) = the bench lotto ticket; vet(4+) =
                            the known-floor veteran. Matches the rubric profile
                            names ("upside-swing"/"boom-bust" vs "veteran-floor")
                            -- many upside-swing exemplars are rookies/2nd-yr.
      2. DRAFT CAPITAL    (players.draft_round): rounds 1-3 = the market's
                            draft-time ceiling assessment (independent cross-axis
                            -- if it shows the same pattern, the result is not an
                            artifact of the experience cut).
    Draft-time median is the leave-one-year-out rank-bin curve from
    backtest_realization (so RATIO = actual/expected-at-rank removes the
    "rookies get drafted deeper" confound). Realized = nflverse half-PPR.

LIMITS (stated up front):
    - Experience/draft-capital are PROXIES for the rubric profiles, not the
      profiles themselves (no historical profile tags exist). The literal
      profile-specific test needs the 2026 season or a historical projections
      dataset. Treat this as the strongest available test of the structural
      claim, not a profile-by-profile calibration.
    - Season totals only (no weekly), so "bench value" uses max(0,pts-repl) on
      the season total as the floor-truncation, not a best-N-games tail.
    - 4 seasons x ~150 depth picks/yr => small cells once split by pos x cohort;
      the LOO sweep + draft-capital cross-axis carry the robustness burden.

Run:  python3 analysis/backtest_role_weighting.py
      (fetches nflverse to ./_nfl/ + players.csv.gz -- cached; safe to re-run)
"""
from __future__ import annotations
import csv, gzip, os, statistics as st, urllib.request
from collections import defaultdict

HERE = os.path.dirname(__file__)
CACHE = os.path.join(HERE, "_nfl")
PRICE_CSV = os.path.expanduser("~/Downloads/Avant League History - Data.csv")
YEARS = [2021, 2022, 2023, 2024]          # clean Superflex/15-man era; 2025 incomplete
POS = ["QB", "RB", "WR", "TE"]

# bench pool = cheap depth (the V4 bench layer target). sal<=10 captures the
# $1 fliers + the $6-10 upside WR/backup-QB slots; prank>=13 adds the few
# mid-salary guys whose within-pos rank says depth (e.g. a $13 backup QB).
BENCH_SAL_MAX = 10
BENCH_PRANK_MIN = 13

# ── scoring (byte-identical to backtest_realization / build_2026 median) ──────
def league_half_ppr(r):
    def f(k):
        try: return float(r.get(k) or 0)
        except ValueError: return 0.0
    return (f("passing_yards") / 25 + f("passing_tds") * 4 + f("interceptions") * -1
            + f("rushing_yards") / 10 + f("rushing_tds") * 6
            + f("receiving_yards") / 10 + f("receiving_tds") * 6
            + f("receptions") * 0.5)

# ── name normalization (same join key as backtest_realization) ────────────────
SUFFIX = (" jr", " sr", " ii", " iii", " iv", " v")
NICK = {"hollywood brown": "marquise brown", "joshua palmer": "josh palmer",
        "mohammad ibrahim": "mo ibrahim", "jeff wilson": "jeff wilson jr"}
def norm(name):
    n = name.strip().lower().replace(".", "").replace("'", "").replace(",", "")
    for s in SUFFIX:
        if n.endswith(s): n = n[: -len(s)].strip()
    return NICK.get(n, n.replace("  ", " "))

def pctl(sorted_vals, q):
    if not sorted_vals: return float("nan")
    if len(sorted_vals) == 1: return sorted_vals[0]
    x = (q / 100) * (len(sorted_vals) - 1)
    lo, hi = int(x), min(int(x) + 1, len(sorted_vals) - 1)
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (x - lo)

# ── data load ────────────────────────────────────────────────────────────────
def fetch(path, url):
    os.makedirs(CACHE, exist_ok=True)
    if not os.path.exists(path):
        print(f"  fetching {os.path.basename(path)}..."); urllib.request.urlretrieve(url, path)
    return path

def load_players():
    """gsis_id -> dict(rookie_season, draft_round). The two draft-time axes."""
    f = fetch(os.path.join(CACHE, "players.csv.gz"),
              "https://github.com/nflverse/nflverse-data/releases/download/players/players.csv.gz")
    out = {}
    with gzip.open(f, "rt") as fh:
        for r in csv.DictReader(fh):
            g = r.get("gsis_id")
            if not g: continue
            out[g] = dict(rookie=r.get("rookie_season"), draft_round=r.get("draft_round"))
    return out

def load_realized():
    """year -> norm_name -> (gsis_id, half_ppr)."""
    out = defaultdict(dict)
    for y in YEARS:
        f = fetch(os.path.join(CACHE, f"player_stats_season_{y}.csv.gz"),
                  f"https://github.com/nflverse/nflverse-data/releases/download/"
                  f"player_stats/player_stats_season_{y}.csv.gz")
        with gzip.open(f, "rt") as fh:
            for r in csv.DictReader(fh):
                if str(r.get("season")) != str(y): continue
                if r.get("position") not in POS: continue
                key = norm(r.get("player_display_name", ""))
                if not key: continue
                pts = league_half_ppr(r)
                if key not in out[y] or pts > out[y][key][1]:
                    out[y][key] = (r.get("player_id"), pts)
    return out

def load_drafts(realized, players):
    """joined skill-draftee rows with gsis, yrs_into_career, draft_round."""
    rows = []
    with open(PRICE_CSV) as fh:
        for r in csv.DictReader(fh):
            if r.get("Year") not in map(str, YEARS): continue
            if r.get("Position") not in POS: continue
            try:
                prank = int(r["Position Rank"]); sal = int(r["Salary"].replace("$", ""))
                y = int(r["Year"])
            except (ValueError, KeyError):
                continue
            hit = realized.get(y, {}).get(norm(r["Name"]))
            if not hit: continue
            g, pts = hit
            meta = players.get(g, {})
            rs = meta.get("rookie")
            try: yrs = y - int(rs) if rs and rs.isdigit() else None
            except ValueError: yrs = None
            dr = meta.get("draft_round")
            try: dr = int(dr) if dr and dr.isdigit() else None
            except ValueError: dr = None
            rows.append(dict(year=y, pos=r["Position"], prank=prank, salary=sal,
                             name=r["Name"], pts=pts, gsis=g, yrs=yrs, draft_round=dr))
    return rows

# ── expected curve (rank-bin LOO medians, from backtest_realization) ──────────
BINS = [(1, 3), (4, 6), (7, 12), (13, 18), (19, 99)]
def _bin(p):
    for lo, hi in BINS:
        if lo <= p <= hi: return (lo, hi)
    return (19, 99)
def expected_curves(rows):
    by = defaultdict(list)
    for j in rows: by[(j["pos"], _bin(j["prank"]), j["year"])].append(j["pts"])
    loo = {}
    for (pos, b, y), pts in by.items():
        others = [p for (pp, bb, yy), lst in by.items()
                  if pp == pos and bb == b and yy != y for p in lst]
        lv = st.median(others) if len(others) >= 2 else st.median(pts)
        for j in rows:
            if j["pos"] == pos and _bin(j["prank"]) == b and j["year"] == y:
                loo[(pos, j["prank"], y)] = lv
    return loo

def with_realized_rank(rows):
    """attach rrank = within-pos realized finish (1 = pos leader) per year."""
    by = defaultdict(list)
    for j in rows: by[(j["year"], j["pos"])].append(j)
    for _, lst in by.items():
        lst.sort(key=lambda j: j["pts"], reverse=True)
        for i, j in enumerate(lst, 1): j["rrank"] = i
    return rows

# ── cohorts (the two draft-time axes) ────────────────────────────────────────
def exp_cohort(yrs):
    if yrs is None: return "unk"
    if yrs <= 1: return "rook/2nd(0-1)"
    if yrs <= 3: return "young(2-3)"
    return "vet(4+)"
def cap_cohort(dr):
    if dr is None: return "UDFA/none"
    if dr <= 3: return "R1-3(high)"
    if dr <= 7: return "R4-7"
    return "UDFA/none"

def bench_pool(rows):
    return [r for r in rows if r["salary"] <= BENCH_SAL_MAX or r["prank"] >= BENCH_PRANK_MIN]

def replacement_levels(rows):
    """per-position waiver-level realized pts = 25th pct of the bench pool.
    Robust + nonzero for every position (prank>=30 medians are sparse at TE).
    Used only for the secondary max(0,pts-repl) cross-check metric."""
    out = {}
    pool = bench_pool(rows)
    for pos in POS:
        v = sorted(r["pts"] for r in pool if r["pos"] == pos)
        out[pos] = pctl(v, 25) if v else 0.0
    return out

# ── metric block for a cohort (the tail gradient) ───────────────────────────
def metrics(sub, repl_by_pos=None):
    n = len(sub)
    if not n: return None
    pts = [r["pts"] for r in sub]
    ratios = sorted(r["ratio"] for r in sub if r.get("ratio") is not None)
    top6 = sum(1 for r in sub if r["rrank"] <= 6)
    top12 = sum(1 for r in sub if r["rrank"] <= 12)
    starter_val = st.mean(pts)                                  # symmetric
    hit_val = st.mean(p * (1 if r["rrank"] <= 12 else 0) for r, p in zip(sub, pts))  # E[pts*1(top12)]
    lw_val = st.mean(p * (1 if r["rrank"] <= 6 else 0) for r, p in zip(sub, pts))    # E[pts*1(top6)]
    out = dict(n=n, p10=pctl(ratios, 10), p50=pctl(ratios, 50), p90=pctl(ratios, 90),
               top6=100 * top6 / n, top12=100 * top12 / n,
               mean=starter_val, hit_val=hit_val, lw_val=lw_val, med_pts=st.median(pts))
    if repl_by_pos is not None:
        out["trunc"] = st.mean(max(0.0, p - repl_by_pos[r["pos"]]) for r, p in zip(sub, pts))
    return out

def fmt_row(label, m):
    if m is None: return f"  {label:16} n=0"
    return (f"  {label:16} n={m['n']:>3}  P10{m['p10']:5.2f} P50{m['p50']:5.2f} "
            f"P90{m['p90']:5.2f}  top6%{m['top6']:4.0f} top12%{m['top12']:4.0f}  "
            f"mean{m['mean']:6.1f} hit{m['hit_val']:6.1f} lw{m['lw_val']:5.1f}")

# ── the discriminating table: youth-vs-vet edge under starter vs bench value ─
def slot_asymmetry(rows, repl, axis="exp", positions=None, bench_only=True):
    """For each position, show cohort metrics + the pivot:
       Δ(starter) = rook.start_val - vet.start_val ; Δ(bench) likewise.
       H1: Δbench > Δstarter (zeroing the floor widens youth's edge)."""
    positions = positions or POS
    pool = bench_pool(rows) if bench_only else rows
    out = []
    for pos in positions:
        out.append(f"\n  --- {pos} {'(bench pool)' if bench_only else '(all)'} ---")
        sub = [r for r in pool if r["pos"] == pos]
        cfn = exp_cohort if axis == "exp" else cap_cohort
        order = ["rook/2nd(0-1)", "young(2-3)", "vet(4+)"] if axis == "exp" \
                else ["R1-3(high)", "R4-7", "UDFA/none"]
        ms = {c: metrics([r for r in sub if cfn(r["yrs"] if axis == "exp" else r["draft_round"]) == c], repl)
              for c in order}
        for c in order: out.append(fmt_row(c, ms[c]))
        if ms.get(order[0]) and ms.get(order[-1]):
            dm = ms[order[0]]["mean"]    - ms[order[-1]]["mean"]
            dh = ms[order[0]]["hit_val"] - ms[order[-1]]["hit_val"]
            dl = ms[order[0]]["lw_val"]  - ms[order[-1]]["lw_val"]
            # key on Δhit vs Δmean (the stable, bench-relevant production signal);
            # Δlw is noisier (top-6 is rarer) so it informs but does not decide.
            if dh > dm + 0.5:      tag = "  <- H1: edge WIDENS into the startable tail"
            elif dh < dm - 0.5:    tag = "  <- REVERSED in tail (edge shrinks/flips)"
            else:                  tag = "  <- H2: edge flat (mid-range)"
            out.append(f"     {order[0].split('(')[0]:>10} vs {order[-1].split('(')[0]:<10}"
                       f"  Δmean {dm:+6.1f}  Δhit {dh:+6.1f}  Δlw {dl:+6.1f}{tag}")
    return "\n".join(out)

# ── position-level LOO (Phase 4 stress test; RB stability is the key check) ───
def pos_loo(rows):
    pool = bench_pool(rows)
    out = []
    for pos in ["QB", "RB", "WR"]:
        out.append(f"\n  --- {pos} (drop each year; is the Δhit sign stable?) ---")
        out.append(f"  {'drop':>6} {'Δmean':>8} {'Δhit':>8} {'Δlw':>8}  "
                   f"{'yT12':>5}{'vT12':>5} {'yT6':>4}{'vT6':>4}  {'ny':>3}{'nv':>3}")
        for drop in ["ALL"] + YEARS:
            sub = [r for r in pool if r["pos"] == pos]
            if drop != "ALL": sub = [r for r in sub if r["year"] != drop]
            young = [r for r in sub if exp_cohort(r["yrs"]) == "rook/2nd(0-1)"]
            vet = [r for r in sub if exp_cohort(r["yrs"]) == "vet(4+)"]
            if not young or not vet:
                out.append(f"  {drop:>6}  (empty)"); continue
            def m(s):
                return (st.mean(r["pts"] for r in s),
                        st.mean(r["pts"] * (1 if r["rrank"] <= 12 else 0) for r in s),
                        st.mean(r["pts"] * (1 if r["rrank"] <= 6 else 0) for r in s),
                        100 * sum(1 for r in s if r["rrank"] <= 12) / len(s),
                        100 * sum(1 for r in s if r["rrank"] <= 6) / len(s))
            ym, yh, yl, yt12, yt6 = m(young); vm, vh, vl, vt12, vt6 = m(vet)
            out.append(f"  {drop:>6} {ym-vm:+8.1f} {yh-vh:+8.1f} {yl-vl:+8.1f}  "
                       f"{yt12:>4.0f}%{vt12:>4.0f}% {yt6:>3.0f}%{vt6:>3.0f}%  "
                       f"{len(young):>3}{len(vet):>3}")
    return "\n".join(out)

# ── leave-one-year-out stability of the pivot (Phase 4) ───────────────────────
def loo_pivot(rows, repl, axis="exp"):
    """drop each year, recompute Δbench - Δstarter pooled; is the sign stable?"""
    out = []
    for drop in YEARS:
        kept = [r for r in rows if r["year"] != drop]
        pool = bench_pool(kept)
        cfn = exp_cohort if axis == "exp" else cap_cohort
        key = lambda r: r["yrs"] if axis == "exp" else r["draft_round"]
        young = [r for r in pool if cfn(key(r)) == ("rook/2nd(0-1)" if axis == "exp" else "R1-3(high)")]
        vet = [r for r in pool if cfn(key(r)) == ("vet(4+)" if axis == "exp" else "UDFA/none")]
        def mv(s):
            if not s: return (0, 0, 0)
            mean = st.mean(r["pts"] for r in s)
            hit = st.mean(r["pts"] * (1 if r["rrank"] <= 12 else 0) for r in s)
            lw = st.mean(r["pts"] * (1 if r["rrank"] <= 6 else 0) for r in s)
            return mean, hit, lw
        ym, yh, yl = mv(young); vm, vh, vl = mv(vet)
        out.append((drop, ym - vm, yh - vh, yl - vl, len(young), len(vet)))
    return out

# ── main ─────────────────────────────────────────────────────────────────────
def run():
    print("V3 ROLE-WEIGHTING BACKTEST  years", "-".join(map(str, YEARS)),
          "| half-PPR | bench pool = sal<=$%d or prank>=%d" % (BENCH_SAL_MAX, BENCH_PRANK_MIN),
          "\n")
    players = load_players()
    realized = load_realized()
    rows = load_drafts(realized, players)
    with_realized_rank(rows)
    loo = expected_curves(rows)
    for j in rows:
        e = loo.get((j["pos"], j["prank"], j["year"]), 0.0)
        j["expected"] = e; j["ratio"] = j["pts"] / e if e > 0 else None
    pool = bench_pool(rows)
    repl = replacement_levels(rows)
    print("joined %d drafted skill players; bench pool n=%d\n" % (len(rows), len(pool)))
    print("Replacement levels (25th pct of bench pool; secondary trunc metric only):")
    print("   " + "  ".join(f"{p}: {repl[p]:.0f}" for p in POS))

    # ── Table A: experience, pooled across position ──────────────────────────
    print("\n" + "=" * 78)
    print("TABLE A — by EXPERIENCE (pooled, bench pool). The high-ceiling/low-floor")
    print("         profile proxy. mean=mean pts(symmetric); hit=E[pts*1(top12)];")
    print("         lw=E[pts*1(top6)] (league-winner).")
    print("=" * 78)
    mA = {c: metrics([r for r in pool if exp_cohort(r["yrs"]) == c], repl)
          for c in ["rook/2nd(0-1)", "young(2-3)", "vet(4+)"]}
    for c in ["rook/2nd(0-1)", "young(2-3)", "vet(4+)"]:
        print(fmt_row(c, mA[c]))
    if mA["rook/2nd(0-1)"] and mA["vet(4+)"]:
        y, v = mA["rook/2nd(0-1)"], mA["vet(4+)"]
        print(f"\n     rook/2nd vs vet(4+)   Δmean {y['mean']-v['mean']:+6.1f}"
              f"  Δhit {y['hit_val']-v['hit_val']:+6.1f}  Δlw {y['lw_val']-v['lw_val']:+6.1f}")

    # ── Table B: THE discriminating cut, by position ─────────────────────────
    print("\n" + "=" * 78)
    print("TABLE B — DISCRIMINATING (experience x position, bench pool).")
    print("  The PIVOT: does the youth edge WIDEN out the tail")
    print("  (Δmean -> Δhit -> Δlw)? H1=yes; H2=flat/mid-range/reversed.")
    print("=" * 78)
    print(slot_asymmetry(rows, repl, axis="exp"))

    # ── Table C: draft-capital cross-axis (robustness) ───────────────────────
    print("\n" + "=" * 78)
    print("TABLE C — DRAFT-CAPITAL cross-axis (bench pool). Independent draft-time")
    print("         ceiling signal: R1-3 = the market's ceiling bet. Same pivot test.")
    print("=" * 78)
    print(slot_asymmetry(rows, repl, axis="cap"))

    # ── LOO stability of the pivot (Phase 4) ─────────────────────────────────
    print("\n" + "=" * 78)
    print("LEAVE-ONE-YEAR-OUT — is the Δmean/Δhit/Δlw sign stable? (pooled, exp axis)")
    print("=" * 78)
    print(f"  {'drop':>6}  {'Δmean':>8} {'Δhit':>8} {'Δlw':>8}   {'nyoung':>6} {'nvet':>5}")
    for drop, dm, dh, dl, ny, nv in loo_pivot(rows, repl, "exp"):
        print(f"  {drop:>6}  {dm:+8.1f} {dh:+8.1f} {dl:+8.1f}   {ny:>6} {nv:>5}")

    # ── position-level LOO (the real stress test; RB stability is pivotal) ────
    print("\n" + "=" * 78)
    print("POSITION-LEVEL LOO (Phase 4) — does each position's Δhit sign survive")
    print("dropping a year? RB stability is the pivotal check (a single weak/strong")
    print("rookie class must not drive the conclusion).")
    print("=" * 78)
    print(pos_loo(rows))

    # ── verdict ──────────────────────────────────────────────────────────────
    print("\n" + "=" * 78)
    print("VERDICT (which hypothesis survived, position by position)")
    print("=" * 78)
    print("""
  The V4 claim ("bench slots filled with high-ceiling/low-floor players
  outperform high-floor players on hit-rate / league-winner basis") is
  POSITION-DEPENDENT, not universal. Draft-time ceiling is proxied by
  EXPERIENCE (rook/2nd = lotto ticket; vet4+ = known floor) and cross-checked
  by DRAFT CAPITAL; the LOO sweep carries the stability burden.

  QB  (robust, all 4 years): young backup-QBs become startable ~32% vs vet
      ~25%, Δhit +17..+49 every year. -> bench ceiling-tilt SUPPORTED at the
      backup-QB slot. Validates the par sheet's young developmental backup
      (Stroud/Shough); cold-market sizing there should tilt young.
  WR  (stable, weak in 2024): young WRs hit top-12 ~15% vs vet ~9%, Δhit >0
      all 4 years. -> bench ceiling-tilt SUPPORTED at the upside-WR / WR-depth
      slot (BN5 and WR depth calls).
  RB  (UNSTABLE): the apparent veteran-favorable reversal (Δhit -4.8 pooled)
      is a 2023 artifact -- a single weak rookie RB class swings it from +11
      (2021) to -33 (2023) to ~0 (2024). RB bench outcomes are dominated by
      that year's rookie-class quality, which is UNKNOWABLE at draft. -> NO
      stable ceiling edge in either direction at RB depth. The specific V4
      thesis (the $5 Henderson-over-Montgomery lotto-RB call) is NOT validated
      by realized RB outcomes; the starter-style median/floor valuation should
      extend to RB depth (or treat RB bench as pure $1 lotto/handcuff with no
      tilt claim). The 'sort by Ceil/$' stopgap is NOT evidence-backed for RB.
  TE  (n too small at rook, n=6): inconclusive.

  IMPLICATION FOR V4: the bench/depth value layer should be POSITION-AWARE --
  ceiling-weighted at QB and WR depth (evidence-backed), NOT at RB depth (no
  signal). This refines, not rejects, V4. The role-weighting gate is passed
  for 2 of the 3 skill positions where bench value is at stake.

  OPEN (unchanged from TODO): the LITERAL profile-specific test (upside-swing
  vs veteran-floor tags, not the age/draft-capital proxy) needs a historical
  projections source or the 2026 season. This is the strongest available
  structural test given current data.""")
    return pool, repl

if __name__ == "__main__":
    run()
