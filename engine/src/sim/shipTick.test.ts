// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { CommunicateFx, Effect, GameContent, ObjectDef, ProximityDef, TriggerDef } from '../content/types';
import { ANYONE } from '../content/types';
import { lineConversation, makeGame } from '../testing/fixture';
import { miniShipData } from '../testing/ship';
import { HeadlessPresenter } from './presenter';
import type { HeadlessPresenter as HP } from './presenter';
import { settle } from './settle';
import type { SimEvent } from './events';
import { runEffect } from './effects';
import { dispatchHail } from './stations';
import { retarget } from './astro';
import { moveInUniverse, requestScriptedWarp } from './shipFx';
import { returnAwayTeam } from './ship';
import { createInitialState } from './state';
import { proximityFires, SHIP_TRIGGER_TICKS, UNIVERSE_MOVE_TICKS, updateUniverseMoves } from './shipTick';
import { checkTriggers } from './timers';
import { World } from './world';

const SHIP_POS = { x: 90, y: 90, z: 90 };
const PLANET_POS = { x: 10, y: 20, z: 30 };

function build(opts: { triggers?: TriggerDef[]; warpPlanet?: number; objects?: ObjectDef[]; crewOnly?: boolean } = {}) {
  const ship = miniShipData();
  if (opts.warpPlanet !== undefined) {
    ship.universe.scriptedWarps = [{ code: 10 * 1000000 + 20 * 1000 + 30, sector: 0, star: 0, planet: opts.warpPlanet, type: 0x21, index: 0 }];
  }
  const speaker: ConvResponseWho = opts.crewOnly ? ['picard'] : [ANYONE];
  const lines = lineConversation('hailc', { 3: 'Hello.' });
  lines.responses[0].who = speaker;
  const content: GameContent = makeGame(
    [
      { id: 'w.ent', name: 'Enterprise', screen: null, universe: { ...SHIP_POS } },
      { id: 'w.planet', name: 'Planet', screen: null, universe: { ...PLANET_POS }, talk: 'Own talk.' },
      ...(opts.objects ?? []),
    ],
    {
      triggers: opts.triggers ?? [],
      ship,
      conversations: { hailc: { ...lines, ship: true, number: 7 } },
    },
  );
  const world = new World(content, createInitialState(content, 1, { onShip: true }), w => new HeadlessPresenter(w.clock));
  const events: SimEvent[] = [];
  world.bus.on(e => events.push(e));
  return { world, events, content };
}
type ConvResponseWho = string[];

const log = (w: World) => (w.presenter as HP).log;
const prox = (p: Partial<ProximityDef> = {}): ProximityDef => ({ dist: 5, from: 'w.ent', to: 'w.planet', reversed: false, instant: false, ...p });
/** Runs a task as an action would, and lets its time pass. */
async function run<T>(w: World, task: () => Promise<T>): Promise<T> {
  let out: T | undefined;
  void w.enqueue(async () => { out = await task(); });
  await settle(w);
  return out as T;
}
const send = (w: World, fx: Effect) => run(w, () => runEffect(w, fx, { verb: 'use', target: 'w.ent', who: 'picard', other: null, walked: false }, 'k'));
const hail = async (w: World, c: CommunicateFx) => { await send(w, { communicate: c }); };
const dispatch = (w: World) => run(w, () => dispatchHail(w));
async function ticks(w: World, n: number): Promise<void> {
  for (let i = 0; i < n; i++) { w.tick(); await settle(w); }
}

describe('proximityFires (trigger.cpp:62-91)', () => {
  it.each([
    // [dist, reversed, inside, match, inTransit, fires]
    [5, false, true, true, false, true],
    [5, false, false, true, false, false],
    [5, true, false, true, false, true],
    [5, true, true, true, false, false],
    [0, false, true, true, false, true],
    [0, false, true, false, false, false],
    [0, false, true, true, true, false],
    [0, true, true, false, false, true],
    [0, true, true, true, false, false],
  ])('dist %i reversed %s inside %s match %s transit %s -> %s', (dist, reversed, inside, match, inTransit, fires) => {
    const { world } = build({ warpPlanet: 2 });
    const o = world.state.objects;
    // inside: the ship is on the planet (distance 0 is inside every range)
    o['w.ent'].universe = inside ? { ...PLANET_POS } : { ...SHIP_POS };
    world.state.ship.location.planet = match ? 2 : 1;
    if (inTransit) {
      world.state.ship.transit = {
        from: { ...SHIP_POS }, to: { ...PLANET_POS }, orbit: 0, destination: { ...world.state.ship.location },
        destType: 0, destStarId: 0, warp: true, speed: 100, startTick: 0, ticks: 100,
      };
    }
    expect(proximityFires(world, prox({ dist, reversed }))).toBe(fires);
  });

  it('uses squared integer distance <= dist*dist', () => {
    const { world } = build();
    // 3-4-0 away: distance 5 exactly
    world.state.objects['w.ent'].universe = { x: PLANET_POS.x + 3, y: PLANET_POS.y + 4, z: PLANET_POS.z };
    expect(proximityFires(world, prox({ dist: 5 }))).toBe(true);
    expect(proximityFires(world, prox({ dist: 4 }))).toBe(false);
  });

  it('missing from/to universe position never fires', () => {
    const { world } = build();
    delete world.state.objects['w.ent'].universe;
    expect(proximityFires(world, prox())).toBe(false);
    world.state.objects['w.ent'].universe = { ...SHIP_POS };
    delete world.state.objects['w.planet'].universe;
    expect(proximityFires(world, prox({ reversed: true }))).toBe(false);
  });

  it("atPlanetFor matches only the scripted warp's planet", () => {
    const { world } = build({ warpPlanet: 2 });
    world.state.objects['w.ent'].universe = { ...PLANET_POS };
    world.state.ship.location.planet = 1;
    expect(proximityFires(world, prox({ dist: 0 }))).toBe(false);
    world.state.ship.location.planet = 2;
    expect(proximityFires(world, prox({ dist: 0 }))).toBe(true);
  });
});

describe('the ship\'s triggers', () => {
  const prox0: TriggerDef = { id: 'near', type: 'proximity', context: 'ship', target: 'w.ent', enabled: true, proximity: prox({ dist: 50, from: 'w.ent', to: 'w.ent' }) };

  it('checks nothing away or at the transporter', async () => {
    const t: TriggerDef = { id: 'n', type: 'normal', context: 'ship', target: 'w.ent', enabled: true };
    const { world, events } = build({ triggers: [t] });
    world.state.ship.station = 'transporter';
    await ticks(world, 250);
    expect(events.some(e => e.type === 'triggerFired')).toBe(false);
    world.state.ship.station = 'bridge';
    await ticks(world, 1);
    expect(events.some(e => e.type === 'triggerFired')).toBe(true);
    // away: world.tick runs the away half, which only looks at away triggers
    const away = build({ triggers: [t] });
    away.world.state.onShip = null;
    away.world.state.awayTeam = ['picard'];
    await ticks(away.world, 250);
    expect(away.events.some(e => e.type === 'triggerFired')).toBe(false);
  });

  it('checks every SHIP_TRIGGER_TICKS, one trigger at a time, as processTriggers does', async () => {
    expect(SHIP_TRIGGER_TICKS).toBe(100);
    const a: TriggerDef = { id: 'a', type: 'normal', context: 'ship', target: 'w.ent', enabled: true };
    const b: TriggerDef = { id: 'b', type: 'normal', context: 'ship', target: 'w.ent', enabled: true };
    const { world, events } = build({ triggers: [a, b] });
    await ticks(world, 1);
    const fired = () => events.filter(e => e.type === 'triggerFired').map(e => e.type === 'triggerFired' && e.id);
    expect(fired()).toEqual(['a']);
    await ticks(world, 98);
    expect(fired()).toEqual(['a']);
    await ticks(world, 3);
    expect(fired()).toEqual(['a', 'a']);
  });

  it('fires a proximity trigger once the ship is in range', async () => {
    const { world, events } = build({ triggers: [{ ...prox0, proximity: prox({ dist: 5, from: 'w.ent', to: 'w.planet' }) }] });
    await ticks(world, 120);
    expect(events.some(e => e.type === 'triggerFired')).toBe(false);
    world.state.objects['w.ent'].universe = { ...PLANET_POS };
    await ticks(world, 100);
    expect(events.some(e => e.type === 'triggerFired' && e.id === 'near')).toBe(true);
  });
});

describe('hails on the ship', () => {
  it('runs an alter-hail "1@c,s" conversation at once (object.cpp:1430-1436), a crew speaker aboard included', async () => {
    const { world } = build({ crewOnly: true, objects: [{ id: 'console', name: 'Console', screen: null }] });
    expect(world.state.awayTeam).toEqual([]);
    await send(world, { alter: { object: 'console', converseNow: '@hailc,3' } } as Effect);
    expect(log(world)).toEqual(['say picard: Hello.']);
  });

  it('dispatches hail 7 to the viewscreen (2|0x100), and no conversation to the target\'s own talk string', async () => {
    const { world } = build();
    await hail(world, { conversation: 'hailc', situation: 3, type: 7 });
    expect(await dispatch(world)).toBe(2 | 0x100);
    expect(world.state.pendingHail).not.toBeNull();
    await hail(world, { from: 'w.planet', type: 7 });
    expect(world.state.pendingHail).toMatchObject({ from: 'w.planet', conversation: null, type: 7 });
    expect(await dispatch(world)).toBe(2);
    expect(world.state.pendingHail).toBeNull();
    expect(world.state.ship.viewscreenTarget).toBe('w.planet');
  });

  it('shows a hail on the viewscreen, then goes back to the station it left', async () => {
    const { world } = build();
    await hail(world, { from: 'w.planet', conversation: 'hailc', situation: 3, type: 7 });
    world.tick();
    await settle(world);
    expect(world.viewscreen).toBeNull();
    expect(log(world)).toEqual(['say picard: Hello.']);
    expect(world.state.pendingHail).toBeNull();
    expect(world.state.ship.station).toBe('bridge');
  });

  it('says the target\'s talk string on the viewscreen for a hail with no conversation', async () => {
    const { world } = build();
    await hail(world, { from: 'w.planet', type: 7 });
    let during: string | null = 'unset';
    (world.presenter as HP).log.push = ((...items: string[]) => { during = world.viewscreen?.target ?? null; return Array.prototype.push.apply(log(world), items); }) as never;
    await ticks(world, 1);
    expect(during).toBe('w.planet');
    expect(log(world).join('|')).toContain('Own talk.');
  });

  it('dispatches 4/5/8 as the ship conversation and clears the hail', async () => {
    for (const type of [4, 5, 8]) {
      const { world } = build();
      await hail(world, { conversation: 'hailc', situation: 3, type });
      expect(world.state.pendingHail).not.toBeNull();
      expect(await dispatch(world)).toBeNull();
      expect(world.state.pendingHail).toBeNull();
      expect(log(world)).toEqual(['say picard: Hello.']);
    }
  });

  it('dispatches 9 to the transporter', async () => {
    const { world } = build();
    await hail(world, { type: 9 });
    expect(await dispatch(world)).toBe(1);
    expect(world.state.pendingHail).toBeNull();
  });

  it('0xb/0x11 set the scenario only', async () => {
    for (const type of [0xb, 0x11]) {
      const { world } = build();
      await hail(world, { scenario: 71, type });
      expect(await dispatch(world)).toBeNull();
      expect(world.state.ship.battleScenario).toBe(71);
      expect(world.state.pendingHail).toBeNull();
    }
  });

  it('0xa and 0x10 go to tactical with their scenario (unity.cpp:676-680)', async () => {
    for (const type of [0xa, 0x10]) {
      const { world } = build();
      await hail(world, { scenario: 5, type });
      expect(await dispatch(world)).toBe(7);
      expect(world.state.ship.battleScenario).toBe(5);
      expect(world.state.pendingHail).toBeNull();
    }
  });

  it('a pending hail is dispatched by the bridge\'s tick, not while at another station', async () => {
    const { world } = build();
    await hail(world, { conversation: 'hailc', situation: 3, type: 4 });
    world.state.ship.station = 'computer';
    await ticks(world, 3);
    expect(world.state.pendingHail).not.toBeNull();
    world.state.ship.station = 'bridge';
    await ticks(world, 1);
    expect(world.state.pendingHail).toBeNull();
  });
});

const WARP_CODE = 110090090;
const normal = (id: string, enabled = true): TriggerDef => ({ id, type: 'normal', context: 'ship', target: 'w.ent', enabled });
const fired = (events: SimEvent[]) => events.filter(e => e.type === 'triggerFired').length;
const codes = (events: SimEvent[]) => events.filter(e => e.type === 'shipScreen').map(e => e.type === 'shipScreen' && e.code);

describe('universe moves (unity.cpp:425-476)', () => {
  it('reaches its target after UNIVERSE_MOVE_TICKS, truncates on the way and clips to 0..159', () => {
    expect(UNIVERSE_MOVE_TICKS).toBe(21600);
    const { world } = build();
    moveInUniverse(world, 'w.planet', { x: 50, y: 0, z: 30 });
    world.state.tick = UNIVERSE_MOVE_TICKS / 2;
    updateUniverseMoves(world);
    // from (10, 20, 30): + trunc(40 / 2), trunc(-20 / 2) (toward zero)
    expect(world.state.objects['w.planet'].universe).toEqual({ x: 30, y: 10, z: 30 });
    world.state.tick = 1;
    updateUniverseMoves(world);
    expect(world.state.objects['w.planet'].universe).toEqual({ x: 10, y: 20, z: 30 });
    world.state.tick = UNIVERSE_MOVE_TICKS;
    updateUniverseMoves(world);
    expect(world.state.objects['w.planet'].universe).toEqual({ x: 50, y: 0, z: 30 });
    expect(world.state.ship.universeMoves).toEqual([]);

    moveInUniverse(world, 'w.planet', { x: 400, y: -5, z: 30 });
    world.state.tick += UNIVERSE_MOVE_TICKS;
    updateUniverseMoves(world);
    expect(world.state.objects['w.planet'].universe).toEqual({ x: 159, y: 0, z: 30 });
  });

  it('run only on the bridge or in astrogation, and keep their start tick while away', async () => {
    const { world } = build();
    moveInUniverse(world, 'w.planet', { x: 50, y: 20, z: 30 });
    world.state.ship.station = 'transporter';
    world.state.tick = UNIVERSE_MOVE_TICKS;
    await ticks(world, 1);
    expect(world.state.objects['w.planet'].universe).toEqual(PLANET_POS);
    expect(world.state.ship.universeMoves).toHaveLength(1);
    // (the start is a tick: it doesn't move with the delay of the ship's timers)
    expect(world.state.ship.universeMoves[0].start).toBe(0);
    world.state.ship.station = 'bridge';
    await ticks(world, 1);
    expect(world.state.objects['w.planet'].universe).toEqual({ x: 50, y: 20, z: 30 });
    expect(world.state.ship.universeMoves).toEqual([]);
  });
});

describe('scripted warps (astrogation.cpp:1142-1220, bridge.cpp:262-264)', () => {
  it('a pending scripted warp on the bridge goes to astrogation (4|0x100)', async () => {
    const { world, events } = build();
    requestScriptedWarp(world, WARP_CODE, 700);
    await ticks(world, 1);
    expect(codes(events)).toEqual([4 | 0x100]);
    expect(world.state.ship.station).toBe('astrogation');
  });

  it('astrogation retargets a scripted warp to its star and auto-engages at its speed', async () => {
    const { world } = build();
    requestScriptedWarp(world, WARP_CODE, 700);
    await ticks(world, 1);
    // (entering astrogation retargets: the warp is no longer pending)
    expect(world.state.ship.warpPending).toBe(false);
    expect(world.autoEngage).toEqual({ sector: 1, star: 0, warp: true, speed: 700, point: { x: 30, y: 10, z: 10 } });
    expect(world.state.ship.warpSpeed).toBe(0);
    await ticks(world, 1);
    expect(world.autoEngage).toBeNull();
    const t = world.state.ship.transit;
    expect(t).not.toBeNull();
    expect(t).toMatchObject({ warp: true, speed: 700, to: { x: 110, y: 90, z: 90 } });
  });

  it('after the auto-engage the ship goes back to the bridge (0|0x100)', async () => {
    const { world, events } = build();
    requestScriptedWarp(world, WARP_CODE, 700);
    await ticks(world, 3);
    expect(codes(events)).toEqual([4 | 0x100, 0 | 0x100]);
    expect(world.state.ship.station).toBe('bridge');
    expect(world.state.ship.transit).not.toBeNull();
  });

  it('retargets a planet, a station, a phenomenon and a point', () => {
    const { world } = build();
    const u = world.content.ship!.universe;
    const target = (w: Partial<(typeof u.scriptedWarps)[0]>) => {
      u.scriptedWarps = [{ code: 20 * 1000000 + 25 * 1000 + 7 * 1, sector: 0, star: -1, planet: -1, type: 0x83, index: 0, ...w }];
      requestScriptedWarp(world, u.scriptedWarps[0].code, 0);
      retarget(world);
      return world.autoEngage;
    };
    expect(target({ star: 0, planet: 2, type: 0x21 })).toMatchObject({ sector: 0, star: 0, planet: 2 });
    expect(target({ type: 0x83 })).toMatchObject({ sector: 0, station: true });
    expect(target({ type: 0x41, index: 3 })).toMatchObject({ sector: 0, phenomenon: 3 });
    // sector 0's corner plus the code's remainders mod 20
    expect(target({ code: 12 * 1000000 + 34 * 1000 + 56 })).toMatchObject({ point: { x: 12, y: 14, z: 16 } });
    // sector 10 is (2, 1, 0)
    expect(target({ code: 12 * 1000000 + 34 * 1000 + 56, sector: 10 })).toMatchObject({ point: { x: 52, y: 34, z: 16 } });
  });

  it('goes to the point when nothing is there', async () => {
    const { world } = build();
    const u = world.content.ship!.universe;
    u.scriptedWarps = [{ code: 12 * 1000000 + 34 * 1000 + 56, sector: 0, star: -1, planet: -1, type: 0x83, index: 0 }];
    requestScriptedWarp(world, u.scriptedWarps[0].code, 0);
    await ticks(world, 2);
    expect(world.state.ship.transit).toMatchObject({ to: { x: 12, y: 14, z: 16 } });
  });

  it('990 and up is maxWarp, and 0 leaves the speed', () => {
    const { world } = build();
    requestScriptedWarp(world, WARP_CODE, 990);
    retarget(world);
    expect(world.autoEngage?.speed).toBe(940);
    requestScriptedWarp(world, WARP_CODE, 0);
    retarget(world);
    // (the screen's own setting, 940 now)
    expect(world.autoEngage?.speed).toBe(940);
    world.warpSetting = 500;
    requestScriptedWarp(world, WARP_CODE, 0xffff);
    retarget(world);
    expect(world.autoEngage?.speed).toBe(500);
  });

  it('checks no trigger while a warp is pending', async () => {
    const { world, events } = build({ triggers: [normal('n')] });
    requestScriptedWarp(world, WARP_CODE, 0);
    checkTriggers(world, 'ship');
    await settle(world);
    expect(fired(events)).toBe(0);
    world.state.ship.warpPending = false;
    checkTriggers(world, 'ship');
    await settle(world);
    expect(fired(events)).toBe(1);
  });
});

describe('the ship\'s timers while the team is away (unity.cpp:820-827, awayteam.cpp:184)', () => {
  it('are delayed by the time spent away', () => {
    const shipTimer: TriggerDef = { id: 's', type: 'timer', context: 'ship', target: 'w.ent', enabled: true, seconds: 10 };
    const idle: TriggerDef = { id: 'idle', type: 'timer', context: 'ship', target: 'w.ent', enabled: true, seconds: 10 };
    const awayTimer: TriggerDef = { id: 'a', type: 'timer', context: 'away', target: 'w.ent', enabled: true, seconds: 10 };
    const { world, content } = build({ triggers: [shipTimer, idle, awayTimer] });
    world.state.triggers.s.due = 500;
    world.state.triggers.a.due = 500;
    world.state.ship.awaySince = 100;
    returnAwayTeam(world.state, content, 400);
    expect(world.state.triggers.s.due).toBe(800);
    // (a timer that isn't running stays so, and the away team's own are left)
    expect(world.state.triggers.idle.due).toBe(0);
    expect(world.state.triggers.a.due).toBe(500);
    expect(world.state.ship.awaySince).toBeNull();
    // (back on the ship twice: nothing more)
    returnAwayTeam(world.state, content, 900);
    expect(world.state.triggers.s.due).toBe(800);
  });
});

describe('bridgeUse and the trigger check after a hail', () => {
  it('runs bridgeUse once on the bridge, as the leader, before the journey moves', async () => {
    const seen: string[] = [];
    const console_: ObjectDef = { id: 'console', name: 'Console', screen: null, on: { use: [{ do: [{ call: { hook: 'saw' } }] }] } };
    const { world } = build({ objects: [console_], triggers: [normal('n')] });
    world.hooks.register('saw', w => { seen.push(w.state.ship.transit === null ? 'idle' : 'moving'); return 0; });
    world.state.ship.bridgeUse = 'console';
    await ticks(world, 1);
    expect(seen).toEqual(['idle']);
    expect(world.state.ship.bridgeUse).toBeNull();
    await ticks(world, 3);
    expect(seen).toHaveLength(1);
  });

  it('is left for the bridge', async () => {
    const console_: ObjectDef = { id: 'console', name: 'Console', screen: null, on: { use: [{ do: [{ call: { hook: 'saw' } }] }] } };
    const { world } = build({ objects: [console_] });
    let n = 0;
    world.hooks.register('saw', () => { n++; return 0; });
    world.state.ship.bridgeUse = 'console';
    world.state.ship.station = 'transporter';
    await ticks(world, 3);
    expect(n).toBe(0);
    world.state.ship.station = 'bridge';
    await ticks(world, 1);
    expect(n).toBe(1);
  });

  it("runs the trigger check after a hail's station change, in the same task (M8)", async () => {
    const { world, events } = build({ triggers: [normal('n')] });
    await hail(world, { conversation: 'hailc', situation: 3, type: 4 });
    await ticks(world, 1);
    expect(world.state.pendingHail).toBeNull();
    expect(fired(events)).toBe(1);
  });
});
