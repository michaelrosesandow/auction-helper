"""Loaders + league config for auction analysis. Pure stdlib."""
from __future__ import annotations
import csv, re, xml.etree.ElementTree as ET, os
from dataclasses import dataclass, field
from collections import defaultdict

HOME = os.path.expanduser("~")
PRICE_CSV = f"{HOME}/Downloads/Avant League History - Data.csv"
PROJ_XLSX = f"{HOME}/Downloads/Ben Gretch 2026 Projections (7_23).xlsx"
NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"

# ── League config ───────────────────────────────────────────────────────────
# Scoring knobs (set from the user's actual league settings). These are the
# defaults; override via LeagueConfig.
@dataclass
class LeagueConfig:
    n_teams: int = 12
    budget: int = 200
    # starters (15-man roster)
    starters: dict = field(default_factory=lambda: dict(QB=1, RB=2, WR=2, TE=1, FLEX=1, SF=1, K=1, DST=1))
    bench: int = 5
    # scoring
    pass_td: float = 4.0       # Avant: 4
    pass_yd: float = 1/25      # 25 yd/pt
    int_pt: float = -1.0       # Avant: -1 per INT
    rush_yd: float = 1/10
    rush_td: float = 6.0
    rec_yd: float = 1/10
    rec_td: float = 6.0
    rec_pt: float = 0.5        # Avant: half PPR
    te_rec_pt: float | None = None  # None = no TE premium


def points(pos, paYds=0, paTD=0, INT=0, ruYds=0, ruTD=0, rec=0, reYds=0, reTD=0,
           cfg: LeagueConfig = LeagueConfig()):
    """Fantasy points from raw stats. TE premium handled by position."""
    p = (paYds*cfg.pass_yd + paTD*cfg.pass_td + INT*cfg.int_pt
         + ruYds*cfg.rush_yd + ruTD*cfg.rush_td
         + reYds*cfg.rec_yd + reTD*cfg.rec_td
         + rec*cfg.rec_pt)
    if pos == "TE" and cfg.te_rec_pt is not None:
        p += rec * (cfg.te_rec_pt - cfg.rec_pt)  # add premium delta
    return p


# ── Price history ────────────────────────────────────────────────────────────
def load_prices(path=PRICE_CSV):
    """One dict per sold player: year, pos, prank, sal, name."""
    rows = []
    with open(path) as fh:
        r = csv.reader(fh); next(r)
        for line in r:
            g = [c.strip() for c in line]
            if len(g) < 9: continue
            if not g[4].isdigit(): continue          # drop junk rows
            try:
                sal = int(g[2].replace("$", "")); prank = int(g[8])
            except ValueError:
                continue
            rows.append(dict(year=int(g[4]), pos=g[6], prank=prank, sal=sal, name=g[9]))
    return rows


# ── Projections xlsx (parse as zip-of-xml, no deps) ──────────────────────────
def _colnum(ref):
    m = re.match(r"([A-Z]+)", ref); n = 0
    for c in m.group(1): n = n*26 + (ord(c)-64)
    return n

def _load_sst(path):
    root = ET.parse(path).getroot(); out = []
    for si in root.findall(f"{NS}si"):
        out.append("".join(t.text or "" for t in si.iter(f"{NS}t")))
    return out

def _parse_sheet(path, sst):
    root = ET.parse(path).getroot(); rows = {}
    for row in root.iter(f"{NS}row"):
        cells = {}
        for c in row.findall(f"{NS}c"):
            v = c.find(f"{NS}v"); isf = c.find(f"{NS}is"); t = c.get("t")
            if t == "s" and v is not None: val = sst[int(v.text)]
            elif t == "inlineStr" and isf is not None:
                val = "".join(x.text or "" for x in isf.iter(f"{NS}t"))
            elif v is not None: val = v.text
            else: val = None
            cells[_colnum(c.get("r"))] = val
        rows[int(row.get("r"))] = cells
    return rows

# (sheet file, name) for the 4 projection tabs
_SHEETS = [("sheet1", "QB"), ("sheet2", "RB"), ("sheet3", "WR"), ("sheet4", "TE")]

def load_projections(path=PROJ_XLSX):
    """Extract a dir first, then read. Returns list of player dicts with raw stats."""
    import zipfile, tempfile, shutil
    tmp = tempfile.mkdtemp(prefix="xlsx_")
    with zipfile.ZipFile(path) as z: z.extractall(tmp)
    sst = _load_sst(f"{tmp}/xl/sharedStrings.xml")
    out = []
    for sh, pos in _SHEETS:
        rows = _parse_sheet(f"{tmp}/xl/worksheets/{sh}.xml", sst)
        header = {v: k for k, v in rows.get(1, {}).items()}  # colname -> colidx
        for r in range(2, max(rows)+1):
            c = rows.get(r, {})
            name = c.get(header.get("Player", 1))
            if not name or not name.strip(): continue
            def num(col):
                x = c.get(header.get(col))
                try: return float(x)
                except (TypeError, ValueError): return 0.0
            rec = dict(name=name.strip(), pos=pos, team=(c.get(header.get("Team",2)) or "").strip())
            for col in ["Dropbacks","PaAtt","Comp","PaYds","PaTD","INT","RuAtt","RuYds","RuTD",
                        "Targets","Rec","ReYds","ReTD"]:
                if col in header: rec[col.lower()] = num(col)
            out.append(rec)
    shutil.rmtree(tmp)
    return out


if __name__ == "__main__":
    p = load_prices(); print(f"prices: {len(p)} rows, years {min(x['year'] for x in p)}-{max(x['year'] for x in p)}")
    pr = load_projections(); 
    from collections import Counter
    print(f"projections: {len(pr)} players", dict(Counter(x['pos'] for x in pr)))
    # spot check points
    josh = [x for x in pr if x['name']=="Josh Allen" and x['pos']=="QB"][0]
    print("Allen pts (4pt pass td):", round(points("QB", josh.get('payds',0), josh.get('patd',0),
        josh.get('int',0), josh.get('ruyds',0), josh.get('rutd',0)), 1), "(sheet 4pt col=360.8)")
