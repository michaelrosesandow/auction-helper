"""assemble.py - build the canonical player table from base data + tier assessment.

Single join:
    out/players.json   (base: name, pos, rank, cost, pts -- from build_2026.py)
  + data/tiers/*.yml   (tier assessment: tier, subtier, profile, target, fade,
                        big_break_after, dead_zone, note)
  + rubric.py          (profile -> floor/ceiling fractions)
  => out/players.json  (canonical; all Player fields populated)
  +  out/players.csv   (the ONE artifact the extension imports via rankings.ts)

The median is NEVER moved by tiers: floor = pts*floor_frac, ceiling =
pts*ceil_frac, median = pts. A player with no profile (not in any YAML, or
pts=None) stays median-only with a fallback COARSE tier so deep players do not
pollute the extension's cliff logic (which keys on the integer `tier`).

Replaces apply_overrides.py:
  - the rank-gap `ceiling = up/down` heuristic  ->  `profile` (real band shape)
  - `my_price` (cost override)                  ->  analysis/scenarios.csv
    (a what-if lever applied at the optimizer, not baked into the canonical table)

Idempotent: enriched fields are stripped and recomputed from base + YAML every
run, so re-running (or running after build_2026 regenerates the base) is safe.

  python3 assemble.py
"""
from __future__ import annotations
import csv, json, os, re, statistics
from collections import defaultdict

import rubric
from yamlmini import parse as parse_yaml

HERE = os.path.dirname(os.path.abspath(__file__))
PLAYERS = os.path.join(HERE, "out", "players.json")
TIERS_DIR = os.path.join(HERE, "data", "tiers")
OUT_JSON = PLAYERS
OUT_CSV = os.path.join(HERE, "out", "players.csv")

# Fields this script owns. Stripped first so re-runs are idempotent.
ENRICHED = ("tier", "subtier", "profile", "target", "fade", "note",
            "big_break_after", "dead_zone", "floor", "ceiling")
# Fields from the retired apply_overrides.py (rank-gap ceiling heuristic, my_rank,
# my_price/model_cost, my_note). Stripped so the canonical table is clean even if
# the old pipeline had been run. `ceiling` (the old "up"/"down" string) is in
# ENRICHED and recomputed as a real number here.
RETIRED = ("proj_rank", "my_rank", "my_price", "model_cost", "my_note")

# CSV schema == data/rankings.example.csv (what the extension's rankings.ts
# expects). Team/Bye are blank (not in the base table; thread through
# build_2026 later if needed).
CSV_COLS = ["Player Name", "Position", "Team", "Bye", "Tier", "Subtier",
            "BigBreak", "DeadZone", "Market Value", "Floor", "Median",
            "Ceiling", "Target", "Fade", "Notes"]


def norm(name):
    """Name normalizer (identical to build_2026/apply_overrides)."""
    s = re.sub(r"[.'’]", "", name.lower())
    toks = [t for t in s.split() if t not in ("jr", "sr", "ii", "iii", "iv", "v", "i")]
    return " ".join(toks).strip()


def fallback_tier(prank):
    """Coarse rank-cohort tier for players NOT in any tier YAML (unauthored
    positions + deep $1 fliers). Keeps the top cohort at tier 1 (correct for
    unauthored positions) and pushes unranked players to 99 so they never
    become the 'top remaining tier' in cliff logic. Overridden per-position by
    authoring data/tiers/{pos}.yml."""
    if not prank or prank >= 999:
        return 99
    return min(15, (prank - 1) // 8 + 1)


def load_tier_assessments():
    """Load data/tiers/*.yml -> {(norm(name), pos): rec, ...}.

    rec: tier, subtier, profile, target, fade, note, big_break_after, dead_zone
    (tier-level flags are propagated onto each player in that tier). Returns
    (lookup, warnings)."""
    lookup = {}
    warnings = []
    if not os.path.isdir(TIERS_DIR):
        return lookup, ["no data/tiers/ directory; all players median-only"]
    for fn in sorted(os.listdir(TIERS_DIR)):
        if not fn.endswith((".yml", ".yaml")):
            continue
        path = os.path.join(TIERS_DIR, fn)
        doc = parse_yaml(open(path).read())
        pos = doc.get("position")
        if not pos:
            warnings.append(f"{fn}: no 'position' key; skipped")
            continue
        for t in doc.get("tiers", []):
            big = bool(t.get("big_break_after"))
            dead = bool(t.get("dead_zone"))
            sub = t.get("subtier")
            for pl in t.get("players", []):
                nm = pl.get("name")
                if not nm:
                    warnings.append(f"{fn}: unnamed player in tier {t.get('tier')}; skipped")
                    continue
                key = (norm(nm), pos)
                if key in lookup:
                    warnings.append(f"{fn}: {nm} ({pos}) listed more than once; keeping first")
                    continue
                prof = pl.get("profile")
                if prof and not rubric.is_known(prof):
                    warnings.append(f"{fn}: {nm} unknown profile '{prof}'; "
                                    f"using {rubric.DEFAULT_PROFILE}")
                    prof = rubric.DEFAULT_PROFILE
                lookup[key] = dict(
                    tier=int(t.get("tier")),
                    subtier=int(sub) if sub is not None else None,
                    profile=prof,
                    target=bool(pl.get("target")),
                    fade=bool(pl.get("fade")),
                    note=pl.get("note") or "",
                    big_break_after=big,
                    dead_zone=dead,
                )
    return lookup, warnings


def _round(x):
    return round(x, 1) if x is not None else None


def enrich(players, tiers):
    matched = 0
    by_profile = defaultdict(list)  # profile -> [(name, floor, ceiling, pts)]
    for p in players:
        for k in ENRICHED + RETIRED:   # idempotent + drop retired apply_overrides fields
            p.pop(k, None)
        rec = tiers.get((norm(p["name"]), p["pos"]))
        pts = p.get("pts")
        if not rec:
            p["tier"] = fallback_tier(p.get("prank"))
            continue
        matched += 1
        p["tier"] = rec["tier"]
        if rec["subtier"] is not None:
            p["subtier"] = rec["subtier"]
        prof = rec["profile"]
        if prof:
            p["profile"] = prof
            if pts is not None:
                lo, hi = rubric.fractions(prof)
                p["floor"] = _round(pts * lo)
                p["ceiling"] = _round(pts * hi)
                by_profile[prof].append((p["name"], p["floor"], p["ceiling"], pts))
        if rec["target"]:
            p["target"] = True
        if rec["fade"]:
            p["fade"] = True
        if rec["note"]:
            p["note"] = rec["note"]
        if rec["big_break_after"]:
            p["big_break_after"] = True
        if rec["dead_zone"]:
            p["dead_zone"] = True
    return matched, by_profile


def write_csv(players):
    with open(OUT_CSV, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(CSV_COLS)
        for p in players:
            pts = p.get("pts")
            w.writerow([
                p["name"], p["pos"], "", "",
                p.get("tier", ""), p.get("subtier", ""),
                "1" if p.get("big_break_after") else "",
                "1" if p.get("dead_zone") else "",
                p.get("cost", ""),
                p.get("floor", ""), pts if pts is not None else "", p.get("ceiling", ""),
                "1" if p.get("target") else "",
                "1" if p.get("fade") else "",
                p.get("note", ""),
            ])


def _find(players, name, pos):
    target = norm(name)
    for p in players:
        if p["pos"] == pos and norm(p["name"]) == target:
            return p
    return None


def spot_checks(players):
    """The TODO T2 acceptance spot-checks, printed for manual confirmation."""
    print("\n── spot checks (TODO T2 acceptance) ──────────────────────────────")
    for name in ("Omarion Hampton", "Jahmyr Gibbs", "Saquon Barkley", "Jonathon Brooks", "Chase Brown"):
        p = _find(players, name, "RB")
        if p:
            pts = p.get("pts")
            print(f"  {name:18} pts={pts}  floor={p.get('floor')}  ceil={p.get('ceiling')}  "
                  f"profile={p.get('profile')}  fade={p.get('fade', False)}  tier={p.get('tier')}")
            if name == "Omarion Hampton" and pts and p.get("ceiling"):
                print(f"      Hampton ceiling/median = {p['ceiling']/pts:.2f}  (want ≫ 1.0)")
            if name == "Jahmyr Gibbs" and pts and p.get("floor"):
                print(f"      Gibbs   floor/median   = {p['floor']/pts:.2f}  (want ≈ 1.0)")
            if name == "Saquon Barkley" and pts and p.get("floor"):
                print(f"      Barkley floor/median   = {p['floor']/pts:.2f}  (want < 1.0)")
    brooks = _find(players, "Jonathon Brooks", "RB")
    brown = _find(players, "Chase Brown", "RB")
    if brooks and brown and brooks.get("ceiling") and brown.get("ceiling"):
        bw_b = brooks["ceiling"] - brooks["floor"]
        bw_c = brown["ceiling"] - brown["floor"]
        print(f"  band width  Brooks={bw_b:.0f}  Chase Brown={bw_c:.0f}  "
              f"(Brooks wider: {bw_b > bw_c})")
    rbs = sorted([p for p in players if p["pos"] == "RB" and p.get("ceiling")],
                 key=lambda p: -p["ceiling"])
    print("  top-8 RB by CEILING (upside-swing names should float up):")
    for p in rbs[:8]:
        print(f"     {p['name']:20} ceil={p['ceiling']:.0f}  profile={p.get('profile')}")


def profile_audit(by_profile):
    """Avg ceil/floor ratio per profile must equal the rubric's hi/lo (same
    fraction applied to every player) -- catches transcription drift."""
    print("\n── profile audit (avg ceil/floor vs rubric) ──────────────────────")
    for prof, rows in sorted(by_profile.items()):
        if not rows:
            continue
        ratios = [ce / (fl or 1) for _, fl, ce, _ in rows]
        lo, hi = rubric.fractions(prof)
        mean_ratio = statistics.mean(ratios)
        print(f"  {prof:18} n={len(rows):2}  avg ceil/floor={mean_ratio:.3f}  "
              f"(rubric {hi/lo:.3f})  "
              f"{'OK' if abs(mean_ratio - hi / lo) < 0.01 else 'DRIFT'}")


def main():
    players = json.load(open(PLAYERS))
    tiers, tw = load_tier_assessments()
    matched, by_profile = enrich(players, tiers)

    json.dump(players, open(OUT_JSON, "w"), indent=2)
    write_csv(players)

    print(f"matched {matched}/{len(players)} players to data/tiers/*.yml")
    if tw:
        print("\ntier YAML warnings:")
        for w in tw:
            print("  " + w)
    player_keys = {(norm(p["name"]), p["pos"]) for p in players}
    unmatched = [k for k in tiers if k not in player_keys]
    if unmatched:
        print(f"\n!! {len(unmatched)} YAML entries matched no player (name mismatch?):")
        for nm, pos in unmatched:
            print(f"  {nm} ({pos})")

    spot_checks(players)
    profile_audit(by_profile)
    print(f"\nwrote {OUT_JSON}")
    print(f"wrote {OUT_CSV}")


if __name__ == "__main__":
    main()
