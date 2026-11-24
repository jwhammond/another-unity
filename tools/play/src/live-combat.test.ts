// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { battleOutcome, combatSim, createInitialState, newSystems, parseGame } from '@another-unity/engine';
import { describe, expect, it } from 'vitest';
import { readGameDir } from './readGameDir';

// (games/unity after npm run unity:build, docs/unity-local.md)
const game = fileURLToPath(new URL('../../../games/unity', import.meta.url));
const lifted = existsSync(join(game, 'combat.yaml'));
if (!lifted) console.info('live-combat.test.ts: skipped; run npm run unity:build for games/unity/combat.yaml (docs/unity-local.md)');

/** The battles whose Enterprise a new game has inactive (measured for Plan 19): the story activates them later. */
const WAITING = [2, 3, 4, 6, 7];

describe.skipIf(!lifted)('every lifted battle in the combat sim (Plans 19-21)', () => {
  it('sets up each of the 40 battles from a new game, or says it has no Enterprise, and flies each 300 steps by hand', async () => {
    const content = parseGame(await readGameDir(game));
    const state = createInitialState(content);
    const ship = content.ship!;
    const combat = ship.combat!;
    const ctx = { combat, enterpriseUnits: ship.data.units, seams: { ...combatSim.NO_SEAMS } };
    const refused: number[] = [];
    for (const scenario of Object.keys(combat.battles).map(Number)) {
      const systems = newSystems(ship);
      combatSim.systemsToBattleClock(systems, state.tick, 10000);
      const { battle, warnings } = combatSim.setupBattle(ctx, {
        scenario, seed: 7, now: 10000, difficulty: 1, active: id => state.objects[id]?.active ?? false, enterprise: systems,
      });
      if (!battle) {
        expect(warnings).toEqual([`battle screen ${scenario.toString(16)} has no Enterprise`]);
        refused.push(scenario);
        continue;
      }
      expect(warnings).toEqual([]);
      combatSim.applyCommand(ctx, battle, { type: 'steer', yaw: 1, pitch: 1, roll: -1, throttle: 1 });
      for (let t = 10066; t <= 10000 + 300 * 66; t += 66) combatSim.updateBattle(ctx, battle, t);
      expect(battle.steps).toBe(300);
      for (const s of battle.ships) for (const v of [s.pos.x, s.pos.y, s.pos.z, s.speed, s.maxSpeed]) expect(Number.isFinite(v)).toBe(true);
    }
    expect(Object.keys(combat.battles)).toHaveLength(40);
    expect(refused).toEqual(WAITING);
    console.info(`live-combat.test.ts: ${40 - refused.length} battles flown; waiting for the story: ${refused.join(', ')}`);
  });

  it('fights each startable battle with weapons and damage: the Enterprise fires on its target every 2 s for 300 steps', async () => {
    const content = parseGame(await readGameDir(game));
    const state = createInitialState(content);
    const ship = content.ship!;
    const combat = ship.combat!;
    const ctx = { combat, enterpriseUnits: ship.data.units, seams: { ...combatSim.NO_SEAMS, ...combatSim.WEAPON_SEAMS, ...combatSim.DAMAGE_SEAMS } };
    expect(combatSim.combatDataProblems(ctx)).toEqual([]);
    let fought = 0, hit = 0, destroyed = 0;
    for (const scenario of Object.keys(combat.battles).map(Number)) {
      if (WAITING.includes(scenario)) continue;
      const systems = newSystems(ship);
      combatSim.systemsToBattleClock(systems, state.tick, 10000);
      const { battle, warnings } = combatSim.setupBattle(ctx, {
        scenario, seed: 7, now: 10000, difficulty: 1, active: id => state.objects[id]?.active ?? false, enterprise: systems,
      });
      expect(warnings).toEqual([]);
      if (!battle) throw new Error(`battle ${scenario} did not set up`);
      const b = battle;
      combatSim.applyCommand(ctx, b, { type: 'powerLevel', level: 4 });
      combatSim.applyCommand(ctx, b, { type: 'weaponsLock', on: true });
      for (let step = 0; step < 300 && b.exitCode === combatSim.NO_EXIT; step++) {
        if (step % 30 === 0) combatSim.applyCommand(ctx, b, { type: 'fire', weapon: 'both' });
        combatSim.updateBattle(ctx, b, b.lastStep + combatSim.STEP_TIME);
      }
      fought++;
      for (const s of b.ships) {
        for (const v of [s.pos.x, s.pos.y, s.pos.z, s.speed]) expect(Number.isFinite(v)).toBe(true);
        for (const u of s.systems.units) expect(Number.isInteger(u.current) && Number.isInteger(u.damage)).toBe(true);
      }
      if (b.ships.slice(1).some(s => s.log.length > 0)) hit++;
      if (b.ships.slice(1).some(s => s.destroyed)) destroyed++;
    }
    expect(fought).toBe(35);
    expect(hit).toBe(24);
    expect(destroyed).toBe(0);
    console.info(`live-combat.test.ts: ${fought} battles fought with weapons; a ship hit in ${hit}, destroyed in ${destroyed}`);
  });

  it('fights each startable battle Delegate against the AI and tactics to an end, or 9000 steps (about ten minutes)', async () => {
    const content = parseGame(await readGameDir(game));
    const state = createInitialState(content);
    const ship = content.ship!;
    const combat = ship.combat!;
    const warnings: string[] = [];
    const ctx = { combat, enterpriseUnits: ship.data.units, seams: { ...combatSim.NO_SEAMS, ...combatSim.SIM_SEAMS }, onWarning: (m: string) => { warnings.push(m); } };
    const outcomes: Record<string, number> = {};
    for (const scenario of Object.keys(combat.battles).map(Number)) {
      if (WAITING.includes(scenario)) continue;
      const systems = newSystems(ship);
      combatSim.systemsToBattleClock(systems, state.tick, 10000);
      const { battle } = combatSim.setupBattle(ctx, {
        scenario, seed: 7, now: 10000, difficulty: 1, active: id => state.objects[id]?.active ?? false, enterprise: systems,
      });
      const b = battle!;
      // (every ship with a script runs it: the Enterprise's sets up its maneuvers in the first step)
      for (const s of b.ships) expect(s.script !== null).toBe(s.tactics !== null);
      for (let step = 0; step < 9000 && battleOutcome(b) === 'fighting'; step++) {
        // (Delegate once the kernel is ready, as a player pressing it: ai.cpp:468-502)
        if (step === 1) combatSim.applyCommand(ctx, b, { type: 'delegate', on: true });
        combatSim.updateBattle(ctx, b, b.lastStep + combatSim.STEP_TIME);
        b.cues.length = 0;
        b.sounds.length = 0;
      }
      for (const s of b.ships) for (const v of [s.pos.x, s.pos.y, s.pos.z, s.speed, s.controls.yaw, s.controls.pitch, s.controls.roll]) expect(Number.isFinite(v)).toBe(true);
      const outcome = battleOutcome(b) === 'fighting' ? 'timeout' : battleOutcome(b);
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    }
    // (measured for Plan 21, Lieutenant, seed 7, as loss 12, timeout 16; since Plan 23 each step asks the sensors first,
    // as the radar's draw did (R10), and one loss goes on to the cap. Plan 22's parity suite checks the battles against ScummVM's traces)
    expect(outcomes).toEqual({ loss: 11, peace: 7, timeout: 17 });
    // (the game's scripts use no token, verb or branch the port doesn't know; the battle that now runs on to the cap pops
    // its tactics' event queue past empty three times, which ScummVM warns of too, tactics.cpp:529: the script's own)
    expect(warnings).toEqual(Array(3).fill('tactic: event queue stack underflow'));
    console.info(`live-combat.test.ts: Delegate against the AI in 35 battles: ${Object.entries(outcomes).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  });
});
