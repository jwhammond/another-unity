// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { checkRefs } from '../content/refs';
import { effectSchema } from '../content/schema';
import type { Effect, GameContent, ObjectDef, ScreenDef } from '../content/types';
import { Projection } from '../content/projection';
import { DEEP_FLOOR, DEEP_SCREEN, makeGame, makeWorld } from '../testing/fixture';
import { runEffect } from './effects';
import type { HeadlessPresenter } from './presenter';
import { advance, settle } from './settle';
import type { World } from './world';

const sign: ObjectDef = { id: 'sign', name: 'Sign', screen: 'hall', description: { text: 'A sign.' } };
const alarm: ObjectDef = { id: 'alarm', name: 'Alarm', screen: 'room', timer: 1, on: { timer: [{ do: [{ say: { who: 'data', text: 'Beep.' } }] }] } };
const lever = (fx: Effect): ObjectDef => ({ id: 'lever', name: 'Lever', screen: 'room', on: { use: [{ do: [fx] }] } });

function world(objects: ObjectDef[] = [], hall: Partial<ScreenDef> = {}, extra: Partial<GameContent> = {}): World {
  const base = makeGame([]);
  return makeWorld([sign, ...objects], {
    screens: { ...base.screens, hall: { ...base.screens.hall, ...hall } },
    rules: { stepIn: 2, items: {}, lines: {} },
    advice: { tip: { easy: { picard: 'Look up.' } } },
    ...extra,
  });
}

async function exec(w: World, fx: Effect): Promise<number> {
  let r = -1;
  void w.enqueue(async () => {
    r = await runEffect(w, fx, { verb: 'use', target: 'lever', who: 'picard', other: null, walked: false }, 'k');
  });
  await settle(w);
  return r;
}

function change(w: World, to: string, entrance = 'entry'): void {
  w.state.pendingScreen = { to, entrance };
  w.applyScreenChange();
}

// (30 px at full scale)
const pixelRules: Partial<GameContent> = { rules: { stepIn: 0.375, items: {}, lines: {} } };

const log = (w: World) => (w.presenter as HeadlessPresenter).log;

describe('screen changes', () => {
  it('gathers the team first, then changes screen once the action is done', async () => {
    const w = world([lever({ screen: { to: 'hall', entrance: 'entry', gather: true } })]);
    const gathered: string[] = [];
    w.bus.on(e => { if (e.type === 'gathered') gathered.push(e.actor); });
    void w.act('use', { target: 'lever', who: 'picard' });
    await settle(w);
    expect(gathered).toEqual(['picard']);
    expect(w.clock.now).toBeGreaterThanOrEqual(20);
    expect(w.state.screen).toBe('hall');
  });

  it('steps arriving members in from the entrance, in a random direction', async () => {
    const w = world([lever({ screen: { to: 'hall', entrance: 'entry', stepIn: true } })]);
    const roll = vi.spyOn(w.rng, 'next').mockReturnValue(2);
    void w.act('use', { target: 'lever', who: 'picard' });
    await settle(w);
    expect(roll).toHaveBeenCalledTimes(4);
    expect(roll).toHaveBeenCalledWith(2, 'stepInX');
    expect(w.obj('picard').pos).toEqual({ x: 3, z: 3 });
    expect(w.obj('data').pos).toEqual({ x: 3, z: 3 });
  });

  it('steps members in crew id order, x before z, whatever the team order', async () => {
    const base = makeGame([]);
    const w = makeWorld([lever({ screen: { to: 'hall', entrance: 'entry', stepIn: true } })], {
      start: { ...base.start, awayTeam: ['data', 'picard'] },
      rules: { stepIn: 2, items: {}, lines: {} },
    });
    const rolls = [0, 2, 1, 0];
    vi.spyOn(w.rng, 'next').mockImplementation(() => rolls.shift() ?? 0);
    void w.act('use', { target: 'lever', who: 'data' });
    await settle(w);
    // from the entry at (1, 1), stepping 2: picard is first in the content (x 0 -> -1, z 2 -> +1), then data (x 1 -> 0, z 0 -> -1)
    expect(w.obj('picard').pos).toEqual({ x: -1, z: 3 });
    expect(w.obj('data').pos).toEqual({ x: 1, z: -1 });
  });

  it('steps in by pixels on a screen with a pixel metric: scaleAt(row) * 30 / 256, in rows as in columns', async () => {
    const floor = new Projection(DEEP_FLOOR);
    const w = world([lever({ screen: { to: 'hall', entrance: 'entry', stepIn: true } })], { markers: { entry: floor.toWorld(559, 230) }, ...DEEP_SCREEN }, pixelRules);
    // picard: x roll 1 (stays), y roll 0 (up); data: x roll 2 (right), y roll 1 (stays)
    const rolls = [1, 0, 2, 1];
    vi.spyOn(w.rng, 'next').mockImplementation(() => rolls.shift() ?? 0);
    void w.act('use', { target: 'lever', who: 'picard' });
    await settle(w);
    // the fitted scale at row 230 is 92.59, so 93: a step of 93 * 30 / 256 = 10 px (truncated, as the original's int)
    expect(w.obj('picard').pos).toEqual(floor.toWorld(559, 220));
    expect(w.obj('data').pos).toEqual(floor.toWorld(569, 230));
  });

  it('clips a pixel step-in to the screen, as the original does', async () => {
    const floor = new Projection(DEEP_FLOOR);
    const w = world([lever({ screen: { to: 'hall', entrance: 'entry', stepIn: true } })], { markers: { entry: floor.toWorld(635, 398) }, ...DEEP_SCREEN }, pixelRules);
    vi.spyOn(w.rng, 'next').mockReturnValue(2);
    void w.act('use', { target: 'lever', who: 'picard' });
    await settle(w);
    expect(w.obj('picard').pos).toEqual(floor.toWorld(639, 399));
  });

  it('leaves anyone down where they fell, and moves on from them', () => {
    const w = world();
    w.state.currentActor = 'data';
    w.state.phaser.data.health = 0;
    change(w, 'hall');
    expect(w.obj('data').screen).toBe('room');
    expect(w.obj('picard')).toMatchObject({ screen: 'hall', pos: { x: 1, z: 1 } });
    expect(w.state.currentActor).toBe('picard');
  });

  it('takes everyone along to a screen in another world', () => {
    const w = world([], { world: 'moon' });
    w.state.phaser.data.health = 0;
    change(w, 'hall');
    expect(w.obj('data').screen).toBe('hall');
  });

  it('goes back to the ship, and the away mission stops', async () => {
    const w = world([alarm]);
    const left: unknown[] = [];
    w.bus.on(e => { if (e.type === 'leftAwayMission') left.push(e.gameOver); });
    await exec(w, { screen: { to: '$ship', gameOver: 3 } });
    w.applyScreenChange();
    expect(w.state.onShip).toEqual({ gameOver: 3 });
    expect(w.state.awayFlags).toEqual({ inputBlocked: false, combadge: true });
    expect(left).toEqual([3]);
    await advance(w, 3);
    expect(log(w)).toEqual([]);
  });

  it('drops every queued walk', async () => {
    const w = world();
    void w.enqueue(async () => {
      w.walkTo('data', { x: 5, z: 5 });
      change(w, 'hall');
    });
    await settle(w);
    expect(w.obj('data').pos).toEqual({ x: 1, z: 1 });
  });

  it('puts crew who are not with the team nowhere', () => {
    const w = world([{ id: 'riker', name: 'Riker', screen: 'hall', crew: true }]);
    change(w, 'hall');
    expect(w.obj('riker').screen).toBeNull();
  });
});

describe('screen startups', () => {
  it('drops a startup action when the screen changes again before it runs', async () => {
    const w = world([], { startup: { action: { verb: 'look', target: 'sign' } } });
    void w.enqueue(async () => {
      change(w, 'hall');
      change(w, 'room', 'door');
    });
    await settle(w);
    expect(log(w)).toEqual([]);
  });

  it("applies the new screen's flags, advice and action", async () => {
    const w = world([], {
      startup: { combadge: true, inputBlocked: true, advice: { id: 'tip', every: 5 }, action: { verb: 'look', target: 'sign', who: '$anyone' } },
    });
    w.clock.advanceTo(10);
    change(w, 'hall');
    await settle(w);
    expect(w.state.awayFlags).toEqual({ inputBlocked: true, combadge: true });
    expect(w.state.advice).toEqual({ id: 'tip', every: 5, due: 310 });
    expect(log(w)).toEqual(['say picard: A sign.']);
  });

  it('runs a startup action by nobody ($none) as nobody, with the current member speaking for it', async () => {
    // (startAwayTeam keeps the startup's ffffff as the actor, awayteam.cpp:334-336; the trace logs it so)
    const w = world([], { startup: { action: { verb: 'look', target: 'sign', who: '$none' } } });
    const started: unknown[] = [];
    w.bus.on(e => { if (e.type === 'actionStarted') started.push(e.who); });
    change(w, 'hall');
    await settle(w);
    expect(started).toEqual(['$none']);
    expect(log(w)).toEqual(['say picard: A sign.']);
  });

  it('keeps the team off a close-up, and skips the startup action after one', async () => {
    const w = world([], { startup: { closeup: true } });
    w.state.startups.room.action = { verb: 'look', target: 'sign' };
    change(w, 'hall');
    expect(w.state.onCloseup).toBe(true);
    expect(w.obj('picard')).toMatchObject({ screen: 'hall', pos: { x: 0, z: 0 } });
    expect(w.walkerFor('picard')).toBeUndefined();
    change(w, 'room', 'door');
    await settle(w);
    expect(w.state.onCloseup).toBe(false);
    expect(log(w)).toEqual([]);
  });

  it('acts at once on a close-up without a floor: no one walks, and no one is placed (M3 Decision 8)', async () => {
    const button: ObjectDef = { id: 'button', name: 'Button', screen: 'hall', on: { use: [{ do: [{ say: { who: 'data', text: '-Click-' } }] }] } };
    const w = world([button], { startup: { closeup: true }, pixelMetric: { ...DEEP_FLOOR, floor: [] }, regions: {} });
    w.jump('hall', 'entry');
    void w.act('use', { target: 'button', who: 'picard' });
    await settle(w);
    expect(w.state.onCloseup).toBe(true);
    expect(log(w)).toEqual(['say data: -Click-']);
  });

  it('applies the first screen when a new game starts', async () => {
    const base = makeGame([]);
    const w = makeWorld([sign], {
      screens: { ...base.screens, room: { ...base.screens.room, startup: { combadge: true, action: { verb: 'look', target: 'sign' } } } },
    });
    await settle(w);
    expect(w.state.awayFlags.combadge).toBe(true);
    expect(log(w)).toEqual(['say picard: A sign.']);
  });
});

describe('advice, startup and awayFlags effects', () => {
  it('set advice now; an interval alone does nothing', async () => {
    const w = world();
    await exec(w, { advice: { every: 9 } });
    expect(w.state.advice).toEqual({ id: null, every: 0, due: 0 });
    await exec(w, { advice: { id: 'tip', every: 9 } });
    expect(w.state.advice).toEqual({ id: 'tip', every: 9, due: 540 });
    await exec(w, { advice: { off: true } });
    expect(w.state.advice.id).toBeNull();
  });

  it('an advice id alone keeps the interval', async () => {
    const w = world();
    await exec(w, { advice: { id: 'tip', every: 9 } });
    await exec(w, { advice: { id: 'tip' } });
    expect(w.state.advice).toEqual({ id: 'tip', every: 9, due: 540 });
  });

  it("change a screen's advice for its next visit", async () => {
    const w = world([], { startup: { advice: { id: 'tip', every: 5 } } });
    await exec(w, { advice: { screen: 'hall', every: 7 } });
    expect(w.state.startups.hall.advice).toEqual({ every: 7 });
    await exec(w, { advice: { screen: 'hall', id: 'tip' } });
    expect(w.state.startups.hall.advice).toEqual({ id: 'tip', every: 7 });
  });

  it("replace a screen's startup action", async () => {
    const w = world();
    await exec(w, { startup: { screen: 'hall', action: { verb: 'look', target: 'sign' } } });
    expect(w.state.startups.hall.action).toEqual({ verb: 'look', target: 'sign' });
    await exec(w, { startup: { screen: 'hall', action: null } });
    expect(w.state.startups.hall.action).toBeNull();
  });

  it('set the flags now, or for a screen', async () => {
    const w = world();
    await exec(w, { awayFlags: { combadge: true, closeup: true } });
    expect(w.state.awayFlags).toEqual({ inputBlocked: false, combadge: true });
    expect(w.state.onCloseup).toBe(false);
    await exec(w, { awayFlags: { screen: 'hall', closeup: true, inputBlocked: true } });
    expect(w.state.startups.hall).toMatchObject({ closeup: true, inputBlocked: true, combadge: null });
  });

  it('are checked at load time', () => {
    const user = (fx: Effect) => makeGame([sign, { id: 'user', name: 'User', screen: 'room', on: { use: [{ do: [fx] }] } }]);
    expect(checkRefs(user({ screen: { to: '$ship' } }))).toEqual([]);
    expect(effectSchema.safeParse({ screen: { to: 'hall' } }).success).toBe(false);
    expect(checkRefs(user({ advice: { id: 'nope' } }))).toEqual(['objects/user: on.use[0].do[0].advice.id: unknown advice "nope"']);
    expect(checkRefs(user({ startup: { screen: 'hall', action: { verb: 'use', target: 'nothing' } } })))
      .toEqual(['objects/user: on.use[0].do[0].startup.action.target: unknown object "nothing"']);
    expect(checkRefs(user({ awayFlags: { screen: 'moon' } }))).toEqual(['objects/user: on.use[0].do[0].awayFlags.screen: unknown screen "moon"']);
  });
});

describe('the current screen ($current, M3 Decision 2)', () => {
  const warningsOf = (w: World) => {
    const seen: string[] = [];
    w.bus.on(e => { if (e.type === 'warning') seen.push(e.message); });
    return seen;
  };
  const base = makeGame([]);
  const roomWith0 = { ...base.screens.room, markers: { ...base.screens.room.markers, entrance_0: { x: 3, z: 3 } } };

  it('enters the screen the team is on again, at the entrance it names', async () => {
    const w = world([lever({ screen: { to: '$current', entrance: 'center' } })]);
    void w.act('use', { target: 'lever', who: 'picard' });
    await settle(w);
    expect(w.state.screen).toBe('room');
    expect(w.obj('picard').pos).toEqual({ x: 5, z: 5 });
    expect(w.state.pendingScreen).toBeNull();
  });

  it('keeps a screen change already asked for (requestScreenChange with screen 0xff)', async () => {
    const both: ObjectDef = { id: 'lever', name: 'Lever', screen: 'room', on: { use: [{ do: [
      { screen: { to: 'hall', entrance: 'entry' } }, { screen: { to: '$current', entrance: 'entry' } },
    ] }] } };
    const w = world([both]);
    void w.act('use', { target: 'lever', who: 'picard' });
    await settle(w);
    expect(w.state.screen).toBe('hall');
  });

  it('uses entrance 0 for an entrance the screen lacks, as placeAwayTeam does', async () => {
    const w = makeWorld([lever({ screen: { to: '$current', entrance: 'entrance_7' } })], { screens: { ...base.screens, room: roomWith0 } });
    const seen = warningsOf(w);
    void w.act('use', { target: 'lever', who: 'picard' });
    await settle(w);
    expect(seen).toEqual(["entrance_7 isn't on room: entrance_0 instead (placeAwayTeam)"]);
    expect(w.obj('picard').pos).toEqual({ x: 3, z: 3 });
  });

  it('does nothing, and says so, without entrance 0 either, or from the ship', async () => {
    const w = world();
    const seen = warningsOf(w);
    expect(await exec(w, { screen: { to: '$current', entrance: 'entrance_7' } })).toBe(0);
    w.state.onShip = { gameOver: null };
    expect(await exec(w, { screen: { to: '$current', entrance: 'door' } })).toBe(0);
    expect(w.state.pendingScreen).toBeNull();
    expect(seen).toEqual([
      'room has neither entrance_7 nor entrance_0: the change to the current screen does nothing',
      'a change to the current screen ($current) from the ship does nothing',
    ]);
  });

  it('keeps a change to the ship already asked for, and its game over', async () => {
    const both: ObjectDef = { id: 'lever', name: 'Lever', screen: 'room', on: { use: [{ do: [
      { screen: { to: '$ship', gameOver: 5 } }, { screen: { to: '$current', entrance: 'door' } },
    ] }] } };
    const w = world([both]);
    const seen = warningsOf(w);
    void w.act('use', { target: 'lever', who: 'picard' });
    await settle(w);
    expect(seen).toEqual(['a change to the current screen ($current) while a change to the ship is pending does nothing']);
    expect(w.state.onShip).toEqual({ gameOver: 5 });
    const w2 = world();
    await exec(w2, { screen: { to: '$ship', gameOver: 5 } });
    await exec(w2, { screen: { to: '$current', entrance: 'door' } });
    expect(w2.state.pendingScreen).toEqual({ to: '$ship', entrance: '', gameOver: 5 });
  });
});
