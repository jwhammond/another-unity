// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { diffTraces } from './diff';
import { GameMaps } from './maps';
import { renderReport } from './report';
import { loadGameHooks, runTs } from './run';
import type { Norm, Value } from './model';
import { normalizeScummvm } from './scummvm';

// RAW_DIR=$HOME/pcode/unity-raw/runs/export/raw, after npm run unity:build;
// TRACES_DIR=$HOME/pcode/unity-raw/runs, after npm run unity:diff on each walk
const game = fileURLToPath(new URL('../../../games/unity', import.meta.url));
const lifted = !!process.env.RAW_DIR && existsSync(join(game, 'ids.yaml'));
const traces = process.env.TRACES_DIR ?? '';
// (the new game's walk is for tools/play only: the harness turns off the ship's opening triggers the route needs; Plan 13 diffs it)
const SHIP_WALK = 'ship-opening.walk';
// (the whole-game walk includes the legs in route/, and is tools/play's live-route.test.ts; ScummVM's runner has no `include`)
const ROUTE_WALK = 'whole-game.walk';
const walks = existsSync(join(game, 'tests')) ? readdirSync(join(game, 'tests')).filter(f => f.endsWith('.walk') && f !== SHIP_WALK && f !== ROUTE_WALK).sort() : [];
if (!lifted) console.info('live.test.ts: skipped; set RAW_DIR and run npm run unity:build (docs/unity-local.md)');

/** Each mission's canonical walk and what it must reach (Plan 9 R5); every other walk only has to play to its end. */
type Goal = { ship: true; trigger?: string; state?: Record<string, Value> } | { state: Record<string, Value> };
const CANONICAL: Record<string, Goal> = {
  'horst3.walk': { ship: true },
  'horst3-leave-early.walk': { ship: true },
  'frigis.walk': { ship: true, trigger: 't90' },
  // (the last sample's check, o_030836, is set by the sample chain)
  'zoo.walk': { ship: true, trigger: 't59', state: { 'obj:o_030836.state': 1 } },
  'lab.walk': { ship: true, trigger: 't133' },
  // (R7 c: the finale can't be walked in ScummVM, which never moves the two leaders off s04, so the walk ends in the
  // guardians' room, where the control panel comes on)
  'unity.walk': { state: { 'obj:o_060a01.active': true } },
  // (allanor.walk ends on s0f once the Chodak have taken the rod, not at t34: see the ledger)
  'allanor.walk': { state: { 'obj:o_020713.state': 1, 'obj:o_020c09.state': 2 } },
};

/**
 * Steps a walk differs in that a ruling accepts (Plan 9 R7 a), each with the state keys that still differ there (original
 * o_ ids; [] where only events differ). The diff must differ in exactly these lines with exactly these keys: a pinned line
 * that goes clean, or gains a difference, fails.
 */
const KNOWN_DIFFERENT_STEPS: Record<string, Record<number, string[]>> = {
  'unity.walk': { 12: ['obj:o_06020f.timer'], 102: ['obj:o_000003.pos'] },
  // (35, 74, 77, 83: controller rulings; line 69, the same use in a different order within the step, is now forgiven by arrival-order)
  'allanor.walk': { 35: ['obj:o_000002.pos'], 74: [], 77: ['obj:o_020e0a.pos'], 83: [] },
};

/** A state key with its object named by original id (o_ hex) rather than by the lifted name. */
function originalKey(key: string, maps: GameMaps): string {
  let best: [string, string] | undefined;
  for (const [hex, slug] of Object.entries(maps.ids.objects)) if (key.startsWith(`obj:${slug}.`) && (!best || slug.length > best[1].length)) best = [hex, slug];
  return best ? `obj:o_${best[0]}${key.slice(`obj:${best[1]}`.length)}` : key;
}

/** The final value of each state key in a run. */
function finalState(events: Norm[]): Map<string, Value> {
  const out = new Map<string, Value>();
  for (const e of events) {
    if (e.k === 'baseline') for (const [k, v] of Object.entries(e.values)) out.set(k, v);
    if (e.k === 'set') out.set(e.key, e.value);
  }
  return out;
}

async function play(walk: string) {
  return runTs(game, readFileSync(join(game, 'tests', walk), 'utf8'), { registerHooks: await loadGameHooks(game), rawDir: process.env.RAW_DIR });
}

describe.skipIf(!lifted)('the walkthroughs in the TypeScript engine (needs RAW_DIR)', () => {
  it.each(walks)('%s plays to its end', async walk => {
    const { events, error } = await play(walk);
    expect(error).toBeNull();
    expect(events.at(-1)).toEqual({ k: 'end' });
    const goal = CANONICAL[walk];
    if (goal && 'ship' in goal) expect(events.some(e => e.k === 'ship')).toBe(true);
    if (goal && 'ship' in goal && goal.trigger) expect(finalState(events).get(`trigger:${goal.trigger}`)).toBe(true);
    if (goal && goal.state) {
      const maps = await GameMaps.load(game, process.env.RAW_DIR);
      const slugged = (k: string) => k.replace(/^obj:o_([0-9a-f]{6})\b/, (_, hex: string) => `obj:${maps.ids.objects[hex]}`);
      for (const [k, v] of Object.entries(goal.state ?? {})) expect(finalState(events).get(slugged(k)), k).toBe(v);
    }
  }, 300_000);
});

describe.skipIf(!lifted || !traces)('the walkthroughs against ScummVM (needs RAW_DIR and TRACES_DIR)', () => {
  it.each(walks)('%s diffs clean', async walk => {
    const maps = await GameMaps.load(game, process.env.RAW_DIR);
    const file = join(traces, `tracediff-${basename(walk, '.walk')}`, 'trace.jsonl');
    const s = normalizeScummvm(readFileSync(file, 'utf8'), maps);
    expect(s.problems).toEqual([]);
    const { events } = await play(walk);
    const report = diffTraces(s.events, events, maps, s.notCompared);
    const known = KNOWN_DIFFERENT_STEPS[walk];
    if (known) {
      expect(report.structure, renderReport(report, walk)).toEqual([]);
      const actual = Object.fromEntries(report.steps.map(step => [step.line, step.state.map(x => originalKey(x.key, maps)).sort()]));
      expect(actual, renderReport(report, walk)).toEqual(known);
    } else {
      expect(report.clean, renderReport(report, walk)).toBe(true);
    }
  }, 300_000);
});
