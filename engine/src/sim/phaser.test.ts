// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { Effect, ObjectDef, PhaserDef, RuleGroup } from '../content/types';
import { makeWorld } from '../testing/fixture';
import { damageObject, firePhaser, setPhaserSetting } from './phaser';
import type { HeadlessPresenter } from './presenter';
import { R } from './result';
import { advance, settle } from './settle';
import type { ActionContext, World } from './world';

const mark = (n: string): Effect => ({ call: { hook: 'mark', args: { n } } });

function guard(over: Partial<PhaserDef> = {}, use: RuleGroup[] = []): ObjectDef {
  return {
    id: 'guard', name: 'Guard', screen: 'room', at: 'panel', on: { use },
    phaser: {
      health: 4, threshold: 1, damageFrom: 2, gtpFrom: 3,
      on: { stun: [{ do: [mark('stun')] }], gtp: [{ do: [mark('gtp')] }], kill: [{ do: [mark('kill')] }] },
      ...over,
    },
  };
}
const phaser: ObjectDef = { id: 'phaser', name: 'Phaser', screen: null, inventory: true };
const panel: ObjectDef = { id: 'panel', name: 'Panel', screen: 'room' };

function setup(objects: ObjectDef[] = [guard()]): { w: World; seen: string[] } {
  const w = makeWorld([...objects, phaser, panel], { rules: { items: { phaser: 'phaser' }, lines: {} } });
  const seen: string[] = [];
  w.hooks.register('mark', (_w, _ctx, args) => {
    seen.push(String(args.n));
    return 0;
  });
  return { w, seen };
}

const shotAt = (target: string, who = 'picard'): ActionContext => ({ verb: 'use', target, who, other: 'phaser', walked: false });

async function fire(w: World, setting: number, target = 'guard', actor = 'picard'): Promise<number> {
  w.state.phaserSetting = setting;
  let r = -1;
  void w.enqueue(async () => {
    r = await firePhaser(w, actor, target, shotAt(target, actor));
  });
  await settle(w);
  return r;
}

async function damage(w: World, id: string, amount: number): Promise<void> {
  void w.enqueue(() => damageObject(w, id, amount));
  await settle(w);
}

const log = (w: World) => (w.presenter as HeadlessPresenter).log;

describe('firePhaser', () => {
  it('refuses targets without phaser data, crew, and shooters who are down', async () => {
    const { w } = setup();
    expect(await fire(w, 3, 'panel')).toBe(R.FAILPHASER);
    expect(await fire(w, 3, 'data')).toBe(R.FAILPHASER);
    w.state.phaser.picard.health = 4;
    expect(await fire(w, 3)).toBe(R.FAILPHASER);
    expect(log(w)).toEqual([]);
  });

  it("runs the target's use rules first, and lets them take over", async () => {
    const { w, seen } = setup([guard({}, [{ do: [{ ...mark('use'), stop: true }] }])]);
    const r = await fire(w, 3);
    expect(r & R.STOPPED).toBeTruthy();
    expect(seen).toEqual(['use']);
    expect(log(w)).toEqual([]);
    expect(w.state.phaser.guard.health).toBe(4);
  });

  it('does no damage below the damage setting', async () => {
    const { w, seen } = setup();
    expect(await fire(w, 1)).toBe(R.DIDSOMETHING);
    expect(log(w)).toEqual(['phaser picard -> guard']);
    expect(w.state.phaser.guard.health).toBe(4);
    expect(seen).toEqual([]);
  });

  it('takes setting - damageFrom + 1, stuns once at the threshold, and kills below 0 every time', async () => {
    const { w, seen } = setup();
    await fire(w, 3);
    expect(w.state.phaser.guard.health).toBe(2);
    expect(seen).toEqual(['gtp']);
    w.clock.advanceTo(50);
    await fire(w, 2);
    // (showing the shot takes a tick)
    expect(w.state.phaser.guard).toEqual({ health: 1, stunned: true, regenAt: 51, destroyed: false });
    expect(seen).toEqual(['gtp', 'stun']);
    await fire(w, 2);
    expect(w.state.phaser.guard.health).toBe(0);
    expect(seen).toEqual(['gtp', 'stun']);
    await fire(w, 2);
    await fire(w, 2);
    expect(w.state.phaser.guard.health).toBe(-2);
    expect(seen).toEqual(['gtp', 'stun', 'kill', 'kill']);
  });

  it('runs gtp for every setting up to gtpUpTo, when that is set', async () => {
    const { w, seen } = setup([guard({ gtpUpTo: 1 })]);
    await fire(w, 0);
    await fire(w, 1);
    await fire(w, 3);
    expect(seen).toEqual(['gtp', 'gtp']);
    expect(w.state.phaser.guard.health).toBe(2);
  });

  it("takes FAILOTHER out of the use rules' result", async () => {
    const { w } = setup([guard({}, [{ when: { other: 'tricorder' }, do: [] }])]);
    expect(await fire(w, 1)).toBe(R.DIDSOMETHING);
  });
});

describe('int8 health', () => {
  it('wraps like the original', async () => {
    const { w, seen } = setup();
    w.state.phaser.guard.health = -127;
    await fire(w, 3);
    // (-129 wraps to 127, which is neither dead nor down)
    expect(w.state.phaser.guard.health).toBe(127);
    expect(seen).toEqual(['gtp']);
    w.state.phaser.guard.health = 120;
    await damage(w, 'guard', -10);
    // (130 wraps to -126: down to nothing)
    expect(w.state.phaser.guard.health).toBe(-126);
    expect(seen).toEqual(['gtp', 'kill']);
  });
});

describe('damageObject', () => {
  it('stuns at the threshold, then kills below 1', async () => {
    const { w, seen } = setup();
    await damage(w, 'guard', 3);
    expect(w.state.phaser.guard).toMatchObject({ health: 1, stunned: true });
    await damage(w, 'guard', 1);
    expect(w.state.phaser.guard.health).toBe(0);
    expect(seen).toEqual(['stun', 'kill']);
  });

  it('clamps at -1, and collapses crew without marking them stunned', async () => {
    const { w } = setup();
    const collapsed: string[] = [];
    w.bus.on(e => { if (e.type === 'collapsed') collapsed.push(e.id); });
    w.clock.advanceTo(10);
    await damage(w, 'data', 20);
    expect(w.state.phaser.data).toEqual({ health: -1, stunned: false, regenAt: 10, destroyed: false });
    expect(collapsed).toEqual(['data']);
  });

  it('heals with negative damage, without running anything', async () => {
    const { w, seen } = setup();
    await damage(w, 'guard', -2);
    expect(w.state.phaser.guard.health).toBe(6);
    expect(seen).toEqual([]);
  });

  it("cancels a collapsing member's queued walk", async () => {
    const { w } = setup();
    void w.enqueue(async () => {
      w.walkTo('data', { x: 5, z: 5 });
      await damageObject(w, 'data', 20);
    });
    await settle(w);
    expect(w.obj('data').pos).toEqual({ x: 0, z: 0 });
  });
});

describe('updateHealth', () => {
  it('gets a member back up, a point every 15 seconds', async () => {
    const { w } = setup();
    const recovered: string[] = [];
    w.bus.on(e => { if (e.type === 'recovered') recovered.push(e.id); });
    w.state.phaser.data = { health: 3, stunned: true, regenAt: 0, destroyed: false };
    await advance(w, 15);
    expect(w.state.phaser.data).toEqual({ health: 4, stunned: true, regenAt: 900, destroyed: false });
    await advance(w, 15);
    expect(w.state.phaser.data).toEqual({ health: 5, stunned: false, regenAt: 1800, destroyed: false });
    expect(recovered).toEqual(['data']);
  });

  it('leaves a member at 0 or below down until treated', async () => {
    const { w } = setup();
    w.state.phaser.data = { health: 0, stunned: false, regenAt: 0, destroyed: false };
    await advance(w, 31);
    expect(w.state.phaser.data.health).toBe(0);
  });

  it('gets a recovered member up only once they are on this screen', async () => {
    const { w } = setup();
    w.state.phaser.data = { health: 5, stunned: true, regenAt: 0, destroyed: false };
    w.obj('data').screen = 'hall';
    await advance(w, 1);
    expect(w.state.phaser.data.stunned).toBe(true);
    w.obj('data').screen = 'room';
    await advance(w, 1 / 60);
    expect(w.state.phaser.data.stunned).toBe(false);
  });

  it('moves on from a current member who is down', async () => {
    const { w } = setup();
    w.state.phaser.picard.health = 0;
    await advance(w, 1 / 60);
    expect(w.state.currentActor).toBe('data');
  });

  it("waits behind the tick's trigger actions, as advice does", async () => {
    const trigger = { id: 'go', type: 'normal' as const, context: 'away' as const, target: 'panel', enabled: true };
    const w = makeWorld(
      [guard(), phaser, { ...panel, on: { use: [{ do: [mark('go'), { trigger: { id: 'go', enabled: false } }] }] } }],
      { rules: { items: { phaser: 'phaser' }, lines: {} }, triggers: [trigger] },
    );
    const during: string[] = [];
    w.hooks.register('mark', (world) => {
      during.push(world.state.currentActor);
      return 0;
    });
    w.state.phaser.picard.health = 0;
    await advance(w, 1 / 60);
    expect(during).toEqual(['picard']);
    expect(w.state.currentActor).toBe('data');
  });

  it('never regenerates objects that are not with the team', async () => {
    const { w } = setup();
    w.state.phaser.guard = { health: 1, stunned: true, regenAt: 0, destroyed: false };
    await advance(w, 16);
    expect(w.state.phaser.guard.health).toBe(1);
  });
});

describe('setPhaserSetting', () => {
  it('needs the phaser in the inventory, and a setting from 0 to 3', () => {
    const { w } = setup();
    expect(setPhaserSetting(w, 2)).toBe(true);
    expect(w.state.phaserSetting).toBe(2);
    expect(() => setPhaserSetting(w, 4)).toThrow('phaser setting must be 0 to 3, not 4');
    w.obj('phaser').inventory = false;
    expect(setPhaserSetting(w, 1)).toBe(false);
    expect(w.state.phaserSetting).toBe(2);
  });
});
