// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkCombatRolls, checkRng, checkTrace, parseTrace, type TraceEventT } from './trace';

// TRACE_FILE=$HOME/pcode/unity-raw/runs/trace/trace.jsonl
const TRACE = process.env.TRACE_FILE ?? '';

/** A game line's sha256 prefix and length: it pins the text without the test holding it (the game's text is Paramount's). */
const fingerprint = (text: string) => `${createHash('sha256').update(text).digest('hex').slice(0, 12)}:${text.length}`;

/** Picard's look at the rubble: who says it, its voice, and its text's fingerprint. */
function expectRubbleLook(events: TraceEventT[]) {
  const said = events.find(e => e.ev === 'say' && e.voice === 'fe0000e6.vac');
  expect(said).toMatchObject({ ev: 'say', who: '000000' });
  expect(said?.ev === 'say' ? fingerprint(said.text) : '').toBe('837f06dbfae0:63');
}

async function loadTrace(path: string): Promise<TraceEventT[]> {
  const { events, problems } = parseTrace(await readFile(path, 'utf8'));
  expect(problems).toEqual([]);
  return events;
}

describe.skipIf(!TRACE)('the trace of a short Horst III run', () => {
  it('is well formed', async () => {
    const events = await loadTrace(TRACE);
    expect(checkTrace(events)).toEqual([]);
    expect(events[0]).toMatchObject({ ev: 'begin', seed: 42 });
  });

  it('logs the screen, the startup action\'s rules in execution order, and the look', async () => {
    const events = await loadTrace(TRACE);
    expect(events).toContainEqual(expect.objectContaining({ ev: 'screen', world: 7, screen: 1, entrance: 0x80 }));
    const setup = events.findIndex(e => e.ev === 'group' && e.list === 'o_070100#/use_entries' && e.index === 0 && e.passed);
    expect(setup).toBeGreaterThan(0);
    const first = events.slice(setup).find(e => e.ev === 'entry' && e.list === 'o_070100#/use_entries');
    expect(first).toMatchObject({ group: 0, index: 0, class: 'TriggerBlock' }); // _order -1 runs first
    expect(events).toContainEqual(expect.objectContaining({ ev: 'action', verb: 'look', target: '070103', who: '000000', depth: 1 }));
    expectRubbleLook(events);
  });

  it('reports the team\'s placement, but not objects merely loaded', async () => {
    const events = await loadTrace(TRACE);
    const screen = events.findIndex(e => e.ev === 'screen');
    expect(events.slice(screen)).toContainEqual(expect.objectContaining({ ev: 'obj', id: '000000', field: 'x' }));
    expect(events).not.toContainEqual(expect.objectContaining({ ev: 'obj', id: '070103', field: 'name' }));
    // the team the console's screen command makes, and its leader
    expect(events.slice(screen)).toContainEqual(expect.objectContaining({ ev: 'global', key: 'team', to: '000000,000001,000002,000003' }));
    expect(events.slice(screen)).toContainEqual(expect.objectContaining({ ev: 'global', key: 'member', to: '000000' }));
  });

  it('draws game-state numbers exactly as the TypeScript Rng does, whatever the sprites draw', async () => {
    const events = await loadTrace(TRACE);
    expect(checkRng(events)).toEqual([]);
    const stepIns = events.filter(e => e.ev === 'rng' && e.site.startsWith('stepIn'));
    // four members arrive through entrance 0x80, each rolling x then y
    expect(stepIns.map(e => (e.ev === 'rng' ? `${e.site}/${e.max}` : ''))).toEqual(
      Array.from({ length: 4 }, () => ['stepInX/2', 'stepInY/2']).flat(),
    );
  });
});

const RUNS = process.env.WALK_RUNS ?? '';

/** A run's out.log: it quit by itself (run.sh marks a run it killed at the timeout). */
async function expectQuitItself(dir: string) {
  const log = await readFile(join(dir, 'out.log'), 'utf8');
  expect(log).not.toContain('HARNESS: killed at the');
  expect(log.trimEnd().split('\n').at(-1)).toBe('exit=0');
}

/** A walkthrough that stopped at an error: that one error, then end, and it quit. */
async function expectStopped(dir: string, what: string | RegExp) {
  const events = await loadTrace(join(dir, 'trace.jsonl'));
  const errors = events.filter(e => e.ev === 'error');
  expect(errors).toEqual([expect.objectContaining({ what: typeof what === 'string' ? what : expect.stringMatching(what) })]);
  expect(events.at(-1)?.ev).toBe('end');
  await expectQuitItself(dir);
  return events;
}

// WALKBAD_DIR=$HOME/pcode/unity-raw/runs/walkbad
const WALKBAD = process.env.WALKBAD_DIR ?? '';

describe.skipIf(!WALKBAD)('a walkthrough with a line it can\'t carry out', () => {
  it('stops there with an error, ends the trace and quits', async () => {
    await expectStopped(WALKBAD, 'line 3 (jump 000000 070103): unknown step');
  });
});

// WALK_RUNS=$HOME/pcode/unity-raw/runs (walkpick, walkadvance, walknegative)
describe.skipIf(!RUNS)('a walkthrough with a bad scripted value', () => {
  it('stops at a pick past the menu\'s options', async () => {
    const events = await expectStopped(join(RUNS, 'walkpick'), /^scripted pick 9 is out of range for '.+'$/);
    expect(events).toContainEqual(expect.objectContaining({ ev: 'choice', kind: 'menu', picked: 9, scripted: true }));
  });

  it('stops at an advance too long to wait', async () => {
    await expectStopped(join(RUNS, 'walkadvance'), 'line 2 (advance 4294968): an advance is at most 3600 seconds');
  });

  it('stops at a negative number', async () => {
    await expectStopped(join(RUNS, 'walknegative'), "line 2 (pick -1): a pick is a number or 'cancel'");
  });
});

// WALK_DIR=$HOME/pcode/unity-raw/runs/walk
const WALK = process.env.WALK_DIR ?? '';

describe.skipIf(!WALK)('the trace of a walkthrough', () => {
  it('runs every line, and draws as the TypeScript Rng does', async () => {
    const events = await loadTrace(join(WALK, 'trace.jsonl'));
    expect(checkTrace(events)).toEqual([]);
    expect(checkRng(events)).toEqual([]);
    // every line of walk.txt (as settled in Step 4), in order
    const lines = (await readFile(join(WALK, 'walk.txt'), 'utf8')).split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    expect(events.filter(e => e.ev === 'step').map(e => (e.ev === 'step' ? e.text : ''))).toEqual(lines);
    await expectQuitItself(WALK);
  });

  it('starts each step only once the last one has returned', async () => {
    const events = await loadTrace(join(WALK, 'trace.jsonl'));
    let open = 0;
    for (const e of events) {
      if (e.ev === 'action') open++;
      if (e.ev === 'actionEnd') open--;
      if (e.ev === 'step') expect(open, `seq ${e.seq}`).toBe(0);
    }
    // the use's failure line is said (after its action) before the talk starts
    const said = events.findIndex(e => e.ev === 'say' && e.voice === 'fe0004da.vac');
    const line = events[said];
    expect(line?.ev === 'say' ? fingerprint(line.text) : '').toBe('723d42a186e3:28');
    const talk = events.findIndex(e => e.ev === 'step' && e.text === 'talk 000000 000001');
    expect(said).toBeGreaterThan(0);
    expect(talk).toBeGreaterThan(said);
  });

  it('acts as the player\'s clicks do', async () => {
    const events = await loadTrace(join(WALK, 'trace.jsonl'));
    const after = (text: string) => events.slice(events.findIndex(e => e.ev === 'step' && e.text === text));
    expect(after('look 000000 070103').find(e => e.ev === 'action')).toMatchObject({ ev: 'action', verb: 'look', target: '070103', who: '000000', depth: 1 });
    expectRubbleLook(events);
    expect(after('use 000000 070103')).toContainEqual(expect.objectContaining({ ev: 'action', verb: 'use', target: '070103', who: '000000', depth: 1 }));
    expect(after('talk 000000 000001')).toContainEqual(expect.objectContaining({ ev: 'action', verb: 'talk', target: '000001', who: '000000', depth: 1 }));
  });
});

// WALKSEED_DIR=$HOME/pcode/unity-raw/runs/walkseed
const WALKSEED = process.env.WALKSEED_DIR ?? '';

describe.skipIf(!WALKSEED)('a walkthrough that reseeds', () => {
  it('logs the seed, and the draws after it follow the new seed', async () => {
    const events = await loadTrace(join(WALKSEED, 'trace.jsonl'));
    expect(checkTrace(events)).toEqual([]);
    const seed = events.findIndex(e => e.ev === 'seed');
    expect(events[seed]).toMatchObject({ ev: 'seed', seed: 12345 });
    const draws = events.filter(e => e.ev === 'rng');
    expect(draws).toHaveLength(8); // four members step in through entrance 0x80
    expect(draws.every(e => e.seq > seed)).toBe(true);
    expect(checkRng(events)).toEqual([]);
    // (and they aren't what the begin seed would draw)
    expect(checkRng(events.filter(e => e.ev !== 'seed'))).not.toEqual([]);
  });
});

// TRACELOAD_DIR=$HOME/pcode/unity-raw/runs/traceload
const TRACELOAD = process.env.TRACELOAD_DIR ?? '';

describe.skipIf(!TRACELOAD)('a trace across a load', () => {
  it('logs the load, and not what the load changed', async () => {
    const events = await loadTrace(join(TRACELOAD, 'trace.jsonl'));
    expect(checkTrace(events)).toEqual([]);
    // the trigger enabled before the save's load, which the load disables again
    const enabled = events.findIndex(e => e.ev === 'triggerState' && e.id === 0x40 && e.enabled);
    const load = events.findIndex(e => e.ev === 'load');
    expect(enabled).toBeGreaterThan(0);
    expect(load).toBeGreaterThan(enabled);
    expect(events.filter(e => e.ev === 'load')).toHaveLength(1);
    expect(events.slice(load + 1).filter(e => e.ev === 'triggerState' || e.ev === 'obj' || e.ev === 'global')).toEqual([]);
    // the rules found after the load
    expect(events.slice(load)).toContainEqual(expect.objectContaining({ ev: 'action', verb: 'look', target: '070103' }));
  });
});

// WALKCOMBADGE_DIR=$HOME/pcode/unity-raw/runs/walkcombadge
const WALKCOMBADGE = process.env.WALKCOMBADGE_DIR ?? '';

describe.skipIf(!WALKCOMBADGE)('a walkthrough that clicks the combadge', () => {
  it('asks first, calls only on Hail, and ends back on the ship', async () => {
    const events = await loadTrace(join(WALKCOMBADGE, 'trace.jsonl'));
    expect(checkTrace(events)).toEqual([]);
    const choices = events.filter(e => e.ev === 'choice');
    expect(choices).toMatchObject([
      { kind: 'box', question: 'Do you wish to contact the ship?', options: ['Hail', 'Ignore'], picked: 1, scripted: true },
      { kind: 'box', question: 'Do you wish to contact the ship?', options: ['Hail', 'Ignore'], picked: 0, scripted: true },
    ]);
    const hail = events.indexOf(choices[1]);
    expect(events.slice(0, hail).filter(e => e.ev === 'action' && e.target === '007002')).toEqual([]);
    expect(events.slice(hail)).toContainEqual(expect.objectContaining({ ev: 'action', verb: 'use', target: '007002', who: '000000', depth: 1 }));
    expect(events.slice(hail)).toContainEqual(expect.objectContaining({ ev: 'ship' }));
    await expectQuitItself(WALKCOMBADGE);
  });
});

// COMBAT_DIR=$HOME/pcode/unity-raw/runs/combat (sh tools/rawcheck/run-harness.sh combat 300)
const COMBAT = process.env.COMBAT_DIR ?? '';

describe.skipIf(!COMBAT)('a traced battle (Plan 22: docs/trace-format.md, "Space combat")', () => {
  it('starts as the battle starts: what it starts from, its seed, its ships, then step 0\'s snapshot', async () => {
    const events = await loadTrace(join(COMBAT, 'trace.jsonl'));
    expect(checkTrace(events)).toEqual([]);
    const start = events.findIndex(e => e.ev === 'combat');
    expect(events.slice(start, start + 4).map(e => e.ev)).toEqual(['combat', 'rng', 'ships', 'snap']);
    expect(events[start]).toMatchObject({ ev: 'combat', scenario: 1, difficulty: 0, delegate: false, lastDifficulty: 255 });
    expect(events[start + 1]).toMatchObject({ ev: 'rng', site: 'combatSeed' });
    // (Ensign: Worf is on and ready at step 0, tactical.cpp:304-334)
    expect(events[start + 3]).toMatchObject({ ev: 'snap', step: 0, delegate: true, weaponsLock: true, powerLevel: 4 });
    // (the camera setup placed: the chase view, 8.1 degrees above and behind the Enterprise; its axes' rows unit length (Plan 25))
    const snap = events[start + 3]!;
    if (snap.ev !== 'snap') throw new Error('no snapshot');
    expect(snap.camera.view).toBe(0);
    for (let r = 0; r < 3; r++) expect(Math.hypot(...snap.camera.axes.slice(r * 3, r * 3 + 3))).toBeCloseTo(1, 5);
  });

  it('traces every draw: each one replays from the seed, at a site with a draw in the unity-engine branch\'s files', async () => {
    const events = await loadTrace(join(COMBAT, 'trace.jsonl'));
    expect(checkCombatRolls(events)).toEqual([]);
    const sites = new Set(events.flatMap(e => (e.ev === 'roll' ? [e.site.split(':')[0]] : [])));
    expect([...sites].every(f => ['ai.cpp', 'tactics.cpp', 'weapons.cpp', 'damage.cpp'].includes(f!))).toBe(true);
    expect(events.filter(e => e.ev === 'roll').length).toBeGreaterThan(0);
  });

  it('snapshots every 15 steps, plays the inputs at their steps, and ends at the cap', async () => {
    const events = await loadTrace(join(COMBAT, 'trace.jsonl'));
    expect(events.filter(e => e.ev === 'snap').map(e => e.ev === 'snap' && e.step)).toEqual(Array.from({ length: 21 }, (_, i) => i * 15));
    expect(events.filter(e => e.ev === 'input').map(e => e.ev === 'input' && [e.step, e.line])).toEqual([[30, 'set shields off'], [45, 'set shields on']]);
    const at = (step: number) => events.find(e => e.ev === 'snap' && e.step === step);
    expect([at(30), at(45)].map(s => s?.ev === 'snap' && s.shieldsRaised)).toEqual([true, false]);
    expect(events.filter(e => e.ev === 'combatEnd')).toMatchObject([{ step: 300, reason: 'cap' }]);
    await expectQuitItself(COMBAT);
  });
});
