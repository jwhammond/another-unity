// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { miniEnterpriseSystems, miniEnterpriseUnits } from '../../testing/combat';
import { miniShipData } from '../../testing/ship';
import { MS_CLOCK, newSystems, SHIP_CLOCK, tickUnits } from '../shipSystems';
import { combatTicks, msToShipTick, shipTickToMs, STEP_TIME, systemsToBattleClock, systemsToShipClock } from './time';

describe('the battle clock', () => {
  it('steps 66 ms, and counts the original clock of 291 ticks a second as ms (combat.h:41-43)', () => {
    expect(STEP_TIME).toBe(66);
    expect(combatTicks(0x369)).toBe(3000);
    expect(combatTicks(0x5af)).toBe(5000);
    expect(combatTicks(0x48)).toBe(247);
    // ((uint32)ticks * 1000 wraps at 32 bits)
    expect(combatTicks(5_000_000)).toBe(Math.trunc(((5_000_000 * 1000) % 2 ** 32) / 291));
  });

  it('moves times between the ship ticks and the battle ms, and back to the same tick', () => {
    expect(shipTickToMs(0)).toBe(0);
    expect(shipTickToMs(1)).toBe(16);
    expect(shipTickToMs(600)).toBe(10000);
    for (let t = 0; t <= 20000; t++) expect(msToShipTick(shipTickToMs(t))).toBe(t);
  });

  it('retimes the Enterprise systems for the battle and back, relative to each clock\'s now, leaving 0 as 0', () => {
    const s = newSystems(miniShipData());
    s.lastTick = 600;
    s.lastReactorTick = 570;
    s.units[3]!.nextStep = 606;
    // (the world's tick 600, the battle starting at 50000 ms: not shipTickToMs(600))
    systemsToBattleClock(s, 600, 50000);
    expect([s.lastTick, s.lastReactorTick, s.units[3]!.nextStep, s.units[4]!.nextStep]).toEqual([50000, 49500, 50100, 0]);
    systemsToShipClock(s, 50000, 600);
    expect([s.lastTick, s.lastReactorTick, s.units[3]!.nextStep, s.units[4]!.nextStep]).toEqual([600, 570, 606, 0]);
    // (a time before the clock's start stays a time, not "never")
    s.lastTick = 1;
    systemsToBattleClock(s, 600, 5000);
    expect(s.lastTick).toBe(1);
  });

  it('brings the Enterprise back from a 300 s battle the world did not see charging and repairing at once', () => {
    const units = miniEnterpriseUnits();
    const s = miniEnterpriseSystems(units);
    const world = 600;
    tickUnits(units, s, world, SHIP_CLOCK);
    const start = shipTickToMs(world);
    systemsToBattleClock(s, world, start);
    let now = start;
    for (; now < start + 300_000; now += STEP_TIME) tickUnits(units, s, now, MS_CLOCK);
    now -= STEP_TIME;
    // (the world's tick has not moved: paused, fast-forwarded, auto-resolved, or its tick stopped for the battle)
    systemsToShipClock(s, now, world);
    expect(s.lastTick).toBe(world);
    expect(s.lastReactorTick).toBeLessThanOrEqual(world);
    for (const u of s.units) expect(Math.max(u.nextStep, u.nextRepair)).toBeLessThanOrEqual(world + SHIP_CLOCK.ms(1000));
    // a phaser (type 1) drained, and another damaged with repair to do
    const phaser = units.findIndex(u => u.type === 1);
    const other = units.findIndex((u, i) => u.type === 1 && i !== phaser);
    s.units[phaser]!.current = 50;
    Object.assign(s.units[other]!, { damage: 3, repair: 3 });
    expect(s.pool).toBeGreaterThan(10);
    tickUnits(units, s, world + SHIP_CLOCK.ms(1000), SHIP_CLOCK);
    expect(s.units[phaser]!.current).toBeGreaterThan(50);
    expect(s.units[other]!.damage).toBe(2);
  });
});
