// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { miniBattle, miniBattleContext } from '../../testing/combat';
import { updateBattle } from './battle';
import { STEP_TIME } from './time';
import { snapshot, SNAPSHOT_STEPS } from './trace';

describe('a battle\'s snapshot, as ScummVM\'s trace writes it', () => {
  it('has every field of the battle, each distinct, in the shapes ScummVM writes', () => {
    const { b } = miniBattle();
    Object.assign(b.console, { redAlert: true, delegate: false, weaponsLock: true, shieldsRaised: false, powerLevel: 3, kernelReady: true });
    b.exitCode = 0x103;
    b.steps = 41;
    b.now = 12345;
    b.target = 0;
    b.random.state = 777;
    const [e, f] = b.ships as [typeof b.ships[0], typeof b.ships[0]];
    Object.assign(e, { condition: 90, flags: 5, removeTime: 6, engaged: false, destroyed: false, removed: false, speed: 2.5, target: null });
    Object.assign(f, { condition: 55, flags: 0x21, removeTime: 800, engaged: true, destroyed: true, removed: false, speed: -1.25, target: 0 });
    e.pos = { x: 1.5, y: 2.5, z: 3.5 }; e.velocity = { x: 4.5, y: 5.5, z: 6.5 }; e.angles = [7, 8, 9];
    f.pos = { x: -1, y: -2, z: -3 }; f.velocity = { x: 0.25, y: -0.5, z: 0.75 }; f.angles = [10, 11, 12];
    e.systems.pool = 7; e.systems.torpedoes = 3;
    f.systems.pool = 13; f.systems.torpedoes = 17;
    const rows = (ship: typeof e, k: number) => ship.systems.units.map((u, i) => {
      Object.assign(u, { current: i + k, target: i + k + 1, max: i + k + 2, damage: i + k + 3, repair: i + k + 4 });
      return [i + k, i + k + 1, i + k + 2, i + k + 3, i + k + 4];
    });
    const eRows = rows(e, 100), fRows = rows(f, 200);
    b.view.camera = { pos: { x: 0.5, y: -1.5, z: 2.5 }, axes: [1, 2, 3, 4, 5, 6, 7, 8, 9] };
    b.view.view = 0xc;
    expect(snapshot(b)).toEqual({
      ev: 'snap', step: 41, now: 12345, exit: 0x103, target: 0, redAlert: true, delegate: false, weaponsLock: true, shieldsRaised: false,
      powerLevel: 3, kernelReady: true, random: 777, camera: { pos: [0.5, -1.5, 2.5], axes: [1, 2, 3, 4, 5, 6, 7, 8, 9], view: 0xc },
      ships: [
        {
          index: 0, pos: [1.5, 2.5, 3.5], velocity: [4.5, 5.5, 6.5], angles: [7, 8, 9], speed: 2.5, condition: 90, flags: 5, destroyed: false,
          removed: false, target: -1, engaged: false, removeTime: 6, units: eRows, pool: 7, torpedoes: 3,
        },
        {
          index: 1, pos: [-1, -2, -3], velocity: [0.25, -0.5, 0.75], angles: [10, 11, 12], speed: -1.25, condition: 55, flags: 0x21, destroyed: true,
          removed: false, target: 0, engaged: true, removeTime: 800, units: fRows, pool: 13, torpedoes: 17,
        },
      ],
      torpedoes: [],
    });
    expect([eRows.length, fRows.length]).toEqual([35, 20]);
  });

  it('lists the active torpedoes by slot, and -1 for no ship', () => {
    const { b } = miniBattle();
    b.target = null;
    Object.assign(b.torpedoes[3]!, { active: true, pos: { x: 1, y: 2, z: 3 }, angles: [4, 5, 6], shooter: 0, target: null, expiry: 99 });
    const s = snapshot(b);
    expect([s.target, s.torpedoes]).toEqual([-1, [{ slot: 3, pos: [1, 2, 3], angles: [4, 5, 6], shooter: 0, target: -1, expiry: 99 }]]);
  });

  it('is taken where onStep hears each step end, inside the update and before what follows it, every 15 steps', () => {
    const steps: number[] = [];
    const ctx = { ...miniBattleContext(), onStep: (b: { steps: number }) => { steps.push(b.steps); } };
    const { b } = miniBattle({ ctx });
    // (one update over three steps: each heard in turn)
    updateBattle(ctx, b, b.lastStep + 3 * STEP_TIME);
    expect([steps, SNAPSHOT_STEPS]).toEqual([[1, 2, 3], 15]);
  });

  it('hears the step that sets the exit code, as it hears every step', () => {
    const heard: number[] = [];
    const ctx = miniBattleContext({ runAI: (_c, b) => { b.exitCode = 7; } });
    ctx.onStep = b => { heard.push(b.exitCode); };
    const { b } = miniBattle({ ctx });
    updateBattle(ctx, b, b.lastStep + 3 * STEP_TIME);
    expect(heard.length).toBe(b.steps);
    expect(heard[0]).toBe(7);
  });
});
