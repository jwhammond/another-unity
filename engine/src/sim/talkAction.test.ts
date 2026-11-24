// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { GameRules, ObjectDef } from '../content/types';
import { Projection } from '../content/projection';
import { DEEP_FLOOR, DEEP_SCREEN, lineConversation, makeGame, makeWorld } from '../testing/fixture';
import { distance } from './geometry';
import { perform } from './actions';
import type { HeadlessPresenter } from './presenter';
import { R } from './result';
import { flush, settle } from './settle';
import type { World } from './world';

const fail = lineConversation('fail', { 1: 'Nothing to see.', 2: 'No answer.' });
const guard = (talk?: string): ObjectDef => ({
  id: 'guard', name: 'Guard', screen: 'room', at: 'panel', width: 1, talk, description: { text: 'A guard.' },
});

function world(objects: ObjectDef[], rules: Partial<GameRules> = {}): World {
  return makeWorld(objects, {
    conversations: { fail, chat: lineConversation('chat', { 1: 'Can I help?' }) },
    rules: {
      items: {},
      lines: { failLook: { conversation: 'fail', situation: 1 }, failTalk: { conversation: 'fail', situation: 2 } },
      ...rules,
    },
  });
}

const log = (w: World) => (w.presenter as HeadlessPresenter).log;

describe('talk', () => {
  it('answers EMPTYTALK to an object with nothing to say, and the player hears the failure line', async () => {
    const w = world([guard()]);
    let r = -1;
    void w.enqueue(async () => {
      r = await perform(w, { verb: 'talk', target: 'guard', who: 'picard', other: null, walked: false });
    });
    await settle(w);
    expect(r).toBe(R.EMPTYTALK);
    expect(log(w)).toEqual([]);
    void w.act('talk', { target: 'guard', who: 'picard' });
    await settle(w);
    expect(log(w)).toEqual(['say picard: No answer.']);
  });

  it('lets the target say a plain talk string itself', async () => {
    const w = world([guard('Move along.')]);
    void w.act('talk', { target: 'guard', who: 'picard' });
    await settle(w);
    expect(log(w)).toEqual(['say guard: Move along.']);
  });

  it('has the talker start a conversation', async () => {
    const w = world([guard('@chat,1')]);
    void w.act('talk', { target: 'guard', who: 'data' });
    await settle(w);
    expect(log(w)).toEqual(['say data: Can I help?']);
  });

  it('walks up beside the target first when too far away, then talks once', async () => {
    const w = world([guard('@chat,1')], { talkDistance: 3 });
    void w.act('talk', { target: 'guard', who: 'picard' });
    await settle(w);
    expect(log(w)).toEqual(['walk picard -> 9,0', 'say picard: Can I help?']);
    expect(w.obj('picard').pos).toEqual({ x: 9, z: 0 });
  });

  it('does not walk when close enough, or without a talk distance', async () => {
    const near = world([guard('@chat,1')], { talkDistance: 3 });
    near.obj('picard').pos = { x: 8, z: 0 };
    void near.act('talk', { target: 'guard', who: 'picard' });
    await settle(near);
    expect(log(near)).toEqual(['say picard: Can I help?']);

    const anywhere = world([guard('@chat,1')]);
    void anywhere.act('talk', { target: 'guard', who: 'picard' });
    await settle(anywhere);
    expect(log(anywhere)).toEqual(['say picard: Can I help?']);
  });

  it('drops a walk-up when the player gives the same member a new command', async () => {
    const w = world([guard('@chat,1')], { talkDistance: 3 });
    void w.act('talk', { target: 'guard', who: 'picard' });
    void w.act('look', { target: 'guard', who: 'picard' });
    await settle(w);
    expect(log(w)).toEqual(['say picard: A guard.']);
    expect(w.obj('picard').pos).toEqual({ x: 0, z: 0 });
  });

  it('drops a walk-up already under way when the player gives a new command', async () => {
    const w = world([guard('@chat,1')], { talkDistance: 3 });
    void w.act('talk', { target: 'guard', who: 'picard' });
    await flush();
    // (Picard is walking now)
    void w.act('look', { target: 'guard', who: 'picard' });
    await settle(w);
    expect(log(w)).toEqual(['walk picard -> 9,0', 'say picard: A guard.']);
  });

  it('does nothing, and says nothing, without a target', async () => {
    const w = world([]);
    void w.act('talk', { who: 'picard' });
    await settle(w);
    expect(log(w)).toEqual([]);
  });

  it('ignores commands for a member who is down', async () => {
    const w = world([guard('Move along.')]);
    w.state.phaser.picard.health = 4;
    void w.act('talk', { target: 'guard', who: 'picard' });
    await settle(w);
    expect(log(w)).toEqual([]);
  });
});

describe('talk on a screen with a pixel metric', () => {
  const floor = new Projection(DEEP_FLOOR);
  const at = (x: number, y: number) => floor.toWorld(x, y);
  // (the guard stands where ScummVM had Data on s03 at canonical line 32; 30 px wide there, as the lifter converts it)
  function pixelWorld(talker: [number, number], size: Partial<ObjectDef> = { width: floor.distance(30, 245), pixelWidth: 30 }): World {
    const base = makeGame([]);
    const w = makeWorld([{ ...guard('@chat,1'), ...size }], {
      screens: { ...base.screens, room: { ...base.screens.room, markers: { ...base.screens.room.markers, panel: at(596, 245) }, ...DEEP_SCREEN } },
      conversations: { chat: lineConversation('chat', { 1: 'Can I help?' }) },
      rules: { talkDistance: 2.25, items: {}, lines: {} },
    });
    w.obj('picard').pos = at(...talker);
    return w;
  }

  it('talks at once 43 px away, as the original does, though that is further than the talk distance in metres', async () => {
    const w = pixelWorld([559, 223]);
    expect(distance(w.obj('picard').pos, w.obj('guard').pos)).toBeGreaterThan(2.25);
    void w.act('talk', { target: 'guard', who: 'picard' });
    await settle(w);
    expect(log(w)).toEqual(['say picard: Can I help?']);
  });

  it('walks up past 180 px (talkDistance over metersPerPixel): to the side by the width in pixels, two rows lower', async () => {
    const w = pixelWorld([300, 300]);
    void w.act('talk', { target: 'guard', who: 'picard' });
    await settle(w);
    const dest = at(596 - 30, 247);
    expect(log(w)).toEqual([`walk picard -> ${dest.x},${dest.z}`, 'say picard: Can I help?']);
    expect(w.obj('picard').pos).toEqual(dest);
  });

  it('walks up beside a target by its raw pixel width, as the original does, though it has no metric width (canonical line 47)', async () => {
    // (crew have no screen in the export, so only their raw width, 60 px, is lifted)
    const w = pixelWorld([300, 300], { pixelWidth: 60 });
    void w.act('talk', { target: 'guard', who: 'picard' });
    await settle(w);
    const dest = at(596 - 60, 247);
    expect(log(w)[0]).toBe(`walk picard -> ${dest.x},${dest.z}`);
  });

  it('walks up to the target itself with no raw pixel width (the original\'s ~0 width)', async () => {
    const w = pixelWorld([300, 300], { width: floor.distance(30, 245) });
    void w.act('talk', { target: 'guard', who: 'picard' });
    await settle(w);
    const dest = at(596, 247);
    expect(log(w)[0]).toBe(`walk picard -> ${dest.x},${dest.z}`);
  });
});
