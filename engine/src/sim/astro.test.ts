// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { settle } from './settle';
import type { AstroThing, Universe, GameContent, ShipContent, ShipUnit } from '../content/types';
import { makeGame } from '../testing/fixture';
import { miniShipData } from '../testing/ship';
import {
  atPlanetFor, BATTLE_DISTANCE, days360, distanceTo, enterAstrogation, engage, journeyTime, LIGHT_YEAR, locationName, MAX_IMPULSE_DISTANCE, maxWarp,
  MIN_WARP_MS, msToTicks, addSensorRecord, scrollSensors, planetCount, planetOrbit, previewCourse, stopTransit, updateAstro,
} from './astro';
import type { SimEvent } from './events';
import { HeadlessPresenter } from './presenter';
import { NO_SCENARIO, type AstroLocation } from './ship';
import { shipTick } from './shipTick';
import { gotoShipScreen } from './stations';
import { createInitialState } from './state';
import { World } from './world';

// The test universe: 512 sectors, three stars and a starbase. The ship starts at (90, 90, 90), sector 292.
//   sector 292: star 0 id 10 at (93, 90, 90), scripted (so it has a planet); star 1 id 12 at (90, 90, 90), scripted
//   sector 293: star 0 id 11 at (110, 90, 90)
//   sector 294: the starbase, id 77, at (100, 90, 90)
// Warp speed i is 5000 * (i + 1): warp 500 is index 40, 205000. Planet orbits are 3600 and 7200 at scale 10.
const unit = (type: number, current = 100): ShipUnit => ({
  name: type === 8 ? 'Long-Zap' : `Unit ${type}`, type, current, target: 100, max: 100, chargeTicks: 0, dischargeTicks: 0,
  damage: 0, repair: 0, baseDamage: 0, maxDamage: 0, efficiency: type === 5 || type === 6 ? 95 : 0,
});
const thing = (id: number, type: number, x: number): AstroThing => ({ id, type, seed: 0, x, y: 90, z: 90, name: `T${id}`, range: 0 });
const star = (id: number, x: number, flags = 0x11, seed = 0) => ({
  ...thing(id, 0x20, x), seed, flags, spectralClass: 0, magnitude: 0, orbitScale: 10, systemName: '', scriptedName: '', scriptedDescription: '', special: -1,
});
const T = { sb: 'ts.b', star: 'ts.s', first: 'ts.f', run: 'ts.r', chk: 'ts.c', sec: 'ts.2' };

function shipContent(units: ShipUnit[] = [4, 6, 3, 5, 8].map(t => unit(t))): GameContent {
  const base = miniShipData();
  const empty = { numStars: 0, numPhenomena: 0, alignment: 0, firstStar: 0, firstPhenomenon: 0, station: -1, description: '', name: '', region: 0 };
  const sectors = Array.from({ length: 512 }, () => ({ ...empty }));
  sectors[292] = { ...empty, numStars: 2, firstStar: 0 };
  sectors[293] = { ...empty, numStars: 1, firstStar: 2 };
  sectors[294] = { ...empty, station: 0 };
  const ship: ShipContent = {
    ...base,
    universe: {
      sectors, stars: [star(10, 93), star(12, 90), star(11, 110)], phenomena: [], stations: [thing(77, 0x83, 100)], specials: [],
      flags: [], regionChatter: [], warpSpeeds: Array.from({ length: 90 }, (_, i) => 5000 * (i + 1)), impulseSpeeds: [1000000],
      scriptedWarps: [
        { code: 92076056, sector: 156, star: 3, planet: 3, type: 0, index: 0 },
        { code: 1002003, sector: 1, star: 1, planet: -1, type: 0, index: 0 },
      ],
      planetOrbits: [3600, 7200], reveals: [],
    },
    data: {
      ...base.data, units,
      astro: { enterprise: 'w.ent', starbaseBattle: 80, defaultBattle: 8, triggers: { arriveStarbase: T.sb, arriveStar: T.star, firstVisit: T.first, runAway: T.run, secondVisitCheck: T.chk, secondVisit: T.sec } },
    },
  };
  const trigger = (id: string, enabled = false) => ({ id, type: 'normal' as const, context: 'ship' as const, target: 'w.ent', enabled });
  return makeGame([{ id: 'w.ent', name: 'Enterprise', screen: null, universe: { x: 90, y: 90, z: 90 } }], {
    triggers: [trigger(T.sb), trigger(T.star), trigger(T.first), trigger(T.run, true), trigger(T.chk), trigger(T.sec)], ship,
  });
}

function shipWorld(units?: ShipUnit[]) {
  const c = shipContent(units);
  const world = new World(c, createInitialState(c, 1, { onShip: true }), w => new HeadlessPresenter(w.clock));
  const events: SimEvent[] = [];
  world.bus.on(e => events.push(e));
  return { world, events, ship: world.state.ship, u: c.ship!.universe };
}
const on = (w: World, id: string) => w.state.triggers[id].enabled;
const NEAR = { sector: 292, star: 0, warp: true, speed: 500 };
const FAR = { sector: 293, star: 0, warp: true, speed: 500 };

describe('journeyTime', () => {
  it("matches the original's rounding", () => {
    const { u } = shipWorld();
    // warp 500 is index (5 - 1) * 10 + 0 = 40: 205000. 3 ly is 262800000: 262800000 / 205000 = 1282.05 is 1 month
    // (833) and 16 days (449.05 / 27); that covers 205000 * 1265 = 259325000, leaving 3475000 * 10000 / 205000 = 169512:
    // 14 hours (159810), 51 minutes (9690 of 9702) and 12 / 3 = 4 seconds.
    expect(journeyTime(u, 500, 3 * LIGHT_YEAR)).toEqual({ years: 0, months: 1, days: 16, hours: 14, minutes: 51, seconds: 4 });
    expect(days360({ years: 0, months: 1, days: 16, hours: 14, minutes: 51, seconds: 4 })).toBeCloseTo(46.6187963, 6);
    // a warp factor's tenths: warp 530 is index 43
    expect(journeyTime(u, 530, 262800000)).toEqual(journeyTime(u, 500, 262800000 * 205000 / 220000));
  });

  it('is 999 years at speed 0, and uses the hours when the velocity covers the distance', () => {
    const { u } = shipWorld();
    expect(journeyTime(u, 0, 1)).toEqual({ years: 999, months: 0, days: 0, hours: 0, minutes: 0, seconds: 0 });
    // impulse 1 is 1000000: 10000 * 10000 / 1000000 = 100 is 0 hours, 0 minutes and 33 seconds
    expect(journeyTime(u, 1, 10000)).toEqual({ years: 0, months: 0, days: 0, hours: 0, minutes: 0, seconds: 33 });
  });
});

describe('distanceTo', () => {
  it('adds the in-system leg: orbit * 10000/3600, and |to - from| at the same star', () => {
    const { ship } = shipWorld();
    ship.orbit = 7200;
    // 3 ly, from 7200 (20000) and to 3600 (10000)
    expect(distanceTo(ship, { x: 93, y: 90, z: 90 }, 3600)).toEqual({ distance: 3 * LIGHT_YEAR + 30000, lightYears: 3 });
    // the same star: |10000 - 20000|
    expect(distanceTo(ship, { x: 90, y: 90, z: 90 }, 3600)).toEqual({ distance: 10000, lightYears: 0 });
  });
});

describe('planets', () => {
  it("counts them as universe.cpp's countPlanets does", () => {
    // seeds worked through AstroRandom by hand: seed 0 draws 0 (so no planets); seed 1 draws 77, then more
    expect(planetCount(star(1, 0, 0, 0))).toBe(0);
    expect(planetCount(star(1, 0, 0x10, 0))).toBe(1);
    expect(planetCount(star(1, 0, 0, 1))).toBe(5);
    expect(planetCount(star(1, 0, 2, 1))).toBe(3);
    expect(planetCount(star(1, 0, 1, 1))).toBe(0);
    expect(planetCount(star(1, 0, 0, 1234567))).toBe(2);
  });

  it('puts a planet at planetOrbit(scale, i) (R3)', () => {
    const { world, u } = shipWorld();
    expect(planetOrbit(u, u.stars[0], 0)).toBe(3600);
    expect(planetOrbit(u, u.stars[0], 1)).toBe(7200);
    // (past the table: the last)
    expect(planetOrbit(u, { ...u.stars[0], orbitScale: 5 }, 40)).toBe(3600);
    const p = previewCourse(world, { sector: 292, star: 0, planet: 0, warp: true, speed: 500 });
    expect(typeof p === 'string' ? p : p.orbit).toBe(3600);
    // a moon is plotted at its own orbit (the scripted star's one planet has one moon from a zero seed), a belt or outpost only where there is one
    const moon = previewCourse(world, { sector: 292, star: 0, planet: 0, moon: 0, warp: true, speed: 500 });
    expect(typeof moon === 'string' ? moon : [moon.location.moon, moon.orbit > 3600]).toEqual([0, true]);
    expect(previewCourse(world, { sector: 292, star: 0, planet: 0, moon: 5, warp: true, speed: 500 })).toBe('nothing there');
    expect(previewCourse(world, { sector: 292, star: 0, moon: 0, warp: true, speed: 500 })).toBe('nothing there');
    expect(previewCourse(world, { sector: 292, star: 0, planet: 0, station: true, warp: true, speed: 500 })).toBe('nothing there');
    expect(previewCourse(world, { sector: 292, star: 0, planet: 0, phenomenon: 0, warp: true, speed: 500 })).toBe('nothing there');
    expect(previewCourse(world, { sector: 292, star: 0, planet: 7, warp: true, speed: 500 })).toBe('nothing there');
    expect(previewCourse(world, { sector: 292, star: 9, warp: true, speed: 500 })).toBe('nothing there');
  });
});

describe('maxWarp', () => {
  it('is ported over the units: 940 at full health, 870 at half warp power, 100 with none', () => {
    expect(maxWarp(shipContent().ship!)).toBe(940);
    // warp 50 * matter/antimatter 100 * 1.375 / 100 = 68.75; impulse 137.5; (68.75 / ... ): rating 77.34375, 773 + 100 = 873 -> 870
    expect(maxWarp(shipContent([unit(4, 50), unit(6), unit(3), unit(5), unit(8)]).ship!)).toBe(870);
    expect(maxWarp(shipContent([]).ship!)).toBe(100);
  });
});

describe('engage', () => {
  it('refuses past maxWarp, with no warp, and impulse past 512000', () => {
    const half = shipWorld([unit(4, 50), unit(6), unit(3), unit(5), unit(8)]);
    expect(engage(half.world, { ...NEAR, speed: 900 })).toBe('too fast');
    expect(half.ship.transit).toBeNull();
    expect(engage(half.world, { ...NEAR, speed: 870 })).toBeNull();
    const none = shipWorld([]);
    expect(engage(none.world, NEAR)).toBe('no warp');
    const { world, ship } = shipWorld();
    expect(MAX_IMPULSE_DISTANCE).toBe(512000);
    expect(engage(world, { ...NEAR, warp: false, speed: 1 })).toBe('too far for impulse');
    // (the same star: 10000 units)
    expect(engage(world, { sector: 292, star: 1, planet: 0, warp: false, speed: 1 })).toBeNull();
    expect(ship.transit!.ticks).toBe(510);
    // no distance, no course
    ship.transit = null;
    expect(engage(world, { sector: 292, star: 1, warp: true, speed: 500 })).toBe('nothing there');
  });

  it('clears the battle scenario on a journey past BATTLE_DISTANCE, and on the first transit tick', () => {
    expect(BATTLE_DISTANCE).toBe(3.5);
    const { world, ship, events } = shipWorld();
    ship.battleScenario = 10;
    expect(engage(world, FAR)).toBeNull();
    expect(ship.battleScenario).toBe(NO_SCENARIO);
    expect(events).toContainEqual({ type: 'battleScenario', scenario: NO_SCENARIO });
    ship.battleScenario = 10;
    ship.transit = null;
    expect(engage(world, NEAR)).toBeNull();
    expect(ship.battleScenario).toBe(NO_SCENARIO);
  });

  it('re-engaging mid-transit keeps a pending battle and restarts the clock (startTransit, updateRegion)', () => {
    const { world, ship } = shipWorld();
    expect(engage(world, NEAR)).toBeNull();
    ship.battleScenario = 10;
    ship.clockStopped = 7;
    expect(engage(world, NEAR)).toBeNull();
    expect(ship.battleScenario).toBe(10);
    expect(ship.clockStopped).toBe(0);
  });

  it('a journey\'s start clears the Enterprise\'s view, and re-engaging mid-transit leaves it (updateRegion, astrogation.cpp:525-532)', () => {
    const { world } = shipWorld();
    const ent = world.state.objects['w.ent']!;
    ent.anim = 774;
    expect(engage(world, NEAR)).toBeNull();
    expect(ent.anim).toBe(-1);
    // (only the first frame of a transit clears it)
    ent.anim = 835;
    expect(engage(world, NEAR)).toBeNull();
    expect(ent.anim).toBe(835);
  });

  it('starts at the current position at the sim time, with a location of nowhere in transit', () => {
    const { world, ship, events } = shipWorld();
    world.clock.advanceTo(100);
    expect(engage(world, NEAR)).toBeNull();
    expect(ship.transit).toMatchObject({ from: { x: 90, y: 90, z: 90 }, to: { x: 93, y: 90, z: 90 }, warp: true, speed: 500, startTick: 100, destType: 0x20, destStarId: 10 });
    expect(ship.location.sector).toBe(-1);
    expect(events.find(e => e.type === 'astro')).toMatchObject({ what: 'engage', speed: 500, ticks: 2798 });
  });
});

describe('a course with a point (astrogation.cpp:1160-1165, 1793-1795)', () => {
  it('goes to the point when nothing is at the destination, and still refuses a plain course there', () => {
    const { world, ship } = shipWorld();
    // (sector 0 has no station and no phenomena)
    expect(engage(world, { sector: 0, station: true, warp: true, speed: 500 })).toBe('nothing there');
    expect(engage(world, { sector: 0, phenomenon: 4, warp: true, speed: 500 })).toBe('nothing there');
    expect(engage(world, { sector: 0, station: true, warp: true, speed: 500, point: { x: 5, y: 6, z: 7 } })).toBeNull();
    expect(ship.transit).toMatchObject({ to: { x: 5, y: 6, z: 7 }, orbit: 0, destType: -1, destStarId: 0 });
    expect(ship.transit!.destination).toMatchObject({ sector: 0, station: 0 });
  });
});

describe('the warp movie', () => {
  it('plays when a warp starts a journey, with the clock stopped, and the journey is pushed back by it', async () => {
    const { world, ship, events } = shipWorld();
    world.clock.advanceTo(100);
    expect(engage(world, NEAR)).toBeNull();
    // (warpMoviesSeen starts at 1: the draw is among movie 1 only, on the game RNG)
    expect(events.find(e => e.type === 'rng')).toMatchObject({ site: 'warpMovie', max: 0, value: 0 });
    await settle(world);
    expect((world.presenter as HeadlessPresenter).log).toContain('play warp 1');
    expect(ship.clockStopped).toBe(0);
    expect(ship.transit!.startTick).toBeGreaterThan(100);
  });

  it('is not played by an impulse journey, or by one that re-engages mid-transit', async () => {
    const { world, events } = shipWorld();
    expect(engage(world, { sector: 292, star: 1, planet: 0, warp: false, speed: 1 })).toBeNull();
    await settle(world);
    expect(events.some(e => e.type === 'rng')).toBe(false);
    const again = shipWorld();
    engage(again.world, NEAR);
    await settle(again.world);
    again.events.length = 0;
    engage(again.world, NEAR);
    expect(again.events.some(e => e.type === 'rng')).toBe(false);
  });
});

describe('transit', () => {
  it("arrives at the tick the journey's milliseconds give", () => {
    const { world, ship, events } = shipWorld();
    world.clock.advanceTo(100);
    engage(world, NEAR);
    // 46.6187963 days is 46618 ms (above the 25000 minimum), and 46618 * 60 / 1000 = 2797.08 ticks, rounded up
    expect(msToTicks(46618)).toBe(2798);
    expect(msToTicks(MIN_WARP_MS)).toBe(1500);
    expect(ship.transit!.ticks).toBe(2798);
    world.clock.advanceTo(100 + 2798 - 1);
    updateAstro(world);
    expect(ship.transit).not.toBeNull();
    world.clock.advanceTo(100 + 2798);
    updateAstro(world);
    expect(ship.transit).toBeNull();
    expect(ship.pos).toEqual({ x: 93, y: 90, z: 90 });
    expect(ship.location).toEqual({ sector: 292, star: 0, planet: -1, moon: -1, station: -1, phenomenon: -1 });
    expect(world.obj('w.ent').universe).toEqual({ x: 93, y: 90, z: 90 });
    expect(events.filter(e => e.type === 'astro').map(e => e.type === 'astro' && e.what)).toEqual(['engage', 'arrive']);
  });

  it("runs from the world's tick on the ship", () => {
    const { world, ship } = shipWorld();
    // (the enabled trigger would fire, and its action keep the world busy: this test never lets it run)
    world.state.triggers[T.run].enabled = false;
    engage(world, { sector: 292, star: 1, planet: 0, warp: false, speed: 1 });
    for (let i = 0; i < 509; i++) world.tick();
    expect(ship.transit).not.toBeNull();
    world.tick();
    expect(ship.transit).toBeNull();
    expect(ship.orbit).toBe(3600);
    expect(ship.location.planet).toBe(0);
    expect(ship.locationType).toBe(0x21);
  });

  it('a save on the bridge mid-transit loads mid-transit and arrives at the same tick', async () => {
    const { world, ship } = shipWorld();
    // (the enabled trigger would fire and keep the world busy, so no save: this test is about the journey)
    world.state.triggers[T.run].enabled = false;
    engage(world, NEAR);
    // (the warp movie plays first, with the clock stopped, and pushes the journey back by its time)
    await settle(world);
    const arrival = ship.transit!.startTick + ship.transit!.ticks;
    for (let i = 0; i < 1000; i++) world.tick();
    expect(ship.transit).not.toBeNull();
    const loaded = World.fromSave(world.content, world.save(), w => new HeadlessPresenter(w.clock));
    expect(loaded.state.onShip).toEqual({ gameOver: null });
    expect(loaded.state.ship.station).toBe('bridge');
    expect(loaded.state.ship.transit).toEqual(ship.transit);
    while (loaded.state.ship.transit !== null) loaded.tick();
    expect(loaded.clock.now).toBe(arrival);
    expect(loaded.state.ship.pos).toEqual({ x: 93, y: 90, z: 90 });
  });

  it('interpolates with floor(d*progress+0.5), and charts each new sector', () => {
    const { world, ship } = shipWorld();
    engage(world, NEAR);
    const start = ship.transit!.startTick;
    // 3 * p + 0.5 first reaches 1 at p = 1/6: tick 467 of 2798 is 0.16690
    world.clock.advanceTo(start + 466);
    updateAstro(world);
    expect(ship.pos.x).toBe(90);
    world.clock.advanceTo(start + 467);
    updateAstro(world);
    expect(ship.pos.x).toBe(91);
    world.clock.advanceTo(start + 1399);
    updateAstro(world);
    expect(ship.pos.x).toBe(92);
    expect(world.obj('w.ent').universe).toEqual({ x: 92, y: 90, z: 90 });

    // 20 ly: x reaches 100 (sector 293) at 20 * p + 0.5 >= 10
    ship.transit = null;
    ship.pos = { x: 90, y: 90, z: 90 };
    engage(world, FAR);
    const t = ship.transit!;
    expect(ship.flags[11] ?? 0).toBe(0);
    world.clock.advanceTo(t.startTick + Math.floor(t.ticks * 0.4));
    updateAstro(world);
    expect(ship.flags[11] ?? 0).toBe(0);
    world.clock.advanceTo(t.startTick + Math.ceil(t.ticks * 0.5));
    updateAstro(world);
    expect(ship.pos.x).toBe(100);
    expect(ship.flags[11]).toBe(1);
    expect(ship.lastSector).toBe(293);
  });

  it('does not chart with the sensors down', () => {
    const { world, ship } = shipWorld([4, 6, 3, 5].map(t => unit(t)));
    engage(world, FAR);
    world.clock.advanceTo(ship.transit!.startTick + ship.transit!.ticks);
    updateAstro(world);
    expect(ship.flags[11] & 0xc).toBe(0xc);
    expect(ship.flags[11] & 1).toBe(0);
  });

  it('the clock stops away from the bridge, astrogation, viewscreen and transporter', async () => {
    const { world, ship } = shipWorld();
    engage(world, NEAR);
    const { startTick, ticks } = ship.transit!;
    world.clock.advanceTo(startTick + 100);
    await gotoShipScreen(world, 5);
    expect(ship.clockStopped).not.toBe(0);
    // 50 ticks at the computer: the journey does not move
    world.clock.advanceTo(startTick + 150);
    updateAstro(world);
    expect(ship.pos.x).toBe(90);
    await gotoShipScreen(world, 0);
    expect(ship.transit!.startTick).toBe(startTick + 50);
    world.clock.advanceTo(startTick + 50 + ticks - 1);
    updateAstro(world);
    expect(ship.transit).not.toBeNull();
    world.clock.advanceTo(startTick + 50 + ticks);
    updateAstro(world);
    expect(ship.transit).toBeNull();
  });

  it('the journey is updated only on the bridge and in astrogation', () => {
    const { world, ship } = shipWorld();
    engage(world, NEAR);
    world.clock.advanceTo(ship.transit!.startTick + ship.transit!.ticks);
    ship.station = 'transporter';
    shipTick(world);
    expect(ship.transit).not.toBeNull();
    ship.station = 'bridge';
    shipTick(world);
    expect(ship.transit).toBeNull();
  });

  it('stopTransit leaves the ship where it has got to, without arriving', () => {
    const { world, ship, events } = shipWorld();
    engage(world, NEAR);
    world.clock.advanceTo(ship.transit!.startTick + 1399);
    updateAstro(world);
    stopTransit(world);
    expect(ship.transit).toBeNull();
    expect(ship.pos.x).toBe(92);
    expect(ship.location.sector).toBe(-1);
    expect(events.some(e => e.type === 'astro' && e.what === 'stop')).toBe(true);
  });
});

describe('arrival', () => {
  const arriveAt = (w: ReturnType<typeof shipWorld>, course: Parameters<typeof engage>[1]) => {
    expect(engage(w.world, course)).toBeNull();
    w.world.clock.advanceTo(w.ship.transit!.startTick + w.ship.transit!.ticks);
    updateAstro(w.world);
    expect(w.ship.transit).toBeNull();
  };

  it('at a starbase enables arriveStarbase and sets the starbase battle', () => {
    const w = shipWorld();
    arriveAt(w, { sector: 294, station: true, warp: true, speed: 500 });
    expect(on(w.world, T.sb)).toBe(true);
    expect(w.ship.battleScenario).toBe(80);
    expect(on(w.world, T.star)).toBe(false);
    expect(w.ship.locationType).toBe(0x83);
  });

  it('at a star off the astrogation station enables arriveStar and marks the star visited', () => {
    const w = shipWorld();
    arriveAt(w, NEAR);
    expect(on(w.world, T.star)).toBe(true);
    expect(w.ship.flags[10] & 0xc).toBe(0xc);
    expect(w.ship.battleScenario).toBe(NO_SCENARIO);
  });

  it('at a star while at astrogation does not', async () => {
    const w = shipWorld();
    await gotoShipScreen(w.world, 4);
    arriveAt(w, NEAR);
    expect(on(w.world, T.star)).toBe(false);
    expect(w.ship.flags[10] & 0xc).toBe(0xc);
  });
});

describe('enterAstrogation', () => {
  it('enables firstVisit unless runAway is off, and secondVisit once secondVisitCheck is on', () => {
    const a = shipWorld();
    enterAstrogation(a.world);
    expect(on(a.world, T.first)).toBe(true);
    expect(a.ship.visits.first).toBe(false);
    expect(on(a.world, T.sec)).toBe(false);

    // (runAway off: the first visit has been and gone)
    const b = shipWorld();
    b.world.setTriggerEnabled(T.run, false);
    enterAstrogation(b.world);
    expect(on(b.world, T.first)).toBe(false);
    expect(b.ship.visits.first).toBe(true);

    const c = shipWorld();
    c.world.setTriggerEnabled(T.chk, true);
    enterAstrogation(c.world);
    expect(on(c.world, T.sec)).toBe(true);
    expect(c.ship.visits.second).toBe(true);
    c.world.setTriggerEnabled(T.sec, false);
    enterAstrogation(c.world);
    expect(on(c.world, T.sec)).toBe(false);
  });

  it('runs when the ship goes to astrogation', async () => {
    const a = shipWorld();
    await gotoShipScreen(a.world, 4);
    expect(on(a.world, T.first)).toBe(true);
  });
});

describe('atPlanetFor', () => {
  it("matches only the scripted warp's planet; no warp, or one without a planet, matches anything", () => {
    const { world, ship } = shipWorld();
    ship.location = { sector: 156, star: 3, planet: 3, moon: -1, station: -1, phenomenon: -1 };
    expect(atPlanetFor(world, { x: 92, y: 76, z: 56 })).toBe(true);
    ship.location.planet = 2;
    expect(atPlanetFor(world, { x: 92, y: 76, z: 56 })).toBe(false);
    // no scripted warp at that place; and one with planet -1 (code 1002003 is (1, 2, 3))
    expect(atPlanetFor(world, { x: 5, y: 5, z: 5 })).toBe(true);
    expect(atPlanetFor(world, { x: 1, y: 2, z: 3 })).toBe(true);
  });
});

describe('locationName (astrogation.cpp:300)', () => {
  const u = {
    sectors: [{ numStars: 1, numPhenomena: 1, firstStar: 0, firstPhenomenon: 0, station: 0, name: 'Sec' }],
    stars: [{ name: 'Star', special: 0 }, ],
    phenomena: [{ name: 'Rift' }], stations: [{ name: 'Base' }], specials: [{ name: 'Outpost' }],
  } as never as Universe;
  const at = (o: Partial<AstroLocation>): AstroLocation => ({ sector: 0, star: -1, planet: -1, moon: -1, station: -1, phenomenon: -1, ...o });
  it('names the star, its outpost, a phenomenon, a station or the sector', () => {
    expect(locationName(u, at({ star: 0 }))).toBe('Star');
    expect(locationName(u, at({ star: 0, station: 0 }))).toBe('Outpost');
    expect(locationName(u, at({ phenomenon: 0 }))).toBe('Rift');
    expect(locationName(u, at({ station: 0 }))).toBe('Base');
    expect(locationName(u, at({}))).toBe('Sec');
    expect(locationName(u, at({ sector: -1 }))).toBe('');
  });
});

describe('the sensor records (astrogation.cpp:678, bridge.cpp:315)', () => {
  const at = (sector: number, star: number): AstroLocation => ({ sector, star, planet: -1, moon: -1, station: -1, phenomenon: -1 });
  it('records each course engaged, newest first, and not the same place twice running', () => {
    const { world, ship } = shipWorld();
    expect(engage(world, { sector: 292, star: 1, planet: 0, warp: false, speed: 1 })).toBeNull();
    expect(ship.sensorRecords).toHaveLength(1);
    expect(ship.sensorRecords[0]).toMatchObject({ sector: 292, star: 1 });
    expect(engage(world, { sector: 292, star: 1, planet: 0, warp: false, speed: 1 })).toBeNull();
    expect(ship.sensorRecords).toHaveLength(1);
    expect(engage(world, { sector: 292, star: 0, planet: 0, warp: true, speed: 500 })).toBeNull();
    expect(ship.sensorRecords.map(r => r.star)).toEqual([0, 1]);
    // (a refused course is not recorded)
    expect(engage(world, { ...FAR, warp: false, speed: 1 })).toBe('too far for impulse');
    expect(ship.sensorRecords).toHaveLength(2);
  });
  it('scrolls three rows at a time, a record at a step, and stops at the ends; a new record scrolls back to the top', () => {
    const { world, ship } = shipWorld();
    expect(scrollSensors(world, 1)).toBe(false);
    for (let i = 0; i < 5; i++) addSensorRecord(world, at(i, 0));
    expect(ship.sensorRecords.map(r => r.sector)).toEqual([4, 3, 2, 1, 0]);
    expect(scrollSensors(world, -1)).toBe(false);
    expect(scrollSensors(world, 1)).toBe(true);
    expect(scrollSensors(world, 1)).toBe(true);
    expect(ship.sensorScroll).toBe(2);
    expect(scrollSensors(world, 1)).toBe(false);
    addSensorRecord(world, at(9, 0));
    expect(ship.sensorScroll).toBe(0);
  });
});

describe('Stop (astrogation.cpp:482)', () => {
  it('stops the ship wherever it has got to, with no destination readout', () => {
    const { world, ship } = shipWorld();
    ship.locationType = 0x20;
    expect(engage(world, { sector: 292, star: 1, planet: 0, warp: false, speed: 1 })).toBeNull();
    world.clock.advanceTo(ship.transit!.startTick + 100);
    updateAstro(world);
    const at = { ...ship.pos };
    stopTransit(world);
    expect(ship.transit).toBeNull();
    expect(ship.locationType).toBe(-1);
    expect(ship.pos).toEqual(at);
    updateAstro(world);
    expect(ship.pos).toEqual(at);
  });
});
