// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { miniShipContent } from '../testing/ship';
import { applyShipFx, chooseWarpMovie, moveInUniverse, requestScriptedWarp } from './shipFx';
import { HeadlessPresenter } from './presenter';
import { createInitialState } from './state';
import { World } from './world';
import type { SimEvent } from './events';

function shipWorld() {
  const content = miniShipContent();
  const world = new World(content, createInitialState(content, 1, { onShip: true }), w => new HeadlessPresenter(w.clock));
  const events: SimEvent[] = [];
  world.bus.on(e => events.push(e));
  const warnings = () => events.filter(e => e.type === 'warning').map(e => (e as { message: string }).message);
  return { world, ship: world.state.ship, events, warnings };
}

describe('applyShipFx', () => {
  it('reveal sets 0x10 on universe.reveals[n] and ignores n past the table', () => {
    const { world, ship, events } = shipWorld();
    expect(ship.flags[1]).toBe(0);
    applyShipFx(world, { reveal: 0 });
    expect(ship.flags[1]).toBe(0x10);
    expect(events).toContainEqual({ type: 'astroFlag', id: 1, from: 0, to: 0x10 });
    applyShipFx(world, { reveal: 5 });
    expect(ship.flags).toEqual([1, 0x10]);
  });

  it('newWarpMovie sets the flag; the next warp shows the next movie, then the RNG picks among those seen', () => {
    const { world, ship, events } = shipWorld();
    applyShipFx(world, { newWarpMovie: true });
    expect(ship.newWarpMovie).toBe(true);
    // (astrogation.cpp:797-813: one movie is seen at the start)
    expect(chooseWarpMovie(world)).toBe(2);
    expect(ship.warpMoviesSeen).toBe(2);
    expect(ship.newWarpMovie).toBe(false);
    expect(events.some(e => e.type === 'rng')).toBe(false);
    // (nothing new: one seen before, from 1 to seen, on the game RNG)
    const seed = world.state.rngSeed;
    const movie = chooseWarpMovie(world);
    expect([1, 2]).toContain(movie);
    expect(world.state.rngSeed).not.toBe(seed);
    expect(events.find(e => e.type === 'rng')).toMatchObject({ site: 'warpMovie', max: 1 });
    // (the last movie is never new again)
    ship.warpMoviesSeen = 5;
    ship.newWarpMovie = true;
    chooseWarpMovie(world);
    expect(ship.warpMoviesSeen).toBe(5);
    expect(ship.newWarpMovie).toBe(false);
  });

  it('repair emits its shipEffect and changes nothing (R4)', () => {
    const { world, ship, events } = shipWorld();
    const before = JSON.stringify(world.state);
    applyShipFx(world, { repair: true });
    expect(events).toEqual([{ type: 'shipEffect', effect: { repair: true } }]);
    expect(JSON.stringify(world.state)).toBe(before);
    expect(ship.warpPending).toBe(false);
  });

  it('hides and shows a numbered entry through entryIds', () => {
    const { world } = shipWorld();
    // (entryIds [2, 3, 4]: number 0 is entry 2, which isn't hidden)
    applyShipFx(world, { computer: 'hide', entry: 0 });
    expect(world.state.computer.hidden).toEqual([2, 3, 4]);
    applyShipFx(world, { computer: 'show', entry: 1 });
    expect(world.state.computer.hidden).toEqual([2, 4]);
  });

  it('records every reading whose entry is the numbered entry, newest first, unhiding parent and entry', () => {
    const { world } = shipWorld();
    // entry number 2 is entry 4, the readings' parent: no reading points at it, so nothing is recorded
    applyShipFx(world, { computer: 'record', entry: 2 });
    expect(world.state.computer.readings).toEqual([]);
    // (a second entry list would reach entry 5; use the entry the readings 1030 and 1040 share)
    world.content.ship!.computer.entryIds.push(5);
    applyShipFx(world, { computer: 'record', entry: 3 });
    expect(world.state.computer.readings).toEqual([1040, 1030]);
    expect(world.state.computer.hidden).toEqual([3]);
  });

  it('warns on an unknown computer entry number and changes nothing', () => {
    const { world, warnings } = shipWorld();
    const before = JSON.stringify(world.state);
    applyShipFx(world, { computer: 'hide', entry: 9 });
    expect(warnings()).toEqual(['unknown computer entry 9']);
    expect(JSON.stringify(world.state)).toBe(before);
  });

  it('universe on the Enterprise asks for the scripted warp x*1e6+y*1e3+z, keeping the speed for 0 or none', () => {
    const { world, ship, events } = shipWorld();
    applyShipFx(world, { universe: { object: 'w.ent', x: 110, y: 90, z: 90, speed: 700 } });
    expect(ship).toMatchObject({ warpPending: true, scriptedWarp: 110090090, warpSpeed: 700 });
    expect(events).toContainEqual({ type: 'scriptedWarp', code: 110090090, speed: 700 });
    applyShipFx(world, { universe: { object: 'w.ent', x: 110, y: 90, z: 90, speed: 0 } });
    expect(ship.warpSpeed).toBe(700);
    applyShipFx(world, { universe: { object: 'w.ent', x: 110, y: 90, z: 90 } });
    expect(ship.warpSpeed).toBe(700);
    applyShipFx(world, { universe: { object: 'w.ent', x: 110, y: 90, z: 90, speed: 0xffff } });
    expect(ship.warpSpeed).toBe(700);
  });

  it('a scripted warp with an unknown code warns and changes nothing', () => {
    const { world, ship, warnings } = shipWorld();
    expect(requestScriptedWarp(world, 1, 500)).toBe(false);
    expect(warnings()).toEqual(['no scripted warp to 1']);
    expect(ship).toMatchObject({ warpPending: false, scriptedWarp: null, warpSpeed: 0 });
  });

  it("universe on anything else replaces that object's last move, from where it is now", () => {
    const { world, ship } = shipWorld();
    applyShipFx(world, { universe: { object: 'w.planet', x: 20, y: 20, z: 30 } });
    world.obj('w.planet').universe = { x: 15, y: 20, z: 30 };
    world.clock.advanceTo(30);
    moveInUniverse(world, 'w.planet', { x: 40, y: 0, z: 0 });
    expect(ship.universeMoves).toEqual([{ object: 'w.planet', start: 30, from: { x: 15, y: 20, z: 30 }, to: { x: 40, y: 0, z: 0 } }]);
    expect(ship.warpPending).toBe(false);
  });

  it('warns in a game with no ship', () => {
    const content = { ...miniShipContent(), ship: undefined };
    const world = new World(content, createInitialState(content), w => new HeadlessPresenter(w.clock));
    const events: SimEvent[] = [];
    world.bus.on(e => events.push(e));
    applyShipFx(world, { reveal: 0 });
    expect(events).toContainEqual({ type: 'warning', message: 'a ship effect in a game with no ship' });
  });
});
