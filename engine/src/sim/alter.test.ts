// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { Projection } from '../content/projection';
import { checkRefs } from '../content/refs';
import { effectSchema } from '../content/schema';
import type { AlterFx, ConversationDef, ObjectDef } from '../content/types';
import { DEEP_FLOOR, makeGame, makeWorld } from '../testing/fixture';
import { runEffect } from './effects';
import type { HeadlessPresenter } from './presenter';
import { R } from './result';
import { runList } from './rules';
import { settle } from './settle';
import type { ActionContext, World } from './world';

const panel: ObjectDef = {
  id: 'panel', name: 'Panel', screen: 'room', at: 'panel', timer: 2, talk: 'Hello.',
  descriptions: { data: { text: 'Data sees a panel.' } },
};
const chip: ObjectDef = { id: 'chip', name: 'Chip', screen: null, inventory: true };
const box: ObjectDef = { id: 'box', name: 'Box', screen: 'hall', at: 'entry' };
const chat: ConversationDef = {
  id: 'chat',
  responses: [{ situation: 1, key: 0, state: 'enabled', who: ['$anyone'], text: 'Shall we?', results: [[{ do: [{ call: { hook: 'see' } }] }]] }],
};

function setup(): { w: World; seen: unknown[] } {
  const w = makeWorld([panel, chip, box], { conversations: { chat } });
  const seen: unknown[] = [];
  w.hooks.register('see', world => {
    seen.push(world.obj('panel').state);
    return 0;
  });
  return { w, seen };
}

const ctxOf = (over: Partial<ActionContext> = {}): ActionContext =>
  ({ verb: 'use', target: 'panel', who: 'data', other: null, walked: false, ...over });

async function exec(w: World, a: AlterFx, ctx = ctxOf()): Promise<number> {
  let r = -1;
  void w.enqueue(async () => {
    r = await runEffect(w, { alter: a }, ctx, 'k');
  });
  await settle(w);
  return r;
}

const log = (w: World) => (w.presenter as HeadlessPresenter).log;

describe('alter', () => {
  it('alters whoever is acting for $anyone', async () => {
    const { w } = setup();
    await exec(w, { object: '$anyone', state: 3 });
    expect(w.obj('data').state).toBe(3);
  });

  it('fails, ending the group, when the object does not exist', async () => {
    const { w } = setup();
    let r = -1;
    void w.enqueue(async () => {
      r = await runList(w, [{ do: [{ alter: { object: 'ghost' } }, { alter: { object: 'panel', state: 9 } }] }], ctxOf(), 'k');
    });
    await settle(w);
    expect(r & R.FAILOTHER).toBeTruthy();
    expect(w.obj('panel').state).toBe(0);
  });

  it('moves an object to a marker on its own screen, or the current one', async () => {
    const { w } = setup();
    await exec(w, { object: 'panel', at: 'center' });
    await exec(w, { object: 'box', at: 'entry' });
    await exec(w, { object: 'chip', at: 'center' });
    expect(w.obj('panel').pos).toEqual({ x: 5, z: 5 });
    expect(w.obj('box')).toMatchObject({ screen: 'hall', pos: { x: 1, z: 1 } });
    expect(w.obj('chip').pos).toEqual({ x: 5, z: 5 });
  });

  it('moves an object to a marker only the current screen has, as the original moves to pixels', async () => {
    const { w } = setup();
    await exec(w, { object: 'box', at: 'center' });
    expect(w.obj('box').pos).toEqual({ x: 5, z: 5 });
  });

  it('measures a pixel marker of the current screen on the metric of the screen the object is on', async () => {
    const base = makeGame([box]).screens;
    const hallMetric = { ...DEEP_FLOOR, horizonY: 100, slope: 1.2 };
    const screens = {
      room: { ...base.room, pixelMetric: DEEP_FLOOR, regions: { deck: true } },
      hall: { ...base.hall, pixelMetric: hallMetric },
    };
    const w = makeWorld([box], { screens });
    await exec(w, { object: 'box', at: 'center' });
    // (a pixel is a different place on the other screen)
    const centre = w.marker('room', 'center');
    expect(w.obj('box').pos).not.toEqual(centre);
    const px = new Projection(DEEP_FLOOR).toPixel(centre);
    expect(w.obj('box').pos).toEqual(new Projection(hallMetric).toWorld(Math.round(px.x), Math.round(px.y)));
  });

  it('gets an object into the inventory, active and off the screen, but only once', async () => {
    const { w } = setup();
    w.obj('panel').active = false;
    await exec(w, { object: 'panel', get: true });
    expect(w.obj('panel')).toMatchObject({ inventory: true, active: true, screen: null });
    w.obj('chip').active = false;
    await exec(w, { object: 'chip', get: true });
    expect(w.obj('chip').active).toBe(false);
  });

  it('drops an object onto the current screen, starting its timer', async () => {
    const { w } = setup();
    await exec(w, { object: 'panel', get: true });
    w.clock.advanceTo(30);
    await exec(w, { object: 'panel', drop: true });
    expect(w.obj('panel')).toMatchObject({ inventory: false, screen: 'room', timerDue: 150 });
    await exec(w, { object: 'box', drop: true });
    expect(w.obj('box').screen).toBe('room');
  });

  it('restarts the timer on activating, even when already active', async () => {
    const { w } = setup();
    expect(w.obj('panel').timerDue).toBe(120);
    w.clock.advanceTo(30);
    await exec(w, { object: 'panel', active: true });
    expect(w.obj('panel').timerDue).toBe(150);
  });

  it('deactivates: out of the inventory, timer stopped', async () => {
    const { w } = setup();
    await exec(w, { object: 'chip', active: false });
    await exec(w, { object: 'panel', active: false });
    expect(w.obj('chip')).toMatchObject({ active: false, inventory: false });
    expect(w.obj('panel')).toMatchObject({ active: false, timerDue: 0 });
  });

  it("has the current member talk to the script's object, not the altered one", async () => {
    const { w } = setup();
    await exec(w, { object: 'box', talkTo: true });
    expect(log(w)).toEqual(['say panel: Hello.']);
    await exec(w, { object: 'box', talkTo: true }, ctxOf({ target: null }));
    expect(log(w)).toEqual(['say panel: Hello.']);
  });

  it("drops the object's queued walks when halted", async () => {
    const { w } = setup();
    void w.enqueue(async () => {
      w.walkTo('data', { x: 5, z: 5 });
      await runEffect(w, { alter: { object: 'data', halt: true } }, ctxOf(), 'k');
    });
    await settle(w);
    expect(w.obj('data').pos).toEqual({ x: 0, z: 0 });
  });

  it('sets and clears the stunned flag without putting anyone down', async () => {
    const { w } = setup();
    await exec(w, { object: 'picard', stunned: true });
    expect(w.obj('picard').stunned).toBe(true);
    expect(w.isIncapacitated('picard')).toBe(false);
    await exec(w, { object: 'picard', stunned: false });
    expect(w.obj('picard').stunned).toBe(false);
  });

  it('sets the timer, and 0 stops it', async () => {
    const { w } = setup();
    await exec(w, { object: 'panel', timer: 5 });
    expect(w.obj('panel')).toMatchObject({ timer: 5, timerDue: 300 });
    await exec(w, { object: 'panel', timer: 0 });
    expect(w.obj('panel').timerDue).toBe(0);
  });

  it('plays an animation, waiting only when asked', async () => {
    const { w } = setup();
    await exec(w, { object: 'panel', anim: { play: 3, wait: true } });
    expect(log(w)).toEqual(['anim panel play 3 wait']);
    expect(w.clock.now).toBeGreaterThanOrEqual(30);
  });

  it('keeps the animation an object is on (the original\'s anim_index), which the picture of it follows: a play sets it, a stop clears it, a new sprite leaves it', async () => {
    const { w } = setup();
    expect(w.obj('panel').anim).toBeUndefined();
    await exec(w, { object: 'panel', anim: { play: 1 } });
    expect(w.obj('panel').anim).toBe(1);
    await exec(w, { object: 'panel', anim: { play: 3, wait: true } });
    expect(w.obj('panel').anim).toBe(3);
    await exec(w, { object: 'panel', anim: { sprite: 9 } });
    expect(w.obj('panel').anim).toBe(3);
    await exec(w, { object: 'panel', anim: { stop: true } });
    expect(w.obj('panel').anim).toBe(-1);
  });

  it('sets a new talk string and its voice', async () => {
    const { w } = setup();
    await exec(w, { object: 'panel', talk: '@chat,1', voice: 'v2' });
    expect(w.obj('panel')).toMatchObject({ talk: '@chat,1', talkVoice: 'v2' });
    await exec(w, { object: 'panel', talk: 'Bye.' });
    expect(w.obj('panel')).toMatchObject({ talk: 'Bye.', talkVoice: null });
  });

  it('has an active object say something now', async () => {
    const { w } = setup();
    await exec(w, { object: 'panel', sayNow: '~7' });
    expect(w.state.readings).toEqual([{ world: 'test', group: 7 }]);
    w.obj('panel').active = false;
    await exec(w, { object: 'panel', sayNow: 'Unheard.' });
    expect(log(w)).toEqual(['tricorder 7']);
  });

  it('starts a conversation now, as whoever is acting, before the state changes', async () => {
    const { w, seen } = setup();
    await exec(w, { object: 'panel', converseNow: '@chat,1', state: 4 });
    expect(log(w)).toEqual(['say data: Shall we?']);
    expect(seen).toEqual([0]);
    expect(w.obj('panel').state).toBe(4);
    await exec(w, { object: 'panel', converseNow: '@chat,1' }, ctxOf({ who: 'box' }));
    expect(log(w)).toEqual(['say data: Shall we?', 'say picard: Shall we?']);
  });

  it('describes the object last, for whoever is acting', async () => {
    const { w } = setup();
    await exec(w, { object: 'panel', name: 'Old Panel', describe: true });
    expect(w.obj('panel').name).toBe('Old Panel');
    expect(log(w)).toEqual(['say data: Data sees a panel.']);
  });

  it('sends a move in the universe to the ship', async () => {
    const { w } = setup();
    const effects: unknown[] = [];
    w.bus.on(e => { if (e.type === 'shipEffect') effects.push(e.effect); });
    await exec(w, { object: 'panel', universe: { x: 1, y: 2, z: 3 } });
    expect(effects).toEqual([{ universe: { object: 'panel', x: 1, y: 2, z: 3 } }]);
  });

  it('is checked at load time', () => {
    const user = (a: AlterFx): ObjectDef => ({ id: 'user', name: 'User', screen: 'room', on: { use: [{ do: [{ alter: a }] }] } });
    expect(checkRefs(makeGame([user({ object: '$anyone', state: 1 })]))).toEqual([]);
    expect(checkRefs(makeGame([user({ object: 'user', converseNow: '@nope,1' })])))
      .toEqual(['objects/user: on.use[0].do[0].alter.converseNow: unknown conversation "nope"']);
    expect(effectSchema.safeParse({ alter: { object: 'x', talk: 'a', sayNow: 'b' } }).success).toBe(false);
    expect(effectSchema.safeParse({ alter: { object: 'x', inventory: true } }).success).toBe(false);
    // ("1@…" is converseNow, not sayNow)
    expect(effectSchema.safeParse({ alter: { object: 'x', sayNow: '@chat,1' } }).success).toBe(false);
  });
});
