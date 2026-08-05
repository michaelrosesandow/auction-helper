"""rubric.py - the single calibration source for projection bands.

Each profile maps Gretch's own language to a (floor_frac, ceil_frac) pair,
applied as a MULTIPLE of the median projection:

    floor   = pts * floor_frac
    ceiling = pts * ceil_frac

The median is NEVER moved by tiers (it stays the stat projection from
build_2026.py); the profile only shapes the band around it. This preserves the
Hampton signal: stat median stays low, tagged upside-swing, engine sees
low-median + high-ceiling (the divergence IS the signal -- a fudged-high median
would lose it).

Fractions are defensible starting points, not measured. The calibration path is
to reconstruct draft-time-median vs final-season points from the historical
ADP/projection data (2021-25) and measure the actual P10/P50/P90 spread by
draft tier; attrition_study.py already pulls nflverse data so the plumbing
exists. Retune PROFILES here, re-run assemble.py, every band updates.

| Profile           | floor x med | ceil x med | shape                 |
|-------------------|-------------|------------|-----------------------|
| compressed-elite  | 0.92        | 1.18       | tight band, shifted up|
| clean-symmetric   | 0.88        | 1.12       | tight, balanced       |
| veteran-floor     | 0.90        | 1.05       | high floor, low ceil  |
| efficiency-fade   | 0.78        | 1.10       | fat left tail         |
| upside-swing      | 0.85        | 1.35       | fat right tail        |
| boom-bust         | 0.65        | 1.50       | wide, bimodal         |
"""
from __future__ import annotations

# profile -> (floor_frac, ceil_frac) as a multiple of median + a shape label.
PROFILES: dict[str, dict[str, float | str]] = {
    # tight band, shifted up -- the elite, "floor is top-5" guys (Gibbs, Bijan)
    "compressed-elite": {"floor": 0.92, "ceiling": 1.18, "shape": "tight, shifted up"},
    # tight, balanced -- median is trustworthy (Chase Brown)
    "clean-symmetric": {"floor": 0.88, "ceiling": 1.12, "shape": "tight, balanced"},
    # high floor, low ceiling -- "take the early points" (Dobbins, Rachaad White,
    # Jordan Mason)
    "veteran-floor": {"floor": 0.90, "ceiling": 1.05, "shape": "high floor, low ceil"},
    # fat left tail -- overly dependent on rushing efficiency / receiving upside
    # (Barkley, Henry, Achane, Cook)
    "efficiency-fade": {"floor": 0.78, "ceiling": 1.10, "shape": "fat left tail"},
    # fat right tail -- the reason you draft them (Tuten, Walker, Hampton,
    # Jeanty, Skattebo, Judkins, Henderson, Love)
    "upside-swing": {"floor": 0.85, "ceiling": 1.35, "shape": "fat right tail"},
    # wide, bimodal -- the median itself is low-confidence (Brooks: "generational
    # bet or huge mistake")
    "boom-bust": {"floor": 0.65, "ceiling": 1.50, "shape": "wide, bimodal"},
}

# Fallback when a listed player is missing a profile (assemble warns). The
# neutral choice -- trusts the median, symmetric thin band.
DEFAULT_PROFILE = "clean-symmetric"


def fractions(profile: str) -> tuple[float, float]:
    """Return (floor_frac, ceil_frac) for a profile. Raises KeyError if unknown."""
    p = PROFILES[profile]
    return float(p["floor"]), float(p["ceiling"])


def is_known(profile: str) -> bool:
    return profile in PROFILES


if __name__ == "__main__":
    for name, p in PROFILES.items():
        lo, hi = float(p["floor"]), float(p["ceiling"])
        print(f"{name:18} floor x{lo:.2f}  ceil x{hi:.2f}  "
              f"width {hi - lo:.2f}  skew {(hi - 1) - (1 - lo):+.2f}  {p['shape']}")
