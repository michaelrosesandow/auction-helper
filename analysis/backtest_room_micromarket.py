"""Room micromarket — this league's DISTINCTIVE drafting errors (and edges),
measured as deviations from the consensus market (FantasyPros ADP).

THE QUESTION (from the V4 room-micromarket digression):
    backtest_gretch_signal.py showed the room-based "market higher than Gretch"
    busts (P50 0.86) but the INDEPENDENT ADP market doesn't show that (P50 0.96).
    The gap IS the signal: where does THIS 12-team room deviate from the broad
    market, and do those deviations win or lose? That is directly exploitable
    league-specific intel (every August, re-run against the new season).

WHAT IT FINDS (5-year, 2021-2025, FantasyPros ADP as the independent market):
    The room is roughly fair-value overall (P50 ~1.00 every year) but has ONE
    distinctive, stable error: the **lone-wolf reach** -- the room drafts a guy
    EARLIER than BOTH the consensus market AND Gretch. Those underperform their
    slot (pooled P50 ~0.86, holds all 5 years). When the room reaches but Gretch
    ENDORSES it, those are winners (~1.05). So the marker is "room > market AND
    room > Gretch," NOT a veteran/position thing: recent lone-wolf busts are
    injury-return RBs, aging WRs, and hyped-rookie underperformers (2025: Conner,
    Kaleb Johnson, Godwin, Tank Bigsby, Chubb, Love).

    NOTE: this is room-vs-consensus. The "Gretch-endorsed reach wins" half
    converges with backtest_role_weighting's youth/ceiling finding -- the room's
    edge is spotting young breakouts Gretch also likes.

DATA:
    - consensus ADP: ~/Downloads/Avant League History - Historical ADP - Fantasy
      Pros (2).csv  (column `Avg`; the proper independent-market source, covers
      2021-2026 incl. 2025 which is blank in the league history).
    - room purchase order (prank): league history Position Rank (via the
      backtest_gretch_signal loader).
    - Gretch rank: saved tier articles (2021 via extract_2021, no target/fade).
    - realized: nflverse half-PPR (2025 aggregated from weekly).
    Ratio is on the ROOM's own slot (expected-at-prank, LOO rank-bin median) so
    "P50<1" means the pick failed to return value for what was paid.

Run:  python3 analysis/backtest_room_micromarket.py
"""
from __future__ import annotations
import os, statistics as st
from collections import Counter

HERE = os.path.dirname(__file__)
YEARS = [2021, 2022, 2023, 2024, 2025]
POS = ["QB", "RB", "WR", "TE"]

# reuse the gretch-signal + role-weighting loaders (no duplication)
import importlib.util
def _load(mod, path):
    s = importlib.util.spec_from_file_location(mod, path)
    m = importlib.util.module_from_spec(s); s.loader.exec_module(m); return m
_gs = _load("gs", os.path.join(HERE, "backtest_gretch_signal.py"))
_brw = _load("brw", os.path.join(HERE, "backtest_role_weighting.py"))
norm = _gs.norm
pctl = _brw.pctl

# consensus within-position ADP rank lives in the shared helper now
# (_gs.load_adp_posrank, sourced from the FantasyPros file).

def build():
    recs = _gs.extract_all()
    realized = _gs.load_realized()
    league = _gs.load_league()
    recs = _gs.join_all(recs, realized, league)   # join_all sets adp_posrank via load_adp_posrank
    players = _brw.load_players()
    for r in recs:
        g = realized.get(r["year"], {}).get(r["nname"], (None, None))[0]
        rs = players.get(g, {}).get("rookie") if g else None
        try: r["yrs"] = r["year"] - int(rs) if rs and rs.isdigit() else None
        except ValueError: r["yrs"] = None
    sub = [r for r in recs if r["drafted"] and r["matched_realized"] and r["rrank"] is not None
           and r["prank"] is not None and r.get("adp_posrank") is not None]
    for r in sub:
        r["room_reach"] = r["adp_posrank"] - r["prank"]   # + = room drafted earlier than market
        r["div_room"] = r["prank"] - r["gretchr"]         # + = room got him cheaper than Gretch
    rows = [dict(pos=r["pos"], prank=r["prank"], year=r["year"], pts=r["pts"]) for r in sub]
    loo = _brw.expected_curves(rows)
    for r in sub:
        e = loo.get((r["pos"], r["prank"], r["year"]), 0)
        r["ratio"] = r["pts"] / e if e > 0 else None
    return sub

def _exp(y): return ("rook/2nd" if y is not None and y <= 1
                     else "young2-3" if y is not None and y <= 3
                     else "vet4+" if y is not None else "unk")

def by_year(sub):
    out = ["\nLONE-WOLF vs GRETCH-ENDORSED reaches, BY YEAR",
           "  room REACH = adp_posrank - prank >= +3  (room drafted earlier than consensus)",
           "  endorsed = div_room >= -5 (Gretch ~ or ranks him earlier); "
           "lone-wolf = div_room <= -5 (room above Gretch too)",
           "  ratio = actual / expected-at-ROOM-slot (P50<1 = failed to pay off)\n",
           f"  {'year':>6} | {'endorsed':>18} | {'lone-wolf':>18} | spread",
           f"  {'':>6} | {'n P50 top12%':>18} | {'n P50 top12%':>18} |"]
    for y in YEARS:
        we = [r for r in sub if r["year"] == y and r["room_reach"] >= 3 and r["div_room"] >= -5 and r["ratio"] is not None]
        lw = [r for r in sub if r["year"] == y and r["room_reach"] >= 3 and r["div_room"] <= -5 and r["ratio"] is not None]
        pe, pl = pctl(sorted(r["ratio"] for r in we), 50), pctl(sorted(r["ratio"] for r in lw), 50)
        te = 100 * sum(1 for r in we if r["rrank"] <= 12) / len(we) if we else 0
        tl = 100 * sum(1 for r in lw if r["rrank"] <= 12) / len(lw) if lw else 0
        out.append(f"  {y:>6} | {len(we):>2} {pe:>4.2f} {te:>4.0f}%{'':>5} | "
                   f"{len(lw):>2} {pl:>4.2f} {tl:>4.0f}%{'':>5} | {pe-pl:+.2f}")
    return "\n".join(out)

def pooled(sub):
    def cell(rr, dr):
        b = [r for r in sub if rr(r["room_reach"]) and dr(r["div_room"]) and r["ratio"] is not None]
        if not b: return None
        return (pctl(sorted(r["ratio"] for r in b), 50),
                100 * sum(1 for r in b if r["rrank"] <= 12) / len(b), len(b))
    out = ["\nPOOLED 2x2 (P50 ratio / top12% / n) -- where do the room's errors live?",
           "  rows = room-vs-Gretch; cols = room-vs-consensus-ADP\n",
           "                   | reach>ADP  |  ~ADP     | disc<ADP"]
    for nm, dfn in [("room ABOVE Gretch", lambda d: d <= -5),
                    ("~Gretch", lambda d: -5 < d < 5),
                    ("room BELOW Gretch", lambda d: d >= 5)]:
        # cell(rr=room_reach filter, dr=div_room filter); cols are the reach/ADP cut
        cells = [cell(g, dfn) for g in
                 (lambda d: d >= 3, lambda d: -2 <= d <= 2, lambda d: d <= -3)]
        row = "  ".join(f"{c[0]:.2f}/{c[2]:>3}" if c else "   -    " for c in cells)
        out.append(f"  {nm:18}| {row}")
    return "\n".join(out)

def characterize(sub):
    lw = [r for r in sub if r["room_reach"] >= 3 and r["div_room"] <= -5]
    we = [r for r in sub if r["room_reach"] >= 3 and r["div_room"] >= -5]
    def mix(b, fn, order):
        c = Counter(fn(r) for r in b); t = len(b) or 1
        return "  ".join(f"{k}:{100*c[k]/t:.0f}%" for k in order)
    out = ["\nCHARACTERIZE the lone-wolf cell (room > ADP AND room > Gretch):",
           f"  exp [{mix(lw, lambda r: _exp(r['yrs']), ['rook/2nd','young2-3','vet4+','unk'])}]"
           f"  | pos [{mix(lw, lambda r: r['pos'], POS)}]  (n={len(lw)})",
           f"  vs the room's WINNING reaches (Gretch-endorsed):",
           f"  exp [{mix(we, lambda r: _exp(r['yrs']), ['rook/2nd','young2-3','vet4+','unk'])}]"
           f"  | pos [{mix(we, lambda r: r['pos'], POS)}]  (n={len(we)})",
           "\n  (winning reaches skew YOUNG; lone-wolf is risk-laden names, not veteran-specific)"]
    return "\n".join(out)

def run():
    print("ROOM MICROMARKET BACKTEST  years", "-".join(map(str, YEARS)),
          "| independent market = FantasyPros ADP\n")
    sub = build()
    print(f"room-drafted w/ consensus ADP + realized: {len(sub)} players\n")
    print(by_year(sub))
    print(pooled(sub))
    print(characterize(sub))
    print("\nEXPLOIT: discount bids on room > (ADP AND Gretch) -- the lone-wolf "
          "reach (injury-return / aging / hyped-rookie names).")
    print("Pay up for room reaches that Gretch ENDORSES (young breakouts) -- "
          "those win ~1.05 / 35-40% stud rate.")

if __name__ == "__main__":
    run()
