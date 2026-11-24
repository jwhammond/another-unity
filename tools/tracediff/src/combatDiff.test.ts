// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { combatSim } from '@another-unity/engine';
import { diffBattle, float32Json, parityExit, parityLines, renderParityReport, traceLine, type CombatDiff, type ParityRow } from './combatDiff';

type CombatEvent = combatSim.CombatEvent;
/** The mutants the table makes of its battle (counted, so a walker that stops early can't pass). */
const MUTANTS = 386;
/** A camera as a snapshot has it (Plan 25): its position, its axes' rows and the view. */
const CAMERA: combatSim.CameraSnap = { pos: [10.5, -84.25, -594], axes: [1, 0, 0, 0, 0.990058243, -0.140657991, 0, 0.140657991, 0.990058243], view: 0 };

describe('a parity report', () => {
  it('reports each battle\'s verdict, problems before a clean diff and a run that didn\'t finish, and the atan2f calls', () => {
    const diff: CombatDiff = { clean: false, first: 'step 30: roll 4: x', differences: [{ step: 30, what: 'roll 4: x' }], atan2: { 'combat.cpp:651': 2 }, atan2Unused: {}, counts: { rolls: 9, snaps: 3, steps: 40 }, problems: [] };
    const clean: CombatDiff = { ...diff, clean: true, first: null, differences: [], atan2: {} };
    const rows: ParityRow[] = [
      { battle: 3, label: 'b3', diff, problems: [], finished: true },
      { battle: 4, label: 'b4', diff: clean, problems: [], finished: true },
      { battle: 5, label: 'b5', diff: clean, problems: ['step 2: x'], finished: true },
      { battle: 6, label: 'b6', diff: clean, problems: [], finished: false },
      { battle: 7, label: 'b7', diff: null, problems: [], finished: true },
      { battle: 8, label: 'b8', diff: { ...clean, problems: ['step 9: y'], atan2Unused: { 'combat.cpp:808': 1 } }, problems: [], finished: true },
    ];
    expect(renderParityReport(rows, 'test')).toBe([
      '# Combat parity: test', '', '| battle | run | steps | rolls | verdict | atan2f taken | atan2f unused |', '|---|---|---|---|---|---|---|',
      '| 3 | b3 | 40 | 9 | DIFFERS at step 30 | 2 | 0 |', '| 4 | b4 | 40 | 9 | CLEAN | 0 | 0 |', '| 5 | b5 | 40 | 9 | PROBLEMS | 0 | 0 |',
      '| 6 | b6 | 40 | 9 | DIDN\'T FINISH | 0 | 0 |', '| 7 | b7 | - | - | NOT COMPARED | 0 | 0 |', '| 8 | b8 | 40 | 9 | PROBLEMS | 0 | 1 |',
      '', '## Battle 3 (b3)', '', '- step 30: roll 4: x', '- atan2f taken: combat.cpp:651 2',
      '', '## Battle 5 (b5)', '', '- problem: step 2: x',
      '', '## Battle 6 (b6)', '', '- ScummVM\'s run didn\'t finish: its trace has no combatEnd, and the replay went as far as it did',
      '', '## Battle 7 (b7)', '', '- not compared',
      '', '## Battle 8 (b8)', '', '- problem: step 9: y', '- atan2f unused: combat.cpp:808 1', '',
    ].join('\n'));
    // (the command's lines and exit code say what the verdict column does)
    expect(rows.map(parityLines)).toEqual([
      ['battle 3: DIFFERS at step 30: step 30: roll 4: x', 'battle 3: atan2f taken: combat.cpp:651 2'], ['battle 4: CLEAN'], ['battle 5: PROBLEMS: step 2: x'],
      ['battle 6: DIDN\'T FINISH: ScummVM\'s run stopped short, and what it logged matches'], ['battle 7: NOT COMPARED'],
      ['battle 8: PROBLEMS: step 9: y', 'battle 8: atan2f unused: combat.cpp:808 1'],
    ]);
    const [b3, b4, b5, b6, b7, b8] = rows.map(r => [r]) as ParityRow[][];
    expect([b3, b4, b5, b6, b7, b8, [...b4!, ...b6!], [...b6!, ...b5!], []].map(x => parityExit(x!))).toEqual([1, 0, 1, 2, 2, 1, 2, 1, 2]);
  });

  it('finds every change to a battle\'s compared events, either way: each roll field, each snapshot leaf, each ordered event\'s key, a dropped or extra event, a shorter array', () => {
    const ship = (index: number): combatSim.ShipSnap => ({
      index, pos: [100.5, -2.25, 3], velocity: [0.5, 0, -1], angles: [10, 20, 30], speed: 1.5, condition: 90, flags: 2, destroyed: false, removed: false,
      target: 1 - index, engaged: true, removeTime: 0, units: [[1, 2, 3, 4, 5], [6, 7, 8, 9, 10]], pool: 100, torpedoes: 5,
    });
    const snap = (step: number): CombatEvent => ({
      ev: 'snap', step, now: 1000 + step, exit: 0xffff, target: 1, redAlert: true, delegate: false, weaponsLock: true, shieldsRaised: true, powerLevel: 4,
      kernelReady: false, random: 7, camera: structuredClone(CAMERA), ships: [ship(0), ship(1)], torpedoes: [{ slot: 2, pos: [1.5, 2.5, 3.5], angles: [1, 2, 3], shooter: 0, target: 1, expiry: 5000 }],
    });
    const base: CombatEvent[] = [
      { ev: 'roll', step: 1, site: 'ai.cpp:1', n: 3, value: 1 }, { ev: 'roll', step: 1, site: 'weapons.cpp:2', n: 10, value: 4 }, snap(15),
      { ev: 'hails', step: 20, site: 'damage.cpp:672', type: 7 }, { ev: 'standDown', step: 20, site: 'tactical.cpp:1' },
      { ev: 'hailsEnd', step: 20, result: true, type: 0xff, exit: 0xffff, redAlert: true, removeTimes: [0, 0] },
      { ev: 'roll', step: 21, site: 'damage.cpp:3', n: 100, value: 50 }, { ev: 'input', step: 21, line: 'delegate off' }, { ev: 'warp', step: 22, wait: 873 },
      snap(30), { ev: 'leave', step: 30, code: 0 }, snap(30), { ev: 'combatEnd', step: 30, reason: 'leave' },
    ];
    expect(diffBattle(base, base).clean).toBe(true);
    // (not compared, by design: what processHails left, which the replay echoes from ScummVM's trace; a hails' and a stand-down's site)
    const exempt = (e: CombatEvent, key: string | number) => key === 'ev' || (e.ev === 'hailsEnd' && key !== 'step') || ((e.ev === 'hails' || e.ev === 'standDown') && key === 'site');
    type Path = (string | number)[];
    const walk = (v: unknown, path: Path, out: { path: Path; v: unknown }[]) => {
      out.push({ path, v });
      if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, [...path, Array.isArray(v) ? Number(k) : k], out);
      return out;
    };
    const mutants: { what: string; events: CombatEvent[] }[] = [];
    const at = (es: CombatEvent[], i: number, path: Path, f: (parent: Record<string | number, unknown>, key: string | number) => void) => {
      const copy = structuredClone(es);
      let o = copy[i] as unknown as Record<string | number, unknown>;
      for (const k of path.slice(0, -1)) o = o[k] as Record<string | number, unknown>;
      f(o, path.at(-1)!);
      return copy;
    };
    base.forEach((e, i) => {
      mutants.push({ what: `event ${i} (${e.ev}) dropped`, events: base.filter((_, k) => k !== i) });
      mutants.push({ what: `event ${i} (${e.ev}) again at the end`, events: [...base, e] });
      for (const { path, v } of walk(e, [], []).slice(1)) {
        if (exempt(e, path[0]!)) continue;
        const what = `event ${i} (${e.ev}) ${path.join('.')}`;
        if (typeof v === 'number') mutants.push({ what, events: at(base, i, path, (o, k) => { o[k] = v + 1; }) });
        else if (typeof v === 'boolean') mutants.push({ what, events: at(base, i, path, (o, k) => { o[k] = !v; }) });
        else if (typeof v === 'string') mutants.push({ what, events: at(base, i, path, (o, k) => { o[k] = k === 'reason' ? 'cap' : `${v} x`; }) });
        else if (Array.isArray(v)) mutants.push({ what: `${what} shorter`, events: at(base, i, path, (o, k) => { (o[k] as unknown[]).pop(); }) });
      }
    });
    expect(mutants.length).toBe(MUTANTS);
    const missed = mutants.filter(m => diffBattle(base, m.events).clean || diffBattle(m.events, base).clean).map(m => m.what);
    expect(missed).toEqual([]);
  });

  it('reports the first non-finite float ScummVM wrote (null) as a problem, though the port\'s non-finite value matches it', () => {
    const snap = (step: number, z: number | null): CombatEvent => ({
      ev: 'snap', step, now: 1, exit: 0xffff, target: -1, redAlert: true, delegate: true, weaponsLock: true, shieldsRaised: true, powerLevel: 4, kernelReady: true, random: 7, camera: CAMERA, torpedoes: [],
      ships: [{ index: 0, pos: [1, 2, z as number], velocity: [0, 0, 0], angles: [0, 0, 0], speed: 0, condition: 0, flags: 0, destroyed: false, removed: false, target: -1, engaged: false, removeTime: 0, units: [], pool: 0, torpedoes: 0 }],
    });
    expect(diffBattle([snap(15, 3), snap(30, null), snap(45, null)], [snap(15, 3), snap(30, NaN), snap(45, Infinity)]))
      .toMatchObject({ clean: true, problems: ['step 30: ScummVM\'s snapshot has a non-finite float at ships[0].pos[2]: not comparable from here'] });
    expect(diffBattle([snap(15, 3)], [snap(15, 3)]).problems).toEqual([]);
  });

  it('reads back the port\'s events written by traceLine as they were, -0 and all, where JSON.stringify would lose it (for Task 7\'s writers)', () => {
    const snap: CombatEvent = {
      ev: 'snap', step: 15, now: 1, exit: 0xffff, target: -1, redAlert: true, delegate: true, weaponsLock: true, shieldsRaised: true, powerLevel: 4, kernelReady: true, random: 7, camera: CAMERA, torpedoes: [],
      ships: [{ index: 0, pos: [-0, 2, 3], velocity: [0, -0, 0], angles: [0, 0, 0], speed: 0, condition: 0, flags: 0, destroyed: false, removed: false, target: -1, engaged: false, removeTime: 0, units: [], pool: 0, torpedoes: 0 }],
    };
    expect(diffBattle([JSON.parse(traceLine(snap)) as CombatEvent], [snap]).clean).toBe(true);
    expect(diffBattle([JSON.parse(JSON.stringify(snap)) as CombatEvent], [snap]).clean).toBe(false);
    // (an atan2 event's inputs are written as the export writes floats: combattrace.cpp:192-194)
    expect(traceLine({ ev: 'atan2', step: 1, site: 'combat.cpp:651', s: 1e-5, c: -0, angle: 3, rounded: 2 }))
      .toBe('{"ev":"atan2","step":1,"site":"combat.cpp:651","s":9.99999975e-06,"c":-0,"angle":3,"rounded":2}');
  });

  it('compares a stand-down by its step only (its site is the export\'s line), and finds one at another step', () => {
    const end: combatSim.CombatEvent = { ev: 'combatEnd', step: 40, reason: 'won' };
    const at = (step: number, site: string): combatSim.CombatEvent => ({ ev: 'standDown', step, site });
    expect(diffBattle([at(40, 'tactical.cpp:494'), end], [at(40, 'tactical.cpp:482'), end]).clean).toBe(true);
    expect(diffBattle([at(40, 'tactical.cpp:494'), end], [at(39, 'tactical.cpp:482'), end]).first).toBe('step 39: event 1: standDown@40 (ScummVM) vs standDown@39 (port)');
  });

  it('compares the camera as it does a ship (M8 spec Decision 12), and says a trace without one predates it', () => {
    const snap: Extract<combatSim.CombatEvent, { ev: 'snap' }> = { ev: 'snap', step: 15, now: 1, exit: 0xffff, target: -1, redAlert: true, delegate: true, weaponsLock: true, shieldsRaised: true, powerLevel: 4, kernelReady: true, random: 7, camera: CAMERA, ships: [], torpedoes: [] };
    // (its floats as float32 values: a difference below a float32 step is none, one step is one)
    const moved = { ...snap, camera: { ...CAMERA, axes: CAMERA.axes.map((a, i) => (i === 4 ? Math.fround(a) + 2 ** -24 : a)) } };
    expect(diffBattle([snap], [moved]).first).toBe('step 15: snapshot at step 15: camera.axes[4]: 0.990058243 (ScummVM) vs 0.990058303 (port)');
    expect(diffBattle([snap], [{ ...snap, camera: { ...CAMERA, view: 0xc } }]).first).toBe('step 15: snapshot at step 15: camera.view: 0 (ScummVM) vs 12 (port)');
    // (an export from before Plan 25: the rest is compared, and the battle has a problem until it is fought again)
    const { camera: _, ...old } = snap;
    const r = diffBattle([old as typeof snap], [snap]);
    expect([r.clean, r.problems]).toEqual([true, ['ScummVM\'s trace has no camera (an export from before Plan 25): its camera is not compared; re-export and fight again']]);
  });

  it('finds a snapshot one side lacks', () => {
    const snap: Extract<combatSim.CombatEvent, { ev: 'snap' }> = { ev: 'snap', step: 15, now: 1, exit: 0xffff, target: -1, redAlert: true, delegate: true, weaponsLock: true, shieldsRaised: true, powerLevel: 4, kernelReady: true, random: 7, camera: CAMERA, ships: [], torpedoes: [] };
    expect(diffBattle([snap], []).first).toBe('step 15: snapshot at step 15: the port has none');
    expect(diffBattle([], [snap]).first).toBe('step 15: snapshot at step 15: ScummVM has none');
    // (the generator's state is an integer, compared exactly even above 2^24, where a float32 would blur it)
    expect(diffBattle([{ ...snap, random: 2 ** 31 + 1 }], [{ ...snap, random: 2 ** 31 }]).first).toBe('step 15: snapshot at step 15: random: 2147483649 (ScummVM) vs 2147483648 (port)');
  });

  it('writes and compares a float as the export\'s JsonWriter does: %.9g, -0 kept, and NaN or an infinity as null', () => {
    // (jsonwriter.cpp:72-79; %.9g by hand: 0.1f is 0.100000001490116, nine digits 0.100000001; 1e-5f goes exponential, as %g below 1e-4)
    expect([0.1, 3000.5, -0, 0, 1e-5, 123456789, NaN, Infinity, 1e39].map(float32Json))
      .toEqual(['0.100000001', '3000.5', '-0', '0', '9.99999975e-06', '123456792', 'null', 'null', 'null']);
    const ship: combatSim.ShipSnap = { index: 0, pos: [-0, 1, NaN], velocity: [0, 0, 0], angles: [0, 0, 0], speed: -0, condition: 0, flags: 0, destroyed: false, removed: false, target: -1, engaged: false, removeTime: 0, units: [], pool: 0, torpedoes: 0 };
    const port: Extract<combatSim.CombatEvent, { ev: 'snap' }> = { ev: 'snap', step: 15, now: 1, exit: 0xffff, target: -1, redAlert: true, delegate: true, weaponsLock: true, shieldsRaised: true, powerLevel: 4, kernelReady: true, random: 7, camera: CAMERA, ships: [ship], torpedoes: [] };
    const line = traceLine(port);
    expect(line).toContain('"pos":[-0,1,null]');
    expect(line).toContain('"speed":-0');
    // (ScummVM's line read back: -0 and null as written; the port's in memory is the same)
    const traced = JSON.parse(line) as typeof port;
    expect(Object.is(traced.ships[0]!.speed, -0)).toBe(true);
    expect(diffBattle([traced], [port]).clean).toBe(true);
    // (-0 is not 0: "%.9g" tells them apart, so the diff does)
    const plus = { ...port, ships: [{ ...port.ships[0]!, speed: 0 }] };
    expect(diffBattle([traced], [plus]).first).toBe('step 15: snapshot at step 15: ships[0].speed: -0 (ScummVM) vs 0 (port)');
    // (a non-finite float is null in the trace, whichever it was: an infinity in the port matches; a number doesn't)
    const inf = { ...port, ships: [{ ...port.ships[0]!, pos: [-0, 1, -Infinity] as [number, number, number] }] };
    expect(diffBattle([traced], [inf]).clean).toBe(true);
    const finite = { ...port, ships: [{ ...port.ships[0]!, pos: [-0, 1, 2] as [number, number, number] }] };
    expect(diffBattle([traced], [finite]).first).toBe('step 15: snapshot at step 15: ships[0].pos[2]: null (ScummVM) vs 2 (port)');
  });
});
