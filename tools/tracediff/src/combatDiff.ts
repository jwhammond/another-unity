// SPDX-License-Identifier: GPL-3.0-or-later
import type { combatSim } from '@another-unity/engine';

type CombatEvent = combatSim.CombatEvent;

/** What a battle's comparison found: the first difference (the earliest step), every difference, and the allowances used. */
export interface CombatDiff {
  clean: boolean;
  /** The earliest difference, as "step N: what", or null when clean. */
  first: string | null;
  differences: { step: number; what: string }[];
  /** ScummVM's atan2f angles the port took (`libm-atan2f`), by call site. */
  atan2: Record<string, number>;
  /** ScummVM's atan2f angles the port never asked for: a presentation call (the camera, the stars) or past a difference. */
  atan2Unused: Record<string, number>;
  counts: { rolls: number; snaps: number; steps: number };
  /**
   * What makes the comparison doubtful, though no difference: an atan2f ScummVM logged at a simulation site (before
   * the first difference) that the port never asked for, and the first non-finite float in ScummVM's snapshots.
   */
  problems: string[];
}

/**
 * The export's atan2f call sites the port's replay makes (angleFromSinCos's callers, in the export's lines: Plan 22 R11):
 * fly (combat.cpp:650-653), steering (ai.cpp:57-58, 72), aim (weapons.cpp:83-84), the shield (damage.cpp:440-441), and
 * since M8 the camera seam's (lookAt, combat.cpp:808-809; the target view, 923-924). Its other calls are the stars'
 * drift (combat.cpp:958-963), once a drawn frame, which the replay doesn't make.
 */
export const ATAN2_SIM_SITES: ReadonlySet<string> = new Set([
  'combat.cpp:650', 'combat.cpp:651', 'combat.cpp:653', 'ai.cpp:57', 'ai.cpp:58', 'ai.cpp:72',
  'weapons.cpp:83', 'weapons.cpp:84', 'damage.cpp:440', 'damage.cpp:441',
  'combat.cpp:808', 'combat.cpp:809', 'combat.cpp:923', 'combat.cpp:924',
]);

/** The keys whose numbers are floats (float32 values): ScummVM prints nine digits, which Math.fround reads back exactly. */
const FLOATS = new Set(['pos', 'velocity', 'speed', 'axes']);

/**
 * A float as the export's JsonWriter::numFloat writes it (jsonwriter.cpp:72-79): `%.9g` of the float32 value, and
 * NaN or an infinity (or a double past the largest float) as null; -0 is written "-0", which JSON.parse reads back as
 * -0. (On an exact tie at the tenth digit, toExponential rounds up where printf rounds to even: either reads back to
 * the same float32, as nine digits always do.)
 */
export function float32Json(x: number): string {
  const f = Math.fround(x);
  if (!Number.isFinite(f)) return 'null';
  if (f === 0) return Object.is(f, -0) ? '-0' : '0';
  const [m, e] = f.toExponential(8).split('e') as [string, string];
  const exp = Number(e);
  const strip = (t: string) => (t.includes('.') ? t.replace(/\.?0+$/, '') : t);
  if (exp < -4 || exp >= 9) return `${strip(m)}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
  return strip(f.toFixed(8 - exp));
}

/** A value as JSON, its floats (under FLOATS' keys) as the export writes them, everything else as JSON.stringify does. */
function writeJson(v: unknown, float: boolean): string {
  if (typeof v === 'number' && float) return float32Json(v);
  if (Array.isArray(v)) return `[${v.map(x => writeJson(x, float)).join(',')}]`;
  if (v && typeof v === 'object') {
    // (an atan2 event's inputs are floats too: combattrace.cpp:192-194)
    const atan2 = (v as { ev?: unknown }).ev === 'atan2';
    return `{${Object.entries(v).filter(([, x]) => x !== undefined)
      .map(([k, x]) => `${JSON.stringify(k)}:${writeJson(x, float || FLOATS.has(k) || (atan2 && (k === 's' || k === 'c')))}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/**
 * One of the port's combat events as a trace line, written as ScummVM's trace writes it (floats `%.9g`, non-finite
 * null, -0 kept). Every writer of the port's events that are read back for a diff must use this: JSON.stringify
 * writes -0 as 0, which the diff would then find apart from ScummVM's -0.
 */
export function traceLine(e: CombatEvent): string {
  return writeJson(e, false);
}

/** A float as the export's trace reads back: the float32 value, or null for one it writes null. */
const asTraced = (x: unknown): unknown => (typeof x === 'number' ? (Number.isFinite(Math.fround(x)) ? Math.fround(x) : null) : x);

function sameValue(a: unknown, b: unknown, float: boolean): boolean {
  // (floats as the trace has them: float32 values, -0 apart from 0 as "%.9g" writes it, non-finite as null)
  if (float) return Object.is(asTraced(a), asTraced(b));
  return a === b;
}

/** Where two values differ, as paths ("ships[2].pos[1]: 3000.5 vs 3000.25"), at most `limit`. */
function compareValues(a: unknown, b: unknown, path: string, float: boolean, out: string[], limit = 8): void {
  if (out.length >= limit) return;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      out.push(`${path}: ${a.length} entries vs ${b.length}`);
      return;
    }
    a.forEach((v, i) => compareValues(v, b[i], `${path}[${i}]`, float, out, limit));
    return;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      compareValues((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k, float || FLOATS.has(k), out, limit);
    }
    return;
  }
  if (!sameValue(a, b, float)) out.push(`${path}: ${writeJson(a, float)} (ScummVM) vs ${writeJson(b, float)} (port)`);
}

const ORDERED = new Set(['hails', 'hailsEnd', 'standDown', 'leave', 'warp', 'input', 'combatEnd']);
/** An ordered event as compared: a stand-down's site is the export's line in ScummVM's trace (its hooks move tactical.cpp's lines), so only its step is. */
function orderedKey(e: CombatEvent): string {
  switch (e.ev) {
    case 'standDown': return `standDown@${e.step}`;
    case 'hails': return `hails@${e.step} type ${e.type}`;
    case 'hailsEnd': return `hailsEnd@${e.step}`;
    case 'leave': return `leave@${e.step} code ${e.code}`;
    case 'warp': return `warp@${e.step} wait ${e.wait}`;
    case 'input': return `input@${e.step} ${e.line}`;
    case 'combatEnd': return `combatEnd@${e.step} ${e.reason}`;
    default: return e.ev;
  }
}

/**
 * Compares a battle's events from ScummVM's trace and the port's replay (docs/tracediff.md, "Space combat"): the
 * rolls in order (step, site, bound, value), the snapshots step by step (floats as float32 values), and the other
 * events in order. ScummVM's `atan2` events aren't differences: those the port took are counted (`libm-atan2f`).
 */
export function diffBattle(scummvm: readonly CombatEvent[], port: readonly CombatEvent[]): CombatDiff {
  const differences: { step: number; what: string }[] = [];
  const rolls = (es: readonly CombatEvent[]) => es.filter((e): e is Extract<CombatEvent, { ev: 'roll' }> => e.ev === 'roll');
  const [sr, pr] = [rolls(scummvm), rolls(port)];
  for (let i = 0; i < Math.max(sr.length, pr.length); i++) {
    const a = sr[i], b = pr[i];
    if (a && b && a.step === b.step && a.site === b.site && a.n === b.n && a.value === b.value) continue;
    const show = (r: typeof a) => (r ? `step ${r.step} ${r.site} rnd(${r.n}) = ${r.value}` : 'none');
    differences.push({ step: Math.min(a?.step ?? Infinity, b?.step ?? Infinity), what: `roll ${i + 1}: ${show(a)} (ScummVM) vs ${show(b)} (port)` });
    break;
  }
  const snaps = (es: readonly CombatEvent[]) => {
    const m = new Map<string, Extract<CombatEvent, { ev: 'snap' }>>();
    // (a step can have two: after the step, and at a leave or the end)
    for (const e of es) if (e.ev === 'snap') m.set(`${e.step}#${[...m.keys()].filter(k => k.startsWith(`${e.step}#`)).length}`, e);
    return m;
  };
  const [ss, ps] = [snaps(scummvm), snaps(port)];
  // (an export from before Plan 25 writes no camera: the rest is compared, and the battle has a problem)
  let cameraless = false;
  for (const [key, a] of ss) {
    const b = ps.get(key);
    if (!b) {
      differences.push({ step: a.step, what: `snapshot at step ${a.step}: the port has none` });
      continue;
    }
    const out: string[] = [];
    if (a.camera === undefined) cameraless = true;
    compareValues(a, a.camera === undefined ? { ...b, camera: undefined } : b, '', false, out);
    if (out.length > 0) differences.push({ step: a.step, what: `snapshot at step ${a.step}: ${out.join('; ')}` });
  }
  for (const [key, b] of ps) if (!ss.has(key)) differences.push({ step: b.step, what: `snapshot at step ${b.step}: ScummVM has none` });
  const ordered = (es: readonly CombatEvent[]) => es.filter(e => ORDERED.has(e.ev));
  const [so, po] = [ordered(scummvm), ordered(port)];
  for (let i = 0; i < Math.max(so.length, po.length); i++) {
    const a = so[i], b = po[i];
    if (a && b && orderedKey(a) === orderedKey(b)) continue;
    differences.push({ step: Math.min(a && 'step' in a ? a.step : Infinity, b && 'step' in b ? b.step : Infinity), what: `event ${i + 1}: ${a ? orderedKey(a) : 'none'} (ScummVM) vs ${b ? orderedKey(b) : 'none'} (port)` });
    break;
  }
  // (the first non-finite float ScummVM wrote, null: from there that value can't be compared)
  const problems: string[] = [];
  if (cameraless) problems.push('ScummVM\'s trace has no camera (an export from before Plan 25): its camera is not compared; re-export and fight again');
  for (const a of ss.values()) {
    const at = nullFloat(a, '', false);
    if (at !== null) {
      problems.push(`step ${a.step}: ScummVM's snapshot has a non-finite float at ${at}: not comparable from here`);
      break;
    }
  }
  differences.sort((x, y) => x.step - y.step);
  const first = differences[0];
  // (each take of ScummVM's angle is counted; each logged call the port took none of is unused)
  const atan2: Record<string, number> = {};
  const atan2Unused: Record<string, number> = {};
  const left = new Map<string, number>();
  for (const e of scummvm) if (e.ev === 'atan2') left.set(JSON.stringify(e), (left.get(JSON.stringify(e)) ?? 0) + 1);
  for (const e of port) {
    if (e.ev !== 'atan2') continue;
    atan2[e.site] = (atan2[e.site] ?? 0) + 1;
    const k = JSON.stringify(e);
    if (left.get(k)) left.set(k, left.get(k)! - 1);
  }
  const unasked: Extract<CombatEvent, { ev: 'atan2' }>[] = [];
  for (const e of scummvm) {
    if (e.ev !== 'atan2') continue;
    const k = JSON.stringify(e);
    if (!left.get(k)) continue;
    left.set(k, left.get(k)! - 1);
    atan2Unused[e.site] = (atan2Unused[e.site] ?? 0) + 1;
    if (ATAN2_SIM_SITES.has(e.site) && (!first || e.step < first.step)) unasked.push(e);
  }
  if (unasked.length > 0) {
    const e = unasked[0]!;
    problems.push(`step ${e.step}: ScummVM's atan2f at ${e.site} (a simulation call) was never asked by the port${unasked.length > 1 ? ` (and ${unasked.length - 1} more)` : ''}`);
  }
  const lastStep = (es: readonly CombatEvent[]) => es.reduce((m, e) => Math.max(m, 'step' in e ? e.step : 0), 0);
  return {
    clean: differences.length === 0,
    first: first ? `step ${first.step}: ${first.what}` : null,
    differences, atan2, atan2Unused,
    counts: { rolls: sr.length, snaps: ss.size, steps: lastStep(scummvm) },
    problems,
  };
}

/** The path of the first null float in a value from ScummVM's trace (a non-finite float, as JsonWriter writes it), or null. */
function nullFloat(v: unknown, path: string, float: boolean): string | null {
  if (v === null) return float ? path : null;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const at = nullFloat(v[i], `${path}[${i}]`, float);
      if (at !== null) return at;
    }
    return null;
  }
  if (typeof v === 'object' && v) {
    for (const [k, x] of Object.entries(v)) {
      const at = nullFloat(x, path ? `${path}.${k}` : k, float || FLOATS.has(k));
      if (at !== null) return at;
    }
  }
  return null;
}

/** A battle's verdict, as a parity report's row: its diff, the replay's problems, and whether ScummVM's run finished. */
export interface ParityRow { battle: number; label: string; diff: CombatDiff | null; problems: string[]; finished: boolean }

/**
 * A battle's verdict: NOT COMPARED (no diff), DIFFERS at its first difference, PROBLEMS (the replay's or the diff's,
 * though no difference), DIDN'T FINISH (ScummVM's run stopped short; what there is matches), or CLEAN.
 */
export function verdictOf(r: ParityRow): string {
  const d = r.diff;
  if (!d) return 'NOT COMPARED';
  if (!d.clean) return `DIFFERS at ${d.first?.split(':')[0] ?? '?'}`;
  if (r.problems.length > 0 || d.problems.length > 0) return 'PROBLEMS';
  if (!r.finished) return 'DIDN\'T FINISH';
  return 'CLEAN';
}

/** The command's exit code, as the verdicts say: 1 when a battle differs or has problems, else 2 when one wasn't compared or didn't finish, else 0. */
export function parityExit(rows: readonly ParityRow[]): number {
  const v = rows.map(verdictOf);
  if (v.some(x => x.startsWith('DIFFERS') || x === 'PROBLEMS')) return 1;
  if (v.length === 0 || v.some(x => x === 'NOT COMPARED' || x === 'DIDN\'T FINISH')) return 2;
  return 0;
}

const bySite = (m: Record<string, number>) => Object.entries(m).map(([site, n]) => `${site} ${n}`).join(', ');

/** The parity report (markdown): one row per battle, then each battle's problems, first differences and atan2f calls. */
export function renderParityReport(rows: ParityRow[], title: string): string {
  const out = [`# Combat parity: ${title}`, '', '| battle | run | steps | rolls | verdict | atan2f taken | atan2f unused |', '|---|---|---|---|---|---|---|'];
  const total = (m: Record<string, number> | undefined) => (m ? Object.values(m).reduce((n, k) => n + k, 0) : 0);
  for (const r of rows) {
    const d = r.diff;
    out.push(`| ${r.battle} | ${r.label} | ${d?.counts.steps ?? '-'} | ${d?.counts.rolls ?? '-'} | ${verdictOf(r)} | ${total(d?.atan2)} | ${total(d?.atan2Unused)} |`);
  }
  for (const r of rows) {
    const d = r.diff;
    if (verdictOf(r) === 'CLEAN' && total(d?.atan2) === 0 && total(d?.atan2Unused) === 0) continue;
    out.push('', `## Battle ${r.battle} (${r.label})`, '');
    if (!d) out.push('- not compared');
    if (!r.finished) out.push('- ScummVM\'s run didn\'t finish: its trace has no combatEnd, and the replay went as far as it did');
    for (const p of [...r.problems, ...(d?.problems ?? [])]) out.push(`- problem: ${p}`);
    for (const x of d?.differences.slice(0, 10) ?? []) out.push(`- step ${x.step}: ${x.what}`);
    if (d && total(d.atan2) > 0) out.push(`- atan2f taken: ${bySite(d.atan2)}`);
    if (d && total(d.atan2Unused) > 0) out.push(`- atan2f unused: ${bySite(d.atan2Unused)}`);
  }
  return out.join('\n') + '\n';
}

/** A battle's line for the command: its verdict, then what made it so (the first difference or problem), then its atan2f calls. */
export function parityLines(r: ParityRow): string[] {
  const v = verdictOf(r);
  const d = r.diff;
  const why = v.startsWith('DIFFERS') ? d?.first : v === 'PROBLEMS' ? [...r.problems, ...(d?.problems ?? [])][0] : v === 'DIDN\'T FINISH' ? 'ScummVM\'s run stopped short, and what it logged matches' : null;
  const lines = [`battle ${r.battle}: ${v}${why ? `: ${why}` : ''}`];
  if (d && Object.keys(d.atan2).length > 0) lines.push(`battle ${r.battle}: atan2f taken: ${bySite(d.atan2)}`);
  if (d && Object.keys(d.atan2Unused).length > 0) lines.push(`battle ${r.battle}: atan2f unused: ${bySite(d.atan2Unused)}`);
  return lines;
}
