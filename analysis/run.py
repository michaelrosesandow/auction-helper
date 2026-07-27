"""run.py - one-command refresh of the whole 2026 analysis.

Full run (ADP or projections changed in ~/Downloads):
    python3 run.py

Rankings-only (you just edited my_rankings.csv):
    python3 run.py --skip-build

Pipeline:
  build_2026.py        cost (rank->SF price) + value  -> out/players.json
  apply_overrides.py   merge my_rankings.csv          -> out/players.json (+ signals)
  03_optimize.py       par-sheet optimizer            -> out/par_sheet.json
  04_qb_strategies.py  QB roster-construction compare -> out/qb_strategies.json
  generate_review_html.py                             -> review.html

To refresh ADP in August: paste updated FantasyPros position ranks into the 2026
rows of ~/Downloads/"Avant League History - Historical ADP - Fantasy Pros (2).csv"
(and/or a newer Gretch xlsx), then `python3 run.py`.
"""
import subprocess, sys, os

HERE = os.path.dirname(os.path.abspath(__file__))


def step(cmd):
    print(f"\n=== {cmd} ===")
    r = subprocess.run(cmd, shell=True, cwd=HERE)
    if r.returncode != 0:
        print(f"!! {cmd} failed (exit {r.returncode})")
        sys.exit(r.returncode)


def main():
    skip_build = "--skip-build" in sys.argv
    if not skip_build:
        step("python3 build_2026.py")
    step("python3 apply_overrides.py")
    step("python3 03_optimize.py")
    step("python3 04_qb_strategies.py")
    step("python3 generate_review_html.py")
    print("\n✓ done. open review.html")


if __name__ == "__main__":
    main()
