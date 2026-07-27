"""Generate review.html: two tabs.

  Tab 1 "Price Review"   — predicted $ per player WITH this league's history,
                           so implausible predictions (Baker $6 after a $33 yr)
                           are visible & overridable. Client-side filter + sort.
  Tab 2 "QB Strategies"  — roster-construction comparison: for each QB plan,
                           fix the QBs and re-optimize the rest of the roster,
                           then rank by projected starter points. Answers
                           "does going cheap at QB actually win?"

Run:  python3 generate_review_html.py   →  review.html
(Regenerates from out/players.json + out/qb_strategies.json + league history.)
"""
import csv, os, re, json
from common import load_projections, points, LeagueConfig

HERE = os.path.dirname(__file__)
HIST = os.path.expanduser("~/Downloads/Avant League History - Historical ADP - Fantasy Pros (2).csv")
OUT = os.path.join(HERE, "review.html")


def norm(name):
    s = re.sub(r"[.'']", "", name.lower())
    return " ".join(t for t in s.split() if t not in ("jr", "sr", "ii", "iii", "iv", "v", "i")).strip()


# ── historical price/rank per player, by year ────────────────────────────────
hist = {}
with open(HIST) as fh:
    for r in csv.DictReader(fh):
        try:
            y = int(r["Year"]); rk = int(r["Position Rank"])
            paid = int(r["Auction Paid"].replace("$", ""))
        except (ValueError, KeyError):
            continue
        if paid <= 0:
            continue
        hist.setdefault(norm(r["Player_Name"]), {})[y] = {"rk": rk, "$": paid}

players = json.load(open(os.path.join(HERE, "out", "players.json")))
players = [p for p in players if p.get("pts")]

# projection-implied rank within position (fallback if apply_overrides wasn't run)
from collections import defaultdict
_pr = defaultdict(list)
for p in players:
    _pr[p["pos"]].append(p)
for lst in _pr.values():
    lst.sort(key=lambda p: -(p.get("pts") or 0))
    for i, p in enumerate(lst, 1):
        p.setdefault("proj_rank", i)

rows = []
for p in sorted(players, key=lambda x: (x["pos"], x["rank"])):
    h = hist.get(norm(p["name"]), {})
    last = max(h) if h else None
    last_paid = h[last]["$"] if last else None
    last_rk = h[last]["rk"] if last else None
    hstr = "  ".join(f"{y}:${h[y]['$']}(rk{h[y]['rk']})" for y in sorted(h, reverse=True))
    flag = ""
    if last_paid is not None and p["cost"] is not None:
        if abs(p["cost"] - last_paid) >= 12:
            flag = "⚠ big change"
    sig = flag
    if p.get("ceiling") == "up":
        sig = (sig + " " if sig else "") + "↑ ceiling"
    elif p.get("ceiling") == "down":
        sig = (sig + " " if sig else "") + "↓ fade"
    rows.append({
        "name": p["name"], "pos": p["pos"], "rk": p["rank"],
        "projrk": p.get("proj_rank"), "myrk": p.get("my_rank"),
        "adp": round(p.get("adp", 0)) if p.get("adp") else None,
        "pred": p["cost"], "ovr": p.get("model_cost"),
        "pts": p["pts"],
        "ppd": round(p["pts"] / p["cost"], 2) if p["cost"] else None,
        "last": last_paid, "lastrk": last_rk, "hist": hstr,
        "flag": flag, "ceil": p.get("ceiling") or "", "sig": sig,
        "note": p.get("my_note") or "",
    })

# ── cost curves tab data (flat 5yr vs recency-weighted, + year-by-year) ──────
import build_2026 as _b
import statistics as _st
from collections import defaultdict as _dd
_adp = _b.load_adp()
_cflat = _b.cost_curve(_adp, {y: 1 for y in _b.HIST_YEARS})
_cwgt = _b.cost_curve(_adp, _b.YEAR_WEIGHTS)
_cyr = _dd(lambda: _dd(list))
for _r in _adp:
    if _r["year"] in _b.HIST_YEARS and _r["paid"] > 0:
        _cyr[(_r["pos"], _r["prank"])][_r["year"]].append(_r["paid"])
_cp26 = {(p["pos"], p["rank"]): p["name"] for p in players}

def _curve_table(pos):
    ranks = sorted(set(list(_cflat[pos]) + [rk for (pp, rk) in _cp26 if pp == pos]))
    ranks = [r for r in ranks if r <= 36]
    h = ['<table class="curve"><thead><tr><th>rk</th>'
         + "".join(f"<th>'{str(y)[2:]}</th>" for y in _b.HIST_YEARS)
         + '<th>flat</th><th class="wgt">wgt</th><th>Δ</th>'
         + '<th class="l">2026 player</th></tr></thead><tbody>']
    for rk in ranks:
        yc = []
        for y in _b.HIST_YEARS:
            v = [x for x in _cyr.get((pos, rk), {}).get(y, []) if x > 0]
            yc.append(f"{int(_st.median(v))}" if v else "·")
        f_ = _cflat[pos].get(rk); w_ = _cwgt[pos].get(rk)
        d = (w_ - f_) if (f_ and w_) else None
        cls = "up" if (d or 0) > 0 else ("down" if (d or 0) < 0 else "")
        ds = f"{d:+d}" if d else ""
        nm = _cp26.get((pos, rk), "")
        h.append(f'<tr><td>{rk}</td>' + "".join(f'<td>{c}</td>' for c in yc)
                 + f'<td class="muted">{f_ or "·"}</td><td class="wgt">{w_ or "·"}</td>'
                 + f'<td class="{cls}">{ds}</td><td class="l">{nm}</td></tr>')
    h.append('</tbody></table>')
    return "".join(h)

_curves_pane = (
    '<div class="callout"><b>Cost curves — flat 5-yr median vs the live recency-weighted prediction.</b><br>'
    "This league's valuations shifted structurally 2021→25: mid-QB $ rose ~2× (9→18 at QB13–24) while "
    "mid/elite RB $ FELL (22→14 at RB13–24) — a budget rotation out of RB into QB/WR, not inflation. "
    "The flat 5-yr median lands on 2023 and lags the trend; "
    "<b>YEAR_WEIGHTS = 21:1, 22:1, 23:2, 24:3, 25:4</b> pulls the curve toward 2024. "
    '<b class="wgt">wgt</b> = predicted 2026 $ (drives the par sheet). '
    '<span class="up">Δ&gt;0</span> repriced up (QB/WR); <span class="down">Δ&lt;0</span> down (RB = new edge).</div>'
    + "".join(f'<h3 class="cvh">{pos}</h3>{_curve_table(pos)}' for pos in ["QB", "RB", "WR", "TE"])
)

# ── QB strategies tab data ───────────────────────────────────────────────────
qb = json.load(open(os.path.join(HERE, "out", "qb_strategies.json")))
strategies = sorted(qb["strategies"], key=lambda s: -s["starter_pts"])
max_pts = max(s["starter_pts"] for s in strategies)
REC_TAG = qb.get("rec_tag")
best_pts = round(max_pts)   # top plan under the "carry 3 QBs" constraint


def qb_short(s):
    starters = [r for r in s["roster"] if r["slot"] in ("QB1", "SF") and r["role"] == "QB-plan"]
    return " + ".join(f"{r['name']}" for r in starters)


def bench_qb_str(s):
    if not s["bench_qbs"]:
        return "—"
    return ", ".join(f"{b['name']} (${b['cost']})" for b in s["bench_qbs"])


def delta_str(pts):
    d = round(pts) - best_pts
    return "best" if d == 0 else f"{d:+.0f}"


def bar_color(s):
    if s["tag"] == REC_TAG:
        return "#1a7f37"      # green - median optimum
    if s.get("is_ask"):
        return "#b7791f"      # amber - your proposed builds
    if s["starter_pts"] >= best_pts - 25:
        return "#2e7d32"      # near-best
    if s["starter_pts"] <= best_pts - 70:
        return "#c0392b"      # costly
    return "#8a94a6"          # mid


# ── bench-QB cost sensitivity sweep ──────────────────────────────────────────
# The summary table ships each plan with its OWN bench QB ($4/$7/$13), so it
# isn't a clean comparison on backup spend. Here we hold the two STARTING QBs
# fixed and re-solve the 6 skill slots at each backup price. The bench QB adds
# 0 starter pts (insurance only), so this is a pure budget sweep: cheaper backup
# -> more $ for RB/WR/TE/FLEX, and the optimal *starter* plan can flip.
import importlib.util as _ilu
_qspec = _ilu.spec_from_file_location("_qbstrat", os.path.join(HERE, "04_qb_strategies.py"))
_qbmod = _ilu.module_from_spec(_qspec); _qspec.loader.exec_module(_qbmod)
_BENCH_COSTS = [13, 8, 7, 4, 3]
def _best_qb_at(cost):
    c = [p for p in players if p["pos"] == "QB" and p["cost"] == cost]
    if not c:
        return None
    b = max(c, key=lambda p: p["pts"])
    return (b["name"], round(b["pts"], 1))
_BENCH_FILL = {bc: _best_qb_at(bc) for bc in _BENCH_COSTS}   # price -> (name, ins. pts)
_T, _KDST, _BNS = 200, 2, 5
def _sname(n):
    t = [w for w in n.replace(".", " ").split() if w.upper() not in ("II", "III", "IV", "JR", "SR")]
    return f"{t[0][0]}. {t[-1]}" if len(t) >= 2 else t[-1]
_sweep = []
for _plan in _qbmod.PLANS:
    _sc = sum(_qbmod.find(n)["cost"] for s, n in _plan["qbs"].items() if s in _qbmod.QB_SLOTS)
    _sp = sum(_qbmod.find(n)["pts"] for s, n in _plan["qbs"].items() if s in _qbmod.QB_SLOTS)
    _cells = {bc: round(_sp + _qbmod.opt_skill(_T - _KDST - _sc - bc - (_BNS - 1))[0], 1)
              for bc in _BENCH_COSTS}
    _start = " + ".join(_sname(n) for s, n in _plan["qbs"].items() if s in _qbmod.QB_SLOTS)
    _sweep.append({"tag": _plan["tag"], "start": _start, "sc": _sc, "cells": _cells})
_sweep.sort(key=lambda r: r["sc"])                       # cheapest starters first
_best_of = {bc: max(_sweep, key=lambda r: r["cells"][bc])["tag"] for bc in _BENCH_COSTS}
_ask_tags = set(qb.get("ask_tags", []))
_sens_head = "".join(f"<th>${bc} backup</th>" for bc in _BENCH_COSTS)
_sens_rows = []
for r in _sweep:
    cls = (" rec" if r["tag"] == REC_TAG else "") + (" ask" if r["tag"] in _ask_tags else "")
    cells = []
    for bc in _BENCH_COSTS:
        bcls = "best" if _best_of[bc] == r["tag"] else ""
        cells.append(f'<td class="{bcls}">{r["cells"][bc]:.0f}</td>')
    _sens_rows.append(
        f'<tr class="sens{cls}"><td class="l">{r["start"]}</td><td>${r["sc"]}</td>{"".join(cells)}</tr>')
_fill_legend = "  ·  ".join(
    f"${bc}={_BENCH_FILL[bc][0]} ({_BENCH_FILL[bc][1]} ins. pts)"
    for bc in _BENCH_COSTS if _BENCH_FILL[bc])
_sens_pane = f'''
<h3 style="margin:18px 0 4px;font-size:15px">Bench-QB cost: does a cheap backup change the answer?</h3>
<div class="callout">
<b>Yes — it flips the optimal starter plan.</b> The summary above lets each plan keep its own bench
QB ($4–$13), so it isn't a clean comparison on backup spend. This table holds the two <b>starting</b>
QBs fixed and re-solves the 6 skill slots at each backup price — a pure budget sweep (the backup adds
0 starter pts; cheaper backup = more $ for RB/WR/TE/FLEX).<br><br>
At a <b>$13 backup (Baker)</b> the cheap-starter plan <b>Kyler+Love</b> wins. Drop the backup to
<b>≤$8</b> and <b>Dak+Purdy</b> takes over for good: the pricier starters are budget-starved, so each
freed backup dollar buys them more skill pts (Kyler+Love is already on a plateau and wastes the
savings until a tier cliff). <b>Sweet spot = $7–8 (Stroud/Shough):</b> ~95% of Baker's insurance value
(287 vs 304 pts) at ~55% of the cost — and it unlocks the better starter plan.
</div>
<table class="sens"><thead><tr>
 <th class="l">Starting QBs</th><th>start $</th>{_sens_head}
</tr></thead><tbody>
{chr(10).join(_sens_rows)}
</tbody></table>
<div class="legend">Backup at each price (best available): {_fill_legend}.
&nbsp;<span class="best-cell"></span> = best starter pts at that backup price.
&nbsp;Rows ordered by starting-QB spend (cheapest first); the green optimum sits at Kyler+Love for a
$13 backup, then drops to Dak+Purdy for any backup ≤$8.</div>
'''


# pre-render summary rows + detail blocks
summary_rows_html = []
detail_blocks_html = []
for s in strategies:
    pct = s["starter_pts"] / max_pts * 100
    rec = " rec" if s["tag"] == REC_TAG else ""
    ask = " ask" if s.get("is_ask") else ""
    summary_rows_html.append(
        f'<tr class="sum{rec}{ask}">'
        f'<td class="l">{s["name"]}</td>'
        f'<td class="l muted">{qb_short(s)}</td>'
        f'<td>${s["qb_cost"]}</td>'
        f'<td>{s["qb_starter_pts"]:.0f}</td>'
        f'<td>{s["non_qb_starter_pts"]:.0f}</td>'
        f'<td class="big">{s["starter_pts"]:.0f}</td>'
        f'<td>{delta_str(s["starter_pts"])}</td>'
        f'<td>${s["total_cost"]}</td>'
        f'<td class="l muted sm">{bench_qb_str(s)}</td></tr>'
    )
    # detail block
    roster_rows = []
    for r in s["roster"]:
        tag = ""
        if r["role"] == "QB-plan":
            tag = " qbslot"
        elif r["slot"] in ("RB1", "RB2", "WR1", "WR2", "TE", "FLEX", "SF"):
            tag = " skill"
        pts = f'{r["pts"]:.1f}' if r["pts"] else "—"
        rk = f'rk{r["rank"]}' if r["rank"] else ""
        roster_rows.append(
            f'<tr class="det{tag}">'
            f'<td class="slot">{r["slot"]}</td>'
            f'<td class="l">{r["name"]}</td>'
            f'<td>{r["pos"]}</td>'
            f'<td class="muted">{rk}</td>'
            f'<td>${r["cost"]}</td>'
            f'<td>{pts}</td></tr>'
        )
    open_attr = " open" if (s["tag"] == REC_TAG or s.get("is_ask")) else ""
    star = ""
    if s["tag"] == REC_TAG:
        star = ' <span class="star">★ median optimum</span>'
    elif s.get("is_ask"):
        star = ' <span class="askstar">★ your ask</span>'
    detail_blocks_html.append(
        f'<details class="build{rec}{ask}"{open_attr}>'
        f'<summary><b>{s["starter_pts"]:.0f}</b> starter pts &nbsp;·&nbsp; '
        f'<span class="muted">{s["name"]}{star}</span>'
        f'<span class="bar"><span style="width:{pct:.1f}%;background:{bar_color(s)}"></span></span>'
        f'</summary>'
        f'<div class="buildbody">'
        f'<div class="kv">QB spend <b>${s["qb_cost"]}</b> &nbsp;·&nbsp; '
        f'starting QB pts <b>{s["qb_starter_pts"]:.0f}</b> &nbsp;·&nbsp; '
        f'non-QB starter pts <b>{s["non_qb_starter_pts"]:.0f}</b> &nbsp;·&nbsp; '
        f'budget left for RB/WR/TE/FLEX <b>${s["free_budget"]}</b> &nbsp;·&nbsp; '
        f'total <b>${s["total_cost"]}</b></div>'
        + ('<div class="kv ins">bench QB insurance: ' + bench_qb_str(s) +
           ' <span class="muted">(costs $ vs a $1 scrub; 0 starter pts — value is '
           'bye/injury coverage + trade equity)</span></div>' if s["bench_qbs"] else "")
        + '<table class="det"><thead><tr><th>slot</th><th class="l">player</th>'
          '<th>pos</th><th>rk</th><th>$</th><th>pts</th></tr></thead><tbody>'
        + "".join(roster_rows)
        + '</tbody></table></div></details>'
    )


html = f"""<!doctype html><html><head><meta charset="utf-8">
<title>2026 Draft Prep — Avant SF</title>
<style>
 body{{font:14px -apple-system,sans-serif;margin:0;color:#222;background:#fff}}
 .wrap{{max-width:1180px;margin:0 auto;padding:20px}}
 h1{{font-size:20px;margin:0 0 2px}} .sub{{color:#666;margin:0 0 14px}}
 .tabbar{{display:flex;gap:0;border-bottom:2px solid #e3e3e3;margin-bottom:18px;position:sticky;top:0;background:#fff;z-index:5}}
 .tabbar button{{font:600 14px -apple-system;padding:10px 18px;border:none;background:none;cursor:pointer;
   border-bottom:3px solid transparent;color:#666}}
 .tabbar button.active{{color:#1a73e8;border-bottom-color:#1a73e8}}
 .tabbar button:hover{{color:#1a73e8}}
 .pane{{display:none}} .pane.active{{display:block}}
 .bars button{{font:13px;padding:5px 12px;margin-right:6px;border:1px solid #ccc;
   border-radius:6px;background:#fff;cursor:pointer}}
 .bars button.active{{background:#1a73e8;color:#fff;border-color:#1a73e8}}
 table{{border-collapse:collapse;width:100%;margin-top:12px}}
 th,td{{padding:5px 8px;text-align:right;border-bottom:1px solid #eee;white-space:nowrap}}
 th{{cursor:pointer;background:#f7f7f7;position:sticky;top:0}}
 th.l,td.l{{text-align:left}} td.flag{{color:#c0392b;font-weight:600}}
 td.myrk{{color:#1a73e8;font-weight:700}}
 td.ovr{{color:#b7791f;font-weight:700}}
 td.sig{{color:#c0392b;font-weight:600;white-space:normal;max-width:120px}}
 tr.hide{{display:none}} .low{{color:#27ae60}} .high{{color:#c0392b}}
 input{{padding:5px 8px;width:200px;border:1px solid #ccc;border-radius:6px}}
 .note{{background:#fffbe6;border:1px solid #f0d000;padding:10px;border-radius:6px;margin:10px 0;font-size:13px}}
 /* QB tab */
 .callout{{background:#eaf4ff;border:1px solid #b6d4fe;border-radius:8px;padding:12px 14px;margin:8px 0 16px;font-size:13px;line-height:1.5}}
 .callout b{{color:#1a4fa0}}
 table.sum{{font-size:13px}}
 table.sum th,.sum td{{padding:6px 8px}}
 table.sens{{font-size:13px}}
 table.sens th,.sens td{{padding:6px 10px}}
 tr.sens td{{border-bottom:1px solid #f0f0f0}}
 tr.sens.rec td{{background:#effaf0;font-weight:600}}
 tr.sens.ask td{{background:#fdf6e3}}
 td.best{{background:#d4f4dc !important;font-weight:700;color:#1a7f37}}
 .best-cell{{display:inline-block;width:11px;height:11px;background:#d4f4dc;border:1px solid #1a7f37;border-radius:2px;vertical-align:middle;margin:0 3px}}
 tr.sum td{{border-bottom:1px solid #f0f0f0}}
 tr.sum.rec td{{background:#effaf0;font-weight:600}}
 tr.sum.ask td{{background:#fdf6e3}}
 td.big{{font-weight:700;font-size:14px}} td.big{{color:#1a7f37}}
 tr.sum.rec td.big{{color:#1a7f37}}
 .muted{{color:#888;font-weight:400}} .sm{{font-size:11px}}
 details.build{{border:1px solid #e3e3e3;border-radius:8px;margin:8px 0;padding:0 12px;background:#fcfcfd}}
 details.build.rec{{border-color:#1a7f37;background:#f4fbf5}}
 details.build.ask{{border-color:#b7791f;background:#fefcf3}}
 details.build summary{{cursor:pointer;padding:10px 0;font-size:14px;list-style:none}}
 details.build summary::-webkit-details-marker{{display:none}}
 details.build summary::before{{content:"▸";display:inline-block;width:14px;color:#999;transition:transform .15s}}
 details.build[open] summary::before{{transform:rotate(90deg)}}
 details.build.rec summary::before{{color:#1a7f37}}
 details.build.ask summary::before{{color:#b7791f}}
 .star{{color:#1a7f37;font-weight:700}} .askstar{{color:#b7791f;font-weight:700}}
 .bar{{display:inline-block;width:240px;max-width:40%;height:14px;background:#eee;border-radius:4px;
   vertical-align:middle;margin-left:14px;overflow:hidden}}
 .bar span{{display:block;height:100%}}
 .buildbody{{padding:0 0 12px}}
 .kv{{font-size:12.5px;margin:6px 0;color:#444}}
 .kv.ins{{color:#8a6d3b}}
 table.det{{margin-top:6px;font-size:12.5px}}
 table.det th{{background:#f7f7f7;font-weight:600}}
 tr.det td.slot{{color:#888;font-weight:600;width:46px}}
 tr.det.qbslot td{{background:#eef6ff}}
 tr.det.skill td{{color:#222}}
 .legend{{font-size:12px;color:#666;margin-top:6px}}
 table.curve{{font-size:12.5px}} table.curve th,table.curve td{{padding:3px 7px}}
 .wgt{{color:#1a73e8;font-weight:700}} .up{{color:#c0392b;font-weight:600}} .down{{color:#27ae60;font-weight:600}}
 h3.cvh{{margin:16px 0 2px;font-size:15px}}
</style></head><body><div class="wrap">
<h1>2026 Draft Prep — Avant Superflex ($200, 12-team)</h1>
<p class="sub">Cost = this league's historical SF price for a player's ADP rank
(2021–25 <b>recency-weighted</b> median — see the Cost Curves tab). &nbsp;Proj = Gretch pts (Avant scoring). &nbsp;Three tabs below.</p>

<div class="tabbar">
 <button class="active" data-t="review">Price Review</button>
 <button data-t="qb">QB Strategies</button>
 <button data-t="curves">Cost Curves</button>
</div>

<!-- ═══════════════ TAB 1: PRICE REVIEW ═══════════════ -->
<div id="review" class="pane active">
<div class="note">⚠ Predicted $ is a <b>rank-based median with wide spread</b> (a QB20 historically cost $4–16).
Where Pred $ diverges a lot from a player's recent actual $, trust your judgment over the model —
this league bids names above their rank (e.g. Baker was $33 as QB7 in '25; now QB20 → recency curve says $13, was $6 flat).<br>
<b>Proj Rk</b> = rank by projected pts (vs the market's <b>26 Rk</b> = ADP rank). <b>My Rk</b> = your rank from
<code>my_rankings.csv</code> (blue). <b>↑ ceiling</b> = you rank a guy far above his projection (upside the median
misses); <b>↓ fade</b> = the reverse. Pred $ shown <span style="color:#b7791f">amber</span> = your my_price override.
Edit <code>my_rankings.csv</code> then <code>python3 run.py --skip-build</code>.</div>
<div class="bars">
 <button class="active" data-f="ALL">All</button>
 <button data-f="QB">QB</button><button data-f="RB">RB</button>
 <button data-f="WR">WR</button><button data-f="TE">TE</button>
 &nbsp; <input id="q" placeholder="filter by name…">
</div>
<table id="t"><thead><tr>
 <th class="l" data-k="name">Player</th><th data-k="pos">Pos</th>
 <th data-k="rk">26 Rk</th><th data-k="projrk">Proj Rk</th><th data-k="myrk">My Rk</th><th data-k="adp">ADP</th>
 <th data-k="pred">Pred $</th><th data-k="pts">Proj Pts</th><th data-k="ppd">Pts/$</th>
 <th data-k="last">'25 $</th><th data-k="lastrk">'25 Rk</th>
 <th class="l">History (recent first)</th><th>Signals</th>
</tr></thead><tbody>
{chr(10).join(
 f'<tr data-pos="{r["pos"]}">' + (f' data-note="{r["note"]}"' if r["note"] else "") + 
 f'<td class="l">{r["name"]}</td><td>{r["pos"]}</td>'
 f'<td>{r["rk"]}</td><td>{r["projrk"] or ""}</td>'
 f'<td class="myrk">{r["myrk"] or ""}</td>'
 f'<td>{r["adp"] if r["adp"] else ""}</td>'
 + (f'<td class="ovr" title="model ${r["ovr"]} (your my_price override)">${r["pred"]}</td>'
    if r["ovr"] is not None else f'<td>${r["pred"]}</td>')
 + f'<td>{r["pts"]}</td><td>{r["ppd"]}</td>'
 f'<td>{r["last"] if r["last"] is not None else ""}</td>'
 f'<td>{r["lastrk"] if r["lastrk"] is not None else ""}</td>'
 f'<td class="l" style="font-size:11px;color:#888">{r["hist"]}</td>'
 f'<td class="sig">{r["sig"]}</td></tr>' for r in rows)}
</tbody></table>
</div>

<!-- ═══════════════ TAB 2: QB STRATEGIES ═══════════════ -->
<div id="qb" class="pane">
<div class="callout">
<b>How to read this.</b> You said every build you draft will carry <b>3 QBs</b> (2 start in
QB1+SF; the 3rd is cheap bench insurance for bye/injury). So every row below carries 3 QBs — the only
open question is which 2 START. For each plan we fix the QBs, then solve <b>exactly</b> (0/1 knapsack
DP, not the old hill-climb which got stuck on tier cliffs) for the best 6 non-QB starters within the
leftover budget. Headline = projected starter points (bench fixed: 1 QB + $1 scrubs, starter-only objective). The 3rd
QB is a $7–13 backup (Stroud/Baker tier under the recency curve) — it adds 0 starter pts here; its value is bye/injury
coverage + trade equity (and cheapening it flips the optimal starter pair — see the bench-QB table below). The full bench-aware optimizer (03_optimize, optionality-weighted bench) puts the net
starter-pts tax at ~0, since the backup's insurance value offsets its cost.<br><br>
<b>The elite-QB caveat (read this before trusting any of these numbers).</b> Gretch projections are
<b>single-point season medians</b> — they undersell elite QBs' <b>week-winning ceilings</b> (the
Allen/Lamar/Hurts/Daniels games that win a matchup outright). So every gap is the cost <i>if everyone
hits their median</i>. The cheap-QB floor carries the opposite risk: these guys are cheap for a reason.
Jones (injury), Rodgers (may retire), Geno (job risk), Ward/Young (rookie variance), Mendoza (likely a
backup) — the medians optimistically assume they all start. The aggro-cheap rows (~$11 of QB) tie the
$76 Daniels+Hurts plan on paper, but that assumes 2 of your 3 punt QBs actually deliver starting
minutes. Bet now on the price (several will rise with preseason clarity); just know the projections are
fragile. The model can't see ceiling or job-security risk — it only prices the median.
</div>

<table class="sum"><thead><tr>
 <th class="l">Strategy</th><th class="l">QB starters</th>
 <th>QB $</th><th>QB pts</th><th>rest pts</th>
 <th>Total starter pts</th><th>Δ vs best</th><th>$ spent</th>
 <th class="l">bench QB</th>
</tr></thead><tbody>
{chr(10).join(summary_rows_html)}
</tbody></table>
<div class="legend">QB pts = the two starting QBs combined. &nbsp;rest pts = best 6 non-QB starters
(RB1/RB2/WR1/WR2/TE/FLEX) fit to the leftover budget. &nbsp;Δ = starter pts behind the best plan.</div>

{_sens_pane}

<h3 style="margin:18px 0 4px;font-size:15px">Full rosters (click to expand)</h3>
{chr(10).join(detail_blocks_html)}

</div>

<!-- ═══════════════ TAB 3: COST CURVES ═══════════════ -->
<div id="curves" class="pane">
{_curves_pane}
</div>

</div>

<script>
/* ── tabs ── */
document.querySelectorAll('.tabbar button').forEach(b=>b.onclick=()=>{{
  document.querySelectorAll('.tabbar button').forEach(x=>x.classList.remove('active'));
  document.querySelectorAll('.pane').forEach(p=>p.classList.remove('active'));
  b.classList.add('active');
  document.getElementById(b.dataset.t).classList.add('active');
}});

/* ── price-review filter + sort (sort by clicked header's column index) ── */
const rows=[...document.querySelectorAll('#t tbody tr')];
let sortIdx=4, sortAsc=false, lastIdx=null;   /* default: Pred $ desc */
function resort(){{
  const tb=document.querySelector('#t tbody');
  rows.sort((a,b)=>{{
    let av=(a.cells[sortIdx]||{{}}).textContent||'', bv=(b.cells[sortIdx]||{{}}).textContent||'';
    let an=parseFloat(av.replace(/[^0-9.-]/g,'')), bn=parseFloat(bv.replace(/[^0-9.-]/g,''));
    let c = (isNaN(an)||isNaN(bn)) ? av.trim().localeCompare(bv.trim()) : an-bn;
    return sortAsc?c:-c;
  }}); rows.forEach(r=>tb.appendChild(r));
}}
document.querySelectorAll('#review th[data-k]').forEach(th=>th.onclick=()=>{{
  const i=th.cellIndex;
  sortAsc = (i===lastIdx) ? !sortAsc : false; lastIdx=i; sortIdx=i; resort(); filter();
}});
function filter(){{
  const f=document.querySelector('#review .bars .active').dataset.f;
  const q=document.getElementById('q').value.toLowerCase();
  rows.forEach(r=>{{ const nm=r.cells[0].textContent.toLowerCase();
    r.classList.toggle('hide', (f!=='ALL'&&r.dataset.pos!==f)||!nm.includes(q)); }}); }}
document.querySelectorAll('#review .bars button').forEach(b=>b.onclick=()=>{{
  document.querySelectorAll('#review .bars button').forEach(x=>x.classList.remove('active'));
  b.classList.add('active'); filter(); }});
document.getElementById('q').oninput=filter;
resort(); filter();
</script></body></html>"""

open(OUT, "w").write(html)
print(f"wrote {OUT} ({len(rows)} players, {len(strategies)} QB strategies)")
