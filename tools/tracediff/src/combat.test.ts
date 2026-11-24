// SPDX-License-Identifier: GPL-3.0-or-later
import { TACTIC, TOKEN, addTactics, assembleTactics, combatSim, miniEnterpriseUnits, miniTacticsCombat, type GameContent } from '@another-unity/engine';
import { describe, expect, it } from 'vitest';
import { HOOK_SITES, hailBlocks, hookSeams, readBattles, replayBattle, type TraceBattle } from './combat';
import { diffBattle, traceLine, verdictOf } from './combatDiff';

type CombatEvent = combatSim.CombatEvent;

/** The made-up game: miniTacticsCombat's battle 3 (the Enterprise on worfTactics and a chodak on zapTactics, objects 100300 and 100301). */
const content = { ship: { combat: miniTacticsCombat(), data: { units: miniEnterpriseUnits() } } } as unknown as GameContent;
const HEX: Record<string, string> = { 'space.enterprise': '100300', 'space.chodak': '100301' };
const hexOf = (slug: string) => HEX[slug];

/** The Enterprise's unit rows as the `combat` event has them (current, target, max, damage, repair, nextStep, nextRepair), a new game's. */
const enterpriseRows = () => miniEnterpriseUnits().map(u => [u.current, u.target, u.max, u.damage, u.repair, 0, 0]);

/** A traced battle's start, as the export writes it, at Ensign, the Enterprise's systems as a new game has them. */
function traced(events: CombatEvent[], o: { difficulty?: 0 | 1 | 2; units?: number[][] } = {}): TraceBattle {
  const units = o.units ?? enterpriseRows();
  return {
    start: {
      scenario: 3, difficulty: o.difficulty ?? 0, delegate: false, lastDifficulty: 0xff, astrogation: [0, 0, 0],
      enterprise: { units, pool: 1625, torpedoes: 275, matterAntimatterOutput: 0, fusionOutput: 0, lastReactorTick: 0, lastTick: 0 },
      objects: [{ id: '100300', active: true, state: 0 }, { id: '100301', active: true, state: 0 }],
    },
    seed: 1234, now: 10000, ships: [{ index: 0, type: 2, id: '100300' }, { index: 1, type: 0, id: '100301' }], events,
  };
}
const end = (step: number): CombatEvent => ({ ev: 'combatEnd', step, reason: 'cap' });
/** The port's own run of a battle to `steps`, as if it were ScummVM's trace. */
const own = (steps: number, more: CombatEvent[] = [], o = {}) => replayBattle(content, hexOf, traced([...more, end(steps)], o)).events;

describe('a battle from a trace, and its replay in the port', () => {
  it('reads a trace\'s battles: the start, the combat seed, the setup clock and ships, and the combat events in order', () => {
    const lines = [
      { seq: 0, ev: 'begin', version: 1, engine: 'scummvm', seed: 42 },
      { seq: 1, ev: 'rng', site: 'combatSeed', max: 0x7fffffff, value: 99 },
      { seq: 2, ev: 'combat', ...traced([]).start },
      { seq: 3, ev: 'rng', site: 'combatSeed', max: 0x7fffffff, value: 1234 },
      { seq: 4, ev: 'ships', now: 10000, ships: traced([]).ships },
      { seq: 5, ev: 'roll', step: 1, site: 'ai.cpp:367', n: 3, value: 1 },
      { seq: 6, ev: 'obj', id: '000000', field: 'x', from: 1, to: 2 },
      { seq: 7, ev: 'rng', site: 'combatSeed', max: 0x7fffffff, value: 5 },
      { seq: 8, ev: 'combatEnd', step: 1, reason: 'cap' },
      { seq: 9, ev: 'roll', step: 2, site: 'ai.cpp:367', n: 3, value: 2 },
      { seq: 10, ev: 'end' },
    ];
    const { battles, problems } = readBattles(lines.map(l => JSON.stringify(l)).join('\n'));
    // (the seed is the first combatSeed draw after the battle's start; nothing after its combatEnd is the battle's)
    expect(problems).toEqual([]);
    expect(battles).toEqual([{ ...traced([]), events: [{ ev: 'roll', step: 1, site: 'ai.cpp:367', n: 3, value: 1 }, end(1)] }]);
  });

  it('replays to the trace\'s end: a snapshot at 0, every 15 steps and at the end, and the same run twice', () => {
    const events = own(40);
    expect(events.filter(e => e.ev === 'snap').map(e => e.step)).toEqual([0, 15, 30, 40]);
    expect(events.at(-1)).toEqual(end(40));
    expect(own(40)).toEqual(events);
    // (an end on the snapshots' cycle has the one snapshot)
    expect(own(30).filter(e => e.ev === 'snap').map(e => e.step)).toEqual([0, 15, 30]);
    // (Ensign: Worf is on, ready from the start)
    const first = events[0]!;
    expect(first.ev === 'snap' && [first.delegate, first.weaponsLock, first.powerLevel]).toEqual([true, true, 4]);
  });

  it('hears the battle as each step leaves it, before the next frame\'s inputs: tools/combatshots draws a shot\'s step from it (Plan 25)', () => {
    const heard: [number, number][] = [];
    const r = replayBattle(content, hexOf, traced([{ ev: 'input', step: 3, line: 'view 3 enterprise' }, end(6)]), undefined, {
      atStep: b => { heard.push([b.steps, b.view.view]); },
    });
    // (the input at step 3 lands before step 4: step 3's battle still has the chase view, as the screen drawn after it does)
    expect(heard).toEqual([[1, 0], [2, 0], [3, 0], [4, 3], [5, 3], [6, 3]]);
    expect(r.events.filter(e => e.ev === 'snap').map(e => e.ev === 'snap' && e.camera.view)).toEqual([0, 3]);
  });

  it('takes ScummVM\'s atan2f angle at the camera\'s lookAt yaw (combat.cpp:808), as at a simulation site, and says one it never asked (Plan 25)', () => {
    const { angleFromSinCos, fma32, fr, sqrtf, sub, toInternal } = combatSim;
    const input: CombatEvent = { ev: 'input', step: 3, line: 'view 16 enterprise' };
    // (the tracking view's lookAt at step 5, as the port asks it: from the camera, which tracking doesn't move, to the Enterprise)
    let d = { x: 0, y: 0, z: 0 };
    replayBattle(content, hexOf, traced([input, end(6)]), undefined, {
      atStep: b => { if (b.steps === 5) d = sub(toInternal(b.ships[0]!.pos), b.view.camera.pos); },
    });
    const s = d.x, c = d.z, rounded = angleFromSinCos(s, c);
    // (ScummVM's angle one apart from the rounded one: the libm-atan2f allowance's case)
    const logged: CombatEvent = { ev: 'atan2', step: 5, site: 'combat.cpp:808', s, c, angle: (rounded + 1) & 0x3fff, rounded };
    // (the camera as step 5 left it, the port's own and with ScummVM's yaw taken)
    const axes = (events: CombatEvent[]) => {
      let out: number[] = [];
      const r = replayBattle(content, hexOf, traced([input, ...events, end(6)]), undefined, { atStep: bs => { if (bs.steps === 5) out = [...bs.view.camera.axes]; } });
      return { r, axes: out };
    };
    const plain = axes([]), scummvm = axes([logged]);
    expect(scummvm.r.events).toContainEqual(logged);
    expect(scummvm.r.problems).toEqual([]);
    expect(scummvm.axes).not.toEqual(plain.axes);
    expect(scummvm.axes).toEqual(combatSim.fromAngles(logged.angle, angleFromSinCos(-d.y, sqrtf(fma32(d.x, d.x, fr(d.z * d.z)))), 0));
    // (ScummVM's events with the angle, against the port's taking it: no problem; against a port that never asked it, the 808 take alone dropped: one)
    const traceEvents = [...scummvm.r.events];
    expect(diffBattle(traceEvents, scummvm.r.events).problems).toEqual([]);
    const unasked = diffBattle(traceEvents, scummvm.r.events.filter(e => !(e.ev === 'atan2' && e.site === 'combat.cpp:808')));
    expect(unasked.problems).toEqual(['step 5: ScummVM\'s atan2f at combat.cpp:808 (a simulation call) was never asked by the port']);
  });

  it('is clean against itself, and finds a changed roll, a snapshot apart by more than a float32 rounding, and a missing input', () => {
    const port = own(60);
    expect(diffBattle(port, port).clean).toBe(true);
    const rolls = port.filter(e => e.ev === 'roll');
    expect(rolls.length).toBeGreaterThan(0);
    const i = port.indexOf(rolls[0]!);
    const changed = port.map((e, k) => (k === i && e.ev === 'roll' ? { ...e, value: e.value + 1 } : e));
    expect(diffBattle(changed, port).first).toMatch(new RegExp(`^step ${rolls[0]!.step}: roll 1: `));
    const snapAt = (es: CombatEvent[], step: number, f: (s: Extract<CombatEvent, { ev: 'snap' }>) => object) =>
      es.map(e => (e.ev === 'snap' && e.step === step ? { ...e, ...f(e) } : e));
    // (ScummVM's nine digits read back to the same float32: no difference)
    const nine = snapAt(port, 30, s => ({ ships: s.ships.map(x => ({ ...x, speed: Number(x.speed.toPrecision(9)) })) }));
    expect(diffBattle(nine, port).clean).toBe(true);
    const moved = snapAt(port, 30, s => ({ ships: s.ships.map((x, k) => (k === 1 ? { ...x, pos: [x.pos[0] + 1, x.pos[1], x.pos[2]] } : x)) }));
    expect(diffBattle(moved, port).first).toMatch(/^step 30: snapshot at step 30: ships\[1\]\.pos\[0\]: /);
    const withInput = own(60, [{ ev: 'input', step: 20, line: 'delegate off' }]);
    expect(diffBattle(withInput, port).first).toMatch(/^step 20: event 1: input@20 delegate off \(ScummVM\) vs combatEnd@60 cap \(port\)/);
  });

  it('replays a trace\'s next battle from the last one\'s end, as the session\'s one Combat carries it: Delegate kept at the same difficulty (Plan 23)', () => {
    // (at Lieutenant Delegate starts off; the player turns it on)
    const first = replayBattle(content, hexOf, traced([{ ev: 'input', step: 1, line: 'delegate on' }, end(5)], { difficulty: 1 }));
    expect(first.battle!.console.delegate).toBe(true);
    // (the next battle at the same difficulty keeps Delegate as the last left it: tactical.cpp:305-308)
    const next = traced([end(5)], { difficulty: 1 });
    next.start.lastDifficulty = 1;
    const delegateAt0 = (r: ReturnType<typeof replayBattle>) => { const e = r.events[0]!; return e.ev === 'snap' && e.delegate; };
    expect(delegateAt0(replayBattle(content, hexOf, next))).toBe(false);
    expect(delegateAt0(replayBattle(content, hexOf, next, first.battle!))).toBe(true);
  });

  it('plays the trace\'s inputs at their steps, and takes what ScummVM\'s processHails left: the Enter object\'s at step 0 ends it', () => {
    const port = own(30, [{ ev: 'input', step: 3, line: 'delegate off' }]);
    const snap10 = port.find(e => e.ev === 'snap' && e.step === 15);
    expect(port.filter(e => e.ev === 'input')).toEqual([{ ev: 'input', step: 3, line: 'delegate off' }]);
    expect(snap10?.ev === 'snap' && snap10.delegate).toBe(false);
    // (a type 0xd hail from the Enter object: the battle is over, back to the bridge, tactical.cpp:399-404)
    const hails: CombatEvent[] = [
      { ev: 'hails', step: 0, site: 'tactical.cpp:476', type: 0xd },
      { ev: 'standDown', step: 0, site: 'tactical.cpp:378' },
      { ev: 'hailsEnd', step: 0, result: false, type: 0xff, exit: 0, redAlert: false, removeTimes: [0, 0] },
    ];
    const r = replayBattle(content, hexOf, traced([...hails, end(5)]));
    expect(r.problems).toEqual([]);
    expect(r.events.filter(e => e.ev !== 'roll' && e.ev !== 'snap').map(e => e.ev)).toEqual(['hails', 'standDown', 'hailsEnd', 'leave', 'combatEnd']);
    expect(r.events.find(e => e.ev === 'leave')).toEqual({ ev: 'leave', step: 1, code: 0 });
  });

  it('says a trace that never ended didn\'t finish, and replays only as far as it went, its last step\'s inputs and no end of its own (Review Focus 3)', () => {
    const port = own(40, [{ ev: 'input', step: 30, line: 'delegate off' }, { ev: 'input', step: 37, line: 'delegate on' }]);
    // (cut at a snapshot's step, and off the snapshots' cycle: an input logged at the last step was played, as ScummVM got past its checks there)
    for (const last of [30, 37]) {
      const cut = port.filter(e => e.ev !== 'combatEnd' && 'step' in e && e.step <= last);
      const r = replayBattle(content, hexOf, traced(cut));
      expect(r.finished).toBe(false);
      expect(r.problems).toEqual([]);
      expect(r.events.some(e => e.ev === 'combatEnd')).toBe(false);
      expect(r.events.filter(e => e.ev === 'input').at(-1)).toEqual({ ev: 'input', step: last, line: last === 30 ? 'delegate off' : 'delegate on' });
      expect(diffBattle(cut, r.events)).toMatchObject({ clean: true, problems: [] });
      expect(verdictOf({ battle: 3, label: 'cut', diff: diffBattle(cut, r.events), problems: r.problems, finished: r.finished })).toBe('DIDN\'T FINISH');
    }
    expect(replayBattle(content, hexOf, traced(port)).finished).toBe(true);
  });

  it('wires each hook seam to its own line in the export\'s damage.cpp', () => {
    const asked: string[] = [];
    const seams = hookSeams((_bs, site) => { asked.push(site); return combatSim.NO_HOOK; });
    const [c, b, s] = [{}, {}, {}] as never[];
    seams.eventScript(c, b, s, 0);
    seams.hailScript(c, b, s, 0);
    seams.hullLowScript(c, b, s);
    seams.destroyedScript(c, b, s);
    expect(asked).toEqual(['damage.cpp:672', 'damage.cpp:693', 'damage.cpp:713', 'damage.cpp:731']);
  });

  it('stands down where the battle is won, and echoes it before the end (tactical.cpp:482)', () => {
    const events = own(3000).filter(e => e.ev === 'standDown' || e.ev === 'combatEnd');
    const last = events.at(-1)!;
    expect(last).toMatchObject({ ev: 'combatEnd', reason: 'won' });
    expect(events.at(-2)).toEqual({ ev: 'standDown', step: last.step, site: 'tactical.cpp:482' });
  });

  it('compares the ships setup built, each index\'s type and object, with ScummVM\'s `ships` event', () => {
    expect(replayBattle(content, hexOf, traced([end(5)])).problems).toEqual([]);
    const wrong = { ...traced([end(5)]), ships: [{ index: 0, type: 2, id: '100300' }, { index: 1, type: 1, id: '100302' }] };
    expect(replayBattle(content, hexOf, wrong).problems).toEqual(['setup: the ships (index:type:object) are 0:2:100300 1:1:100302 in ScummVM, 0:2:100300 1:0:100301 in the port']);
    const fewer = { ...traced([end(5)]), ships: [{ index: 0, type: 2, id: '100300' }] };
    expect(replayBattle(content, hexOf, fewer).problems).toHaveLength(1);
  });

  it('says an input line of ScummVM\'s that the port can\'t read, and doesn\'t play it', () => {
    const r = replayBattle(content, hexOf, traced([{ ev: 'input', step: 3, line: ' delegate off' }, end(5)]));
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatch(/^step 3: /);
    expect(r.events.some(e => e.ev === 'input')).toBe(false);
  });

  // (the made-up battle runs its event hook, Combat::runEventHook's processHails at damage.cpp:672, first at step 27, and next at 35)
  const hook = (step: number, site: string): CombatEvent[] => [
    { ev: 'hails', step, site, type: 0 },
    { ev: 'hailsEnd', step, result: false, type: 0xff, exit: 0xffff, redAlert: true, removeTimes: [] },
  ];
  it('takes a hook\'s processHails only from its own line and at its own step, and says which ScummVM made that the port didn\'t (R8)', () => {
    expect(replayBattle(content, hexOf, traced([...hook(27, HOOK_SITES.eventScript), end(30)])).problems).toEqual([]);
    for (const site of [HOOK_SITES.hailScript, HOOK_SITES.hullLowScript, HOOK_SITES.destroyedScript]) {
      expect(replayBattle(content, hexOf, traced([...hook(27, site), end(30)])).problems).toEqual([`step 27: ScummVM's processHails from ${site} had no call in the port`]);
    }
    expect(replayBattle(content, hexOf, traced([...hook(28, HOOK_SITES.eventScript), end(40)])).problems).toEqual(['step 28: ScummVM\'s processHails from damage.cpp:672 had no call in the port']);
    expect(replayBattle(content, hexOf, traced([...hook(26, HOOK_SITES.eventScript), end(40)])).problems).toEqual(['step 26: ScummVM\'s processHails from damage.cpp:672 had no call in the port']);
    // (the Enter object's is the first frame's, at step 0 only, and never a hook's)
    expect(replayBattle(content, hexOf, traced([...hook(0, HOOK_SITES.hullLowScript), end(5)])).problems).toEqual(['step 0: ScummVM\'s processHails from damage.cpp:713 had no call in the port']);
    expect(replayBattle(content, hexOf, traced([...hook(2, 'tactical.cpp:476'), end(5)])).problems).toEqual(['step 2: ScummVM\'s processHails from tactical.cpp:476 had no call in the port']);
  });

  it('takes only what processHails can change (R8, tactical.cpp:377-436), and says what else ScummVM\'s left apart from the port', () => {
    const block = (type: number, end: Partial<Extract<CombatEvent, { ev: 'hailsEnd' }>>, standDown = false): CombatEvent[] => [
      { ev: 'hails', step: 27, site: HOOK_SITES.eventScript, type },
      ...(standDown ? [{ ev: 'standDown', step: 27, site: 'tactical.cpp:423' } as CombatEvent] : []),
      { ev: 'hailsEnd', step: 27, result: false, type: 0xff, exit: 0xffff, redAlert: true, removeTimes: [0, 0], ...end },
    ];
    const run = (es: CombatEvent[]) => {
      const r = replayBattle(content, hexOf, traced([...es, end(30)]));
      const snap = r.events.find(e => e.ev === 'snap' && e.step === 30);
      return { problems: r.problems, snap: snap?.ev === 'snap' ? snap : null };
    };
    // (0x10: everyone blows up in turn, the remove times it set where they were 0, and it stood down: :420-427)
    const blowUp = run(block(0x10, { redAlert: false, removeTimes: [88888888, 99999999] }, true));
    expect(blowUp.problems).toEqual([]);
    expect(blowUp.snap!.ships.map(x => x.removeTime)).toEqual([88888888, 99999999]);
    // (another type sets no remove time, nor the red alert without a stand-down or 0xf, nor the exit without 0xd or 7)
    const other = run(block(0, { exit: 0, redAlert: false, removeTimes: [0, 99999999] }));
    expect(other.problems).toEqual([
      'step 27: ScummVM\'s processHails from damage.cpp:672 left the exit 0, which its hails can\'t set; the port has 65535',
      'step 27: ScummVM\'s processHails from damage.cpp:672 left the red alert false, which its hails can\'t set; the port has true',
      'step 27: ScummVM\'s processHails from damage.cpp:672 left ship 1\'s remove time 99999999, which its hails can\'t set; the port has 0',
    ]);
    expect([other.snap!.exit, other.snap!.ships[1]!.removeTime]).toEqual([0xffff, 0]);
    // (0xf: the red alert on, :416-418)
    expect(run(block(0xf, { redAlert: false })).problems).toEqual([]);
  });

  it('reads a half-written last line of a battle that never ended as the run stopping there; a bad line anywhere else is not JSON', () => {
    const head = [
      { seq: 0, ev: 'begin', version: 1, engine: 'scummvm', seed: 42 },
      { seq: 1, ev: 'combat', ...traced([]).start },
      { seq: 2, ev: 'rng', site: 'combatSeed', max: 0x7fffffff, value: 1234 },
      { seq: 3, ev: 'ships', now: 10000, ships: traced([]).ships },
    ].map(l => JSON.stringify(l));
    const port = own(40);
    const cut = port.slice(0, port.findIndex(e => e.ev === 'snap' && e.step === 30) + 1);
    const half = '{"seq":99,"ev":"roll","step":3';
    // (written as the export writes them: JSON.stringify would lose a -0)
    const read = readBattles([...head, ...cut.map(traceLine), half, ''].join('\n'));
    expect(read.problems).toEqual([]);
    expect(read.notes).toEqual([`line ${head.length + cut.length + 1}: half-written, dropped: the run stopped part way through its battle`]);
    // (every event read, its floats as float32 values: nine digits read back to the same float, not the same double)
    expect(read.battles[0]!.events).toHaveLength(cut.length);
    expect(diffBattle(read.battles[0]!.events, cut).clean).toBe(true);
    const r = replayBattle(content, hexOf, read.battles[0]!);
    expect(verdictOf({ battle: 3, label: 'half', diff: diffBattle(read.battles[0]!.events, r.events), problems: r.problems, finished: r.finished })).toBe('DIDN\'T FINISH');
    // (in the middle, or after the battle's combatEnd: an error)
    const middle = readBattles([...head, half, ...cut.map(traceLine)].join('\n'));
    expect([middle.problems, middle.notes]).toEqual([[`line ${head.length + 1}: not JSON`], []]);
    const after = readBattles([...head, ...port.map(traceLine), half].join('\n'));
    expect([after.problems, after.notes]).toEqual([[`line ${head.length + port.length + 1}: not JSON`], []]);
  });

  it('compares a trace cut part way through a step as a prefix of that step: it didn\'t finish, and doesn\'t differ (Review Focus 3)', () => {
    // (blind sensors, so a step has the radar's draw after its own: units 8-12 at 0)
    const units = enterpriseRows();
    for (let i = 8; i <= 12; i++) units[i]![0] = 0;
    const port = replayBattle(content, hexOf, traced([end(40)], { units })).events;
    for (const step of [1, 39]) {
      // (several rolls at the step, and the trace stops after the first)
      expect(port.filter(e => e.ev === 'roll' && e.step === step).length).toBeGreaterThan(1);
      const cut = port.slice(0, port.findIndex(e => e.ev === 'roll' && e.step === step) + 1);
      const r = replayBattle(content, hexOf, traced(cut, { units }));
      const diff = diffBattle(cut, r.events);
      expect([r.finished, r.problems, diff.clean]).toEqual([false, [], true]);
      expect(r.events).toEqual(cut);
      expect(verdictOf({ battle: 3, label: 'cut', diff, problems: r.problems, finished: r.finished })).toBe('DIDN\'T FINISH');
    }
  });

  it('compares a trace cut just after a step\'s radar draw as a prefix: it didn\'t finish, and doesn\'t differ (weapons.cpp:602; Plan 23 R10)', () => {
    // (blind sensors: units 8-12 at 0, so each step's radar check draws)
    const units = enterpriseRows();
    for (let i = 8; i <= 12; i++) units[i]![0] = 0;
    const port = replayBattle(content, hexOf, traced([end(40)], { units })).events;
    for (const step of [1, 20]) {
      const cut = port.slice(0, port.findIndex(e => e.ev === 'roll' && e.site === 'weapons.cpp:602' && e.step === step) + 1);
      expect(cut.at(-1)).toMatchObject({ ev: 'roll', site: 'weapons.cpp:602', step });
      const r = replayBattle(content, hexOf, traced(cut, { units }));
      const diff = diffBattle(cut, r.events);
      expect([r.finished, r.problems, diff.clean]).toEqual([false, [], true]);
      expect(r.events).toEqual(cut);
      expect(verdictOf({ battle: 3, label: 'cut', diff, problems: r.problems, finished: r.finished })).toBe('DIDN\'T FINISH');
    }
  });

  it('warps as TacticalScreen::showWarp does: the warp event, the clock skipping the overlay\'s wait once, and the keys let go (tactical.cpp:841-846)', () => {
    // (the made-up Enterprise's script is WARP 0 on MAIN, its warp engines able to warp: units 27-28 at 1000 of 1000, the grid 32 full)
    const combat = miniTacticsCombat();
    addTactics(combat, 'warp.bin', assembleTactics([{ cls: TOKEN.page, opcode: 0x1f, page: 'MAIN', args: [0x6b] }, { cls: TOKEN.do, opcode: TACTIC.warp, args: [0] }]).bin);
    combat.battles[3]!.ships.find(s => s.type === combatSim.KIND.enterprise)!.tactics = 'warp.bin';
    const warping = { ship: { combat, data: { units: miniEnterpriseUnits() } } } as unknown as GameContent;
    const units = enterpriseRows();
    for (const i of [27, 28]) Object.assign(units[i]!, { 0: 1000, 2: 1000 });
    units[32]![0] = 3000;
    // (the camera's orbit key held from the start: Delegate flies on, as a flight key would stop it)
    const r = replayBattle(warping, hexOf, traced([{ ev: 'input', step: 0, line: 'orbit 1' }, end(30)], { units }));
    const wait = combatSim.combatTicks(0x369);
    expect(r.events.filter(e => e.ev === 'warp')).toEqual([{ ev: 'warp', step: 1, wait }]);
    // (each snapshot's clock: the setup's 10000, a step's STEP_TIME each, and the wait once)
    const nows = r.events.filter(e => e.ev === 'snap').map(e => e.ev === 'snap' && [e.step, e.now]);
    expect(nows).toEqual([[0, 10000], [15, 10000 + 15 * combatSim.STEP_TIME + wait], [30, 10000 + 30 * combatSim.STEP_TIME + wait]]);
    expect(r.battle?.input.held).toBe(0);
  });

  it('asks blind sensors once a frame, weapons.cpp:602\'s draw, until the view goes wide (tactical.cpp:1111-1113, weapons.cpp:601-602)', () => {
    // (sensor units 8-12 at 0: quality 0, under 40, so each check draws)
    const units = enterpriseRows();
    for (let i = 8; i <= 12; i++) units[i]![0] = 0;
    const draws = (more: CombatEvent[]) => replayBattle(content, hexOf, traced([...more, end(10)], { units })).events
      .filter(e => e.ev === 'roll' && e.site === 'weapons.cpp:602').map(e => e.ev === 'roll' && e.step);
    expect(draws([])).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(draws([{ ev: 'input', step: 5, line: 'wide on' }])).toEqual([0, 1, 2, 3, 4]);
    // (healthy sensors draw nothing)
    expect(own(10).filter(e => e.ev === 'roll' && e.site === 'weapons.cpp:602')).toEqual([]);
  });

  it('stops at once when an input leaves: no radar draw and no step after the Bridge button (tactical.cpp:503-510, unity.cpp:286, 1756-1766)', () => {
    // (blind sensors, so each frame's radar draw rolls: an extra draw would show)
    const units = enterpriseRows();
    for (let i = 8; i <= 12; i++) units[i]![0] = 0;
    // (the chodak past the AI's stand-down range, so the red alert is off and the Bridge button leaves rather than hails: ai.cpp, tactical.cpp:503-510)
    const combat = miniTacticsCombat();
    combat.battles[3]!.ships[1]!.position = [1000, 0, 70000];
    const far = { ship: { combat, data: { units: miniEnterpriseUnits() } } } as unknown as GameContent;
    const r = replayBattle(far, hexOf, traced([{ ev: 'input', step: 5, line: 'bridge' }, { ev: 'combatEnd', step: 5, reason: 'leave' }], { units }));
    expect(r.problems).toEqual([]);
    expect(r.events.filter(e => e.ev !== 'roll' && e.ev !== 'snap')).toEqual([
      { ev: 'leave', step: 5, code: 0 }, { ev: 'input', step: 5, line: 'bridge' }, { ev: 'combatEnd', step: 5, reason: 'leave' },
    ]);
    // (each frame before drew the radar; the leaving frame's inputs come before its draw, which then draws nothing)
    const draws = r.events.filter(e => e.ev === 'roll' && e.site === 'weapons.cpp:602').map(e => e.step);
    expect(draws).toEqual([0, 1, 2, 3, 4]);
    expect(r.events.some(e => 'step' in e && e.step > 5)).toBe(false);
    expect(r.battle?.steps).toBe(5);
  });

  it('leaves after a hail\'s 0xd only at the next update, after its step, as TacticalScreen::update does (tactical.cpp:399-403, 470-477)', () => {
    const hail: CombatEvent[] = [
      { ev: 'input', step: 5, line: 'hail' },
      { ev: 'hails', step: 5, site: 'tactical.cpp:449', type: 7 },
      { ev: 'standDown', step: 5, site: 'tactical.cpp:378' },
      { ev: 'hailsEnd', step: 5, result: true, type: 0xff, exit: 0, redAlert: false, removeTimes: [0, 0] },
    ];
    const r = replayBattle(content, hexOf, traced([...hail, { ev: 'combatEnd', step: 6, reason: 'leave' }]));
    expect(r.problems).toEqual([]);
    expect(r.events.filter(e => e.ev !== 'roll' && e.ev !== 'snap').map(e => `${e.ev}@${'step' in e ? e.step : ''}`))
      .toEqual(['hails@5', 'standDown@5', 'hailsEnd@5', 'input@5', 'leave@6', 'combatEnd@6']);
  });

  it('groups processHails calls with what they logged, a nested call within its caller', () => {
    const e: CombatEvent[] = [
      { ev: 'hails', step: 4, site: 'damage.cpp:713', type: 7 },
      { ev: 'hails', step: 4, site: 'tactical.cpp:399', type: 0xc },
      { ev: 'standDown', step: 4, site: 'tactical.cpp:420' },
      { ev: 'hailsEnd', step: 4, result: false, type: 0xff, exit: 0xffff, redAlert: false, removeTimes: [] },
      { ev: 'roll', step: 4, site: 'damage.cpp:109', n: 3, value: 1 },
      { ev: 'hailsEnd', step: 4, result: true, type: 0xff, exit: 0xffff, redAlert: false, removeTimes: [] },
    ];
    const blocks = hailBlocks(e);
    expect(blocks.map(b => [b.step, b.site, b.events.length, b.end?.result])).toEqual([[4, 'damage.cpp:713', 5, true]]);
  });
});
