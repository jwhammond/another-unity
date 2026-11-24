// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { GameContent, ObjectDef } from '../content/types';
import { makeGame } from '../testing/fixture';
import { miniShipData } from '../testing/ship';
import { HeadlessPresenter } from './presenter';
import { settle } from './settle';
import { createInitialState } from './state';
import { gotoShipScreen } from './stations';
import { STATION_CODE } from './ship';
import {
  addToPad, canEnergize, chooseRecommended, energize, energizeAndArrive, moveToEquipment, moveToKit, openTransporter, removeFromPad, restoreTransporter, transporterRoom, transporterTick,
} from './transporter';
import { World } from './world';

const item = (id: string): ObjectDef => ({ id, name: id, screen: null, active: true });
const crew = (id: string): ObjectDef => ({ id, name: id, screen: 'room', crew: true });
const marker = { entrance_0: { x: 1, z: 1 } };

/** A ship with three worlds (3, 4, 6), Crusher, the usual items and a team per world. */
function game(): GameContent {
  const ship = miniShipData();
  ship.data.transporter = {
    exits: [{ code: 0, text: '-Bridge-' }],
    teams: [
      { world: 3, members: ['picard', 'crusher'], items: ['spare'] },
      { world: 4, members: ['data', 'picard'], items: [] },
      { world: 6, members: ['picard'], items: [] },
      { world: 8, members: ['crusher'], items: [] },
    ],
    targets: Array.from({ length: 9 }, () => ({ x: 0, y: 0 })),
  };
  ship.data.equipment = ['communicator', 'phaser', 'tricorder', 'medtric', 'medkit', 'spare'];
  ship.data.crew.leaderOrder = ['picard', 'data', 'crusher'];
  const c = makeGame(
    [crew('crusher'), ...ship.data.equipment.map(item),
      { id: 'w.ent', name: 'Enterprise', screen: null, universe: { x: 90, y: 90, z: 90 } }],
    { ship },
  );
  c.rules = { doctor: 'crusher', items: { phaser: 'phaser', tricorder: 'tricorder', medicalTricorder: 'medtric', medkit: 'medkit', communicator: 'communicator' }, lines: {} };
  c.screens.w3 = { id: 'w3', world: 'three', markers: marker, regions: {} };
  c.screens.w4 = { id: 'w4', world: 'four', markers: marker, regions: {} };
  c.screens.w6 = { id: 'w6', world: 'six', markers: marker, regions: {} };
  c.missions = [
    { world: 'three', number: 3, screen: 'w3', entrance: 'entrance_0' },
    { world: 'four', number: 4, screen: 'w4', entrance: 'entrance_0' },
    { world: 'six', number: 6, screen: 'w6', entrance: 'entrance_0', beamEffect: false },
  ];
  c.ship!.data.astro.enterprise = 'w.ent';
  return c;
}

function aboard(target: string | null, difficulty?: number): World {
  const c = game();
  const w = new World(c, createInitialState(c, 1, { onShip: true }), x => new HeadlessPresenter(x.clock), { difficulty });
  w.start();
  w.state.beamTarget = target;
  w.state.ship.station = 'transporter';
  return w;
}

describe('the transporter room', () => {
  it("offers the ship's equipment without the communicator, and the phaser except on world 3", () => {
    // (the phaser and tricorder go in the kit by themselves; the phaser is last in the list, so it moves first)
    const four = openTransporter(aboard('w4'));
    expect(four.kit).toEqual(['phaser', 'tricorder']);
    expect(four.equipment).toEqual(['medtric', 'medkit', 'spare']);
    // (world 3's recommended team has Crusher, so she has taken the medical items already)
    const three = openTransporter(aboard('w3'));
    expect(three.kit).toEqual(['tricorder', 'medkit', 'medtric', 'spare']);
    expect(three.equipment).toEqual([]);
    expect([...three.kit, ...three.equipment]).not.toContain('phaser');
    expect([...three.kit, ...three.equipment]).not.toContain('communicator');
  });

  it("chooseRecommended puts the world's team on the pads and its items in the kit", () => {
    const w = aboard('w3');
    const room = openTransporter(w);
    // (world 3's recommended team and kit were already chosen at the middle level; a fresh room says so again)
    expect(room.pads).toEqual(['picard', 'crusher', null, null]);
    expect(room.kit).toContain('spare');
    room.pads.fill(null);
    room.crew = ['picard', 'data', 'crusher'];
    chooseRecommended(w, room);
    expect(room.pads).toEqual(['picard', 'crusher', null, null]);
    expect(room.crew).toEqual(['data']);
  });

  it('a fifth crew member finds no pad', () => {
    const w = aboard('w4');
    const room = openTransporter(w);
    room.pads.fill(null);
    room.crew = ['a', 'b', 'c', 'd', 'e'];
    for (const id of room.crew.slice()) addToPad(w, room, id);
    expect(room.pads).toEqual(['a', 'b', 'c', 'd']);
    expect(room.crew).toEqual(['e']);
  });

  it('Crusher on a pad takes the medkit and medical tricorder unless moved by hand; off the pad she leaves them', () => {
    const w = aboard('w4');
    const room = openTransporter(w);
    expect(room.kit).not.toContain('medkit');
    addToPad(w, room, 'crusher');
    // (from the end of the list: the kit gets the medkit first)
    expect(room.kit).toEqual(['phaser', 'tricorder', 'medkit', 'medtric']);
    removeFromPad(w, room, room.pads.indexOf('crusher'));
    expect(room.kit).toEqual(['phaser', 'tricorder']);
    expect(room.crew).toContain('crusher');
    // moved by hand: she neither takes it nor leaves it
    moveToKit(room, 'medkit', true);
    expect(room.movedByHand).toEqual({ medkit: true, medicalTricorder: false });
    addToPad(w, room, 'crusher');
    expect(room.kit).toEqual(['phaser', 'tricorder', 'medkit', 'medtric']);
    removeFromPad(w, room, room.pads.indexOf('crusher'));
    expect(room.kit).toEqual(['phaser', 'tricorder', 'medkit']);
    moveToEquipment(room, 'medkit', true);
    expect(room.equipment).toContain('medkit');
  });

  it('returns the crew to the list in id order', () => {
    const w = aboard('w4');
    const room = openTransporter(w);
    room.pads.fill(null);
    room.crew = ['crusher'];
    addToPad(w, room, 'crusher');
    room.crew = ['data'];
    removeFromPad(w, room, 0);
    expect(room.crew).toEqual(['data', 'crusher']);
  });

  it('cannot energize without a target or with empty pads', () => {
    const none = aboard(null);
    const room = openTransporter(none);
    expect(room.target).toBeNull();
    expect(canEnergize(room)).toBe(false);
    expect(() => energize(none, room)).toThrow('no transporter target');
    const w = aboard('w4');
    const r = openTransporter(w);
    expect(r.target).toBe('w4');
    expect(canEnergize(r)).toBe(true);
    r.pads.fill(null);
    expect(canEnergize(r)).toBe(false);
  });

  it("energize on world 6 returns no effect and world 8 is world 5's: it beams to the target screen", () => {
    const six = aboard('w6');
    const room = openTransporter(six);
    expect(energize(six, room)).toBe(false);
    expect(six.state.screen).toBe('w6');
    const w = aboard('w4');
    const r = openTransporter(w);
    const seen: { world: number; effect: boolean }[] = [];
    w.bus.on(e => { if (e.type === 'beamedDown') seen.push(e); });
    r.world = 8;
    expect(energize(w, r)).toBe(true);
    expect(seen).toEqual([{ type: 'beamedDown', world: 5, effect: true }]);
    expect(w.state.screen).toBe('w4');
  });

  it('opens when the ship goes to the transporter; world 6 energizes by itself', async () => {
    const w = aboard('w4');
    w.state.ship.station = 'bridge';
    expect(transporterRoom(w)).toBeNull();
    void w.enqueue(() => gotoShipScreen(w, STATION_CODE.transporter));
    await settle(w);
    expect(w.transporter?.target).toBe('w4');
    expect(w.state.onShip).not.toBeNull();
    const six = aboard('w6');
    six.state.ship.station = 'bridge';
    void six.enqueue(() => gotoShipScreen(six, STATION_CODE.transporter));
    await settle(six);
    expect(six.state.onShip).toBeNull();
    expect(six.state.screen).toBe('w6');
  });

  it("the team's beam-in plays once they are on the screen, and the game waits for it (awayteam.cpp:137-140); world 6 has none", async () => {
    const w = aboard('w4');
    const room = openTransporter(w);
    room.pads.fill(null);
    room.crew = ['data', 'crusher'];
    addToPad(w, room, 'crusher');
    addToPad(w, room, 'data');
    const log = (w.presenter as HeadlessPresenter).log;
    const seen: string[] = [];
    w.bus.on(e => { if (e.type === 'beamedDown') seen.push(`beamedDown ${w.state.screen} ${w.state.awayTeam.join(',')}`); });
    let done = false;
    void energizeAndArrive(w, room).then(() => { done = true; });
    // (the away mission has started, and the beam-in is under way: nothing else happens until it ends)
    expect(w.state.screen).toBe('w4');
    expect(seen).toEqual(['beamedDown w4 crusher,data']);
    expect(log).toEqual(['beam in crusher,data']);
    expect(done).toBe(false);
    for (let i = 0; i < 4; i++) {
      w.tick();
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    expect(done).toBe(true);
    const six = aboard('w6');
    await energizeAndArrive(six, openTransporter(six));
    expect((six.presenter as HeadlessPresenter).log).toEqual([]);
  });

  it('beamDown picks the leader by leaderOrder, puts the kit in the inventory and starts the away mission', () => {
    const w = aboard('w4');
    w.state.tick = 40;
    const room = openTransporter(w);
    room.pads.fill(null);
    room.crew = ['data', 'crusher', 'picard'];
    addToPad(w, room, 'crusher');
    addToPad(w, room, 'data');
    moveToKit(room, 'spare', true);
    energize(w, room);
    expect(w.state.onShip).toBeNull();
    expect(w.state.screen).toBe('w4');
    expect(w.state.awayTeam).toEqual(['crusher', 'data']);
    expect(w.state.currentActor).toBe('data');
    expect(w.state.objects.crusher.screen).toBe('w4');
    expect(w.state.objects.picard.screen).toBeNull();
    for (const id of ['phaser', 'tricorder', 'medtric', 'medkit', 'spare']) expect(w.state.objects[id].inventory).toBe(true);
    expect(w.state.ship.equipment).toEqual(['communicator']);
    // (startAwayTeam: awayteam.cpp:345)
    expect(w.state.ship.awaySince).toBe(40);
    expect(w.state.ship.station).toBe('transporter');
    // the ship's clock isn't stopped by the beam (save.cpp:476: only restoring an away save stops it)
    expect(w.state.ship.clockStopped).toBe(0);
    expect(w.transporter).toBeNull();
  });
});

describe('difficulty (R6)', () => {
  it('below difficulty 2 the recommended team is on the pads; at 2 the pads are empty', () => {
    for (const level of [undefined, 0, 1]) expect(openTransporter(aboard('w4', level)).pads).toEqual(['data', 'picard', null, null]);
    const captain = openTransporter(aboard('w4', 2));
    expect(captain.pads).toEqual([null, null, null, null]);
    expect(captain.kit).toEqual(['phaser', 'tricorder']);
  });

  it('a difficulty out of range is clipped, and one that is not a number is the default', () => {
    expect(aboard(null, 7).difficulty).toBe(2);
    expect(aboard(null, -3).difficulty).toBe(0);
    expect(aboard(null, Number.NaN).difficulty).toBe(1);
    expect(aboard(null).difficulty).toBe(1);
  });

  it('at difficulty 0 the transporter energizes by itself once it can', async () => {
    const w = aboard('w4', 0);
    w.transporter = openTransporter(w);
    w.transporter.pads.fill(null);
    w.transporter.crew = ['picard', 'data', 'crusher'];
    expect(transporterTick(w)).toBe(false);
    addToPad(w, w.transporter, 'data');
    expect(transporterTick(w)).toBe(true);
    await settle(w);
    expect(w.state.onShip).toBeNull();
    expect(w.state.screen).toBe('w4');
    // (not at the other levels)
    const one = aboard('w4', 1);
    one.transporter = openTransporter(one);
    expect(transporterTick(one)).toBe(false);
    const two = aboard('w4', 2);
    two.transporter = openTransporter(two);
    addToPad(two, two.transporter, 'data');
    expect(transporterTick(two)).toBe(false);
  });

  it('energize sets adviceMode: 0 at level 1 with the recommended team, 2 without one of them, the level otherwise', () => {
    const beam = (level: number, team: string[]) => {
      const w = aboard('w4', level);
      const room = openTransporter(w);
      room.pads.fill(null);
      room.crew = ['picard', 'data', 'crusher'];
      for (const id of team) addToPad(w, room, id);
      energize(w, room);
      return w.state.adviceMode;
    };
    // (world 4's recommended team is Data and Picard)
    expect(beam(1, ['data', 'picard'])).toBe(0);
    expect(beam(1, ['data', 'picard', 'crusher'])).toBe(0);
    expect(beam(1, ['data', 'crusher'])).toBe(2);
    expect(beam(0, ['data'])).toBe(0);
    expect(beam(2, ['data', 'picard'])).toBe(2);
    expect(beam(2, ['crusher'])).toBe(2);
  });
});

describe('world 8', () => {
  it("a beam to world 8 offers world 8's team and lands on world 5's screen", async () => {
    const w = aboard('w4');
    w.state.beamWorld = 8;
    const room = openTransporter(w);
    expect(room.world).toBe(8);
    expect(room.target).toBe('w4');
    expect(room.pads).toEqual(['crusher', null, null, null]);
    // (without the number, the screen's own world is the team's)
    w.state.beamWorld = null;
    expect(openTransporter(w).world).toBe(4);
    w.state.beamWorld = 8;
    const seen: { world: number }[] = [];
    w.bus.on(e => { if (e.type === 'beamedDown') seen.push(e); });
    energize(w, room);
    expect(seen).toEqual([{ type: 'beamedDown', world: 5, effect: true }]);
    expect(w.state.screen).toBe('w4');
  });
});

describe('reading the transporter (M9)', () => {
  it('changes nothing: the room opens on entering and after a load there', async () => {
    const w = aboard('w4');
    expect(transporterRoom(w)).toBeNull();
    expect(w.transporter).toBeNull();
    restoreTransporter(w);
    expect(w.transporter?.target).toBe('w4');
    const room = w.transporter;
    restoreTransporter(w);
    expect(w.transporter).toBe(room);
    // (reading it again changes nothing)
    const before = JSON.stringify(w.state);
    expect(transporterRoom(w)).toBe(room);
    expect(JSON.stringify(w.state)).toBe(before);
    // a save made at the transporter loads with its room
    const loaded = World.fromSave(game(), w.save(), x => new HeadlessPresenter(x.clock));
    expect(loaded.state.ship.station).toBe('transporter');
    expect(loaded.transporter?.target).toBe('w4');
  });
});
