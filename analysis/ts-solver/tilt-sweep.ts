// tilt-sweep.ts — V2 weight sweep (ports analysis/06_robustness.py's idea to
// the TS solver). Measures how often the optimal QB pair AND skill roster
// change as the starter ceiling-tilt moves 0.20 → 0.40. If a single ±0.05 step
// flips the recommended pair, the 0.30 calibration is sharper than the data
// justifies — read the result as a PLATEAU, not "the answer" (the QB tier is
// flat and projections are uncertain, so a few-pts margin is within noise).
//
// QBs are median-only in players.json (no ceiling), so the tilt perturbs ONLY
// the skill knapsack; that skill-pts shift is what can flip the QB-pair
// ranking indirectly via the free-budget term. We track both the QB leader and
// a fingerprint of the 6 skill starters.
//
// Dev harness (run via esbuild), not part of the extension toolchain:
//   npx esbuild analysis/ts-solver/tilt-sweep.ts --bundle --format=esm \
//     --platform=node --outfile=/tmp/tilt-sweep.mjs && node /tmp/tilt-sweep.mjs
import { blendPts, optimizeRoster, type OptPlayer } from "../../src/engine/optimize.js";
import playersRaw from "../out/players.json";

interface RawPlayer {
  name?: string;
  pos?: string;
  cost?: number;
  pts?: number; // the median (assemble.py: median = pts, never moved by tiers)
  ceiling?: number;
  fade?: boolean;
}

const raw = playersRaw as unknown as RawPlayer[];

// Keep median + ceiling so we can re-blend at each tilt. cost is the live price
// (already inflation-adjusted market value in players.json).
interface PoolEntry {
  id: string;
  name: string;
  pos: OptPlayer["pos"];
  cost: number;
  median: number;
  ceiling?: number;
  fade: boolean;
}

const pool: PoolEntry[] = raw
  .filter((p) => p.pos && ["QB", "RB", "WR", "TE"].includes(p.pos) && typeof p.pts === "number")
  .map((p) => ({
    id: p.name ?? "",
    name: p.name ?? "",
    pos: p.pos as OptPlayer["pos"],
    cost: p.cost ?? 0,
    median: p.pts ?? 0,
    ceiling: typeof p.ceiling === "number" ? p.ceiling : undefined,
    fade: p.fade === true,
  }));

const withCeiling = pool.filter((p) => p.ceiling !== undefined).length;

// Blend the pool at a given tilt → OptPlayer[] with pts = blendPts(...). This
// is the exact code path the live optimizer uses; the sweep measures the real
// blend, not a reimplementation.
function blendedPool(tilt: number): OptPlayer[] {
  return pool.map((p) => ({
    id: p.id,
    name: p.name,
    pos: p.pos,
    cost: p.cost,
    pts: blendPts(
      { projMedian: p.median, projCeiling: p.ceiling, fade: p.fade },
      { ceilingTilt: tilt },
    ),
  }));
}

// Sorted skill-starter IDs — a stable fingerprint of the 6 knapsack slots.
function skillFingerprint(res: ReturnType<typeof optimizeRoster>): string {
  const best = res.best;
  if (!best) {
    return "";
  }
  return Object.values(best.skill.slots)
    .map((s) => s?.id ?? "")
    .filter((id) => id !== "")
    .sort()
    .join(",");
}

const TILTS = [0.2, 0.25, 0.3, 0.35, 0.4]; // ±0.05 steps across 0.20–0.40
const BACKUPS = [7, 13]; // the two regimes from optcheck.ts / 06_robustness.py

interface Row {
  tilt: number;
  qbLeader: string;
  skillFp: string;
  totalPts: number;
  margin: number; // leader.totalPts − #2.totalPts (0 if only one pair)
  qbFlip: boolean;
  skillFlip: boolean;
}

function pad(s: string | number, n: number): string {
  return String(s).padEnd(n);
}

console.log(
  `loaded ${pool.length} players (${withCeiling} with ceiling → only skill slots are tilt-sensitive)\n`,
);

for (const backup of BACKUPS) {
  console.log("=".repeat(82));
  console.log(`backup-QB allowance = $${backup}   (budget $200)`);
  console.log("=".repeat(82));
  console.log(
    pad("tilt", 6) +
      pad("QB leader", 30) +
      pad("TOT", 8) +
      pad("margin→#2", 11) +
      "skill roster change",
  );
  console.log("-".repeat(82));

  const rows: Row[] = [];
  let prevQb = "";
  let prevSkill = "";
  for (const tilt of TILTS) {
    const res = optimizeRoster({
      players: blendedPool(tilt),
      budget: 200,
      backupQbAllowance: backup,
      topN: 6,
    });
    const best = res.best;
    const second = res.topPairs[1];
    const qbLeader = best ? best.qbs.map((q) => q.name).join(" + ") : "(none)";
    const skillFp = skillFingerprint(res);
    const totalPts = best?.totalPts ?? 0;
    const margin = best && second ? best.totalPts - second.totalPts : 0;
    const qbFlip = prevQb !== "" && qbLeader !== prevQb;
    const skillFlip = prevSkill !== "" && skillFp !== prevSkill;
    rows.push({ tilt, qbLeader, skillFp, totalPts, margin, qbFlip, skillFlip });
    const flag = qbFlip ? "← QB FLIP" : skillFlip ? "skill change" : "";
    console.log(
      pad(tilt.toFixed(2), 6) +
        pad(qbLeader, 30) +
        pad(totalPts.toFixed(0), 8) +
        pad("+" + margin.toFixed(1), 11) +
        flag,
    );
    prevQb = qbLeader;
    prevSkill = skillFp;
  }

  // Summary
  const distinctQb = new Set(rows.map((r) => r.qbLeader)).size;
  const distinctSkill = new Set(rows.map((r) => r.skillFp)).size;
  const qbFlips = rows.filter((r) => r.qbFlip);
  const skillFlips = rows.filter((r) => r.skillFlip);
  const margins = rows.map((r) => r.margin);
  const minMargin = Math.min(...margins);
  const maxMargin = Math.max(...margins);
  console.log("-".repeat(82));
  console.log(
    `distinct QB leaders: ${distinctQb} | distinct skill rosters: ${distinctSkill} | ` +
      `±0.05 QB flips: ${qbFlips.length} | ±0.05 skill changes: ${skillFlips.length}`,
  );
  console.log(
    `leader margin→#2 across sweep: ${minMargin.toFixed(1)}–${maxMargin.toFixed(1)} pts ` +
      `(QB tier is ~flat; a few pts is within projection noise)`,
  );
  const plateau = distinctQb === 1;
  const knifeEdge = qbFlips.length > 0;
  const verdict = plateau
    ? "→ PLATEAU: QB leader stable across tilt 0.20–0.40 ⇒ 0.30 is NOT sharper than the data."
    : knifeEdge
      ? "→ UNSTABLE: a ±0.05 step flipped the QB leader ⇒ 0.30 is sharper than the data justifies. Treat the pick as a plateau, not an answer."
      : "→ DRIFT (no knife-edge): the leader moves across the sweep but no single ±0.05 step flips it.";
  console.log(verdict);
  console.log();
}
