// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { miniShipContent } from '../testing/ship';
import { HeadlessPresenter } from './presenter';
import type { SimEvent } from './events';
import { clockRunsAt, contacts, dispatchHail, gotoShipScreen, hailObject, holodeckPlay, HOLODECK_COMPUTER_PERCENT, leaveHolodeck, loungeTalk, LOUNGE_EMPTY, NO_RESPONSE, seenMovieStems, startClock, stopClock } from './stations';
import { markMovieSeen } from './ship';
import { computerVoices } from './computer';
import type { HeadlessPresenter as HP } from './presenter';
import { shipTick } from './shipTick';
import { settle } from './settle';
import { createInitialState } from './state';
import { World } from './world';

function shipWorld() {
  const c = miniShipContent();
  const world = new World(c, createInitialState(c, 1, { onShip: true }), w => new HeadlessPresenter(w.clock));
  const events: SimEvent[] = [];
  world.bus.on(e => events.push(e));
  return { world, events };
}

describe('gotoShipScreen', () => {
  it('goes to astrogation with the clock running, and to the computer with it stopped', async () => {
    const { world, events } = shipWorld();
    await gotoShipScreen(world, 4);
    expect(world.state.ship.station).toBe('astrogation');
    expect(world.state.ship.clockStopped).toBe(0);
    await gotoShipScreen(world, 5 | (3 << 8));
    // (the computer leaves the station as it was, M5)
    expect(world.state.ship.station).toBe('astrogation');
    expect(world.computer).not.toBeNull();
    expect(world.state.ship.clockStopped).not.toBe(0);
    await gotoShipScreen(world, 0);
    expect(world.state.ship.clockStopped).toBe(0);
    expect(events.filter(e => e.type === 'shipScreen')).toEqual([
      { type: 'shipScreen', code: 4 }, { type: 'shipScreen', code: 5 | (3 << 8) }, { type: 'shipScreen', code: 0 },
    ]);
  });

  it('ends the game with the reason in the parameter', async () => {
    const { world } = shipWorld();
    await gotoShipScreen(world, 0xfe | (1 << 8));
    expect(world.state.onShip).toEqual({ gameOver: 1 });
  });

  it('warns about an unknown code and goes to the bridge', async () => {
    const { world, events } = shipWorld();
    await gotoShipScreen(world, 4);
    await gotoShipScreen(world, 0x33);
    expect(world.state.ship.station).toBe('bridge');
    expect(events.some(e => e.type === 'warning')).toBe(true);
  });

  it('falls back to the bridge when the battle has no Enterprise', async () => {
    const { world, events } = shipWorld();
    await gotoShipScreen(world, 4);
    await gotoShipScreen(world, 2);
    expect(world.state.ship.station).toBe('astrogation');
    // (the mini ship's default battle has no ships: no Enterprise)
    await gotoShipScreen(world, 7);
    expect(world.state.ship.station).toBe('bridge');
    // (the viewscreen has no signal; the battle has no Enterprise)
    expect(events.filter(e => e.type === 'warning')).toHaveLength(2);
  });


  it('is refused while the team is away', async () => {
    const c = miniShipContent();
    const world = new World(c, createInitialState(c, 1), w => new HeadlessPresenter(w.clock));
    await expect(gotoShipScreen(world, 4)).rejects.toThrow(/away/);
  });
});

describe('the clock', () => {
  it('stops at the stations the original stops it at', () => {
    expect((['bridge', 'astrogation', 'viewscreen', 'transporter'] as const).every(clockRunsAt)).toBe(true);
    expect((['computer', 'tactical', 'engineering'] as const).some(clockRunsAt)).toBe(false);
  });

  it('pushes a journey back by the time it was stopped', () => {
    const { world } = shipWorld();
    world.state.ship.transit = { from: { x: 0, y: 0, z: 0 }, to: { x: 1, y: 0, z: 0 }, orbit: 0, destination: world.state.ship.location, destType: 0, destStarId: 0, warp: true, speed: 1, startTick: 10, ticks: 100 };
    world.state.tick = 50;
    stopClock(world);
    stopClock(world);
    world.state.tick = 80;
    startClock(world);
    expect(world.state.ship.transit!.startTick).toBe(40);
    expect(world.state.ship.clockStopped).toBe(0);
  });
});

describe('the computer station (M5)', () => {
  it('opens the entry a script asked for, leaves ship.station as it was, and stops the clock', async () => {
    const { world } = shipWorld();
    world.content.ship!.computer.entries = Array.from({ length: 9 }, (_, i) => ({ title: `E${i}`, heading: '', text: '', flags: 0, subentries: [] }));
    await gotoShipScreen(world, 0);
    await gotoShipScreen(world, 5 | (8 << 8));
    expect(world.state.ship.station).toBe('bridge');
    expect(world.computer?.ancestors).toEqual([0, 7]);
    expect(world.computer?.selected).toBe(7);
    expect(world.state.ship.clockStopped).not.toBe(0);
    // (no entry asked for: the root)
    await gotoShipScreen(world, 5);
    expect(world.computer?.ancestors).toEqual([0]);
  });

  it('comes back to the previous station after a viewscreen hail, and any other screen closes it', async () => {
    const { world } = shipWorld();
    await gotoShipScreen(world, 4);
    await gotoShipScreen(world, 5);
    expect(world.computer).not.toBeNull();
    world.state.ship.viewscreenTarget = null;
    await gotoShipScreen(world, 2);
    expect(world.state.ship.station).toBe('astrogation');
    expect(world.computer).toBeNull();
    await gotoShipScreen(world, 5);
    await gotoShipScreen(world, 0);
    expect(world.computer).toBeNull();
    expect(world.state.ship.station).toBe('bridge');
  });
});

describe('the ship tick at the computer', () => {
  it('leaves a pending hail waiting while the computer is open, and sends it once back on the bridge', async () => {
    const { world } = shipWorld();
    await gotoShipScreen(world, 5);
    world.state.pendingHail = { type: 9, from: 'w.planet', conversation: null, situation: 0, scenario: null } as never;
    shipTick(world);
    await settle(world);
    expect(world.state.pendingHail).not.toBeNull();
    await gotoShipScreen(world, 0);
    shipTick(world);
    await settle(world);
    expect(world.state.pendingHail).toBeNull();
    expect(world.state.ship.station).toBe('transporter');
  });
});

describe("the bridge's Comms and lounge", () => {
  const log = (w: World) => (w.presenter as HP).log;
  function bridge(comms: { object: string; sprite: boolean }[], lounge: string[] = []) {
    const c = miniShipContent();
    c.ship!.data.contacts = { comms, lounge };
    const world = new World(c, createInitialState(c, 1, { onShip: true }), w => new HeadlessPresenter(w.clock));
    const events: SimEvent[] = [];
    world.bus.on(e => events.push(e));
    return { world, events };
  }

  it('lists only the active contacts that have a sprite, at most ten', () => {
    const { world } = bridge([
      { object: 'w.planet', sprite: true }, { object: 'w.ent', sprite: false }, ...Array.from({ length: 12 }, () => ({ object: 'w.planet', sprite: true })),
    ]);
    expect(contacts(world, 'comms')).toHaveLength(10);
    world.state.objects['w.planet'].active = false;
    expect(contacts(world, 'comms')).toEqual([]);
  });

  it("lists the lounge's active contacts without needing a sprite", () => {
    const { world } = bridge([], ['w.ent', 'w.planet']);
    world.state.objects['w.planet'].active = false;
    expect(contacts(world, 'lounge')).toEqual(['w.ent']);
  });

  it("puts the target on the viewscreen and says its own talk string there, then comes back", async () => {
    const { world, events } = bridge([{ object: 'w.planet', sprite: true }]);
    world.state.objects['w.planet'].talk = 'Own talk.';
    void world.enqueue(() => hailObject(world, 'w.planet'));
    await settle(world);
    expect(world.state.ship.viewscreenTarget).toBe('w.planet');
    expect(events).toContainEqual({ type: 'viewscreen', on: true, target: 'w.planet' });
    expect(log(world)).toEqual(['say picard: Own talk.']);
    expect(world.viewscreen).toBeNull();
    expect(world.state.ship.station).toBe('bridge');
  });

  it('says nobody answers with nobody to hail, and stays', async () => {
    const { world, events } = bridge([]);
    void world.enqueue(() => hailObject(world, null));
    await settle(world);
    expect(log(world)).toEqual([`say picard: ${NO_RESPONSE}`]);
    expect(events.some(e => e.type === 'viewscreen')).toBe(false);
    expect(world.state.ship.viewscreenTarget).toBeNull();
  });

  it('has the lounge talk to its contact as the leader, and say the room is empty with nobody', async () => {
    const { world } = bridge([], ['w.planet']);
    world.state.objects['w.planet'].talk = 'Lounge talk.';
    void world.enqueue(() => loungeTalk(world, 'w.planet'));
    await settle(world);
    expect(log(world)).toEqual(['say w.planet: Lounge talk.']);
    log(world).length = 0;
    void world.enqueue(() => loungeTalk(world, null));
    await settle(world);
    expect(log(world)).toEqual([`say picard: ${LOUNGE_EMPTY}`]);
  });

  it('puts the bridge viewscreen down for hail 4 and up for hail 5', async () => {
    const { world, events } = bridge([]);
    for (const type of [4, 5]) {
      world.state.pendingHail = { from: null, conversation: null, situation: 0, type };
      void world.enqueue(async () => { await dispatchHail(world); });
      await settle(world);
      expect(world.state.pendingHail).toBeNull();
    }
    expect(events.filter(e => e.type === 'bridgeViewscreen')).toEqual([
      { type: 'bridgeViewscreen', up: false }, { type: 'bridgeViewscreen', up: true },
    ]);
  });

  it('leaves the unused hail types pending at the bridge (unity.cpp:690-692)', async () => {
    const { world } = bridge([]);
    for (const type of [0, 1, 2, 3, 0xc, 0xd, 0xe, 0xf]) {
      world.state.pendingHail = { from: null, conversation: null, situation: 0, type };
      let next: number | null = 1;
      void world.enqueue(async () => { next = await dispatchHail(world); });
      await settle(world);
      expect(next).toBeNull();
      expect(world.state.pendingHail?.type).toBe(type);
    }
  });
});

describe('the holodeck (runHolodeck, unity.cpp:379-426)', () => {
  const cues = (events: SimEvent[]) => events.flatMap(e => (e.type === 'shipCue' ? [e.cue] : []));

  it('opens with the computer at full strength: the clock stops, and the door and the projector sound', async () => {
    const { world, events } = shipWorld();
    await gotoShipScreen(world, 0xa);
    expect(world.state.ship.station).toBe('holodeck');
    expect(world.state.ship.clockStopped).not.toBe(0);
    expect(cues(events)).toEqual(['holodeckDoor', 'holodeckOn']);
    expect(events.filter(e => e.type === 'warning')).toEqual([]);
  });

  it('is refused while the computer is below the percent it needs: the computer says so and the bridge comes back', async () => {
    const { world, events } = shipWorld();
    const computer = world.state.ship.systems.units.filter((_, i) => world.content.ship!.data.units[i]!.type === 11);
    computer.forEach(u => { u.current = HOLODECK_COMPUTER_PERCENT - 1; });
    await gotoShipScreen(world, 0xa);
    expect(world.state.ship.station).toBe('bridge');
    expect(cues(events)).toEqual(['computerOffline']);
    // (exactly the percent is enough: `< kHolodeckComputerPercent`)
    computer.forEach(u => { u.current = HOLODECK_COMPUTER_PERCENT; });
    await gotoShipScreen(world, 0xa);
    expect(world.state.ship.station).toBe('holodeck');
  });

  it('says the refusal to its end before the bridge comes back: the screen it was asked from stays until then (waitForSpeech, unity.cpp:383)', async () => {
    const { world, events } = shipWorld();
    world.state.ship.systems.units.forEach((u, i) => { if (world.content.ship!.data.units[i]!.type === 11) u.current = 10; });
    await gotoShipScreen(world, 1);
    expect(world.state.ship.station).toBe('transporter');
    let release!: () => void;
    let asked = 0;
    world.waitForSpeech = () => { asked++; return new Promise<void>(resolve => { release = resolve; }); };
    const went = gotoShipScreen(world, 0xa);
    await Promise.resolve();
    await Promise.resolve();
    expect(cues(events)).toEqual(['computerOffline']);
    expect(asked).toBe(1);
    // (still where it was asked from, with no bridge yet: the bridge's own start waits for the voice)
    expect(world.state.ship.station).toBe('transporter');
    expect(events.filter(e => e.type === 'shipScreen').map(e => (e as { code: number }).code)).toEqual([1]);
    release();
    await went;
    expect(world.state.ship.station).toBe('bridge');
    expect(events.filter(e => e.type === 'shipScreen').map(e => (e as { code: number }).code)).toEqual([1, 0]);
  });

  it('does not wait when the holodeck opens: only the refusal is spoken', async () => {
    const { world } = shipWorld();
    let asked = 0;
    world.waitForSpeech = async () => { asked++; };
    await gotoShipScreen(world, 0xa);
    expect(world.state.ship.station).toBe('holodeck');
    expect(asked).toBe(0);
  });

  it('plays a movie seen before between the pick and the projector sounds, and refuses one not seen', async () => {
    const { world, events } = shipWorld();
    await gotoShipScreen(world, 0xa);
    await expect(holodeckPlay(world, 'labarriv')).rejects.toThrow(/not been seen/);
    markMovieSeen(world.state.ship, 'LabArriv');
    events.length = 0;
    void world.enqueue(() => holodeckPlay(world, 'labarriv'));
    await settle(world);
    expect((world.presenter as HP).log).toContain('play labarriv');
    expect(cues(events)).toEqual(['holodeckPick', 'holodeckOff']);
  });

  it('only plays at the holodeck, and its Bridge button goes back with the door sound', async () => {
    const { world, events } = shipWorld();
    await expect(holodeckPlay(world, 'shiptour')).rejects.toThrow(/not at the holodeck/);
    await expect(leaveHolodeck(world)).rejects.toThrow(/not at the holodeck/);
    await gotoShipScreen(world, 0xa);
    events.length = 0;
    await leaveHolodeck(world);
    expect(world.state.ship.station).toBe('bridge');
    expect(world.state.ship.clockStopped).toBe(0);
    expect(cues(events)).toEqual(['holodeckDoor']);
  });

  it('names a warp movie seen by its index as the stem the index lists', () => {
    const { world } = shipWorld();
    markMovieSeen(world.state.ship, 'warp:2');
    markMovieSeen(world.state.ship, 'warp:4');
    expect([...seenMovieStems(world, [null, 'warpout1', 'WarpOut2', 'warpout3', null])].sort()).toEqual(['shiptour', 'warpout2']);
    // (without the list a warp key names nothing)
    expect([...seenMovieStems(world)]).toEqual(['shiptour']);
  });
});

describe('what the computer says as its screen opens (computer.cpp:306-316)', () => {
  it('says online and then full at 100, online and partial between, and only offline at 0', () => {
    expect(computerVoices(100)).toEqual(['computerOnline', 'computerFull']);
    expect(computerVoices(150)).toEqual(['computerOnline', 'computerFull']);
    expect(computerVoices(99)).toEqual(['computerOnline', 'computerPartial']);
    expect(computerVoices(1)).toEqual(['computerOnline', 'computerPartial']);
    expect(computerVoices(0)).toEqual(['computerOffline']);
  });

  it('sends them as cues when the screen opens, before the screen change, and not for other stations', async () => {
    const { world, events } = shipWorld();
    await gotoShipScreen(world, 4);
    expect(events.filter(e => e.type === 'shipCue')).toEqual([]);
    await gotoShipScreen(world, 5);
    const order = events.filter(e => e.type === 'shipCue' || (e.type === 'shipScreen' && e.code === 5)).map(e => (e.type === 'shipCue' ? e.cue : 'screen'));
    expect(order).toEqual(['computerOnline', 'computerFull', 'screen']);
  });
});
