// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { SHIP_FLAGS } from '../../content/types';
import { TACTIC, TOKEN } from '../../content/tactics';
import { miniBattle, miniBattleContext, miniCombat, recordingSeams, tacticScript } from '../../testing/combat';
import { assembleTactics } from '../../testing/tactics';
import {
  AI_SEAMS, aiTarget, autoTarget, enemySystemsCheck, evade, ram, runAI, SCRIPT_PERIOD, setDelegate, starbase,
} from './ai';
import { VIEW } from './battle';
import { setTarget } from './commands';
import { CAMERA_SEAMS } from './camera';
import { DAMAGE_SEAMS } from './damage';
import { v3 } from './math';
import { newRandom } from './random';
import { SIM_SEAMS } from './seams';
import { TACTICS_SEAMS } from './tactics';
import { KIND, SHIP_STATE } from './types';
import { WEAPON_SEAMS } from './weapons';

/**
 * miniCombat's battle, the Enterprise at the origin heading 0 (ahead +y) and enemies where `at` puts them (the first
 * at (0, 5000, 0) heading 180 by default, facing it), every ship radius 200, top speed 300, at 10 s. Weapons, the
 * lock and the power are recorded seams (the fire's spread too); the rolls are heard by site; seed 1's rnd(3) gives
 * 2, 1, 2, 1, 1 (low bytes 198, 126, 129, 107, 75).
 */
function battle(o: { difficulty?: 0 | 1 | 2; at?: [number, number, number][] } = {}) {
  const log: string[] = [];
  const spreads: number[] = [];
  const sites: string[] = [];
  const combat = miniCombat();
  const ships = combat.battles[3]!.ships;
  const at = o.at ?? [[0, 5000, 0]];
  at.forEach((p, i) => {
    ships[i + 1] = { ...ships[1]!, object: `space.zap${i}`, position: p };
  });
  const ctx = {
    ...miniBattleContext(recordingSeams(log, { fireTorpedoes: (_c, _b, _s, spread) => { spreads.push(spread); } }), combat),
    onDraw: (site: string, n: number, value: number) => { sites.push(`${site} ${n} ${value}`); },
  };
  const { b } = miniBattle({ ctx, difficulty: o.difficulty ?? 1 });
  b.random = newRandom(1);
  b.cues.length = 0;
  log.length = 0;
  return { ctx, b, e: b.ships[0]!, chodak: b.ships[1]!, log, spreads, sites };
}

describe('Combat::aiTarget and autoTarget (ai.cpp:133-165)', () => {
  it('aiTarget makes a visible ship the Enterprise\'s target, which the computer names after the last cue', () => {
    const { ctx, b, e, chodak } = battle({ at: [[0, 5000, 0], [0, 9000, 0]] });
    // (setup targets the last ship)
    expect(b.target).toBe(2);
    aiTarget(ctx, b, e, b.ships[2]!);
    chodak.decloakTime = 1;
    aiTarget(ctx, b, e, chodak);
    aiTarget(ctx, b, e, null);
    expect(b.cues).toEqual([]);
    chodak.decloakTime = 0;
    aiTarget(ctx, b, e, chodak);
    expect([b.target, e.target, b.cues]).toEqual([1, 1, [{ cue: 0x46, delay: 0, interrupt: false, after: true }]]);
  });

  it('autoTarget takes the nearest enemy within 18000 once the Enterprise has fired, or with a target, one over 40 points stronger', () => {
    const { ctx, b, e } = battle({ at: [[0, 9000, 0], [0, 5000, 0], [0, 19000, 0]] });
    const [near, far] = [b.ships[2]!, b.ships[3]!];
    setTarget(b, null);
    autoTarget(ctx, b, e);
    expect(b.target).toBeNull();
    e.flags |= SHIP_STATE.hasFired;
    autoTarget(ctx, b, e);
    expect(b.target).toBe(2);
    // (with the nearer one targeted: the other isn't 40 points stronger; then it is; a friend or one past 18000 never)
    autoTarget(ctx, b, e);
    expect(b.target).toBe(2);
    near.condition = 50;
    far.condition = 100;
    far.flags |= SHIP_FLAGS.friendly;
    autoTarget(ctx, b, e);
    expect(b.target).toBe(1);
  });

  it('autoTarget takes the nearest, not the last seen; a stronger friend, or a stronger enemy past 18000, never (ai.cpp:146-160)', () => {
    const { ctx, b, e } = battle({ at: [[0, 5000, 0], [0, 9000, 0]] });
    const [near, other] = [b.ships[1]!, b.ships[2]!];
    setTarget(b, null);
    e.flags |= SHIP_STATE.hasFired;
    autoTarget(ctx, b, e);
    expect(b.target).toBe(1);
    // (the target at 50, the other 50 points stronger: a friend, then 18001 off, then 18000 off)
    near.condition = 50;
    other.flags |= SHIP_FLAGS.friendly;
    autoTarget(ctx, b, e);
    other.flags &= ~SHIP_FLAGS.friendly;
    other.pos = v3(0, 18001, 0);
    autoTarget(ctx, b, e);
    expect(b.target).toBe(1);
    other.pos = v3(0, 18000, 0);
    autoTarget(ctx, b, e);
    expect(b.target).toBe(2);
  });
});

describe('ram and evade (ai.cpp:167-203)', () => {
  it('ram makes for the target, firing torpedoes from afar, and up close stops and fires everything (not at a friend)', () => {
    const { ctx, b, chodak, e, log, spreads } = battle();
    ram(ctx, b, chodak);
    expect([chodak.log, chodak.waypoint, chodak.waypointActive, chodak.targetSpeed, log]).toEqual([['Performing sudden impact.'], v3(), true, 500, ['fireTorpedoes:1']]);
    // (the waypoint is the ship's own copy: moving it moves no ship)
    chodak.waypoint.x = 99;
    expect(e.pos).toEqual(v3());
    chodak.pos = v3(0, 3000, 0);
    ram(ctx, b, chodak);
    e.flags |= SHIP_FLAGS.friendly;
    ram(ctx, b, chodak);
    expect([chodak.targetSpeed, log, spreads]).toEqual([0, ['fireTorpedoes:1', 'fireTorpedoes:1', 'firePhasers:1'], [0, 0]]);
  });

  it('evade turns by the bits of the strongest of the first two shields mixed with the target\'s facing', () => {
    const { ctx, b, chodak } = battle();
    // (the Enterprise is straight ahead of the chodak: facing 1. Shields 0 and 1 equal: 0, so pitch only)
    evade(ctx, b, chodak);
    expect([chodak.controls.yaw, chodak.controls.pitch, chodak.controls.roll]).toEqual([0, 75, 0]);
    // (shield 1 stronger: 1 ^ 1 = 0, no turn)
    chodak.systems.units[1]!.current = 101;
    evade(ctx, b, chodak);
    expect([chodak.controls.yaw, chodak.controls.pitch, chodak.controls.roll]).toEqual([0, 0, 0]);
  });
});

describe('enemySystemsCheck and starbase (ai.cpp:302-326)', () => {
  it('has a crippled enemy (no speed, under 20%) arm its self-destruct for 20 s, once', () => {
    const { ctx, b, e, chodak } = battle();
    chodak.condition = 10;
    enemySystemsCheck(ctx, b, chodak);
    expect(chodak.selfDestructTime).toBe(0);
    chodak.maxSpeed = 0;
    enemySystemsCheck(ctx, b, chodak);
    enemySystemsCheck(ctx, b, chodak);
    expect([chodak.selfDestructTime, chodak.log]).toEqual([30000, ['Engaging self-destruct mechanism.']]);
    expect(b.cues).toEqual([{ cue: 0x80, delay: 2000, interrupt: false }, { cue: 0x80, delay: 5000, interrupt: false }]);
    Object.assign(e, { maxSpeed: 0, condition: 10 });
    enemySystemsCheck(ctx, b, e);
    expect(e.selfDestructTime).toBe(0);
  });

  it('turns the starbase slowly, and within 5000 repairs the Enterprise and puts it 24000 off', () => {
    const { ctx, b, e, chodak } = battle({ at: [[0, 6000, 0]] });
    chodak.type = KIND.starbase;
    starbase(ctx, b, chodak);
    // (6000 off: no repair)
    expect([chodak.angles[0], chodak.scriptTime, e.pos]).toEqual([8192 + 0x10, 10000 + SCRIPT_PERIOD, v3()]);
    starbase(ctx, b, chodak);
    expect(chodak.angles[0]).toBe(8192 + 0x10);
    b.now = 10061;
    chodak.pos = v3(0, 4000, 0);
    Object.assign(e.systems.units[3]!, { damage: 6, repair: 2 });
    b.view.view = VIEW.target;
    starbase(ctx, b, chodak);
    // (setDamage(kUnitAll, 1): every unit off and repaired)
    expect([e.systems.units[3], e.systems.units[0]!.current, e.pos, e.waypointActive, b.view.view]).toEqual([
      expect.objectContaining({ current: 0, damage: 0, repair: 0 }), 0, v3(-24000, 4000, 0), false, VIEW.chase,
    ]);
  });
});

describe('Combat::runAI (ai.cpp:328-466)', () => {
  it('fires every 5 s: phasers within 6500, torpedoes fore or aft; an Ensign\'s enemy only on a roll of 1 in rnd(3) each (ai.cpp:367, 380)', () => {
    const ensign = battle({ difficulty: 0 });
    runAI(ensign.ctx, ensign.b, ensign.chodak);
    // (seed 1: rnd(3) is 2, no phasers; then 1, torpedoes, straight ahead: spread 0)
    expect([ensign.sites, ensign.log, ensign.spreads, ensign.chodak.fireTime]).toEqual([['ai.cpp:367 3 2', 'ai.cpp:380 3 1'], ['fireTorpedoes:1'], [0], 15000]);
    runAI(ensign.ctx, ensign.b, ensign.chodak);
    expect(ensign.sites.length).toBe(2);
    const lieutenant = battle();
    runAI(lieutenant.ctx, lieutenant.b, lieutenant.chodak);
    expect([lieutenant.sites, lieutenant.log]).toEqual([[], ['firePhasers:1', 'fireTorpedoes:1']]);
    // (Worf at Ensign never rolls)
    const worf = battle({ difficulty: 0 });
    worf.e.fireTime = 0;
    runAI(worf.ctx, worf.b, worf.e);
    expect([worf.sites, worf.log]).toEqual([[], ['firePhasers:0', 'fireTorpedoes:0']]);
  });

  it('fires torpedoes aft too: a target straight behind is yaw 0x2000 (measured 8191), averaged 4095, capped at 0x800', () => {
    const { ctx, b, chodak, log, spreads } = battle({ at: [[0, -5000, 0]] });
    runAI(ctx, b, chodak);
    expect([log, spreads]).toEqual([['firePhasers:1', 'fireTorpedoes:1'], [0x800]]);
  });

  it('sets the Enterprise\'s spread from where the target is, averaging an unsigned yaw with the pitch (sic, ai.cpp:375)', () => {
    // (464 right: spread 232, cell 1 then 2: 460 and 10 degrees)
    const right = battle({ at: [[900, 5000, 0]] });
    // (past setup's hold on the Enterprise's fire, combat.cpp:263-264)
    right.e.fireTime = 0;
    runAI(right.ctx, right.b, right.e);
    expect([right.spreads, right.b.console.spread, right.b.console.spreadDegrees]).toEqual([[232], 460, 10]);
    // (464 left is 0x4000 - 464: averaged it is 7960, capped at 0x800, cell 8 then 9: 2070 and 45 degrees)
    const left = battle({ at: [[-900, 5000, 0]] });
    left.e.fireTime = 0;
    runAI(left.ctx, left.b, left.e);
    expect([left.spreads, left.b.console.spread, left.b.console.spreadDegrees]).toEqual([[0x800], 2070, 45]);
    expect(left.log).toEqual(['firePhasers:0', 'fireTorpedoes:0']);
    // (left and down, atan2(300, 5000): yaw 0x4000 - 156 and pitch 0x4000 - 155 (measured); averaged 0x4000 - 156,
    // past 0x2000, so 0x4000 less it: 156, cell 0: 0 and 0 degrees)
    const below = battle({ at: [[-300, 5000, -300]] });
    below.e.fireTime = 0;
    below.b.console.spread = 99;
    runAI(below.ctx, below.b, below.e);
    expect([below.spreads, below.b.console.spread, below.b.console.spreadDegrees]).toEqual([[156], 0, 0]);
  });

  it('decides red alert by the range, and chases a target beyond 40000 at 999', () => {
    const { ctx, b, chodak, e } = battle({ at: [[0, 45000, 0]] });
    runAI(ctx, b, chodak);
    // (beyond 15000, the strategy closes in at 700 for 10 s; the chase sets 999 and 20 s first)
    expect([b.console.redAlert, chodak.waypoint, chodak.waypointActive, chodak.targetSpeed, chodak.holdTime]).toEqual([false, v3(), true, 700, 20000]);
    chodak.pos = v3(0, 5000, 0);
    chodak.strategyTime = 99999;
    runAI(ctx, b, chodak);
    expect(b.console.redAlert).toBe(true);
    chodak.pos = v3(0, 60000, 0);
    runAI(ctx, b, chodak);
    expect([b.console.redAlert, chodak.targetSpeed]).toEqual([false, 700]);
    // (the close-in's waypoint, ai.cpp:457, is the ship's own copy: moving it moves no ship)
    chodak.waypoint.x = 99;
    expect(e.pos).toEqual(v3());
  });

  it('chases, between strategies, to a copy of the target\'s position (ai.cpp:399)', () => {
    const { ctx, b, chodak, e } = battle({ at: [[0, 45000, 0]] });
    chodak.strategyTime = 99999;
    b.console.redAlert = true;
    runAI(ctx, b, chodak);
    // (beyond 40000, the chase: 999, and a hold of combatTicks(0x16bc), 20 s; no strategy to close in after it. Short
    // of 58000 the alert stays)
    expect([chodak.waypoint, chodak.waypointActive, chodak.targetSpeed, chodak.holdTime, b.console.redAlert]).toEqual([v3(), true, 999, 10000 + 20000, true]);
    chodak.waypoint.x = 99;
    expect(e.pos).toEqual(v3());
  });

  it('closes in at 700 for 10 s on a target beyond 15000, short of the chase (ai.cpp:453-461)', () => {
    const { ctx, b, chodak } = battle({ at: [[0, 20000, 0]] });
    runAI(ctx, b, chodak);
    expect([b.console.redAlert, chodak.waypointActive, chodak.targetSpeed, chodak.holdTime]).toEqual([true, true, 700, 10000 + 10000]);
  });

  it('flees only under a third of the target\'s condition (ai.cpp:410)', () => {
    // (the Enterprise at 100: 3 * 34 = 102 isn't under it, 3 * 33 = 99 is)
    const brave = battle();
    brave.chodak.condition = 34;
    runAI(brave.ctx, brave.b, brave.chodak);
    const flees = battle();
    flees.chodak.condition = 33;
    runAI(flees.ctx, flees.b, flees.chodak);
    expect([brave.chodak.log, flees.chodak.log]).toEqual([[], ['Get me outa here.']]);
  });

  it('flees, much weaker: an enemy says so, Worf warps away; and holds 30 s', () => {
    const { ctx, b, chodak, e } = battle();
    chodak.condition = 10;
    runAI(ctx, b, chodak);
    expect([chodak.log, chodak.holdTime]).toEqual([['Get me outa here.'], 10000 + 30030]);
    e.condition = 10;
    chodak.condition = 100;
    runAI(ctx, b, e);
    expect(e.log).toEqual(['Warp engage failed.', 'Combined reactor output inadequate.']);
  });

  it('rams a target about to blow itself up, firing a spread of 0x38e, or flees one about to go now', () => {
    const { ctx, b, chodak, e, spreads } = battle();
    e.selfDestructTime = 10000 + 6000;
    runAI(ctx, b, chodak);
    expect([chodak.log, spreads.slice(1), chodak.holdTime]).toEqual([['Performing sudden impact.'], [0, 0x38e], 20000]);
    const soon = battle();
    soon.e.selfDestructTime = 10000 + 5000;
    runAI(soon.ctx, soon.b, soon.chodak);
    expect(soon.chodak.log).toEqual(['Get me outa here.']);
  });

  it('evades when it can\'t move, and rams a target that can\'t (not a starbase)', () => {
    const { ctx, b, chodak } = battle();
    chodak.maxSpeed = 0;
    runAI(ctx, b, chodak);
    expect([chodak.log, chodak.controls.pitch]).toEqual([['mini is gonna be nuked.'], 75]);
    const lame = battle();
    lame.e.maxSpeed = 0;
    runAI(lame.ctx, lame.b, lame.chodak);
    expect(lame.chodak.log).toEqual(['mini is lame.', 'Performing sudden impact.']);
    // (a starbase can't move either, and is no ram's target)
    const base = battle({ at: [[0, 5000, 0], [0, 9000, 0]] });
    Object.assign(base.b.ships[2]!, { type: KIND.starbase, maxSpeed: 0 });
    base.chodak.target = 2;
    runAI(base.ctx, base.b, base.chodak);
    expect(base.chodak.log).toEqual([]);
  });

  it('runs an engaged ship\'s tactics every SCRIPT_PERIOD once its hold is over, and Worf, not engaged, jumps to the kernel', () => {
    const { bin } = assembleTactics([
      { cls: TOKEN.page, opcode: 0x1f, page: 'MAIN', args: [0x6b] }, { cls: TOKEN.do, opcode: TACTIC.message, text: 'tick' },
      { cls: TOKEN.branch, opcode: TACTIC.goto, args: [TACTIC.goto, 0x6b, 0] },
    ]);
    const { ctx, b, chodak, e } = battle();
    chodak.script = tacticScript(bin);
    chodak.engaged = true;
    runAI(ctx, b, chodak);
    expect([chodak.log, chodak.scriptTime]).toEqual([['tick'], 10000 + SCRIPT_PERIOD]);
    // (between strategies: a token each time the script period is over, here the GOTO, then the MESSAGE again)
    b.now = 10050;
    runAI(ctx, b, chodak);
    b.now = 10062;
    runAI(ctx, b, chodak);
    expect([chodak.log, chodak.script.pc]).toEqual([['tick'], 0x6b]);
    b.now = 10124;
    runAI(ctx, b, chodak);
    expect(chodak.log).toEqual(['tick', 'tick']);
    // (held: nothing, between strategies or at one)
    const pc = chodak.script.pc;
    chodak.holdTime = 20000;
    b.now = 10200;
    runAI(ctx, b, chodak);
    b.now = 15001;
    runAI(ctx, b, chodak);
    expect([chodak.log, chodak.script.pc, chodak.scriptTime, chodak.strategyTime]).toEqual([['tick', 'tick'], pc, 10124 + SCRIPT_PERIOD, 15001 + 5000]);
    e.script = tacticScript(bin);
    e.script.kernel = 0x200;
    b.console.kernelReady = true;
    runAI(ctx, b, e);
    expect([e.script.pc, e.log]).toEqual([0x200, []]);
  });

  it('with no live target (or in battle 0x43), only runs its tactics; frozen, does nothing; a starbase nothing', () => {
    const { bin } = assembleTactics([{ cls: TOKEN.page, opcode: 0x1f, page: 'MAIN', args: [0x6b] }, { cls: TOKEN.do, opcode: TACTIC.message, text: 'tick' }]);
    const { ctx, b, chodak, e, log, sites } = battle({ difficulty: 0 });
    chodak.script = tacticScript(bin);
    chodak.engaged = true;
    e.destroyed = true;
    runAI(ctx, b, chodak);
    expect([chodak.log, chodak.scriptTime]).toEqual([['tick'], 10000 + SCRIPT_PERIOD]);
    e.destroyed = false;
    b.scenario = 0x43;
    b.now = 10100;
    runAI(ctx, b, chodak);
    // (its next token: past the code, and back to the start)
    expect([chodak.script.pc, chodak.scriptTime]).toEqual([0x6b, 10100 + SCRIPT_PERIOD]);
    b.scenario = 3;
    chodak.freezeTime = 20000;
    runAI(ctx, b, chodak);
    chodak.freezeTime = 0;
    chodak.type = KIND.starbase;
    runAI(ctx, b, chodak);
    expect([chodak.log, log, sites, chodak.fireTime, chodak.scriptTime]).toEqual([['tick'], [], [], 0, 10100 + SCRIPT_PERIOD]);
  });

  it('has Worf take an enemy over 40 points stronger than the target', () => {
    const { ctx, b, e } = battle({ at: [[0, 5000, 0], [0, 9000, 0]] });
    setTarget(b, 1);
    b.ships[1]!.condition = 50;
    runAI(ctx, b, e);
    expect([b.target, b.cues]).toEqual([2, [{ cue: 0x46, delay: 0, interrupt: false, after: true }]]);
  });
});

describe('Combat::setDelegate (ai.cpp:468-502)', () => {
  it('on, with an enemy about: Worf locks weapons, sets the banks and salvos full, the power to 4, and engages', () => {
    const { ctx, b, e, log } = battle();
    e.banks = [{ setting: 20 }, { setting: 0 }] as typeof e.banks;
    setDelegate(ctx, b, true, true);
    expect([b.console.delegate, e.engaged, e.banks.map(bank => bank.setting), b.console.salvo.map(s => s.setting), log]).toEqual([
      true, true, [100, 100], [10, 10], ['setWeaponsLock', 'setPowerLevel'],
    ]);
    expect(b.cues).toEqual([{ cue: 5, delay: 0, interrupt: false }, { cue: 7, delay: 0, interrupt: false, after: true }]);
  });

  it('jumps to the kernel when asked with cues and it is ready; without cues, or locked and at 4 already, asks nothing more', () => {
    const { ctx, b, e, log } = battle();
    e.script = tacticScript(assembleTactics([{ cls: TOKEN.page, opcode: 0x1f, page: 'MAIN', args: [0x6b] }]).bin);
    e.script.kernel = 0x80;
    b.console.kernelReady = true;
    setDelegate(ctx, b, true, false);
    expect([e.script.pc, b.cues]).toEqual([0x6b, []]);
    b.console.weaponsLock = true;
    b.console.powerLevel = 4;
    log.length = 0;
    setDelegate(ctx, b, true, true);
    expect([e.script.pc, log]).toEqual([0x80, []]);
  });

  it('on with only friends about just engages; off, stops the tactics and centres the controls', () => {
    const { ctx, b, e, chodak, log } = battle();
    chodak.flags |= SHIP_FLAGS.friendly;
    setDelegate(ctx, b, true, false);
    expect([e.engaged, log]).toEqual([true, []]);
    Object.assign(e, { waypoint: v3(1, 2, 3), waypointActive: true });
    Object.assign(e.controls, { yaw: 5, pitch: 6, roll: 7, throttle: 8 });
    setDelegate(ctx, b, false, false);
    expect([b.console.delegate, e.engaged, e.waypoint, e.waypointActive, e.controls]).toEqual([
      false, false, v3(), false, { yaw: 0, pitch: 0, roll: 0, throttle: 8, stopping: false },
    ]);
  });
});

describe('AI_SEAMS and SIM_SEAMS', () => {
  it('fill ai.cpp\'s seams, and with weapons, damage and tactics every seam the sim fills, frozen', () => {
    expect(Object.keys(AI_SEAMS).sort()).toEqual(['autoTarget', 'avoidCollision', 'enemySystemsCheck', 'filterInputs', 'runAI', 'setDelegate', 'starbase', 'steerTowards']);
    expect(Object.keys(SIM_SEAMS)).toHaveLength(12 + 3 + 8 + 6 + 1);
    expect([Object.isFrozen(AI_SEAMS), Object.isFrozen(SIM_SEAMS), SIM_SEAMS.runAI]).toEqual([true, true, runAI]);
    // (a fresh object, each seam its part's own: no part shadows another's)
    const parts: Record<string, unknown>[] = [WEAPON_SEAMS, DAMAGE_SEAMS, AI_SEAMS, TACTICS_SEAMS, CAMERA_SEAMS];
    expect(parts.includes(SIM_SEAMS as Record<string, unknown>)).toBe(false);
    for (const part of parts) {
      for (const [name, seam] of Object.entries(part)) expect([name, (SIM_SEAMS as Record<string, unknown>)[name]]).toEqual([name, seam]);
    }
  });
});
