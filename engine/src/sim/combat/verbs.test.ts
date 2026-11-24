// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { SHIP_FLAGS } from '../../content/types';
import { TACTIC, TOKEN } from '../../content/tactics';
import { miniBattle, miniBattleContext, recordingSeams, tacticScript } from '../../testing/combat';
import { assembleTactics, type TacticArg } from '../../testing/tactics';
import { VIEW } from './battle';
import { engage } from './maneuvers';
import { v3 } from './math';
import { setTokenArg } from './script';
import { operate, verb } from './verbs';
import type { BattleContext } from './types';

const FOE = TACTIC.foe;
/** One DO per case, each labelled. */
const CASES: Record<string, { opcode: number; args?: TacticArg[]; text?: string }> = {
  print: { opcode: TACTIC.print, text: 'debug only' },
  phasers: { opcode: TACTIC.fire, args: [TACTIC.phaser] },
  photons: { opcode: TACTIC.fire, args: [TACTIC.photon] },
  'yaw =50': { opcode: TACTIC.heading, args: [10, TACTIC.heading, 0, 50] },
  'yaw +30': { opcode: TACTIC.heading, args: [11, TACTIC.heading, 0, 30] },
  'yaw -200': { opcode: TACTIC.heading, args: [12, TACTIC.heading, 0, 200] },
  'yaw *-1': { opcode: TACTIC.heading, args: [13, TACTIC.heading, 0, -1] },
  'yaw /0': { opcode: TACTIC.heading, args: [14, TACTIC.heading, 0, 0] },
  'yaw /3': { opcode: TACTIC.heading, args: [14, TACTIC.heading, 0, 3] },
  'yaw >>1': { opcode: TACTIC.heading, args: [15, TACTIC.heading, 0, 1] },
  'yaw <<33': { opcode: TACTIC.heading, args: [16, TACTIC.heading, 0, 33] },
  'pitch =foe': { opcode: TACTIC.climb, args: [10, TACTIC.climb, FOE, 0] },
  'roll =-foe': { opcode: TACTIC.bank, args: [10, TACTIC.bank, -FOE, 0] },
  'bad axis': { opcode: TACTIC.heading, args: [10, 0xe, 0, 50] },
  'speed =400': { opcode: TACTIC.speed, args: [400, 0, 10] },
  'speed +foe': { opcode: TACTIC.speed, args: [0, FOE, 11] },
  'speed /0': { opcode: TACTIC.speed, args: [0, 0, 14] },
  'x +250': { opcode: TACTIC.pos, args: [1, 0, { float: 250 }, 11] },
  'way z =foe': { opcode: TACTIC.way, args: [3, FOE, { float: 0 }, 10] },
  'way x =1100': { opcode: TACTIC.way, args: [1, 0, { float: 1100 }, 10] },
  'damage 13 =5': { opcode: TACTIC.system, args: [13, 0, 5, 10] },
  'target 13 /2': { opcode: TACTIC.system, args: [13, 1, 2, 14] },
  'damage 13 *-1': { opcode: TACTIC.system, args: [13, 0, -1, 13] },
  debug: { opcode: TACTIC.debug, args: [1] },
  message: { opcode: TACTIC.message, text: 'Zap ahoy' },
  'acquire chodak': { opcode: TACTIC.acquire, args: [0] },
  'acquire enterprise': { opcode: TACTIC.acquire, args: [2] },
  cloak: { opcode: TACTIC.cloak, args: [1] },
  decloak: { opcode: TACTIC.cloak, args: [0] },
  menu: { opcode: TACTIC.menu, args: [0, 7, 0], text: 'Zigzag Drill' },
  'menu off': { opcode: TACTIC.menu, args: [0, 7, 0, 0] },
  'engage 2': { opcode: TACTIC.engage, args: [2] },
  'engage 3': { opcode: TACTIC.engage, args: [3] },
  'engage 1': { opcode: TACTIC.engage, args: [1] },
  'warp away': { opcode: TACTIC.warp, args: [0] },
  retreat: { opcode: TACTIC.warp, args: [2] },
  story: { opcode: TACTIC.story, args: [1] },
  bearing: { opcode: TACTIC.bearing, args: [1] },
  oppose: { opcode: TACTIC.oppose, args: [1] },
  unknown: { opcode: 0x30 },
  // (the cases below pin branches the mutation sweep found loose)
  'yaw =foe 40': { opcode: TACTIC.heading, args: [10, TACTIC.heading, FOE, 40] },
  'yaw =-foe': { opcode: TACTIC.heading, args: [10, TACTIC.heading, -FOE, 0] },
  'yaw op 17': { opcode: TACTIC.heading, args: [17, TACTIC.heading, 0, 1] },
  'pos axis 4': { opcode: TACTIC.pos, args: [4, 0, { float: 250 }, 11] },
  'x =-foe': { opcode: TACTIC.pos, args: [1, -FOE, { float: 0 }, 10] },
  'way x =1300': { opcode: TACTIC.way, args: [1, 0, { float: 1300 }, 10] },
};
const FILE = assembleTactics([
  { cls: TOKEN.page, opcode: 0x1f, page: 'MAIN', args: [0x6b] },
  ...Object.entries(CASES).flatMap(([label, t]) => [{ label }, { cls: TOKEN.do, ...t }]),
]);

/** miniCombat's battle (the chodak at (1000, 0, 5000), heading 8192), with the weapons' seams recorded and each ship running a copy of FILE. */
function battle() {
  const log: string[] = [];
  const warnings: string[] = [];
  const ctx: BattleContext = { ...miniBattleContext(recordingSeams(log, { engage })), onWarning: m => { warnings.push(m); } };
  const { b } = miniBattle({ ctx });
  const [e, chodak] = [b.ships[0]!, b.ships[1]!];
  e.script = tacticScript(FILE.bin);
  chodak.script = tacticScript(FILE.bin);
  b.cues.length = 0;
  log.length = 0;
  const run = (ship: typeof e, ...names: string[]) => { for (const name of names) verb(ctx, b, ship.script!, ship, FILE.labels[name]!); };
  return { ctx, b, e, chodak, run, log, warnings };
}

describe('operate (tactics.cpp:721-736)', () => {
  it('sets, adds, subtracts, multiplies and divides in float, not by 0, and keeps for anything else', () => {
    expect([10, 11, 12, 13, 14, 15].map(op => operate(op, 7, 2))).toEqual([2, 9, 5, 14, 3.5, 7]);
    expect(operate(14, 7, 0)).toBe(7);
    expect(operate(14, 1, 3)).toBe(Math.fround(1 / 3));
  });
});

describe('Combat::verb (tactics.cpp:738-921)', () => {
  it('PRINT does nothing; FIRE fires through the weapons\' seams, but not the Enterprise at a friend', () => {
    const { b, e, chodak, run, log } = battle();
    const before = structuredClone(b);
    run(e, 'print');
    expect(b).toEqual(before);
    run(e, 'phasers', 'photons');
    run(chodak, 'photons');
    chodak.flags |= SHIP_FLAGS.friendly;
    run(e, 'phasers', 'photons');
    expect(log).toEqual(['firePhasers:0', 'fireTorpedoes:0', 'fireTorpedoes:1']);
  });

  it('HEADING, CLIMB and BANK set a turn rate in whole numbers, -100 to 100, by literal or the subject\'s angle', () => {
    const { e, run, warnings } = battle();
    const yaws = ['yaw =50', 'yaw +30', 'yaw +30', 'yaw -200', 'yaw *-1', 'yaw /0', 'yaw /3', 'yaw >>1', 'yaw <<33'].map(name => {
      run(e, name);
      return e.controls.yaw;
    });
    // (110 clips to 100; 100 - 200 is -100; -100 * -1 is 100; by 0 keeps it; 100 / 3 truncates to 33; 33 >> 1 is 16; << 33 is << 1)
    expect(yaws).toEqual([50, 80, 100, -100, 100, 100, 33, 16, 32]);
    e.controls.pitch = 12.9;
    run(e, 'pitch =foe', 'roll =-foe');
    // (the chodak's yaw is 8192, but CLIMB reads its pitch, 0; BANK its roll, 0)
    expect([e.controls.pitch, e.controls.roll]).toEqual([0, 0]);
    run(e, 'bad axis');
    expect(warnings).toEqual(['tactic: unknown axis']);
  });

  it('SPEED sets the target speed by literal or the subject\'s, in float', () => {
    const { e, chodak, run } = battle();
    chodak.targetSpeed = 120.9;
    run(e, 'speed =400', 'speed +foe', 'speed /0');
    expect(e.targetSpeed).toBe(520);
  });

  it('POS moves the ship; WAY its waypoint, never at a cloaked target, and cuts the camera to one in free space under Delegate', () => {
    const { b, e, chodak, run } = battle();
    run(e, 'x +250');
    expect(e.pos).toEqual(v3(250, 0, 0));
    // (the chodak's z, 5000: the waypoint (0, 0, 5000) is 1000 from the chodak, beyond twice its radius (400): a cut
    // to kViewChaseClose (5) for kEventViewTime, 0x6d2 * 1000 / 291 = 6000 ms)
    b.console.delegate = true;
    run(e, 'way z =foe');
    expect([e.waypoint, e.waypointActive, b.view.view, b.view.viewShip, b.view.viewExpiry]).toEqual([v3(0, 0, 5000), true, 5, 0, b.now + 6000]);
    // ((1100, 0, 5000) is within 400 of the chodak: no cut)
    b.console.eventViewTime = 0;
    b.view.view = VIEW.chase;
    run(e, 'way x =1100');
    expect([e.waypoint, b.view.view]).toEqual([v3(1100, 0, 5000), VIEW.chase]);
    // (WAY writes the waypoint in place, so it must be the ship's own object: x 1100 would have moved the chodak from 1000)
    expect(e.waypoint).not.toBe(chodak.pos);
    expect(chodak.pos).toEqual(v3(1000, 0, 5000));
    chodak.decloakTime = 1;
    run(e, 'way z =foe');
    expect([e.waypointActive, e.waypoint]).toEqual([false, v3(1100, 0, 5000)]);
  });

  it('SYSTEM sets a unit\'s damage or target as an int; DEBUG the trace; MESSAGE logs', () => {
    const { e, run } = battle();
    run(e, 'damage 13 *-1');
    expect(Object.is(e.systems.units[13]!.damage, 0)).toBe(true);
    run(e, 'damage 13 =5', 'target 13 /2', 'debug', 'message');
    expect([e.systems.units[13]!.damage, e.systems.units[13]!.target, e.script!.trace, e.log]).toEqual([5, 50, 1, ['Zap ahoy']]);
  });

  it('ACQUIRE targets the first ship of the kind that isn\'t the target, which may be the ship itself', () => {
    const { b, e, run } = battle();
    run(e, 'acquire chodak');
    expect(e.target).toBe(1);
    run(e, 'acquire enterprise');
    // (the ship's own target only: Combat::_target stays)
    expect([e.target, b.target]).toEqual([0, 1]);
  });

  it('CLOAK cloaks a ship that can until told to decloak, and decloaks it now; either is worth a camera cut', () => {
    const { b, e, chodak, run } = battle();
    b.console.delegate = true;
    run(e, 'cloak');
    expect(e.decloakTime).toBe(0);
    run(chodak, 'cloak');
    // (the Enterprise can't cloak, but its CLOAK still cut to it, kViewChase; the chodak's cut waits out that view's 6 s)
    expect([chodak.decloakTime, b.cues.map(c => c.cue), b.view.viewShip, b.view.view]).toEqual([0xffffffff, [0x3e], 0, VIEW.chase]);
    run(chodak, 'decloak');
    expect(chodak.decloakTime).toBe(b.now);
  });

  it('MENU adds a heading for the Enterprise\'s script only, and removes a heading by its id for anyone\'s', () => {
    const { b, e, chodak, run } = battle();
    run(chodak, 'menu');
    expect(b.console.menu).toEqual([]);
    run(e, 'menu');
    expect(b.console.menu).toEqual([{ heading: true, open: false, payload: FILE.labels.menu! + 12, label: 'Zigzag Drill', buttons: [] }]);
    expect(b.console.menuRows).toEqual([[0, -1]]);
    run(chodak, 'menu off');
    expect([b.console.menu, b.console.menuRows]).toEqual([[], []]);
  });

  it('ENGAGE 2 locks the script and the menu, 3 makes the kernel ready and unlocks, then engage as asked', () => {
    const { b, e, run } = battle();
    run(e, 'engage 2');
    expect([b.console.scriptLock, b.console.engageLock]).toEqual([true, true]);
    run(e, 'engage 1');
    expect(e.engaged).toBe(false);
    run(e, 'engage 3');
    expect([b.console.scriptLock, b.console.kernelReady, b.console.engageLock]).toEqual([false, true, false]);
    run(e, 'engage 1');
    expect(e.engaged).toBe(true);
  });

  it('WARP warps the Enterprise away or retreats, not during its self-destruct, and no other ship', () => {
    const { b, e, chodak, run } = battle();
    run(chodak, 'warp away', 'retreat');
    expect(chodak.log).toEqual([]);
    b.console.selfDestructTime = b.now + 1000;
    run(e, 'warp away', 'retreat');
    expect(e.log).toEqual([]);
    b.console.selfDestructTime = 0;
    run(e, 'warp away', 'retreat');
    expect(e.log).toEqual(['Warp engage failed.', 'Combined reactor output inadequate.', 'Warp engage failed.']);
  });

  it('STORY, BEARING and OPPOSE do nothing (tactics.cpp:913-916); an unknown verb warns', () => {
    const { b, e, run, warnings } = battle();
    const before = structuredClone(b);
    run(e, 'story', 'bearing', 'oppose');
    expect([b, warnings]).toEqual([before, []]);
    run(e, 'unknown');
    expect(warnings).toEqual(['tactic: unknown verb 30']);
  });
});

describe('Combat::verb, the branches between the cases (tactics.cpp:738-921)', () => {
  it('FIRE spares a friend for the Enterprise only, and fires photons with no spread', () => {
    const { ctx, e, chodak, run, log } = battle();
    ctx.seams.fireTorpedoes = (_c, _b, ship, spread) => { log.push(`spread:${ship.index}:${spread}`); };
    e.flags |= SHIP_FLAGS.friendly;
    run(chodak, 'phasers', 'photons');
    expect(log).toEqual(['firePhasers:1', 'spread:1:0']);
  });

  it('HEADING takes a literal over the subject, negates for a negative subject, and truncates the current rate', () => {
    const { e, run } = battle();
    run(e, 'yaw =foe 40');
    expect(e.controls.yaw).toBe(40);
    // (the chodak's yaw, 8192, negated: -8192, clipped)
    run(e, 'yaw =-foe');
    expect(e.controls.yaw).toBe(-100);
    // ((int32)12.9 = 12, + 30)
    e.controls.yaw = 12.9;
    run(e, 'yaw +30');
    expect(e.controls.yaw).toBe(42);
    // (an op it doesn't know keeps the current rate, as an int32)
    e.controls.yaw = 12.9;
    run(e, 'yaw op 17');
    expect(e.controls.yaw).toBe(12);
  });

  it('POS ignores an axis beyond z and negates for a negative subject', () => {
    const { e, run } = battle();
    run(e, 'pos axis 4');
    expect(e.pos).toEqual(v3(0, 0, 0));
    run(e, 'x =-foe');
    expect(e.pos).toEqual(v3(-1000, 0, 0));
  });

  it('WAY cuts the camera only beyond twice a live ship\'s radius', () => {
    const { b, e, chodak, run } = battle();
    b.console.delegate = true;
    run(e, 'way z =foe');
    // ((1300, 0, 5000) is 300 from the chodak: within 400, no cut)
    b.console.eventViewTime = 0;
    b.view.view = VIEW.chase;
    run(e, 'way x =1300');
    expect(b.view.view).toBe(VIEW.chase);
    // (a destroyed chodak doesn't count: (1100, 0, 5000) is a cut)
    chodak.destroyed = true;
    run(e, 'way x =1100');
    expect([b.view.view, b.view.viewShip]).toEqual([5, 0]);
  });

  it('ACQUIRE skips the target and takes the first of the kind', () => {
    const { b, e, chodak, run } = battle();
    b.ships.push({ ...structuredClone(chodak), index: 2 });
    e.target = 1;
    run(e, 'acquire chodak');
    expect(e.target).toBe(2);
    e.target = null;
    run(e, 'acquire chodak');
    expect(e.target).toBe(1);
  });

  it('CLOAK leaves a cloak\'s time be, decloaks only a cloaked ship, and cuts to the ship', () => {
    const { b, chodak, run } = battle();
    b.console.delegate = true;
    run(chodak, 'decloak');
    expect(chodak.decloakTime).toBe(0);
    // (the decloak's cut, to the chodak in kViewChase)
    expect([b.view.viewShip, b.view.view]).toEqual([1, VIEW.chase]);
    chodak.decloakTime = 5;
    run(chodak, 'cloak');
    expect([chodak.decloakTime, b.cues]).toEqual([5, []]);
  });

  it('MENU removes the first heading of the id, reading the Enterprise\'s script', () => {
    const { b, e, chodak, run } = battle();
    run(e, 'menu', 'menu', 'menu');
    // (the chodak's own copy says 8: ignored)
    setTokenArg(chodak.script!, FILE.labels.menu!, 1, 8);
    run(chodak, 'menu off');
    expect(b.console.menu.length).toBe(2);
  });

  it('ENGAGE 3 makes the kernel ready only after an ENGAGE 2', () => {
    const { b, e, run } = battle();
    run(e, 'engage 3');
    expect(b.console.kernelReady).toBe(false);
  });
});
