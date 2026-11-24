// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { miniBattle, miniBattleContext } from '../../testing/combat';
import { setView, step, updateBattle, VIEW, VIEW_TIME } from './battle';

describe('updateView (Combat::updateCamera\'s view state, combat.cpp:849-855, 933-939)', () => {
  it('goes back to chasing the Enterprise when a view expires, before the camera is placed', () => {
    const seen: number[][] = [];
    const ctx = miniBattleContext({ updateCamera: (_c, s) => { seen.push([s.view.view, s.view.viewShip!, s.view.viewExpiry, s.view.viewFrame]); } });
    const { b } = miniBattle({ ctx });
    setView(b, 1, VIEW.target);
    expect(b.view.viewExpiry).toBe(10000 + VIEW_TIME);
    updateBattle(ctx, b, 10000 + VIEW_TIME - 1);
    expect([b.view.view, b.view.viewShip]).toEqual([VIEW.target, 1]);
    updateBattle(ctx, b, 10000 + VIEW_TIME + 66);
    expect([b.view.view, b.view.viewShip, b.view.viewExpiry, b.view.viewFrame]).toEqual([VIEW.chase, 0, 0, 1]);
    expect(seen.at(-1)).toEqual([VIEW.chase, 0, 0, 0]);
  });

  it('goes back to chasing the Enterprise when the viewed ship is dead', () => {
    const { ctx, b } = miniBattle();
    setView(b, 1, VIEW.orbit);
    b.ships[1]!.destroyed = true;
    step(ctx, b);
    expect([b.view.view, b.view.viewShip, b.view.viewExpiry]).toEqual([VIEW.chase, 0, 0]);
  });

  it('turns the drop view into tracking, keeping its expiry (combat.cpp:933-939)', () => {
    const { ctx, b } = miniBattle();
    setView(b, 0, 0x11);
    b.now += 66;
    step(ctx, b);
    expect([b.view.view, b.view.viewShip, b.view.viewExpiry, b.view.viewFrame]).toEqual([0x10, 0, 30000, 1]);
  });
});

