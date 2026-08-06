"""V3 backtest — Gretch's OWN draft-time signal (target/fade + tier rank): does
it change the role-weighting verdict, and does scout-vs-market divergence
predict realized upside?

WHY THIS EXISTS (the follow-up to backtest_role_weighting.py):
    The first role-weighting test proxied "high-ceiling/low-floor profile" by
    EXPERIENCE + DRAFT CAPITAL (nflverse players.csv) -- because no historical
    Gretch profile TAGS were assumed to exist. They now do: saved tier articles
    2022-2024 (~/Downloads/gretch/{year}/). This tests the claim with Gretch's
    OWN opinion instead of a proxy.

WHAT THE ARTICLES ACTUALLY CONTAIN (read this -- it bounds the test):
    - tiers + subtiers + a within-position RANK ORDER (Gretch's scout opinion)
    - **bold** = target, *italics* = fade (his directional call)
    - prose commentary -- but NOT the rubric.py profile tags (upside-swing /
      veteran-floor / etc.). Those are a hand-author step (assemble.py). So the
      LITERAL profile-specific test still needs ~400 hand-authored profiles and
      is NOT done here. What IS extractable, and arguably a BETTER draft-time
      signal (it's his call, not our rubric guess), is target/fade + rank.

TWO TESTS:
    1. TARGET/FADE role-weighting (the V4 gate, re-cut): in the bench/depth
       pool, do Gretch's TARGETS outperform his FADES on realized tail (top-6 /
       top-12 finish, E[pts*1(topN)])? Does the target edge WIDEN in depth
       (vs elite), the way H1 predicts? Run on the SAME bench pool as
       backtest_role_weighting (sal<=10 or prank>=13) for apples-to-apples, plus
       a Gretch-rank depth cut (gretchr_rank>=30) for the fuller sample.
    2. TIER DIVERGENCE (closes the OTHER open TODO item -- the literal
       tier-rank-vs-projection-rank test): divergence = league_draft_rank -
       gretch_rank (positive = drafted CHEAPER than Gretch's opinion, i.e. the
       market slept on him). Does positive divergence predict realized upside
       (the "scouts like him more than ADP" thesis)?

DATA / SUBSTITUTION:
    Same wall as backtest_realization: NO historical point PROJECTIONS, so the
    draft-time level is still the leave-one-year-out rank-bin median (ratio =
    actual/expected-at-rank). NEW here: Gretch's within-pos rank + target/fade
    from the saved articles. Realized = nflverse half-PPR, byte-identical
    scoring. YEARS_G = 2022-2024 (2021 article is a different HTML format --
    per-player <p>, QB+TE merged -- needs a custom parser; 2025 has no realized
    stats on nflverse yet). 3 years is thinner than the proxy's 4, so the LOO
    sweep + the proxy's own verdict carry the stability burden here.

Run:  python3 analysis/backtest_gretch_signal.py
      (articles must be in ~/Downloads/gretch/{2022,2023,2024}/; nflverse cached)
"""
from __future__ import annotations
import csv, gzip, os, statistics as st
from collections import defaultdict

HERE = os.path.dirname(__file__)
CACHE = os.path.join(HERE, "_nfl")
PRICE_CSV = os.path.expanduser("~/Downloads/Avant League History - Data.csv")
ADP_CSV = os.path.expanduser(
    "~/Downloads/Avant League History - Historical ADP - Fantasy Pros (2).csv")
GRETCH = os.path.expanduser("~/Downloads/gretch")
YEARS_G = [2021, 2022, 2023, 2024, 2025]      # 2021 parsed via extract_2021 (no target/fade markup); 2025 from weekly agg
POS = ["QB", "RB", "WR", "TE"]
BENCH_SAL_MAX = 10                       # match backtest_role_weighting exactly
BENCH_PRANK_MIN = 13

ARTICLES = {
    2021: {"QB": "Tiers updates and commentary for QB and TE - by Ben Gretch.html",
           "RB": "Tiers updates and commentary for RB - by Ben Gretch.html",
           "WR": "Tiers updates and commentary for WR - by Ben Gretch.html",
           "TE": "Tiers updates and commentary for QB and TE - by Ben Gretch.html"},
    2022: {"QB": "Targets and Fades — QB Tiers - by Ben Gretch.html",
           "RB": "Targets and Fades — RB Tiers - by Ben Gretch.html",
           "WR": "Targets and Fades — WR Tiers - by Ben Gretch.html",
           "TE": "Targets and Fades — TE Tiers - by Ben Gretch.html"},
    2023: {"QB": "QB Targets and Fades — How to play the tiers.html",
           "RB": "RB Targets and Fades — How to play the tiers.html",
           "WR": "WR Targets and Fades — How to play the tiers.html",
           "TE": "TE Targets and Fades — How to play the tiers.html"},
    2024: {"QB": "QB Targets and Fades — Interpreting the Tiers.html",
           "RB": "RB Targets and Fades — Interpreting the Tiers.html",
           "WR": "WR Targets and Fades — Interpreting the tiers.html",
           "TE": "TE Targets and Fades — Interpreting the Tiers.html"},
    2025: {"QB": "QB Targets and Fades — the 2025 tiers - by Ben Gretch.html",
           "RB": "RB Targets and Fades — the 2025 tiers - by Ben Gretch.html",
           "WR": "WR Targets and Fades — the 2025 tiers - by Ben Gretch.html",
           "TE": "TE Targets and Fades — the 2025 tiers - by Ben Gretch.html"},
}

# ── reuse the extractor + the shared loaders (no duplication) ─────────────────
import importlib.util
def _load(mod, path):
    s = importlib.util.spec_from_file_location(mod, path)
    m = importlib.util.module_from_spec(s); s.loader.exec_module(m); return m
_brw = _load("brw", os.path.join(HERE, "backtest_role_weighting.py"))
_et = _load("et", os.path.join(HERE, "data", "tiers", "extract_targets.py"))
norm = _brw.norm
pctl = _brw.pctl

def half_ppr(r): return _brw.league_half_ppr(r)

# ── 2021 parser (different format: no target/fade markup; lists are <span>+<br/> ──
import re as _re
_TIER21 = _re.compile(r"<h3[^>]*>\s*(Tier\s+\d+[a-z]?)\s*<div", _re.I)
_H2_21 = _re.compile(r"(?s)<h2[^>]*>(.*?)</h2>")

def _parse_p_names(inner):
    inner = _re.sub(r"<br\s*/?>", "|", inner, flags=_re.I)
    inner = _re.sub(r"<[^>]+>", "", inner)
    names = []
    for piece in inner.split("|"):
        nm = piece.replace("\\u2019", "'").replace("\u2019", "'").strip()
        if nm and len(nm) < 40 and not nm.endswith("."):   # filter prose paragraphs
            names.append(nm)
    return names

def extract_2021(html, pos):
    """2021 articles predate the bold/italic target/fade convention (0 <strong>/<em>
    tags) and use two list shapes: single-player tiers are <p>Name</p>, multi-
    player tiers are <p><span>Name</span><br/>...</p>. Body tier headings carry an
    embedded anchor <div> (the TOC headings don't) -- _TIER21 keys on that. The
    QB+TE file splits at the body <h2>Tight Ends</h2>. Returns [(tier_label,
    [name,...])]; target/fade are absent (assigned False upstream)."""
    tiers = [(m.start(), m.group(1)) for m in _TIER21.finditer(html)]
    if not tiers: return []
    body0, bodyN = tiers[0][0], tiers[-1][0]
    te_split = None
    if pos in ("QB", "TE"):
        for m in _H2_21.finditer(html):
            if body0 < m.start() < bodyN and _re.search(r"tight.?end", m.group(1), _re.I):
                te_split = m.start(); break
    out = []
    for i, (pstart, label) in enumerate(tiers):
        if pos in ("QB", "TE"):
            if pos == "QB" and te_split and pstart > te_split: continue
            if pos == "TE" and (not te_split or pstart < te_split): continue
        hend = html.find("</h3>", pstart)
        if hend < 0: continue
        nxt = tiers[i + 1][0] if i + 1 < len(tiers) else len(html)
        p = _re.search(r"(?s)<p>(.*?)</p>", html[hend:nxt])
        if not p: continue
        names = _parse_p_names(p.group(1))
        if names: out.append((label, names))
    return out

# ── extract Gretch's tier list per (year, pos) ────────────────────────────────
def extract_all():
    """-> list of dict(year,pos,gretchr,tier,subtier,target,fade,nname,raw).
    2021 has no target/fade markup -> all target/fade False there (those records
    still carry tier + within-pos rank for the depth/divergence tests)."""
    out = []
    for y in YEARS_G:
        for pos in POS:
            fp = os.path.join(GRETCH, str(y), ARTICLES[y][pos])
            if not os.path.exists(fp):
                print(f"  !! missing article {fp}"); continue
            html = open(fp, encoding="utf-8").read()
            if y == 2021:
                rank = 0
                for label, names in extract_2021(html, pos):
                    tnum, sub = _et.parse_tier_label(label)
                    if tnum is None: continue
                    for name in names:
                        rank += 1
                        out.append(dict(year=y, pos=pos, gretchr=rank, tier=tnum, subtier=sub,
                                        target=False, fade=False, nname=norm(name), raw=name))
                continue
            for label, entries in _et.extract(html):
                tnum, sub = _et.parse_tier_label(label)
                if tnum is None: continue
                for num, name, fmt in entries:
                    out.append(dict(year=y, pos=pos, gretchr=num, tier=tnum, subtier=sub,
                                    target=(fmt == "target"), fade=(fmt == "fade"),
                                    nname=norm(name), raw=name))
    return out

# ── realized + league joins (self-contained over YEARS_G; 2025 from weekly agg) ──
def load_realized():
    """year -> norm_name -> (gsis_id, half_ppr). Loads YEARS_G season files
    directly (incl. 2025 aggregated from weekly). Matches backtest_role_weighting
    semantics: keeps max pts per name (the season file's REG+POST row wins)."""
    out = defaultdict(dict)
    for y in YEARS_G:
        f = os.path.join(CACHE, f"player_stats_season_{y}.csv.gz")
        if not os.path.exists(f):
            print(f"  !! missing realized {f}"); continue
        with gzip.open(f, "rt") as fh:
            for r in csv.DictReader(fh):
                if str(r.get("season")) != str(y) or r.get("position") not in POS:
                    continue
                key = norm(r.get("player_display_name", ""))
                if not key: continue
                pts = half_ppr(r)
                if key not in out[y] or pts > out[y][key][1]:
                    out[y][key] = (r.get("player_id"), pts)
    return out

def load_league():
    """(year,nname) -> dict(salary, prank, adp, pos). adp = this LEAGUE HISTORY's
    consensus-overall pick column (blank for 2025); parsed for schema fidelity
    but NOT the divergence-test market source -- that's FantasyPros ADP via
    load_adp_posrank below. pos attaches within-position realized finish (rrank)."""
    out = {}
    with open(PRICE_CSV) as fh:
        for r in csv.DictReader(fh):
            if r.get("Year") not in map(str, YEARS_G): continue
            if r.get("Position") not in POS: continue
            try:
                prank = int(r["Position Rank"]); sal = int(r["Salary"].replace("$", ""))
                y = int(r["Year"])
            except (ValueError, KeyError):
                continue
            adp = None
            a = r.get("ADP", "").strip()
            if a and a != "#N/A":
                try: adp = float(a)
                except ValueError: adp = None
            out[(y, norm(r["Name"]))] = dict(salary=sal, prank=prank, adp=adp, pos=r["Position"])
    return out

def load_adp_posrank():
    """(year,pos,nname) -> within-position consensus ADP rank (1 = market's #1 at
    pos), from FantasyPros ADP -- the independent broad market (column `Avg`,
    covers 2021-2025 incl. the 2025 window that's blank in the league history).
    Shared with backtest_room_micromarket: keep ONE copy here so both harnesses
    agree on the market source."""
    raw = defaultdict(list)
    with open(ADP_CSV) as fh:
        for r in csv.DictReader(fh):
            if r["Year"] not in map(str, YEARS_G): continue
            pos = r.get("Position")
            if pos not in POS: continue
            a = r.get("Avg", "").strip()
            if not a or a == "#N/A": continue
            try: avg = float(a)
            except ValueError: continue
            raw[(int(r["Year"]), pos)].append((norm(r["Player_Name"]), avg))
    out = {}
    for (y, pos), lst in raw.items():
        lst.sort(key=lambda x: x[1])              # lower ADP = earlier = rank 1
        for i, (n, _) in enumerate(lst, 1): out[(y, pos, n)] = i
    return out

def join_all(records, realized, league):
    """attach pts + salary/prank + within-pos realized finish (rrank) + within-pos
    ADP rank (adp_posrank, the independent broad-market rank)."""
    # pos-tagged realized population (for within-pos realized finish)
    pos_of = {}
    for y in YEARS_G:
        f = os.path.join(CACHE, f"player_stats_season_{y}.csv.gz")
        if not os.path.exists(f): continue
        with gzip.open(f, "rt") as fh:
            for r in csv.DictReader(fh):
                if str(r.get("season")) != str(y) or r.get("position") not in POS:
                    continue
                pos_of[(y, norm(r.get("player_display_name", "")))] = (r.get("position"), half_ppr(r))
    pop = defaultdict(list)
    for (y, n), (p, pts) in pos_of.items():
        pop[(y, p)].append((n, pts))
    rrank = {}
    for (y, p), lst in pop.items():
        lst.sort(key=lambda x: x[1], reverse=True)
        for i, (n, _) in enumerate(lst, 1):
            rrank[(y, p, n)] = i
    # within-position ADP rank per year (independent broad market = FantasyPros;
    # covers 2021-2025, incl. the 2025 window the league history leaves blank).
    adp_posrank = load_adp_posrank()
    # attach
    for rec in records:
        y, p, n = rec["year"], rec["pos"], rec["nname"]
        hit = realized.get(y, {}).get(n)
        rec["pts"] = hit[1] if hit else None
        rec["matched_realized"] = hit is not None
        lg = league.get((y, n))
        rec["salary"] = lg["salary"] if lg else None
        rec["prank"] = lg["prank"] if lg else None
        rec["drafted"] = lg is not None
        rec["rrank"] = rrank.get((y, p, n))
        rec["adp_posrank"] = adp_posrank.get((y, p, n))
    return records

# ── pools + tail-gradient metrics (same shape as backtest_role_weighting) ─────
def league_bench(rec):
    return rec["drafted"] and (rec["salary"] <= BENCH_SAL_MAX or rec["prank"] >= BENCH_PRANK_MIN)

def gretchr_depth(rec):
    return rec["gretchr"] >= 30          # Gretch-rank depth, independent of league draft

def metrics(sub):
    sub = [r for r in sub if r["matched_realized"] and r["rrank"] is not None]
    n = len(sub)
    if not n: return None
    pts = [r["pts"] for r in sub]
    top6 = sum(1 for r in sub if r["rrank"] <= 6)
    top12 = sum(1 for r in sub if r["rrank"] <= 12)
    return dict(n=n,
                mean=st.mean(pts),
                hit=st.mean(p * (1 if r["rrank"] <= 12 else 0) for r, p in zip(sub, pts)),
                lw=st.mean(p * (1 if r["rrank"] <= 6 else 0) for r, p in zip(sub, pts)),
                top6=100 * top6 / n, top12=100 * top12 / n)

def fmt(label, m):
    if m is None: return f"  {label:14} n=0"
    return (f"  {label:14} n={m['n']:>3}  top6%{m['top6']:4.0f} top12%{m['top12']:4.0f}  "
            f"mean{m['mean']:6.1f} hit{m['hit']:6.1f} lw{m['lw']:5.1f}")

# ── TEST 1: target/fade role-weighting ────────────────────────────────────────
def target_fade_test(recs, pool_fn, pool_name):
    pool = [r for r in recs if pool_fn(r)]
    out = [f"\n  --- pool: {pool_name} (n={len([r for r in pool if r['matched_realized']])} realized) ---"]
    by_pos = {"ALL": pool}
    for pos in POS: by_pos[pos] = [r for r in pool if r["pos"] == pos]
    for key in ["ALL"] + POS:
        sub = by_pos[key]
        mt = metrics([r for r in sub if r["target"]])
        mf = metrics([r for r in sub if r["fade"]])
        mo = metrics([r for r in sub if not r["target"] and not r["fade"]])
        out.append(f"  [{key}]")
        out.append(fmt("target", mt))
        out.append(fmt("fade", mf))
        out.append(fmt("none", mo))
        if mt and mo:
            dh = mt["hit"] - mo["hit"]
            out.append(f"       target vs none:  Δhit {dh:+6.1f}  Δtop12 {mt['top12']-mo['top12']:+4.0f}pp"
                       + ("  <- target edge" if dh > 1 else "  <- flat/negative"))
    return "\n".join(out)

# ── TEST 2: tier divergence, LEVEL-CONTROLLED (raw top12% is confounded) ──────
def divergence_test(recs):
    """ROOM-based divergence: div = this league's Position Rank (purchase order) -
    gretch_rank (+ = this room got him cheaper/later than Gretch). NOT an
    independent market (the room is Gretch-influenced) -- see divergence_test_adp
    for the consensus-ADP version. Raw top12%/mean is LEVEL-CONFOUNDED (the
    'consensus' bucket = elites who score more regardless), so we use realized
    RATIO (actual/expected-at-rank, LOO rank-bin median) -- P50~1.0 isolates the
    divergence itself."""
    drafted = [dict(pos=r["pos"], prank=r["prank"], year=r["year"], pts=r["pts"])
               for r in recs if r["drafted"] and r["matched_realized"]]
    loo = _brw.expected_curves(drafted)
    out = ["\n  TIER DIVERGENCE -- ROOM-based (this league's Position Rank; Gretch-influenced).",
           "  div = league_rank - gretch_rank (+ = this room got him cheaper than Gretch).",
           "  ratio = actual/expected-at-rank (P50~1.0 unbiased; P90 = ceiling beyond rank).",
           "  -> for the INDEPENDENT market, see the ADP table below."]
    out.append(f"  {'div bucket':18} {'n':>4}  {'P50':>5} {'P90':>5}  {'top12%':>6}")
    buckets = [("deep sleeper (>=+15)", lambda d: d >= 15),
               ("mild sleeper (+5..+15)", lambda d: 5 <= d < 15),
               ("consensus (-5..+5)", lambda d: -5 <= d < 5),
               ("market higher (<-5)", lambda d: d < -5)]
    for label, fn in buckets:
        ratios, t12n, t12d = [], 0, 0
        for r in recs:
            if not (r["drafted"] and r["matched_realized"] and r["rrank"] is not None): continue
            if not fn(r["prank"] - r["gretchr"]): continue
            e = loo.get((r["pos"], r["prank"], r["year"]), 0)
            if e > 0: ratios.append(r["pts"] / e)
            t12d += 1; t12n += 1 if r["rrank"] <= 12 else 0
        if not ratios:
            out.append(f"  {label:18} {0:>4}"); continue
        rs = sorted(ratios)
        out.append(f"  {label:18} {len(rs):>4}  {pctl(rs,50):>5.2f} {pctl(rs,90):>5.2f}  "
                   f"{100*t12n/t12d:>5.0f}%")
    return "\n".join(out)

# ── TEST 2b: ADP-based divergence (the INDEPENDENT broad market) ─────────────
def divergence_test_adp(recs):
    """The independent-market version of the divergence test. adp_div = within-
    position ADP rank (consensus) - gretch_rank (+ = the broad market had him
    cheaper/later than Gretch). This is NOT this room's behavior -- it's the
    consensus draft market, so it's the fair test of 'market vs Gretch'. Level-
    controlled via realized ratio on the ADP-rank axis. ADP sourced from
    FantasyPros (load_adp_posrank), covers 2021-2025 incl. the 2025 window the
    league history leaves blank -- so this is no longer a room-independent
    4-year window but a full 5-year one."""
    rows = [dict(pos=r["pos"], prank=r["adp_posrank"], year=r["year"], pts=r["pts"])
            for r in recs if r.get("adp_posrank") and r["matched_realized"]]
    loo = _brw.expected_curves(rows)
    out = ["\n  TIER DIVERGENCE -- ADP-based (independent broad market, FantasyPros 2021-2025).",
           "  adp_div = within-pos ADP rank - gretch_rank (+ = market cheaper than Gretch).",
           "  ratio on the ADP-rank axis (P50~1.0). This is the fair 'market vs Gretch' test."]
    out.append(f"  {'adp_div bucket':18} {'n':>4}  {'P50':>5} {'P90':>5}  {'top12%':>6}")
    buckets = [("deep sleeper (>=+15)", lambda d: d >= 15),
               ("mild sleeper (+5..+15)", lambda d: 5 <= d < 15),
               ("consensus (-5..+5)", lambda d: -5 <= d < 5),
               ("market higher (<-5)", lambda d: d < -5)]
    for label, fn in buckets:
        ratios, t12n, t12d = [], 0, 0
        for r in recs:
            if not (r.get("adp_posrank") and r["matched_realized"] and r["rrank"] is not None): continue
            if not fn(r["adp_posrank"] - r["gretchr"]): continue
            e = loo.get((r["pos"], r["adp_posrank"], r["year"]), 0)
            if e > 0: ratios.append(r["pts"] / e)
            t12d += 1; t12n += 1 if r["rrank"] <= 12 else 0
        if not ratios:
            out.append(f"  {label:18} {0:>4}"); continue
        rs = sorted(ratios)
        out.append(f"  {label:18} {len(rs):>4}  {pctl(rs,50):>5.2f} {pctl(rs,90):>5.2f}  "
                   f"{100*t12n/t12d:>5.0f}%")
    return "\n".join(out)
def elite_vs_bench_test(recs):
    """THE key cut for the per-slot split. Gretch's targets overperform in the
    depth/bench pool but UNDERPERFORM at elite/starter (consensus is right at the
    top; contrarian elite targets lose). Same signal, opposite value by slot =>
    the V4 split is data-motivated, not a guess. RB is the exception (his RB
    calls are good at both levels)."""
    out = ["\n  TARGET EDGE by SLOT (bench vs elite/starter) -- bench-specific?",
           "  bench = league bench pool; elite = drafted, NOT bench. Δhit = target - none."]
    out.append(f"  {'pos':4} {'bench Δhit':>11} {'elite Δhit':>11}   read")
    for pos in ["ALL"] + POS:
        def edge(pool):
            mt = metrics([r for r in pool if r["target"]])
            mo = metrics([r for r in pool if not r["target"] and not r["fade"]])
            return (mt["hit"] - mo["hit"]) if mt and mo else float("nan")
        bench = [r for r in recs if league_bench(r) and (pos == "ALL" or r["pos"] == pos)]
        elite = [r for r in recs if r["drafted"] and not league_bench(r) and (pos == "ALL" or r["pos"] == pos)]
        eb, ee = edge(bench), edge(elite)
        read = ("BENCH-SPECIFIC -> split" if eb > 1 and ee < 1
                else "target good everywhere" if eb > 1 and ee > 1
                else "weak / mixed")
        out.append(f"  {pos:4} {eb:>+11.1f} {ee:>+11.1f}   {read}")
    return "\n".join(out)

# ── LOO stress test (target edge in depth, pooled, by year) ───────────────────
def loo(recs, pool_fn):
    out = []
    for drop in YEARS_G:
        pool = [r for r in recs if r["year"] != drop and pool_fn(r)]
        mt = metrics([r for r in pool if r["target"]])
        mo = metrics([r for r in pool if not r["target"] and not r["fade"]])
        dh = (mt["hit"] - mo["hit"]) if (mt and mo) else float("nan")
        out.append((drop, dh, mt["n"] if mt else 0, mo["n"] if mo else 0))
    return out

def run():
    print("V3 GRETCH-SIGNAL BACKTEST  years", "-".join(map(str, YEARS_G)),
          "| half-PPR | target/fade + tier-rank from saved articles\n")
    recs = extract_all()
    realized = load_realized()
    league = load_league()
    recs = join_all(recs, realized, league)
    n_real = sum(1 for r in recs if r["matched_realized"])
    n_drafted = sum(1 for r in recs if r["drafted"])
    print(f"extracted {len(recs)} tier entries ({sum(1 for r in recs if r['target'])} targets, "
          f"{sum(1 for r in recs if r['fade'])} fades); {n_real} matched realized; "
          f"{n_drafted} drafted in league\n")

    print("=" * 78)
    print("TEST 1 — TARGET/FADE role-weighting (does Gretch's call beat the depth pool?)")
    print("=" * 78)
    print(target_fade_test(recs, league_bench, "LEAGUE bench (sal<=10 or prank>=13) [matches proxy]"))
    print(target_fade_test(recs, gretchr_depth, "GRETCH depth (gretchr>=30) [fuller sample]"))

    print("\n" + "=" * 78)
    print("TEST 1b — TARGET EDGE by SLOT (bench vs elite): is the split data-motivated?")
    print("=" * 78)
    print(elite_vs_bench_test(recs))

    print("\n" + "=" * 78)
    print("TEST 2 — TIER DIVERGENCE: room (this league) vs ADP (independent market)")
    print("=" * 78)
    print(divergence_test(recs))
    print(divergence_test_adp(recs))

    print("\n" + "=" * 78)
    print("LEAVE-ONE-YEAR-OUT — target edge (Δhit) in LEAGUE bench pool, pooled:")
    print("  (positive = Gretch's bench targets beat bench non-targets on startable prod)")
    print("=" * 78)
    print(f"  {'drop':>6} {'Δhit':>8}  {'ntgt':>5} {'nnone':>6}")
    for drop, dh, nt, nn in loo(recs, league_bench):
        print(f"  {drop:>6} {dh:+8.1f}  {nt:>5} {nn:>6}")

if __name__ == "__main__":
    run()
