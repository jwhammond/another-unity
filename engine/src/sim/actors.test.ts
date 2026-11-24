// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { checkRefs } from '../content/refs';
import { makeGame, makeWorld } from '../testing/fixture';
import { settle } from './settle';

describe('script actors (carry note 37)', () => {
  it('lets any object on the screen act for a script, as getWalker does', async () => {
    const w = makeWorld([
      { id: 'guard', name: 'Guard', screen: 'room', at: 'center' },
      {
        id: 'lever', name: 'Lever', screen: 'room', at: 'panel',
        on: {
          use: [{ do: [{ act: { verb: 'look', object: 'lever', who: 'guard' } }] }],
          look: [{ when: { who: 'guard' }, do: [{ alter: { object: 'lever', state: 3 } }] }],
        },
      },
      { id: 'statue', name: 'Statue', screen: 'hall' },
    ]);
    expect(w.walkerIdFor('guard')).toBe('guard');
    expect(w.walkerIdFor('statue')).toBeUndefined();
    void w.act('use', { target: 'lever', who: 'picard' });
    await settle(w);
    expect(w.obj('lever').state).toBe(3);
  });

  it('keeps the crew from walking on a close-up, but not the close-up\'s own objects', () => {
    const w = makeWorld([{ id: 'dial', name: 'Dial', screen: 'room' }]);
    w.state.onCloseup = true;
    expect(w.walkerIdFor('data')).toBeUndefined();
    expect(w.walkerIdFor('dial')).toBe('dial');
  });

  it('accepts any object as a script\'s actor, and still refuses an unknown one', () => {
    const act = (who: string) => makeGame([{ id: 'guard', name: 'Guard', screen: 'room', on: { use: [{ do: [{ act: { verb: 'look', who } }] }] } }]);
    expect(checkRefs(act('guard'))).toEqual([]);
    expect(checkRefs(act('nobody'))).toEqual([expect.stringContaining('act.who: unknown object "nobody"')]);
  });
});
