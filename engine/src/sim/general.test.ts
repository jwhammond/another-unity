// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { checkRefs } from '../content/refs';
import { effectSchema } from '../content/schema';
import type { CommunicateFx, Effect, ObjectDef, ShipFx, TriggerDef } from '../content/types';
import { lineConversation, makeGame, makeWorld } from '../testing/fixture';
import { runEffect } from './effects';
import { callShip } from './general';
import type { HeadlessPresenter } from './presenter';
import { settle } from './settle';
import type { World } from './world';

const beacon = (talk: string): ObjectDef => ({ id: 'beacon', name: 'Beacon', screen: 'room', talk });
const communicator: ObjectDef = {
  id: 'communicator', name: 'Communicator', screen: null, inventory: true,
  on: { use: [{ do: [{ say: { who: 'picard', text: 'Away team to bridge.' } }] }] },
};
const triggers: TriggerDef[] = [
  { id: 'on', type: 'timer', context: 'away', target: 'beacon', enabled: true, seconds: 5 },
  { id: 'off', type: 'timer', context: 'away', target: 'beacon', enabled: false, seconds: 5 },
  { id: 'normal', type: 'normal', context: 'away', target: 'beacon', enabled: true },
];

function world(talk = '@beacon-chat,3'): World {
  return makeWorld([beacon(talk), communicator], {
    conversations: {
      // (the ship's conversation 12, and the beacon's own conversation 12 in its world)
      hail: { ...lineConversation('hail', { 3: 'Bridge here, go ahead.', 5: 'Hailing.' }), ship: true, number: 12 },
      'beacon-chat': { ...lineConversation('beacon-chat', { 3: 'Beacon here.' }), number: 12 },
      lonely: { ...lineConversation('lonely', { 1: 'Alone.' }), number: 40 },
    },
    rules: { items: { communicator: 'communicator' }, lines: {} },
    triggers,
  });
}

async function exec(w: World, fx: Effect): Promise<number> {
  let r = -1;
  void w.enqueue(async () => {
    r = await runEffect(w, fx, { verb: 'use', target: 'beacon', who: 'data', other: null, walked: false }, 'k');
  });
  await settle(w);
  return r;
}

const hail = (w: World, c: CommunicateFx) => exec(w, { communicate: c });
const log = (w: World) => (w.presenter as HeadlessPresenter).log;

function warnings(w: World): string[] {
  const out: string[] = [];
  w.bus.on(e => { if (e.type === 'warning') out.push(e.message); });
  return out;
}

describe('communicate', () => {
  it('runs a type 6 hail now, as the leader', async () => {
    const w = world();
    expect(await hail(w, { conversation: 'hail', situation: 3, type: 6 })).toBe(0);
    expect(log(w)).toEqual(['say picard: Bridge here, go ahead.']);
    expect(w.state.pendingHail).toBeNull();
  });

  it("takes the numbers from the hailer's talk string, and hails the ship conversation with that number", async () => {
    const w = world();
    await hail(w, { from: 'beacon', type: 6 });
    await hail(w, { from: 'beacon', type: 4 });
    expect(log(w)).toEqual(['say picard: Bridge here, go ahead.']);
    expect(w.state.pendingHail).toEqual({ from: 'beacon', conversation: 'hail', situation: 3, type: 4 });
  });

  it('warns and does nothing when that talk string is not a plain conversation, or has no ship conversation', async () => {
    for (const talk of ['@beacon-chat,?3', '@lonely,1', 'Beep.']) {
      const w = world(talk);
      const seen = warnings(w);
      await hail(w, { from: 'beacon', type: 4 });
      expect(seen).toEqual(['no conversation for a hail from beacon']);
      expect(w.state.pendingHail).toBeNull();
    }
  });

  it("leaves the hail for the bridge, ignoring the hailer's talk string for types 7 and 8", async () => {
    const w = world();
    const hails: unknown[] = [];
    w.bus.on(e => { if (e.type === 'hail') hails.push(e.hail); });
    await hail(w, { from: 'beacon', conversation: 'hail', situation: 5, type: 8 });
    const expected = { from: 'beacon', conversation: 'hail', situation: 5, type: 8 };
    expect(w.state.pendingHail).toEqual(expected);
    expect(hails).toEqual([expected]);
    expect(log(w)).toEqual([]);
  });

  it("announces a copy of the hail, so a listener can't change the pending one", async () => {
    const w = world();
    w.bus.on(e => { if (e.type === 'hail') e.hail.situation = 99; });
    await hail(w, { conversation: 'hail', situation: 5, type: 8 });
    expect(w.state.pendingHail).toEqual({ from: null, conversation: 'hail', situation: 5, type: 8 });
  });

  it('clears the pending hail for type 0xff, and ignores types 0 to 3', async () => {
    const w = world();
    const seen = warnings(w);
    await hail(w, { conversation: 'hail', situation: 5, type: 8 });
    await hail(w, { conversation: 'hail', situation: 5, type: 2 });
    expect(w.state.pendingHail).not.toBeNull();
    expect(seen).toEqual(['unused hail type 2']);
    await hail(w, { type: 0xff });
    expect(w.state.pendingHail).toBeNull();
  });
});

describe('the general commands', () => {
  it('waits', async () => {
    const w = world();
    await exec(w, { wait: { seconds: 2 } });
    expect(w.clock.now).toBe(120);
  });

  it('restarts every enabled timer trigger', async () => {
    const w = world();
    for (const t of Object.values(w.state.triggers)) t.due = 99;
    await exec(w, { restartTimers: true });
    expect(w.state.triggers).toEqual({
      on: { enabled: true, due: 0 }, off: { enabled: false, due: 99 }, normal: { enabled: true, due: 99 },
    });
  });

  it('applies ship commands at once, and announces a copy', async () => {
    const w = world();
    const effects: unknown[] = [];
    w.bus.on(e => { if (e.type === 'shipEffect') effects.push(e.effect); });
    const fx: ShipFx = { universe: { object: 'beacon', x: 1, y: 2, z: 3 } };
    w.bus.on(e => { if (e.type === 'shipEffect' && 'universe' in e.effect) e.effect.universe.x = 50; });
    await exec(w, { ship: { computer: 'record', entry: 4 } });
    await exec(w, { ship: fx });
    expect(effects[0]).toEqual({ computer: 'record', entry: 4 });
    expect(fx).toEqual({ universe: { object: 'beacon', x: 1, y: 2, z: 3 } });
  });
});

describe('callShip', () => {
  it('uses the communicator, but only with the combadge enabled', async () => {
    const w = world();
    w.state.awayFlags.combadge = false;
    expect(callShip(w)).toBe(false);
    w.state.awayFlags.combadge = true;
    expect(callShip(w)).toBe(true);
    await settle(w);
    expect(log(w)).toEqual(['say picard: Away team to bridge.']);
  });

  it('leaves blocked input to the UI, as the original does', async () => {
    const w = world();
    w.state.awayFlags.combadge = true;
    w.state.awayFlags.inputBlocked = true;
    expect(callShip(w)).toBe(true);
    await settle(w);
    expect(log(w)).toEqual(['say picard: Away team to bridge.']);
  });
});

describe('effects', () => {
  it('are checked at load time', () => {
    const user = (fx: Effect) => makeGame([{ id: 'user', name: 'User', screen: 'room', on: { use: [{ do: [fx] }] } }], {
      conversations: { chat: lineConversation('chat', { 1: 'Hello.' }) },
    });
    expect(checkRefs(user({ communicate: { conversation: 'nope', situation: 1, type: 6 } })))
      .toEqual(['objects/user: on.use[0].do[0].communicate.conversation: unknown conversation "nope"']);
    expect(checkRefs(user({ communicate: { conversation: 'chat', situation: 1, type: 6 } })))
      .toEqual(['objects/user: on.use[0].do[0].communicate.conversation: "chat" is not a ship conversation']);
    expect(checkRefs(user({ communicate: { from: 'nobody', type: 6 } })))
      .toEqual(['objects/user: on.use[0].do[0].communicate.from: unknown object "nobody"']);
    expect(effectSchema.safeParse({ communicate: { type: 8 } }).success).toBe(false);
    expect(effectSchema.safeParse({ communicate: { type: 0x12, conversation: 'c', situation: 1 } }).success).toBe(false);
  });

  it('refuse an unknown effect at run time too', async () => {
    const w = world();
    await exec(w, { teleport: {} } as unknown as Effect);
    expect(String(w.errors[0])).toMatch(/unknown effect/);
  });
});
