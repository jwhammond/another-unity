// SPDX-License-Identifier: GPL-3.0-or-later
import { R } from '@another-unity/engine';
import type { AllowanceId } from './allowances';
import type { GameMaps } from './maps';
import { describeNorm, streamKey, type Norm, type Value } from './model';

export interface StateDiff {
  key: string;
  scummvm: Value;
  ts: Value;
}

export interface StepDiff {
  line: number;
  text: string;
  onlyScummvm: string[];
  onlyTs: string[];
  /** Random values that differ while the two streams are aligned. */
  rng: string[];
  state: StateDiff[];
  /** Differences an `explain` allowance names the cause of: still differences. */
  explained: string[];
}

export interface Report {
  clean: boolean;
  /** Steps that don't line up, and runs that didn't end. */
  structure: string[];
  steps: StepDiff[];
  allowances: Map<AllowanceId, number>;
  notCompared: Map<string, number>;
  info: string[];
}

interface Step {
  line: number;
  text: string;
  events: Norm[];
}

/** A step's ordered events, its firings (each with the sets ScummVM logged inside it), and its advisor offers. */
interface Prepared {
  rest: Norm[];
  fired: Norm[][];
  advised: number;
  /** The advice id in force at the step's end (global:adviceId). */
  adviceId: Value;
}

/** Steps in which the actor may walk, whose end position is compared loosely (walk-end-position). */
const WALKING_VERBS = new Set(['walk', 'use', 'talk', 'look', 'get', 'combadge']);
/** Positions this close are the same place: the projection rounds to the millimetre, the sim to its markers. */
const SAME_PLACE = 0.05;
/** Above this many cells, the LCS table is too big, and steps are aligned position by position. */
const MAX_CELLS = 25_000_000;
/** The phaser's original id, as walk files name it (phaser-regen-timing doesn't cover a step that fires it). */
const PHASER_ID = '007003';

function split(events: Norm[]): { baseline: Record<string, Value>; steps: Step[]; ended: boolean } {
  let baseline: Record<string, Value> = {};
  const steps: Step[] = [];
  let ended = false;
  for (const e of events) {
    if (e.k === 'baseline') baseline = e.values;
    else if (e.k === 'step') steps.push({ line: e.line, text: e.text, events: [] });
    else if (e.k === 'end') ended = true;
    else steps.at(-1)?.events.push(e);
  }
  return { baseline, steps, ended };
}

/** The last value each key was set to in a step, with its tag. */
function finalSets(events: Norm[]): Map<string, { value: Value; tag?: string }> {
  const sets = new Map<string, { value: Value; tag?: string }>();
  for (const e of events) if (e.k === 'set') sets.set(e.key, { value: e.value, tag: e.tag });
  return sets;
}

/** The crew who can offer an advice entry: updateAdvice's advisors are those with an easy line in it (talk.cpp:421-445). */
function advisors(adviceId: Value, maps: GameMaps): string[] {
  return typeof adviceId === 'string' ? Object.keys(maps.content.advice[adviceId]?.easy ?? {}) : [];
}

function prepare(events: Norm[], adviceId: Value, maps: GameMaps): Prepared {
  // advice-timing: each advisor draw, and the one line it offers, if one of the entry's advisors says it
  // (the sets between them stay)
  const kept: Norm[] = [];
  let advised = 0;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.k === 'set' && e.key === 'global:adviceId') adviceId = e.value;
    if (e.k !== 'rng' || e.site !== 'advisor') {
      kept.push(e);
      continue;
    }
    advised++;
    let j = i + 1;
    for (; events[j]?.k === 'set'; j++) {
      const x = events[j];
      if (x.k === 'set' && x.key === 'global:adviceId') adviceId = x.value;
      kept.push(x);
    }
    const line = events[j];
    i = line?.k === 'say' && advisors(adviceId, maps).includes(line.who) ? j : j - 1;
  }
  // each timer or trigger firing, with its action to its end (and any sets inside it)
  const rest: Norm[] = [];
  const fired: Norm[][] = [];
  for (let i = 0; i < kept.length; i++) {
    const e = kept[i];
    // (a timer's action run again after the sim's walk-up has no timer event of its own: it is a firing too)
    const rerun = e.k === 'action' && e.verb === 'timer' && e.depth === 1;
    if (e.k !== 'timer' && e.k !== 'trigger' && !rerun) {
      if (e.k !== 'set') rest.push(e);
      continue;
    }
    const block: Norm[] = [e];
    if (rerun) {
      let j = i + 1;
      for (; j < kept.length; j++) {
        const x = kept[j];
        block.push(x);
        if (x.k === 'actionEnd' && x.depth === 1) break;
      }
      i = j;
    } else if (kept.slice(i + 1).find(x => x.k !== 'set')?.k === 'action') {
      let j = i + 1;
      for (; j < kept.length; j++) {
        const x = kept[j];
        block.push(x);
        if (x.k === 'actionEnd' && x.depth === 1) break;
      }
      i = j;
    }
    fired.push(block);
  }
  return { rest, fired, advised, adviceId };
}

/** A firing as matched: its events without the sets inside it. */
/** An action at depth 1 by one of the away team (a walk's arrival: the walkers' order is a race). */
const isCrewAction = (e: Norm): boolean => e.k === 'action' && e.depth === 1 && e.verb === 'use' && e.who === e.who.toLowerCase() && !e.who.includes('.');

/**
 * The events as a run of whole depth-1 `use` actions, each by its own walker (an arrival's action squares), or null if
 * anything else is among them. A block is its action event, what happened inside it and its end.
 */
export function arrivalBlocks(events: Norm[]): { blocks: { who: string; sig: string }[]; ends: string[] } | null {
  const blocks: { who: string; sig: string }[] = [];
  const ends: string[] = [];
  for (let i = 0; i < events.length; ) {
    const a = events[i];
    if (a.k !== 'action' || a.depth !== 1 || a.verb !== 'use' || a.who === a.target) return null;
    let j = i + 1;
    while (j < events.length && !(events[j].k === 'actionEnd' && (events[j] as { depth: number }).depth === 1) &&
      !(events[j].k === 'action' && (events[j] as { depth: number }).depth === 1)) j++;
    // (the last block may have lost its end to the alignment; an end's flags go with whoever ran first, so they are compared as a set)
    const inner = events.slice(i, j);
    const closed = j < events.length && events[j].k === 'actionEnd';
    if (closed) ends.push(streamKey(events[j]));
    blocks.push({ who: a.who, sig: `${a.who} ${inner.map(e => (e.k === 'action' ? `${e.verb} ${e.target} ${e.other}` : streamKey(e))).join(' | ')}` });
    i = closed ? j + 1 : j;
  }
  return { blocks, ends };
}

/** A timer's firing whose every group failed, so that it changed nothing (idle-timer-firing). */
export const idleFiring = (b: Norm[]): boolean =>
  b.length > 0 && b[0].k === 'timer' && b.some(e => e.k === 'group') && b.every(e => e.k === 'timer' || (e.k === 'group' && !e.passed) || ((e.k === 'action' || e.k === 'actionEnd') && e.verb === 'timer'));

const blockKey = (b: Norm[]) => b.filter(e => e.k !== 'set' && e.k !== 'timer').map(streamKey).join(' | ');
const setKeys = (b: Norm[]) => b.flatMap(e => (e.k === 'set' ? [e.key] : []));

type Op = { s?: number; t?: number };

/**
 * The two key lists' longest common subsequence, as ordered pairs and leftovers; position by position
 * (`positional`) when the table would be too big.
 */
function align(a: string[], b: string[]): { ops: Op[]; positional: boolean } {
  const n = a.length;
  const m = b.length;
  const ops: Op[] = [];
  if (n * m > MAX_CELLS) {
    for (let i = 0; i < Math.max(n, m); i++) {
      if (i < n && i < m && a[i] === b[i]) ops.push({ s: i, t: i });
      else {
        if (i < n) ops.push({ s: i });
        if (i < m) ops.push({ t: i });
      }
    }
    return { ops, positional: true };
  }
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) ops.push({ s: i++, t: j++ });
    else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push({ s: i++ });
    else ops.push({ t: j++ });
  }
  while (i < n) ops.push({ s: i++ });
  while (j < m) ops.push({ t: j++ });
  return { ops, positional: false };
}

/** What differs between two firings paired across steps: their events (sets aside) and their actions' actors. */
function firingDiff(sBlock: Norm[], tBlock: Norm[]): { sOnly: Norm[]; tOnly: Norm[] } {
  const a = sBlock.filter(e => e.k !== 'set');
  const b = tBlock.filter(e => e.k !== 'set');
  const sOnly: Norm[] = [];
  const tOnly: Norm[] = [];
  for (const op of align(a.map(streamKey), b.map(streamKey)).ops) {
    if (op.s !== undefined && op.t !== undefined) {
      const x = a[op.s];
      const y = b[op.t];
      if (x.k === 'action' && y.k === 'action' && x.who !== y.who) {
        sOnly.push(x);
        tOnly.push(y);
      }
    } else if (op.s !== undefined) sOnly.push(a[op.s]);
    else if (op.t !== undefined) tOnly.push(b[op.t]);
  }
  return { sOnly, tOnly };
}

/** Each step prepared in order, carrying the advice id in force from one step to the next. */
function prepareAll(steps: Step[], baseline: Record<string, Value>, maps: GameMaps): Prepared[] {
  let adviceId: Value = baseline['global:adviceId'] ?? null;
  return steps.map(st => {
    const p = prepare(st.events, adviceId, maps);
    adviceId = p.adviceId;
    return p;
  });
}

function gap(a: string, b: string): number {
  const [ax, az] = a.split(',').map(Number);
  const [bx, bz] = b.split(',').map(Number);
  const d = Math.hypot(ax - bx, az - bz);
  return Number.isFinite(d) ? d : Infinity;
}

/** What the step is: its actor (a slug, when the verb can walk), and whether it fires the phaser. */
function stepFacts(text: string, maps: GameMaps): { actor: string | null; phaser: boolean } {
  const [verb, who] = text.split(/[ \t]+/);
  const actor = WALKING_VERBS.has(verb) && who ? maps.object(who) : null;
  return { actor, phaser: verb === 'phaser' || text.split(/[ \t]+/).includes(PHASER_ID) };
}

/** Whether two final values are the same, or which allowance forgives the difference. */
function compareValue(
  key: string, a: Value, b: Value, step: { actor: string | null; phaser: boolean; moved: boolean }, maps: GameMaps,
): 'same' | 'differs' | AllowanceId {
  if (a === b) return 'same';
  const unlifted = /^trigger:\?(\d+)$/.exec(key);
  if (unlifted) return maps.unliftedTriggerExpected(Number(unlifted[1])) ? 'unlifted-triggers' : 'differs';
  if (key.startsWith('obj:') && key.endsWith('.pos') && typeof a === 'string' && typeof b === 'string') {
    const d = gap(a, b);
    if (d <= SAME_PLACE) return 'same';
    const id = key.slice('obj:'.length, -'.pos'.length);
    if (id === step.actor && !step.moved && d <= maps.talkDistance()) return 'walk-end-position';
    return 'differs';
  }
  if (key.startsWith('phaser:') && key.endsWith('.health') && typeof a === 'number' && typeof b === 'number' && !step.phaser) {
    const threshold = maps.threshold(key.slice('phaser:'.length, -'.health'.length));
    if (threshold !== undefined && (a <= threshold) === (b <= threshold)) return 'phaser-regen-timing';
  }
  if (/^obj:.+\.state$/.test(key) && maps.animated(key.slice('obj:'.length, -'.state'.length))) return 'sprite-state';
  return 'differs';
}

/** Compares two normalized runs of one walkthrough, step by step (Plan 6 Decisions 5 and 16). */
export function diffTraces(scummvm: Norm[], ts: Norm[], maps: GameMaps, notCompared = new Map<string, number>()): Report {
  const report: Report = { clean: false, structure: [], steps: [], allowances: new Map(), notCompared, info: [] };
  const allow = (id: AllowanceId) => report.allowances.set(id, (report.allowances.get(id) ?? 0) + 1);
  const S = split(scummvm);
  const T = split(ts);
  // (ScummVM only logs changes: both start from the TypeScript world's baseline)
  const sNow = new Map<string, Value>(Object.entries(T.baseline));
  const tNow = new Map<string, Value>(Object.entries(T.baseline));
  const now = (state: Map<string, Value>, key: string): Value => (state.has(key) ? state.get(key)! : null);
  const sPrep = prepareAll(S.steps, T.baseline, maps);
  const tPrep = prepareAll(T.steps, T.baseline, maps);

  // firings matched within their step; what is left may pair across a step boundary (timer-cadence)
  const sLeft: Norm[][][] = [];
  const tLeft: Norm[][][] = [];
  sPrep.forEach((sp, i) => {
    const others = [...(tPrep[i]?.fired ?? [])];
    sLeft[i] = [];
    for (const block of sp.fired) {
      const k = others.findIndex(b => blockKey(b) === blockKey(block));
      if (k >= 0) others.splice(k, 1);
      else sLeft[i].push(block);
    }
    tLeft[i] = others;
  });
  for (let i = sPrep.length; i < tPrep.length; i++) {
    sLeft[i] = [];
    tLeft[i] = [...tPrep[i].fired];
  }
  const used = new Set<Norm[]>();
  /** Keys whose comparison waits for a later step: key -> that step. */
  const deferTo = new Map<string, number>();
  /** What differs inside firings paired across steps, reported at the later step: step -> differences. */
  const pairedDiffs = new Map<number, { s: string[]; t: string[] }>();

  let aligned = true;
  const unalign = (line: number, why: string) => {
    if (!aligned) return;
    aligned = false;
    report.info.push(`line ${line}: ${why}, so random values aren't compared until both engines log the next seed`);
  };
  let lastAlters = new Set<string>();

  const steps = Math.min(S.steps.length, T.steps.length);
  for (let i = 0; i < steps; i++) {
    const s = S.steps[i];
    const t = T.steps[i];
    if (s.line !== t.line) {
      report.structure.push(`step ${i + 1}: ScummVM is on line ${s.line} (${s.text}), TypeScript on line ${t.line} (${t.text})`);
      break;
    }
    const d: StepDiff = { line: s.line, text: s.text, onlyScummvm: [], onlyTs: [], rng: [], state: [], explained: [] };
    // (an error stops a walkthrough: it is never clean, even when both engines stop alike)
    for (const e of s.events) if (e.k === 'error') report.structure.push(`line ${s.line}: ScummVM stopped with an error: ${e.what}`);
    for (const e of t.events) if (e.k === 'error') report.structure.push(`line ${t.line}: TypeScript stopped with an error: ${e.what}`);
    // (M3 Decision 3: ScummVM fails where the export lacks content, so a walk that reaches it is never clean)
    for (const e of t.events) {
      if (e.k === 'missing') report.structure.push(`line ${t.line}: TypeScript reached content the export lacks: ${e.kind} ${e.id} (ScummVM fails there)`);
    }
    const paired = pairedDiffs.get(i);
    if (paired) {
      d.onlyScummvm.push(...paired.s);
      d.onlyTs.push(...paired.t);
    }
    const sSets = finalSets(s.events);
    const tSets = finalSets(t.events);
    for (const [k, v] of sSets) sNow.set(k, v.value);
    for (const [k, v] of tSets) tNow.set(k, v.value);
    // (a close-up places no one, awayteam.cpp:307-309: going on to one leaves the team where its walk ended)
    const placed = (e: Norm) => e.k === 'screen' && !maps.isCloseup(e.screen);
    const moved = s.events.some(placed) || t.events.some(placed);
    const facts = { ...stepFacts(s.text, maps), moved };

    // advice-timing
    const sp = sPrep[i];
    const tp = tPrep[i];
    for (let n = 0; n < sp.advised + tp.advised; n++) allow('advice-timing');
    if (sp.advised + tp.advised > 0) unalign(s.line, 'an advisor drew a number');

    // firings left over: same-tick-screen-timers, then timer-cadence with the next step, one for one
    const screenNow = s.events.find(e => e.k === 'screen');
    for (const [mine, theirs, side] of [[sLeft, tLeft, 'scummvm'], [tLeft, sLeft, 'ts']] as const) {
      for (const block of mine[i]) {
        if (used.has(block)) continue;
        const head = block[0];
        if (side === 'scummvm' && head.k === 'timer' && screenNow?.k === 'screen' && screenNow.screen !== now(sNow, `obj:${head.object}.screen`)) {
          used.add(block);
          allow('same-tick-screen-timers');
          continue;
        }
        const partner = (theirs[i + 1] ?? []).find(b => !used.has(b) && streamKey(b[0]) === streamKey(head));
        if (partner) {
          used.add(block);
          used.add(partner);
          allow('timer-cadence');
          for (const key of [...setKeys(block), ...setKeys(partner)]) deferTo.set(key, i + 1);
          // (the timing is forgiven, not the contents: a difference inside the pair shows at the later step)
          const [sBlock, tBlock] = side === 'scummvm' ? [block, partner] : [partner, block];
          const { sOnly, tOnly } = firingDiff(sBlock, tBlock);
          if (sOnly.length + tOnly.length > 0) {
            const from = ` (in ${describeNorm(head)}, paired across lines ${s.line} and ${S.steps[i + 1]?.line ?? '?'})`;
            const later = pairedDiffs.get(i + 1) ?? { s: [], t: [] };
            later.s.push(...sOnly.map(e => describeNorm(e) + from));
            later.t.push(...tOnly.map(e => describeNorm(e) + from));
            pairedDiffs.set(i + 1, later);
          }
          if ([...block, ...partner].some(e => e.k === 'rng')) unalign(s.line, 'a firing paired across steps drew a number');
          continue;
        }
        if (idleFiring(block)) {
          used.add(block);
          allow('idle-timer-firing');
          continue;
        }
        used.add(block);
        (side === 'scummvm' ? d.onlyScummvm : d.onlyTs).push(...block.filter(e => e.k !== 'set').map(describeNorm));
      }
    }

    // state: the final value of every key either engine changed in this step, unless a paired firing
    // defers it to the next; plus the keys deferred to this step
    const keys = new Set([...sSets.keys(), ...tSets.keys(), ...[...deferTo].filter(([, at]) => at === i).map(([k]) => k)]);
    const spriteState: { key: string; scummvm: Value; ts: Value }[] = [];
    for (const key of [...keys].sort()) {
      if ((deferTo.get(key) ?? -1) > i) continue;
      deferTo.delete(key);
      const a = now(sNow, key);
      const b = now(tNow, key);
      const verdict = compareValue(key, a, b, facts, maps);
      if (verdict === 'differs') d.state.push({ key, scummvm: a, ts: b });
      else if (verdict === 'sprite-state') spriteState.push({ key, scummvm: a, ts: b });
      else if (verdict !== 'same') allow(verdict);
    }
    const alters = new Set([...sSets].filter(([k, v]) => v.tag === 'alter' && k.endsWith('.pos')).map(([k]) => k.slice('obj:'.length, -'.pos'.length)));

    // the rest in order: an LCS of the keys, then the pairs' actors and random values
    const sOnly: Norm[] = [];
    const tOnly: Norm[] = [];
    const { ops, positional } = align(sp.rest.map(streamKey), tp.rest.map(streamKey));
    if (positional) report.info.push(`line ${s.line}: too many events to align by LCS, so they were compared position by position`);
    for (const op of ops) {
      if (op.s !== undefined && op.t !== undefined) {
        const x = sp.rest[op.s];
        const y = tp.rest[op.t];
        if (x.k === 'seed' && y.k === 'seed') {
          if (!aligned) report.info.push(`line ${s.line}: random values are compared again from this seed`);
          aligned = true;
        }
        if (x.k === 'rng' && y.k === 'rng' && aligned && x.value !== y.value) d.rng.push(`${x.site}/${x.max}: ScummVM ${x.value}, TypeScript ${y.value}`);
        // (an action's actor isn't in its key: a different one is a difference of its own)
        if (x.k === 'action' && y.k === 'action' && x.who !== y.who) {
          sOnly.push(x);
          tOnly.push(y);
        }
      } else if (op.s !== undefined) {
        sOnly.push(sp.rest[op.s]);
        if (sp.rest[op.s].k === 'rng') unalign(s.line, 'ScummVM drew a number the sim didn\'t');
      } else if (op.t !== undefined) {
        tOnly.push(tp.rest[op.t]);
        if (tp.rest[op.t].k === 'rng') unalign(s.line, 'the sim drew a number ScummVM didn\'t');
      }
    }
    // arrival-order: the same crew members doing the same thing to the same target, in another order
    if (sOnly.length > 1 && sOnly.length === tOnly.length && sOnly.every(isCrewAction) && tOnly.every(isCrewAction)) {
      const key = (e: Norm) => (e.k === 'action' ? `${e.verb} ${e.target} ${e.who} ${e.other}` : '');
      const a = sOnly.map(key).sort().join('|');
      if (a === tOnly.map(key).sort().join('|') && new Set(sOnly.map(e => (e.k === 'action' ? `${e.verb} ${e.target}` : ''))).size === 1) {
        for (let n = 0; n < sOnly.length; n++) allow('arrival-order');
        sOnly.length = 0;
        tOnly.length = 0;
      }
    }
    // (also whole arrivals: walkers who each ran the same squares, in another order, with the same results for each)
    if (sOnly.length > 0 && tOnly.length > 0) {
      const sb = arrivalBlocks(sOnly);
      const tb = arrivalBlocks(tOnly);
      // (each walker's own arrivals keep their order; only the walkers interleave differently)
      const perWalker = (r: NonNullable<typeof sb>) => [...new Set(r.blocks.map(b => b.who))].sort().map(w => r.blocks.filter(b => b.who === w).map(b => b.sig).join('\n'));
      if (sb && tb && sb.blocks.length > 0 &&
          perWalker(sb).join('\n--\n') === perWalker(tb).join('\n--\n') &&
          sb.ends.sort().join('\n') === tb.ends.sort().join('\n')) {
        for (let n = 0; n < sb.blocks.length; n++) allow('arrival-order');
        sOnly.length = 0;
        tOnly.length = 0;
      }
    }
    d.onlyScummvm.push(...sOnly.map(describeNorm));
    d.onlyTs.push(...tOnly.map(describeNorm));

    // explain: known causes of what is left
    for (const x of sOnly) {
      if (x.k === 'group' && tOnly.some(y => y.k === 'group' && y.key === x.key && y.passed !== x.passed) && maps.groupCondition(x.key)?.near) {
        d.explained.push(`${x.key}: proximity-threshold (passed in ${x.passed ? 'ScummVM' : 'the sim'} only; patch the group's near dist in overrides/objects)`);
        allow('proximity-threshold');
      }
      if (x.k === 'action' && x.depth === 1 && (alters.has(x.who) || lastAlters.has(x.who))) {
        d.explained.push(`${describeNorm(x)}: alter-stops-walk (an AlterBlock moved ${x.who} mid-walk; the sim dropped the queued action)`);
        allow('alter-stops-walk');
      }
    }
    // A TALK that walks up first ends WALKING, and talks again on arrival (as ScummVM logs it in Task 11's
    // horst3.walk): one engine's extra talk to the step's target, at depth 1, with an end that says WALKING
    const talk = /^talk[ \t]+\S+[ \t]+(\S+)/.exec(s.text);
    if (talk) {
      const target = maps.object(talk[1]);
      for (const [only, who] of [[sOnly, 'ScummVM'], [tOnly, 'the sim']] as const) {
        const walked = only.some(x => x.k === 'actionEnd' && x.verb === 'talk' && x.target === target && x.depth === 1 && (x.flags & R.WALKING) !== 0);
        const x = only.find(y => y.k === 'action' && y.verb === 'talk' && y.target === target && y.depth === 1);
        if (walked && x) {
          d.explained.push(`${describeNorm(x)}: talk-walkup-threshold (only ${who} walked up first; see the allowance's fix rule)`);
          allow('talk-walkup-threshold');
        }
      }
    }
    lastAlters = alters;

    // sprite-state: forgiven only when nothing else in the step differs
    if (spriteState.length > 0) {
      if (d.onlyScummvm.length + d.onlyTs.length + d.rng.length + d.state.length + d.explained.length === 0) for (let n = 0; n < spriteState.length; n++) allow('sprite-state');
      else d.state.push(...spriteState);
    }
    if (d.onlyScummvm.length + d.onlyTs.length + d.rng.length + d.state.length > 0) report.steps.push(d);
  }

  if (S.steps.length !== T.steps.length) report.structure.push(`ScummVM ran ${S.steps.length} steps, TypeScript ${T.steps.length}`);
  if (!S.ended) report.structure.push("ScummVM's trace has no end");
  if (!T.ended) report.structure.push("TypeScript's trace has no end");
  report.clean = report.structure.length === 0 && report.steps.length === 0;
  return report;
}
