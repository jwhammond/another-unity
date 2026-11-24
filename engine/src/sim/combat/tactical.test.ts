// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { miniBattleContext, miniCombat, miniEnterpriseSystems } from '../../testing/combat';
import { SIM_SEAMS } from './seams';
import { logMessage } from './battle';
import { blowUpInTurn, DEFAULT_BATTLE, leaveCode, NO_BATTLE, NO_DIFFICULTY, scrollLog, STARBASE_BATTLE, startBattle, tacticalUpdate, type StartInput } from './tactical';
import { combatTicks, STEP_TIME } from './time';
import { GAME_OVER_EXIT, MAX_RANGE, NO_EXIT, type BattleState } from './types';

/** miniCombat with battle 3 copied to the default battle (8) and the starbase's (0x50), and battle 4 with a friendly Klingon (type 3) for the enemy. */
function combat() {
  const c = miniCombat();
  const three = c.battles[3]!;
  c.battles[DEFAULT_BATTLE] = three;
  c.battles[STARBASE_BATTLE] = three;
  c.battles[4] = { ...three, ships: [three.ships[0]!, { ...three.ships[1]!, type: 3 }] };
  return c;
}
const ctx = miniBattleContext({ ...SIM_SEAMS }, combat());
function start(o: Partial<StartInput> = {}, c = ctx): BattleState {
  const { battle, warnings } = startBattle(c, {
    scenario: 3, seed: 1234, now: 10000, difficulty: 1, active: () => true, enterprise: miniEnterpriseSystems(),
    lastDifficulty: NO_DIFFICULTY, objectState: () => 0, ...o,
  });
  expect(warnings).toEqual([]);
  return battle!;
}
const ready = (b: BattleState) => [b.console.delegate, b.console.weaponsLock, b.console.powerLevel, b.console.redAlert, b.console.connPage];

describe('TacticalScreen::start\'s battle (tactical.cpp:301-336)', () => {
  it('has Worf fight for an Ensign: Delegate on, the weapons locked and battle stations, at a red alert on the CONN page', () => {
    expect(ready(start({ difficulty: 0 }))).toEqual([true, true, 4, true, true]);
  });

  it('leaves a Lieutenant to fly: Delegate off, the lock off, the power level from the Enterprise object\'s state (1-5, else 0)', () => {
    expect(ready(start({ objectState: () => 3 }))).toEqual([false, false, 2, true, true]);
    expect(start({ objectState: () => 6 }).console.powerLevel).toBe(0);
    expect(start({ objectState: () => 5 }).console.powerLevel).toBe(4);
    // (the Enterprise's own object: the battle's ship 0 after setup)
    expect(start({ objectState: o => (o === 'space.enterprise' ? 4 : 1) }).console.powerLevel).toBe(3);
  });

  it('sets Delegate only when the difficulty has changed since the last battle; else it stays as the last left it', () => {
    const last = start({ difficulty: 0 });
    // (the player turned Worf off; at the same difficulty the next battle keeps it off)
    last.console.delegate = false;
    expect(start({ difficulty: 0, lastDifficulty: 0, previous: last }).console.delegate).toBe(false);
    last.console.delegate = true;
    expect(start({ difficulty: 1, lastDifficulty: 1, previous: last }).console.delegate).toBe(true);
    expect(start({ difficulty: 1, lastDifficulty: 0, previous: last }).console.delegate).toBe(false);
  });

  it('gets Worf ready only if there is an enemy: with only a friend, Delegate is on but the lock and power stay', () => {
    expect(ready(start({ difficulty: 0, scenario: 4, objectState: () => 2 }))).toEqual([true, false, 1, true, true]);
  });

  it('is at a red alert unless it is the default battle or the starbase\'s', () => {
    expect([start({ scenario: DEFAULT_BATTLE }), start({ scenario: STARBASE_BATTLE }), start({ scenario: 4 })].map(b => b.console.redAlert)).toEqual([false, false, true]);
  });

  it('fights the default battle when there is no scenario, and says so (tactical.cpp:311-313)', () => {
    const r = startBattle(ctx, {
      scenario: NO_BATTLE, seed: 1234, now: 10000, difficulty: 1, active: () => true, enterprise: miniEnterpriseSystems(),
      lastDifficulty: NO_DIFFICULTY, objectState: () => 0,
    });
    expect([r.scenario, r.battle!.scenario, r.battle!.console.redAlert]).toEqual([DEFAULT_BATTLE, DEFAULT_BATTLE, false]);
  });

  it('gives the next start its last difficulty, this start\'s, even when setup fails (tactical.cpp:308, 314-318)', () => {
    const input = { seed: 1234, now: 10000, active: () => true, enterprise: miniEnterpriseSystems(), lastDifficulty: 1, objectState: () => 0 };
    expect(startBattle(ctx, { ...input, scenario: 3, difficulty: 2 }).lastDifficulty).toBe(2);
    // (battle 9 isn't in the data: no battle, and the difficulty is still taken)
    const failed = startBattle(ctx, { ...input, scenario: 9, difficulty: 0 });
    expect([failed.battle, failed.lastDifficulty, failed.scenario]).toEqual([null, 0, 9]);
  });
});

describe('processHails\' 0x10, its battle half (tactical.cpp:420-429)', () => {
  it('blows everyone up in turn from the battle\'s now, the later ships first, and leaves a ship already due as it is', () => {
    const b = start();
    b.ships[1]!.removeTime = 12345;
    blowUpInTurn(b, 20000);
    // ((3 - 0) * 0x5af ticks = 15000 ms for the Enterprise; the chodak was already due)
    expect([b.ships[0]!.removeTime, b.ships[1]!.removeTime]).toEqual([20000 + combatTicks(3 * 0x5af), 12345]);
    expect(combatTicks(3 * 0x5af)).toBe(15000);
  });

  it('puts a fifth ship\'s hours on, as ScummVM\'s uint32 count below zero does (a quirk, kept)', () => {
    const b = start();
    for (let i = 2; i < 5; i++) b.ships.push({ ...structuredClone(b.ships[1]!), index: i, removeTime: 0 });
    blowUpInTurn(b, 20000);
    // ((3 - 4) * 0x5af = -1455 as uint32, * 1000 in uint32, / 291: 14754337 ms)
    expect(b.ships.map(s => s.removeTime)).toEqual([35000, 30000, 25000, 20000, 20000 + 14754337]);
  });
});

describe('TacticalScreen::update\'s battle (tactical.cpp:468-482)', () => {
  it('steps the battle, and leaves by the exit code without standing down', () => {
    const b = start();
    expect(tacticalUpdate(ctx, b, b.lastStep + STEP_TIME)).toEqual({ leave: null, standDowns: [] });
    expect(b.steps).toBe(1);
    b.exitCode = 9;
    expect(tacticalUpdate(ctx, b, b.lastStep + STEP_TIME)).toEqual({ leave: 9, standDowns: [] });
    // (the code is spent as the screen leaves: tactical.cpp:370)
    expect([b.console.redAlert, b.exitCode]).toEqual([true, NO_EXIT]);
  });

  it('leaves for the game\'s end when the self-destruct is armed, whatever the code (tactical.cpp:371-373)', () => {
    const b = start();
    b.console.selfDestructTime = b.now + 1000;
    expect(leaveCode(b, 0)).toBe(GAME_OVER_EXIT);
    b.console.selfDestructTime = 0;
    expect(leaveCode(b, 0)).toBe(0);
  });

  it('stands down once only the Enterprise is left (a won battle: no exit code)', () => {
    const b = start();
    b.ships[1]!.removed = true;
    expect(tacticalUpdate(ctx, b, b.lastStep + STEP_TIME)).toEqual({ leave: null, standDowns: ['tactical.cpp:482'] });
    expect([b.console.redAlert, b.exitCode]).toEqual([false, NO_EXIT]);
  });

  it('stands down when the target is out of range, and the battle goes on', () => {
    // (without the AI, whose own stand-down beyond 58000 comes first in the step: ai.cpp:394-395)
    const quiet = miniBattleContext({}, combat());
    const b = start({}, quiet);
    b.ships[1]!.pos = { x: MAX_RANGE * 2, y: 0, z: 0 };
    expect(tacticalUpdate(quiet, b, b.lastStep + STEP_TIME)).toEqual({ leave: null, standDowns: ['tactical.cpp:480'] });
    expect(b.console.redAlert).toBe(false);
    expect(tacticalUpdate(quiet, b, b.lastStep + STEP_TIME)).toEqual({ leave: null, standDowns: [] });
    expect(b.steps).toBe(2);
  });

  it('leaves the AI\'s own stand-down to the AI: beyond 58000 the enemy stands the Enterprise down within the step', () => {
    const b = start();
    b.ships[1]!.pos = { x: MAX_RANGE * 2, y: 0, z: 0 };
    expect(tacticalUpdate(ctx, b, b.lastStep + STEP_TIME)).toEqual({ leave: null, standDowns: [] });
    expect(b.console.redAlert).toBe(false);
  });
});

describe('the scanner\'s log, scrolling as drawScanner reads it (tactical.cpp:1250-1255; Plan 27 R6)', () => {
  it('shows a line more each 0x48 ticks while it is read, to the newest, and keeps its place as old lines fall off', () => {
    const b = start();
    const e = b.ships[0]!;
    for (let i = 0; i < 4; i++) logMessage(e, `-L${i}-`);
    // (the first read at any time from 0: the newest line read is the second, the next read 247 ms on)
    scrollLog(e, 10000);
    expect([e.logRead, e.logScrollTime]).toEqual([1, 10000 + combatTicks(0x48)]);
    scrollLog(e, 10100);
    expect(e.logRead).toBe(1);
    scrollLog(e, 10247);
    scrollLog(e, 10494);
    scrollLog(e, 10741);
    // (no line past the last: 3 is the newest of four)
    expect(e.logRead).toBe(3);
    for (let i = 4; i < 16; i++) logMessage(e, `-L${i}-`);
    // (fifteen kept: the first fell off, and the line read moved down with it, damage.cpp:85-90)
    expect([e.log.length, e.log[0], e.logRead, e.log[e.logRead]]).toEqual([15, '-L1-', 2, '-L3-']);
  });
});
