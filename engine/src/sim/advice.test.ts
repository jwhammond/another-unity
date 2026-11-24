// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import type { AdviceDef, Effect, GameContent, ObjectDef } from '../content/types';
import { makeGame, makeWorld } from '../testing/fixture';
import { setAdvice } from './advice';
import type { HeadlessPresenter } from './presenter';
import { advance } from './settle';
import type { World } from './world';

const crew = (id: string): ObjectDef => ({ id, name: id, screen: 'room', crew: true });

function world(hint: AdviceDef = { easy: { picard: 'Try the panel.', data: 'I concur.' } }, extra: Partial<GameContent> = {}): World {
  return makeWorld([crew('riker'), crew('troi')], {
    start: { ...makeGame([]).start, awayTeam: ['picard', 'data', 'riker', 'troi'] },
    advice: { hint },
    ...extra,
    conversations: {
      go: { id: 'go', responses: [{ situation: 0, key: 0, state: 'enabled', who: ['$anyone'], results: [[{ do: [{ screen: { to: 'hall', entrance: 'entry' } }] }]] }] },
    },
  });
}

const log = (w: World) => (w.presenter as HeadlessPresenter).log;

describe('setAdvice', () => {
  it('sets the advice and its interval, turns it off, and ignores an empty change', () => {
    const w = world();
    setAdvice(w, { id: 'hint', every: 10 });
    expect(w.state.advice).toEqual({ id: 'hint', every: 10, due: 600 });
    setAdvice(w, {});
    expect(w.state.advice).toEqual({ id: 'hint', every: 10, due: 600 });
    setAdvice(w, { every: 5 });
    expect(w.state.advice).toEqual({ id: 'hint', every: 5, due: 300 });
    setAdvice(w, { off: true });
    expect(w.state.advice).toEqual({ id: null, every: 0, due: 300 });
  });
});

describe('updateAdvice', () => {
  it("offers a random advisor's easy advice every interval, with a full team", async () => {
    const w = world();
    setAdvice(w, { id: 'hint', every: 2 });
    const roll = vi.spyOn(w.rng, 'next').mockReturnValue(1);
    await advance(w, 2);
    expect(roll).toHaveBeenCalledWith(1, 'advisor');
    expect(log(w)).toEqual(['say data: I concur.']);
    await advance(w, 2);
    expect(log(w)).toEqual(['say data: I concur.', 'say data: I concur.']);
  });

  it('stays quiet unless all four are on their feet here', async () => {
    const w = world();
    setAdvice(w, { id: 'hint', every: 2 });
    w.state.phaser.picard.health = 0;
    await advance(w, 3);
    expect(log(w)).toEqual([]);
  });

  it('stays quiet without an interval', async () => {
    const w = world();
    setAdvice(w, { id: 'hint' });
    await advance(w, 3);
    expect(log(w)).toEqual([]);
  });

  it('applies a screen change that the advice asked for', async () => {
    const w = world({ easy: { picard: '@go,0', data: '@go,0' } });
    setAdvice(w, { id: 'hint', every: 1 });
    await advance(w, 1);
    expect(w.state.screen).toBe('hall');
  });

  it("is given on the new screen after a same-tick trigger changed it, before that screen's startup action", async () => {
    const off: Effect = { trigger: { id: 'n', enabled: false } };
    const base = world();
    const w = world(undefined, {
      screens: { ...base.content.screens, hall: { ...base.content.screens.hall, startup: { action: { verb: 'use', target: 'sign' } } } },
      objects: {
        ...base.content.objects,
        door: { id: 'door', name: 'Door', screen: 'room', on: { use: [{ do: [off, { screen: { to: 'hall', entrance: 'entry' } }] }] } },
        sign: { id: 'sign', name: 'Sign', screen: 'hall', on: { use: [{ do: [{ call: { hook: 'startup' } }] }] } },
      },
      triggers: [{ id: 'n', type: 'normal', context: 'away', target: 'door', enabled: true }],
    });
    w.hooks.register('startup', world2 => {
      world2.rng.next(7);
      log(world2).push('startup');
      return 0;
    });
    setAdvice(w, { id: 'hint', every: 1 / 60 });
    const roll = vi.spyOn(w.rng, 'next').mockReturnValue(1);
    await advance(w, 1 / 60);
    expect(w.state.screen).toBe('hall');
    expect(roll.mock.calls).toEqual([[1, 'advisor'], [7]]);
    expect(log(w)).toEqual(['say data: I concur.', 'startup']);
  });

  it('heals after the advice line, not while it is being said', async () => {
    const w = world();
    setAdvice(w, { id: 'hint', every: 1 / 60 });
    vi.spyOn(w.rng, 'next').mockReturnValue(1);
    // (a stunned member back above the threshold gets up in the health update)
    const ps = w.state.phaser.picard;
    ps.stunned = true;
    const stunnedAtSay: boolean[] = [];
    const say = w.presenter.say.bind(w.presenter);
    vi.spyOn(w.presenter, 'say').mockImplementation(async (who, text) => {
      stunnedAtSay.push(ps.stunned);
      await say(who, text);
    });
    await advance(w, 1 / 60);
    expect(stunnedAtSay).toEqual([true]);
    expect(ps.stunned).toBe(false);
  });

  it('rolls after the same-tick trigger action has made its own draws', async () => {
    const off: Effect = { trigger: { id: 'n', enabled: false } };
    const w = world(undefined, {
      objects: {
        ...world().content.objects,
        door: { id: 'door', name: 'Door', screen: 'room', on: { use: [{ do: [off, { call: { hook: 'draw' } }] }] } },
      },
      triggers: [{ id: 'n', type: 'normal', context: 'away', target: 'door', enabled: true }],
    });
    w.hooks.register('draw', world2 => {
      world2.rng.next(5);
      return 0;
    });
    setAdvice(w, { id: 'hint', every: 1 / 60 });
    const roll = vi.spyOn(w.rng, 'next').mockReturnValue(1);
    await advance(w, 1 / 60);
    expect(roll.mock.calls).toEqual([[5], [1, 'advisor']]);
  });
});
