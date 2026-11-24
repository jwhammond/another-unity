// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import type { Condition, ObjectDef } from '../content/types';
import { Projection } from '../content/projection';
import { DEEP_FLOOR, DEEP_SCREEN, makeGame, makeWorld } from '../testing/fixture';
import { checkCondition } from './conditions';
import { distance } from './geometry';
import { pixelsOf } from './pixels';
import { R } from './result';
import { settle } from './settle';
import type { ActionContext } from './world';

const panel: ObjectDef = { id: 'panel', name: 'Panel', screen: 'room', at: 'panel' };
const tricorder: ObjectDef = { id: 'tricorder', name: 'Tricorder', screen: null, inventory: true };
const ctx = (over: Partial<ActionContext> = {}): ActionContext =>
  ({ verb: 'use', target: 'panel', who: 'picard', other: null, walked: false, ...over });
const world = () => makeWorld([panel, tricorder]);
const check = (w: ReturnType<typeof world>, cond: Condition, c = ctx()) => checkCondition(w, cond, c, 'k');

describe('checkCondition', () => {
  it('passes an empty condition', () => {
    expect(check(world(), {})).toBe(0);
  });

  it('matches the other object', () => {
    const w = world();
    expect(check(w, { other: 'tricorder' }, ctx({ other: 'tricorder' }))).toBe(R.MATCHOTHER);
    expect(check(w, { other: 'tricorder' })).toBe(R.FAILOTHER);
  });

  it('fails $none when another object was given', () => {
    const w = world();
    expect(check(w, { other: '$none' }, ctx({ other: 'tricorder' }))).toBe(R.FAILOTHER);
    expect(check(w, { other: '$none' })).toBe(0);
  });

  it('fails when the other object does not exist', () => {
    expect(check(world(), {}, ctx({ other: 'ghost' }))).toBe(R.NOTARGET);
  });

  it('starts a walk when the actor is too far away, then re-runs the action in range', async () => {
    const w = world();
    expect(check(w, { near: { dist: 2 } })).toBe(R.WALKING | R.DIDSOMETHING);
    await settle(w);
    expect(w.obj('picard').pos).toEqual({ x: 8, z: 0 });
  });

  it('walks to a marker when one is given', async () => {
    const w = world();
    expect(check(w, { near: { dist: 1, at: 'center' } })).toBe(R.WALKING | R.DIDSOMETHING);
    await settle(w);
    expect(distance(w.obj('picard').pos, { x: 5, z: 5 })).toBeCloseTo(1);
  });

  it('skips the distance check once the actor has walked', () => {
    expect(check(world(), { near: { dist: 2 } }, ctx({ walked: true }))).toBe(0);
  });

  it('treats an inventory target as always close enough', () => {
    expect(check(world(), { near: { dist: 1 } }, ctx({ target: 'tricorder' }))).toBe(0);
  });

  it('fails without a walker on this screen', () => {
    const w = world();
    w.obj('picard').screen = 'hall';
    expect(check(w, { near: { dist: 1 } })).toBe(R.NOTARGET | R.WALKING);
  });

  it('checks who is acting', () => {
    const w = world();
    expect(check(w, { who: 'data' })).toBe(R.AWAYTEAM);
    expect(check(w, { who: 'data' }, ctx({ who: 'data' }))).toBe(0);
  });

  it('passes a skill check without rolling when skills are high enough', () => {
    const w = world();
    const roll = vi.spyOn(w.rng, 'next');
    expect(check(w, { skill: 0x5555 })).toBe(0);
    expect(roll).not.toHaveBeenCalled();
  });

  it('rolls for each short digit, like the original', () => {
    // need '7' against '5': a difference of 2, which fails for rolls 64..191
    const w = world();
    const roll = vi.spyOn(w.rng, 'next');
    roll.mockReturnValue(100);
    expect(check(w, { skill: 0x7555 })).toBe(R.FAILSKILL);
    roll.mockReturnValue(0);
    expect(check(w, { skill: 0x7555 })).toBe(0);
    roll.mockReturnValue(255);
    expect(check(w, { skill: 0x7555 })).toBe(0);
    expect(roll).toHaveBeenCalledWith(255, 'skill');
  });

  it('do-when fails until its counter runs out, passes once, then wraps like a uint16', () => {
    const w = world();
    const cond: Condition = { counter: { mode: 'when', value: 2 } };
    expect([1, 2, 3, 4].map(() => check(w, cond)))
      .toEqual([R.COUNTER_DOWHEN, R.COUNTER_DOWHEN, 0, R.COUNTER_DOWHEN]);
    expect(w.state.counters.k).toBe(0xfffe);
  });

  it('do-until passes until its counter runs out', () => {
    const w = world();
    const cond: Condition = { counter: { mode: 'until', value: 2 } };
    expect([1, 2, 3].map(() => check(w, cond))).toEqual([0, 0, R.COUNTER_DOUNTIL]);
    expect(w.state.counters.k).toBe(0);
  });

  it('checks object state', () => {
    const w = world();
    expect(check(w, { checks: [{ object: 'panel', state: 1 }] })).toBe(R.FAILSTATE);
    w.obj('panel').state = 1;
    expect(check(w, { checks: [{ object: 'panel', state: 1 }] })).toBe(0);
  });

  it('fails on an inactive object unless a state is checked', () => {
    const w = world();
    w.obj('panel').active = false;
    expect(check(w, { checks: [{ object: 'panel' }] })).toBe(R.INACTIVE);
    expect(check(w, { checks: [{ object: 'panel', state: 0 }] })).toBe(0);
  });

  it('passes at once on an inactive object marked passIfInactive', () => {
    const w = world();
    w.obj('panel').active = false;
    expect(check(w, { checks: [{ object: 'panel', passIfInactive: true }, { object: 'panel', state: 9 }] })).toBe(0);
  });

  it('fails passIfInactive on an active object with FAILSCREEN', () => {
    expect(check(world(), { checks: [{ object: 'panel', passIfInactive: true }] })).toBe(R.FAILSCREEN);
  });

  it('checks status, position and screen before failing passIfInactive on an active object', () => {
    const w = world();
    expect(check(w, { checks: [{ object: 'tricorder', passIfInactive: true, status: 'notInInventory' }] })).toBe(R.INVENTORY);
    expect(check(w, { checks: [{ object: 'panel', passIfInactive: true, at: 'center' }] })).toBe(R.FAILPOS);
    expect(check(w, { checks: [{ object: 'panel', passIfInactive: true, screen: 'hall' }] })).toBe(R.FAILSCREEN);
  });

  it('fails on a crew member who is down, including $anyone', () => {
    const w = world();
    w.state.phaser.picard.health = 4;
    expect(check(w, { checks: [{ object: 'picard' }] })).toBe(R.STUNNED);
    expect(check(w, { checks: [{ object: '$anyone' }] })).toBe(R.STUNNED);
    // (the stunned flag that alter sets isn't being down)
    w.state.phaser.picard.health = 5;
    w.obj('picard').stunned = true;
    expect(check(w, { checks: [{ object: 'picard' }] })).toBe(0);
  });

  it('checks away team membership', () => {
    const w = world();
    expect(check(w, { checks: [{ object: 'data', status: 'inTeam' }] })).toBe(0);
    w.state.awayTeam = ['picard'];
    expect(check(w, { checks: [{ object: 'data', status: 'inTeam' }] })).toBe(R.AWAYTEAM);
  });

  it('fails inTeam for a team member on another screen', () => {
    const w = world();
    w.obj('data').screen = 'hall';
    expect(check(w, { checks: [{ object: 'data', status: 'inTeam' }] })).toBe(R.AWAYTEAM);
  });

  it('checks the inventory', () => {
    const w = world();
    expect(check(w, { checks: [{ object: 'tricorder', status: 'inInventory' }] })).toBe(0);
    expect(check(w, { checks: [{ object: 'tricorder', status: 'notInInventory' }] })).toBe(R.INVENTORY);
  });

  it('checks position and screen', () => {
    const w = world();
    expect(check(w, { checks: [{ object: 'panel', at: 'panel' }] })).toBe(0);
    expect(check(w, { checks: [{ object: 'panel', at: 'center' }] })).toBe(R.FAILPOS);
    expect(check(w, { checks: [{ object: 'panel', screen: 'hall' }] })).toBe(R.FAILSCREEN);
  });

  it('checks that a spot is empty', () => {
    const w = world();
    expect(check(w, { checks: [{ emptyAt: 'door' }] })).toBe(R.FAILPOS);
    expect(check(w, { checks: [{ emptyAt: 'center' }] })).toBe(0);
  });

  it('keeps MATCHOTHER on a later failure', () => {
    expect(check(world(), { other: 'tricorder', who: 'data' }, ctx({ other: 'tricorder' })))
      .toBe(R.MATCHOTHER | R.AWAYTEAM);
  });

  it('fails a position check, rather than the game, when the marker isn\'t on the object\'s screen (carry note 34)', () => {
    const w = world();
    w.obj('panel').screen = 'hall';
    expect(check(w, { checks: [{ object: 'panel', at: 'panel' }] })).toBe(R.FAILPOS);
  });
});

describe('checkCondition near, on a screen with a pixel metric', () => {
  const floor = new Projection(DEEP_FLOOR);
  const at = (x: number, y: number) => floor.toWorld(x, y);
  // a near distance of 40 px, lifted at the panel's row as the lifter does
  const near = { dist: floor.distance(40, 245) };
  function pixelWorld(walker: [number, number]) {
    const base = makeGame([]);
    const w = makeWorld([panel, tricorder], {
      screens: { ...base.screens, room: { ...base.screens.room, markers: { ...base.screens.room.markers, panel: at(596, 245), center: at(400, 300) }, ...DEEP_SCREEN } },
    });
    w.obj('picard').pos = at(...walker);
    return w;
  }

  it('passes 30 rows away, within 40 px, though that is many times the distance in metres', () => {
    const w = pixelWorld([596, 215]);
    expect(distance(w.obj('picard').pos, w.obj('panel').pos)).toBeGreaterThan(4 * near.dist);
    expect(check(w, { near })).toBe(0);
  });

  it('walks when more than the pixel distance away, measured across rows and columns', () => {
    expect(check(pixelWorld([596 - 33, 245 - 33]), { near })).toBe(R.WALKING | R.DIDSOMETHING);
    expect(check(pixelWorld([596 - 28, 245 - 28]), { near })).toBe(0);
  });

  it('measures a target that has moved to another row in the original\'s own pixels (px), not in the metres lifted at its first row', () => {
    // 200 px lifted at a front row; the panel now stands on a back row, where those metres are fewer pixels
    const lifted = { dist: floor.distance(200, 380), px: 200 };
    expect(pixelsOf(floor, lifted.dist, 245)).toBeLessThan(190);
    const w = pixelWorld([596 - 190, 245]);
    expect(check(w, { near: { dist: lifted.dist } })).toBe(R.WALKING | R.DIDSOMETHING);
    expect(check(w, { near: lifted })).toBe(0);
    expect(check(pixelWorld([596 - 210, 245]), { near: lifted })).toBe(R.WALKING | R.DIDSOMETHING);
  });

  it('passes where it stands when findPath finds no walk at all, as walkToThenAct fails at once', () => {
    const base = makeGame([]);
    const w = makeWorld([panel, tricorder], {
      screens: { ...base.screens, room: { ...base.screens.room, markers: { ...base.screens.room.markers, panel: at(596, 245) }, pixelMetric: { ...DEEP_FLOOR, floor: [] }, regions: {} } },
    });
    w.obj('picard').pos = at(100, 300);
    expect(check(w, { near })).toBe(0);
  });

  it('measures from a marker in pixels too, converting its distance at the marker\'s row', () => {
    const atCenter = { dist: floor.distance(20, 300), at: 'center' };
    expect(check(pixelWorld([400, 315]), { near: atCenter })).toBe(0);
    expect(check(pixelWorld([400, 325]), { near: atCenter })).toBe(R.WALKING | R.DIDSOMETHING);
  });
});
