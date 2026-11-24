// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { ObjectDef } from '../content/types';
import { makeGame, makeWorld } from '../testing/fixture';
import { perform } from './actions';
import { checkCondition } from './conditions';
import type { HeadlessPresenter } from './presenter';
import { settle } from './settle';
import type { World } from './world';

const log = (w: World) => (w.presenter as HeadlessPresenter).log;
const panel: ObjectDef = {
  id: 'panel', name: 'Panel', screen: 'room', at: 'panel',
  on: { use: [{ do: [{ say: { who: 'picard', text: 'Done.' } }] }] },
};

describe('World plumbing', () => {
  it('counts anyone at or below their threshold as down', () => {
    const w = makeWorld([panel]);
    expect(w.isIncapacitated('picard')).toBe(false);
    w.state.phaser.picard.health = 4;
    expect(w.isIncapacitated('picard')).toBe(true);
    expect(w.isActiveAwayTeamMember('picard')).toBe(false);
    // (the stunned flag alone isn't being down, and nothing without phaser data ever is)
    w.state.phaser.picard.health = 10;
    w.obj('picard').stunned = true;
    expect(w.isIncapacitated('picard')).toBe(false);
    expect(w.isIncapacitated('panel')).toBe(false);
    expect(w.isActiveAwayTeamMember('panel')).toBe(false);
  });

  it('selects the next member who can act, in team order', () => {
    const riker: ObjectDef = { id: 'riker', name: 'Riker', screen: 'room', crew: true };
    const w = makeWorld([riker], { start: { ...makeGame([]).start, awayTeam: ['picard', 'data', 'riker'] } });
    w.state.phaser.data.health = 0;
    w.selectNextMember();
    expect(w.state.currentActor).toBe('riker');
    w.obj('picard').screen = 'hall';
    w.selectNextMember();
    expect(w.state.currentActor).toBe('riker');
    w.obj('picard').screen = 'room';
    w.selectNextMember();
    expect(w.state.currentActor).toBe('picard');
  });

  it("drops an actor's queued walk-then-act after a halt", async () => {
    const w = makeWorld([panel]);
    const use = { verb: 'use' as const, target: 'panel', who: 'picard', other: null, walked: false };
    void w.enqueue(async () => {
      w.walkThenAct('picard', { x: 10, z: 0 }, use);
      w.halt('picard');
    });
    await settle(w);
    expect(w.obj('picard').pos).toEqual({ x: 0, z: 0 });
    expect(log(w)).toEqual([]);

    // (halting someone else doesn't)
    void w.enqueue(async () => {
      w.walkThenAct('picard', { x: 10, z: 0 }, use);
      w.halt('data');
    });
    await settle(w);
    expect(log(w)).toEqual(['walk picard -> 10,0', 'say picard: Done.']);
  });

  it('records who acts, and on what, for the outermost action only', async () => {
    const w = makeWorld([
      { id: 'panel', name: 'Panel', screen: 'room', on: { use: [{ do: [{ call: { hook: 'outer' } }] }] } },
      { id: 'box', name: 'Box', screen: 'room', on: { use: [{ do: [{ call: { hook: 'inner' } }] }] } },
    ]);
    const seen: unknown[] = [];
    w.hooks.register('outer', async world => {
      seen.push(world.actionWho, world.talkTarget);
      await perform(world, { verb: 'use', target: 'box', who: 'data', other: null, walked: false });
      return 0;
    });
    w.hooks.register('inner', world => {
      seen.push(world.actionWho, world.talkTarget);
      return 0;
    });
    void w.act('use', { target: 'panel', who: 'picard' });
    await settle(w);
    expect(seen).toEqual(['picard', 'panel', 'picard', 'panel']);
    expect(w.talkTarget).toBeNull();
  });

  it('queues a walk-then-act once per walker, target, verb and who, whatever the other object', async () => {
    const w = makeWorld([panel]);
    const use = (other: string | null) => ({ verb: 'use' as const, target: 'panel', who: 'picard', other, walked: false });
    void w.enqueue(async () => {
      w.walkThenAct('picard', { x: 10, z: 0 }, use('tricorder'));
      w.walkThenAct('picard', { x: 10, z: 0 }, use(null));
    });
    await settle(w);
    expect(log(w)).toEqual(['walk picard -> 10,0', 'say picard: Done.']);
  });

  it('uses a transition at once when nobody here can walk to it', async () => {
    const w = makeWorld([
      { id: 'door', name: 'Door', screen: 'room', at: 'center', transition: 'square' },
      { id: 'square', name: 'Doorway', screen: 'room', at: 'panel', on: { use: [{ do: [{ say: { who: 'data', text: 'Through.' } }] }] } },
    ]);
    w.obj('data').screen = 'hall';
    void w.act('walk', { target: 'door', who: 'data' });
    await settle(w);
    expect(log(w)).toEqual(['say data: Through.']);
    expect(w.obj('data').pos).toEqual({ x: 0, z: 0 });
  });

  it('walks the current member for $none and $anyone', async () => {
    const w = makeWorld([panel]);
    w.state.currentActor = 'data';
    expect(w.walkerIdFor('$none')).toBe('data');
    expect(w.walkerIdFor('$anyone')).toBe('data');
    expect(w.walkerIdFor('panel')).toBe('panel'); // (any object on the screen: getWalker, unity.cpp:876-886)
    void w.enqueue(async () => {
      checkCondition(w, { near: { dist: 1 } }, { verb: 'use', target: 'panel', who: '$none', other: null, walked: false }, 'k');
    });
    await settle(w);
    expect(w.obj('data').pos).toEqual({ x: 9, z: 0 });
  });

  it('applies ship effects and announces them', () => {
    const w = makeWorld([]);
    const events: unknown[] = [];
    w.bus.on(e => { if (e.type === 'shipEffect') events.push(e.effect); });
    w.applyShipEffect({ reveal: 3 });
    expect(events).toEqual([{ reveal: 3 }]);
  });

  it('scripts conversation menus in the headless presenter', async () => {
    const w = makeWorld([]);
    const p = w.presenter as HeadlessPresenter;
    p.pick(1);
    p.pick(null);
    const picked: (number | null)[] = [];
    void w.enqueue(async () => {
      picked.push(await p.menu(['A', 'B']));
      picked.push(await p.menu(['C']));
    });
    await settle(w);
    expect(picked).toEqual([1, null]);
    expect(p.log).toEqual(['menu A | B', 'menu C']);
    await expect(p.menu(['D'])).rejects.toThrow('no scripted pick for menu: D');
  });
});

describe('World halts', () => {
  it('lets the same walk-then-act be queued again right after a halt', async () => {
    const w = makeWorld([panel]);
    const use = { verb: 'use' as const, target: 'panel', who: 'picard', other: null, walked: false };
    void w.enqueue(async () => {
      w.walkThenAct('picard', { x: 10, z: 0 }, use);
      w.halt('picard');
      w.walkThenAct('picard', { x: 10, z: 0 }, use);
    });
    await settle(w);
    expect(log(w)).toEqual(['walk picard -> 10,0', 'say picard: Done.']);
  });

  it('drops a plain walk queued before a halt', async () => {
    const w = makeWorld([panel]);
    void w.enqueue(async () => {
      w.walkTo('picard', { x: 10, z: 0 });
      w.halt('picard');
    });
    await settle(w);
    expect(log(w)).toEqual([]);
    expect(w.obj('picard').pos).toEqual({ x: 0, z: 0 });
  });
});
