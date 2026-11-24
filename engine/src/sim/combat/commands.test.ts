// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { miniBattle, miniBattleContext, miniCombat, recordingSeams } from '../../testing/combat';
import { applyCommand, CONSOLE_PAGES, CYCLE_DELAY, nextTarget } from './commands';
import { FLIGHT } from './flight';
import { v3 } from './math';
import { SHIP_STATE } from './types';

const bit = (n: number) => 1 << n;

describe('applyCommand (the inputs, spec §4.5)', () => {
  it('holds the flight keys a steer command names, and keeps the orbit keys', () => {
    const { ctx, b } = miniBattle();
    applyCommand(ctx, b, { type: 'orbit', direction: 1 });
    applyCommand(ctx, b, { type: 'steer', yaw: -1, pitch: 1, roll: 1, throttle: -1 });
    expect(b.input.held).toBe(bit(FLIGHT.yawLeft) | bit(FLIGHT.pitchUp) | bit(FLIGHT.rollRight) | bit(FLIGHT.decelerate) | bit(FLIGHT.orbitRight));
    applyCommand(ctx, b, { type: 'steer', yaw: 0, pitch: 0, roll: 0, throttle: 0 });
    expect(b.input.held).toBe(bit(FLIGHT.orbitRight));
    applyCommand(ctx, b, { type: 'orbit', direction: 0 });
    expect(b.input.held).toBe(0);
    applyCommand(ctx, b, { type: 'steer', yaw: 1, pitch: -1, roll: -1, throttle: 1 });
    expect(b.input.held).toBe(bit(FLIGHT.yawRight) | bit(FLIGHT.pitchDown) | bit(FLIGHT.rollLeft) | bit(FLIGHT.accelerate));
  });

  it('stops all, with the cue (tactical.cpp:748-751)', () => {
    const { ctx, b } = miniBattle();
    b.ships[0]!.controls.yaw = 50;
    applyCommand(ctx, b, { type: 'allStop' });
    expect(b.ships[0]!.controls).toMatchObject({ yaw: 0, stopping: true });
    expect(b.cues).toEqual([{ cue: 0xa, delay: 0, interrupt: false }]);
  });

  it('sends the weapons, tactics and screen commands to their seams, phasers before torpedoes for both, with their arguments', () => {
    const log: string[] = [];
    const args: Record<string, unknown[][]> = {};
    const spy = (name: string) => (...a: unknown[]) => { (args[name] ??= []).push(a.slice(2)); };
    const names = ['setSpread', 'raiseShields', 'setWeaponsLock', 'setDelegate', 'setPowerLevel', 'clickManeuver', 'scrollManeuvers', 'fireTorpedoes'];
    const also = Object.fromEntries(names.map(n => [n, spy(n)]));
    const { ctx, b } = miniBattle({ ctx: miniBattleContext(recordingSeams(log, also)) });
    log.length = 0;
    for (const cmd of [
      { type: 'fire', weapon: 'phasers' }, { type: 'fire', weapon: 'both' }, { type: 'fire', weapon: 'torpedoes' }, { type: 'spread', cell: 3 }, { type: 'spread', cell: 10 },
      { type: 'shields', on: true }, { type: 'shields', on: false }, { type: 'weaponsLock', on: true }, { type: 'weaponsLock', on: false },
      { type: 'delegate', on: true }, { type: 'delegate', on: false }, { type: 'selfDestruct' },
      { type: 'powerLevel', level: 4 }, { type: 'powerLevel', level: 5 }, { type: 'maneuver', row: 2 }, { type: 'scrollManeuvers', direction: -1 },
      { type: 'engage' }, { type: 'hail' }, { type: 'bridge' }, { type: 'engineering' },
    ] as const) applyCommand(ctx, b, cmd);
    expect(log).toEqual([
      'firePhasers:0', 'firePhasers:0', 'fireTorpedoes:0', 'fireTorpedoes:0', 'setSpread', 'raiseShields', 'raiseShields', 'setWeaponsLock', 'setWeaponsLock',
      'setDelegate', 'setDelegate', 'armSelfDestruct', 'setPowerLevel', 'clickManeuver', 'scrollManeuvers', 'engageManeuver', 'hail', 'bridge', 'engineering',
    ]);
    expect(args.fireTorpedoes).toEqual([[b.ships[0], 0], [b.ships[0], 0]]);
    expect(args.setSpread).toEqual([[3]]);
    expect(args.raiseShields).toEqual([[true], [false]]);
    expect(args.setWeaponsLock).toEqual([[true], [false]]);
    expect(args.setDelegate).toEqual([[true, true], [false, true]]);
    expect(args.setPowerLevel).toEqual([[4, false]]);
    expect(args.clickManeuver).toEqual([[2]]);
    expect(args.scrollManeuvers).toEqual([[-1]]);
  });

  it('sets the phaser banks\' and the tubes\' sliders within their ranges, and all or none of the banks', () => {
    const { ctx, b } = miniBattle();
    const bank = () => ({ unit: 13, offset: v3(), active: false, miss: false, missOffset: v3(), endTime: 0, lastUpdate: 0, beam: { frames: null, frame: 0, frameTime: 0, lastFrame: 0 }, charge: 0, setting: 50, savedSetting: 0, tip: v3() });
    b.ships[0]!.banks = [bank(), bank()];
    applyCommand(ctx, b, { type: 'bank', bank: 1, setting: 140 });
    applyCommand(ctx, b, { type: 'bank', bank: 7, setting: 10 });
    expect(b.ships[0]!.banks.map(k => k.setting)).toEqual([50, 100]);
    applyCommand(ctx, b, { type: 'banks', all: false });
    expect(b.ships[0]!.banks.map(k => k.setting)).toEqual([0, 0]);
    applyCommand(ctx, b, { type: 'salvo', tube: 1, setting: 12 });
    applyCommand(ctx, b, { type: 'salvo', tube: 0, setting: 3.7 });
    expect(b.console.salvo.map(t => t.setting)).toEqual([3, 10]);
  });

  it('targets the next or previous live, visible ship that is not the Enterprise, or a ship by its index', () => {
    const combat = miniCombat();
    const ships = combat.battles[3]!.ships;
    ships.push({ ...ships[1]!, object: 'space.b' }, { ...ships[1]!, object: 'space.c' }, { ...ships[1]!, object: 'space.d' });
    const { ctx, b } = miniBattle({ ctx: miniBattleContext({}, combat) });
    expect(b.target).toBe(4);
    b.ships[2]!.decloakTime = 99999;
    b.ships[3]!.flags |= SHIP_STATE.dying;
    applyCommand(ctx, b, { type: 'target', which: 'next' });
    expect([b.target, b.ships[0]!.target]).toEqual([1, 1]);
    applyCommand(ctx, b, { type: 'target', which: 'next' });
    expect(b.target).toBe(4);
    applyCommand(ctx, b, { type: 'target', which: 'prev' });
    expect(b.target).toBe(1);
    // (with ship 2 visible again, from 1 next is 2 and prev wraps past the Enterprise to 4)
    b.ships[2]!.decloakTime = 0;
    applyCommand(ctx, b, { type: 'target', which: 'next' });
    expect(b.target).toBe(2);
    applyCommand(ctx, b, { type: 'target', ship: 1 });
    applyCommand(ctx, b, { type: 'target', which: 'prev' });
    expect(b.target).toBe(4);
    applyCommand(ctx, b, { type: 'target', ship: null });
    expect([b.target, b.ships[0]!.target]).toEqual([null, null]);
    // (with none left to target, none: from a target, not from the none the line above left)
    applyCommand(ctx, b, { type: 'target', ship: 1 });
    for (const s of b.ships.slice(1)) s.destroyed = true;
    nextTarget(b, 1);
    expect(b.target).toBeNull();
    expect(b.ships[0]!.target).toBeNull();
  });

  it('ignores a target past the last ship, as the harness does (harness.inc `target`): the target stays as it was', () => {
    const { ctx, b } = miniBattle();
    applyCommand(ctx, b, { type: 'target', ship: 1 });
    applyCommand(ctx, b, { type: 'target', ship: b.ships.length });
    applyCommand(ctx, b, { type: 'target', ship: 99 });
    expect([b.target, b.ships[0]!.target]).toEqual([1, 1]);
    applyCommand(ctx, b, { type: 'target', ship: 0 });
    expect(b.target).toBe(0);
  });

  it('changes only what the presentation reads: views, the zoom (levels -1 to 3), the cycle (at most every 247 ms) and the wide view', () => {
    const { ctx, b } = miniBattle();
    applyCommand(ctx, b, { type: 'view', view: 0xc, ship: 'target' });
    expect([b.view.view, b.view.viewShip, b.view.viewExpiry]).toEqual([0xc, 1, 30000]);
    applyCommand(ctx, b, { type: 'view', view: 0x13, ship: 'enterprise' });
    expect(b.view.view).toBe(0xc);
    applyCommand(ctx, b, { type: 'view', view: 0xe, ship: 'enterprise' });
    expect([b.view.view, b.view.viewShip]).toEqual([0xe, 0]);
    for (let i = 0; i < 6; i++) applyCommand(ctx, b, { type: 'zoom', direction: 'in' });
    expect([b.view.zoomLevel, b.view.zoom]).toEqual([3, 0.75]);
    for (let i = 0; i < 6; i++) applyCommand(ctx, b, { type: 'zoom', direction: 'out' });
    expect([b.view.zoomLevel, b.view.zoom]).toEqual([-1, 3.75]);
    expect(CYCLE_DELAY).toBe(247);
    applyCommand(ctx, b, { type: 'cycleView' });
    expect([b.view.cycleShip, b.view.viewShip, b.view.view]).toEqual([1, 1, 0]);
    applyCommand(ctx, b, { type: 'cycleView' });
    expect(b.view.cycleShip).toBe(1);
    b.now += 247;
    applyCommand(ctx, b, { type: 'cycleView' });
    expect([b.view.cycleShip, b.view.cycleView, b.view.viewShip, b.view.view]).toEqual([0, 1, 0, 1]);
    applyCommand(ctx, b, { type: 'wide', on: true });
    expect(b.view.wide).toBe(true);
  });

  it('shows the radar while it is open and the view narrow: `radar` opens and closes it, `wide` hides it (tactical.cpp:1315-1316; Plan 23 R10)', () => {
    const { ctx, b } = miniBattle();
    const shown = () => [b.console.radarOpen, b.view.wide, b.console.radarShown];
    expect(shown()).toEqual([true, false, true]);
    applyCommand(ctx, b, { type: 'wide', on: true });
    expect(shown()).toEqual([true, true, false]);
    applyCommand(ctx, b, { type: 'radar', open: false });
    applyCommand(ctx, b, { type: 'wide', on: false });
    expect(shown()).toEqual([false, false, false]);
    applyCommand(ctx, b, { type: 'wide', on: true });
    applyCommand(ctx, b, { type: 'radar', open: true });
    expect(shown()).toEqual([true, true, false]);
    applyCommand(ctx, b, { type: 'wide', on: false });
    expect(shown()).toEqual([true, false, true]);
  });

  it('follows the console\'s page only as far as the sim reads it: on the CONN page or not (tactical.cpp:471)', () => {
    const { ctx, b } = miniBattle();
    expect(CONSOLE_PAGES).toEqual(['phasers', 'torpedoes', 'damage', 'conn', 'tactics', 'sensors']);
    for (const page of CONSOLE_PAGES) {
      applyCommand(ctx, b, { type: 'page', page });
      expect(b.console.connPage, page).toBe(page === 'conn');
    }
  });

  it('cycles the view when the last cycle is ahead of the clock, as ScummVM\'s uint32 does (combat.cpp:690)', () => {
    const { ctx, b } = miniBattle();
    b.view.lastCycle = b.now + 1000;
    applyCommand(ctx, b, { type: 'cycleView' });
    expect([b.view.cycleShip, b.view.lastCycle]).toEqual([1, b.now]);
  });
});

