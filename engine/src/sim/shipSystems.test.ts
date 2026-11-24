// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { ShipContent } from '../content/types';
import { TICKS_PER_SECOND } from './clock';
import {
  liveUnits, MS_CLOCK, newSystems, resetSystems, setDamage, setSlider, SLIDER_WIDTH, STARTING_POWER, STARTING_TORPEDOES, tickSystems, tickUnits,
  sensorOutput, typePercent, UNIT_ALL, UNIT_FUSION, UNIT_POWER_GRID, UNIT_SENSOR, UNIT_TORPEDO, UNIT_WARP,
} from './shipSystems';
import { deserializeState, serializeState } from './save';
import { createInitialState } from './state';
import { miniShipContent } from '../testing/ship';

/** A made-up set of units: the grid, a fusion reactor, a warp engine, a shield and a torpedo launcher. */
function ship(): ShipContent {
  const unit = (name: string, type: number, current: number, max: number, chargeTicks = 30, maxDamage = 100) => (
    { name, type, current, target: current, max, chargeTicks, dischargeTicks: 10, damage: 0, repair: 0, baseDamage: 0, maxDamage, efficiency: type === UNIT_FUSION ? 95 : 0 }
  );
  const c = miniShipContent().ship!;
  c.data.units = [
    unit('Eps power grid', UNIT_POWER_GRID, 0, 1000),
    unit('Fusion reactor', UNIT_FUSION, 20, 25),
    unit('Port warp', UNIT_WARP, 100, 100),
    unit('Fore torpedo', UNIT_TORPEDO, 2, 10),
  ];
  return c;
}
const second = TICKS_PER_SECOND;

describe('the ship\'s systems', () => {
  it('start as the lifted units say, with the starting power and torpedoes, and the reactors at 95 percent', () => {
    const s = newSystems(ship());
    expect(s.pool).toBe(STARTING_POWER);
    expect(s.torpedoes).toBe(STARTING_TORPEDOES);
    expect(s.units.map(u => u.efficiency)).toEqual([0, 95, 0, 0]);
    expect(s.units[1]).toMatchObject({ current: 20, target: 20, max: 25, damage: 0, repair: 0 });
  });

  it('take each unit\'s efficiency from ship.yaml (ShipSystems::load, ship.cpp:77), which every unit has (Plan 23 dropped the reactors\' fallback)', () => {
    const c = ship();
    c.data.units[1]!.efficiency = 77;
    c.data.units[2]!.efficiency = 40;
    expect(newSystems(c).units.map(u => u.efficiency)).toEqual([0, 77, 40, 0]);
  });

  it('read the live level when there is one, and the content\'s when not', () => {
    const c = ship();
    const s = newSystems(c);
    s.units[2]!.current = 50;
    expect(typePercent(c, UNIT_WARP, false, s)).toBe(50);
    expect(typePercent(c, UNIT_WARP, false)).toBe(100);
    expect(liveUnits(c, s)[2]).toEqual({ name: 'Port warp', type: UNIT_WARP, current: 50, max: 100 });
  });

  describe('setSlider (EngineeringScreen::setSlider)', () => {
    it('sets a power target by the distance along the bar, clipped to its 119 pixels', () => {
      const c = ship(), s = newSystems(c);
      setSlider(c, s, 2, 'power', 59.5);
      expect(s.units[2]!.target).toBe(Math.trunc(100 * 59 / SLIDER_WIDTH));
      setSlider(c, s, 2, 'power', 500);
      expect(s.units[2]!.target).toBe(100);
      setSlider(c, s, 2, 'power', -20);
      expect(s.units[2]!.target).toBe(0);
    });

    it('asks for repair no more than what is damaged, in seconds of the unit\'s own repair time', () => {
      const c = ship(), s = newSystems(c);
      s.units[2]!.damage = 30;
      setSlider(c, s, 2, 'repair', SLIDER_WIDTH);
      expect(s.units[2]!.repair).toBe(30);
      setSlider(c, s, 2, 'repair', 12);
      expect(s.units[2]!.repair).toBe(Math.trunc(100 * 12 / SLIDER_WIDTH));
    });

    it('will not move a damaged reactor, and sets the torpedoes to load in tenths of the cells\' 101 pixels', () => {
      const c = ship(), s = newSystems(c);
      s.units[1]!.damage = 5;
      setSlider(c, s, 1, 'reactor', 60);
      expect(s.units[1]!.target).toBe(20);
      s.units[1]!.damage = 0;
      setSlider(c, s, 1, 'reactor', 60);
      expect(s.units[1]!.target).toBe(Math.trunc(25 * 60 / SLIDER_WIDTH));
      setSlider(c, s, 3, 'torpedoes', 50);
      expect(s.units[3]!.target).toBe(4);
      setSlider(c, s, 3, 'torpedoes', SLIDER_WIDTH);
      expect(s.units[3]!.target).toBe(10);
    });
  });

  describe('tickSystems (ShipSystems::tick)', () => {
    it('fills the power grid from the reactors twice a second, up to what the grid holds', () => {
      const c = ship(), s = newSystems(c);
      s.pool = 0;
      tickSystems(c, s, 10);
      expect(s.pool).toBe(0);
      // half a second on: a fusion reactor at 20 of 25 gives 0.5 * 0.95 * 0.8 * 100 = 38, and half of that goes to the grid
      tickSystems(c, s, 10 + second / 2);
      expect(s.fusionOutput).toBe(38);
      expect(s.pool).toBe(19);
      expect(s.units[0]!.current).toBe(19);
      s.pool = 995;
      tickSystems(c, s, 10 + second);
      expect(s.pool).toBe(1000);
    });

    it('charges a system to its target from the pool, five at a time, and gives power back as it is turned down', () => {
      const c = ship(), s = newSystems(c);
      s.units[2]!.current = 0;
      s.units[2]!.target = 8;
      const pool = s.pool;
      tickSystems(c, s, 10);
      expect(s.units[2]!.current).toBe(5);
      expect(s.pool).toBe(pool - 5);
      tickSystems(c, s, 10 + 2 * second);
      expect(s.units[2]!.current).toBe(8);
      s.units[2]!.target = 6;
      tickSystems(c, s, 10 + 4 * second);
      expect(s.units[2]!.current).toBe(7);
      expect(s.pool).toBeGreaterThan(pool - 8);
    });

    it('repairs a second at a time at the cost of a point of power, and a damaged system is offline until it is whole', () => {
      const c = ship(), s = newSystems(c);
      s.units[2]!.damage = 2;
      s.units[2]!.repair = 2;
      const pool = s.pool;
      tickSystems(c, s, 10);
      expect(s.units[2]).toMatchObject({ damage: 1, repair: 1, current: 0 });
      expect(s.pool).toBe(pool - 1);
      tickSystems(c, s, 10 + second);
      expect(s.units[2]).toMatchObject({ damage: 0, repair: 0 });
      s.units[2]!.target = 100;
      tickSystems(c, s, 10 + 2 * second);
      expect(s.units[2]!.current).toBeGreaterThan(0);
    });

    it('loads a torpedo for 25 power from the store, and unloads one for 20 back', () => {
      const c = ship(), s = newSystems(c);
      s.units[3]!.target = 4;
      const pool = s.pool;
      tickSystems(c, s, 10);
      expect(s.units[3]!.current).toBe(3);
      expect(s.torpedoes).toBe(STARTING_TORPEDOES - 1);
      expect(s.pool).toBe(pool - 25);
      s.units[3]!.target = 0;
      tickSystems(c, s, 10 + 5 * second);
      expect(s.units[3]!.current).toBe(2);
      expect(s.torpedoes).toBe(STARTING_TORPEDOES);
      expect(s.pool).toBe(pool - 5);
    });

    it('treats a long gap as the clock having been stopped: nothing catches up', () => {
      const c = ship(), s = newSystems(c);
      s.units[2]!.current = 0;
      s.units[2]!.target = 100;
      tickSystems(c, s, 10);
      tickSystems(c, s, 10 + 1000 * second);
      expect(s.units[2]!.current).toBe(10);
    });
  });

  it('setDamage takes a type or everything offline, repairing or destroying it, and reset makes the ship new', () => {
    const c = ship(), s = newSystems(c);
    setDamage(c, s, UNIT_WARP, 2);
    expect(s.units[2]).toMatchObject({ current: 0, damage: 100 });
    expect(s.units[1]!.current).toBe(20);
    s.units[2]!.repair = 500;
    setDamage(c, s, UNIT_ALL, 1);
    expect(s.units.map(u => [u.current, u.damage])).toEqual([[0, 0], [0, 0], [0, 0], [0, 0]]);
    resetSystems(c, s);
    expect(s.units[1]!.current).toBe(20);
    expect(s.pool).toBe(STARTING_POWER);
  });

  it('are saved with the game, and a save from before them starts the ship\'s systems as new', () => {
    const content = miniShipContent();
    const state = createInitialState(content, 1, { onShip: true });
    state.ship.systems.pool = 1234;
    state.ship.systems.units[0]!.target = 77;
    const back = deserializeState(serializeState(state), content);
    expect(back.ship.systems.pool).toBe(1234);
    expect(back.ship.systems.units[0]!.target).toBe(77);
    const old = JSON.parse(serializeState(state)) as { ship: Record<string, unknown> };
    delete old.ship.systems;
    expect(deserializeState(JSON.stringify(old), content).ship.systems.pool).toBe(STARTING_POWER);
  });

  it('load a save whose units carry combat\'s working fields (hit weight, Delegate\'s target and cap): the schema accepts them (R6; whether saves keep them is Plan 22\'s)', () => {
    const content = miniShipContent();
    const state = createInitialState(content, 1, { onShip: true });
    Object.assign(state.ship.systems.units[0]!, { hitWeight: 1, aiTarget: 70, aiCap: 0 });
    const back = deserializeState(serializeState(state), content);
    expect(back.ship.systems.units).toHaveLength(state.ship.systems.units.length);
    expect(back.ship.systems.units[0]).toMatchObject({ current: state.ship.systems.units[0]!.current, max: state.ship.systems.units[0]!.max });
  });

  it('measure the sensors as ShipSystems::sensorOutput does: roundf of the float percentage (ship.cpp:238-247)', () => {
    const c = ship();
    c.data.units[2]!.type = UNIT_SENSOR;
    c.data.units[3]!.type = UNIT_SENSOR;
    const s = newSystems(c);
    s.units[2]!.current = 1;
    s.units[2]!.max = 3;
    s.units[3]!.current = 0;
    s.units[3]!.max = 5;
    // (100 / 8 = 12.5, rounded away from zero)
    expect(sensorOutput(c.data.units, s)).toBe(13);
    s.units[2]!.current = 0;
    expect(sensorOutput(c.data.units, s)).toBe(0);
  });
});

describe('the systems on the battle clock (tickUnits with MS_CLOCK, Plan 19)', () => {
  it('read a last tick ahead of the clock as ScummVM\'s uint32 does, a long gap: the units start afresh and the reactors run (ship.cpp:111, 126; Plan 23)', () => {
    const c = ship(), s = newSystems(c);
    tickUnits(c.data.units, s, 5000, MS_CLOCK);
    s.units[2]!.nextStep = s.units[2]!.nextRepair = 9999;
    // (a retime between the clocks that left the last ticks 50 ms ahead)
    s.lastTick = s.lastReactorTick = 5050;
    tickUnits(c.data.units, s, 5000, MS_CLOCK);
    expect([s.units[2]!.nextRepair, s.lastReactorTick, s.lastTick]).toEqual([6000, 5000, 5000]);
  });

  it('read a reactor tick ahead of the clock as a uint32 gap too: the reactors run though the units carry on (ship.cpp:126; Plan 23)', () => {
    const c = ship(), s = newSystems(c);
    tickUnits(c.data.units, s, 5000, MS_CLOCK);
    s.units[2]!.nextRepair = 9999;
    // (the units' last tick 100 ms back, no long gap; the reactors' 50 ms ahead, which a signed gap would read as -50)
    s.lastTick = 4900;
    s.lastReactorTick = 5050;
    tickUnits(c.data.units, s, 5000, MS_CLOCK);
    expect([s.units[2]!.nextRepair, s.lastReactorTick, s.lastTick]).toEqual([9999, 5000, 5000]);
  });

  it('charge in the original milliseconds: a torpedo every trunc(30 * 1000 / 291.3) = 102 ms', () => {
    const c = ship(), s = newSystems(c);
    s.units[3]!.target = 4;
    tickUnits(c.data.units, s, 1000, MS_CLOCK);
    expect([s.units[3]!.current, s.units[3]!.nextStep, s.torpedoes, s.pool]).toEqual([3, 1102, STARTING_TORPEDOES - 1, STARTING_POWER - 25]);
    tickUnits(c.data.units, s, 1101, MS_CLOCK);
    expect(s.units[3]!.current).toBe(3);
    tickUnits(c.data.units, s, 1102, MS_CLOCK);
    expect(s.units[3]!.current).toBe(4);
  });

  it('fill the grid after half a second, by the fraction of a second since, and restart after a gap of over a second', () => {
    const c = ship(), s = newSystems(c);
    tickUnits(c.data.units, s, 1000, MS_CLOCK);
    tickUnits(c.data.units, s, 1499, MS_CLOCK);
    expect(s.fusionOutput).toBe(0);
    tickUnits(c.data.units, s, 1500, MS_CLOCK);
    // (fusion at 20 of 25: trunc(0.5 * 95 / 100 * 0.8 * 100) = 38; the grid holds at most 1000)
    expect([s.fusionOutput, s.pool, s.units[0]!.current]).toEqual([38, 1000, 1000]);
    tickUnits(c.data.units, s, 2501, MS_CLOCK);
    expect([s.lastReactorTick, s.units[1]!.nextStep]).toEqual([2501, 2501 + 102]);
  });
});
