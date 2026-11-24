// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { checkRefs } from '../content/refs';
import type { Effect, ObjectDef, ReactFx } from '../content/types';
import { makeGame, makeWorld } from '../testing/fixture';
import { runEffect } from './effects';
import type { HeadlessPresenter } from './presenter';
import { settle } from './settle';
import type { ActionContext, World } from './world';

const mark = (n: string): Effect => ({ call: { hook: 'mark', args: { n } } });
const guard: ObjectDef = {
  id: 'guard', name: 'Guard', screen: 'room', at: 'panel',
  phaser: { health: 4, threshold: 2, damageFrom: 1, gtpFrom: 4, on: { stun: [{ do: [mark('stun')] }], kill: [{ do: [mark('kill')] }] } },
};
const drone: ObjectDef = {
  id: 'drone', name: 'Drone', screen: 'room',
  phaser: { health: 4, threshold: 1, damageFrom: 1, gtpFrom: 4, on: { stun: [{ do: [mark('drone stun')] }], kill: [{ do: [mark('drone kill')] }] } },
};
const riker: ObjectDef = { id: 'riker', name: 'Riker', screen: null, crew: true };
const cargo: ObjectDef = { id: 'cargo', name: 'Cargo', screen: 'hall', timer: 1 };

function setup(): { w: World; seen: string[] } {
  const w = makeWorld([guard, drone, riker, cargo]);
  const seen: string[] = [];
  w.hooks.register('mark', (_w, _ctx, args) => {
    seen.push(String(args.n));
    return 0;
  });
  return { w, seen };
}

const ctxOf = (over: Partial<ActionContext> = {}): ActionContext =>
  ({ verb: 'use', target: 'guard', who: 'data', other: null, walked: false, ...over });

async function exec(w: World, fx: Effect, ctx = ctxOf()): Promise<number> {
  let r = -1;
  void w.enqueue(async () => {
    r = await runEffect(w, fx, ctx, 'k');
  });
  await settle(w);
  return r;
}

const react = (w: World, r: ReactFx, ctx = ctxOf()) => exec(w, { react: r }, ctx);
const log = (w: World) => (w.presenter as HeadlessPresenter).log;

describe('react', () => {
  it('targets whoever is acting, or the team here including anyone down', async () => {
    const { w } = setup();
    expect(await react(w, { who: 'actor', do: { damage: 1 } })).toBe(0);
    expect(w.state.phaser.data.health).toBe(9);
    w.state.phaser.data.health = 3;
    await react(w, { who: 'team', do: { damage: 1 } });
    expect(w.state.phaser.picard.health).toBe(9);
    expect(w.state.phaser.data.health).toBe(2);
  });

  it('targets one active member at random', async () => {
    const { w } = setup();
    const roll = vi.spyOn(w.rng, 'next').mockReturnValue(1);
    await react(w, { who: 'random', do: { damage: 1 } });
    expect(roll).toHaveBeenCalledWith(1, 'reactMember');
    expect(w.state.phaser.data.health).toBe(9);
    w.state.phaser.picard.health = 0;
    roll.mockReturnValue(0);
    await react(w, { who: 'random', do: { damage: 1 } });
    expect(roll).toHaveBeenLastCalledWith(0, 'reactMember');
    expect(w.state.phaser.data.health).toBe(8);
  });

  it('brings an object from elsewhere to this screen', async () => {
    const { w } = setup();
    await react(w, { who: { object: 'cargo' }, do: { damage: 1 } });
    expect(w.obj('cargo')).toMatchObject({ screen: 'room', timerDue: 60 });
  });

  it('leaves an object where it is once its sprite is loaded, which entering its screen does', async () => {
    const { w } = setup();
    expect(w.state.spritesLoaded).not.toContain('cargo');
    w.state.pendingScreen = { to: 'hall', entrance: 'entry' };
    w.applyScreenChange();
    expect(w.state.spritesLoaded).toContain('cargo');
    w.state.pendingScreen = { to: 'room', entrance: 'door' };
    w.applyScreenChange();
    await react(w, { who: { object: 'cargo' }, do: { damage: 1 } });
    expect(w.obj('cargo')).toMatchObject({ screen: 'hall', timerDue: 0 });
  });

  it('revives anyone down to just above their threshold, with state 1', async () => {
    const { w } = setup();
    const recovered: string[] = [];
    w.bus.on(e => { if (e.type === 'recovered') recovered.push(e.id); });
    w.state.phaser.data = { health: 0, stunned: true, regenAt: 0, destroyed: false };
    await react(w, { who: 'team', do: 'revive' });
    expect(w.state.phaser.data).toMatchObject({ health: 5, stunned: false });
    expect(w.obj('data').state).toBe(1);
    expect(w.obj('picard').state).toBe(0);
    expect(recovered).toEqual(['data']);
  });

  it('heals with negative damage, running nothing', async () => {
    const { w, seen } = setup();
    await react(w, { who: { object: 'guard' }, do: { damage: -3 } });
    expect(w.state.phaser.guard.health).toBe(7);
    expect(seen).toEqual([]);
  });

  it('stuns to just below the threshold, which kills when that is below 1', async () => {
    const { w, seen } = setup();
    await react(w, { who: { object: 'guard' }, do: 'stun' });
    await react(w, { who: { object: 'drone' }, do: 'stun' });
    expect(w.state.phaser.guard).toMatchObject({ health: 1, stunned: true });
    expect(w.state.phaser.drone.health).toBe(0);
    expect(seen).toEqual(['stun', 'drone kill']);
    await react(w, { who: { object: 'guard' }, do: 'stun' });
    expect(seen).toEqual(['stun', 'drone kill']);
  });

  it('kills down to 0, once', async () => {
    const { w, seen } = setup();
    await react(w, { who: { object: 'guard' }, do: 'kill' });
    await react(w, { who: { object: 'guard' }, do: 'kill' });
    expect(w.state.phaser.guard.health).toBe(0);
    expect(seen).toEqual(['kill']);
  });

  it("shows a phaser shot from the script's object when asked", async () => {
    const { w } = setup();
    await react(w, { who: 'actor', do: { damage: 1 }, shot: true });
    expect(log(w)).toEqual(['phaser guard -> data']);
  });

  it('beams in at a marker here, and crew who beam down join the team', async () => {
    const { w } = setup();
    await react(w, { who: { object: 'riker' }, do: { beamIn: 'center' } });
    expect(w.obj('riker')).toMatchObject({ screen: 'room', pos: { x: 5, z: 5 } });
    expect(w.state.awayTeam).toEqual(['picard', 'data', 'riker']);
    expect(log(w)).toEqual(['beam in riker']);
  });

  it('beams to an entrance on another screen, moving the current member on', async () => {
    const { w } = setup();
    await react(w, { who: 'actor', do: { beamTo: { screen: 'hall', entrance: 'entry' } } }, ctxOf({ who: 'picard' }));
    expect(w.obj('picard')).toMatchObject({ screen: 'hall', pos: { x: 1, z: 1 } });
    expect(w.state.currentActor).toBe('data');
    expect(log(w)).toEqual(['beam out picard']);
  });

  it('warns and moves no one when the screen lacks the entrance (ReactionBlock::execute)', async () => {
    const { w } = setup();
    const seen: string[] = [];
    w.bus.on(e => { if (e.type === 'warning') seen.push(e.message); });
    const before = { ...w.obj('picard').pos };
    await react(w, { who: 'actor', do: { beamTo: { entrance: 'entrance_9' } } }, ctxOf({ who: 'picard' }));
    expect(w.obj('picard')).toMatchObject({ screen: 'room', pos: before });
    expect(seen).toEqual(['no entrance entrance_9 on room to beam to']);
    expect(log(w)).toEqual([]);
  });

  it('beams up to the ship, leaving the team', async () => {
    const { w } = setup();
    await react(w, { who: 'actor', do: 'beamUp' });
    expect(w.obj('data').screen).toBeNull();
    expect(w.state.awayTeam).toEqual(['picard']);
  });

  it('does nothing without targets', async () => {
    const { w } = setup();
    w.obj('data').screen = 'hall';
    expect(await react(w, { who: 'actor', do: 'kill' })).toBe(0);
    expect(w.state.phaser.data.health).toBe(10);
  });
});

describe('beam', () => {
  it('sets where the transporter goes next, or clears it', async () => {
    const { w } = setup();
    await exec(w, { beam: { to: 'hall' } });
    expect(w.state.beamTarget).toBe('hall');
    await exec(w, { beam: { to: null } });
    expect(w.state.beamTarget).toBeNull();
  });

  it("carries world 8's number with the target (the screen is world 5's), and any other beam clears it", async () => {
    const { w } = setup();
    await exec(w, { beam: { to: 'hall', world: 8 } });
    expect([w.state.beamTarget, w.state.beamWorld]).toEqual(['hall', 8]);
    await exec(w, { beam: { to: 'hall' } });
    expect([w.state.beamTarget, w.state.beamWorld]).toEqual(['hall', null]);
    await exec(w, { beam: { to: 'hall', world: 8 } });
    await exec(w, { beam: { to: null } });
    expect([w.state.beamTarget, w.state.beamWorld]).toEqual([null, null]);
  });
});

describe('react and beam references', () => {
  it('are checked at load time', () => {
    const user = (fx: Effect): ObjectDef => ({ id: 'user', name: 'User', screen: 'room', on: { use: [{ do: [fx] }] } });
    expect(checkRefs(makeGame([user({ react: { who: { object: 'nobody' }, do: 'kill' } })])))
      .toEqual(['objects/user: on.use[0].do[0].react.who.object: unknown object "nobody"']);
    expect(checkRefs(makeGame([user({ react: { who: 'team', do: { beamTo: { screen: 'hall', entrance: 'door' } } } })])))
      .toEqual(['objects/user: on.use[0].do[0].react.do.beamTo.entrance: unknown marker "door" on screen "hall"']);
    expect(checkRefs(makeGame([user({ beam: { to: 'moon' } })])))
      .toEqual(['objects/user: on.use[0].do[0].beam.to: unknown screen "moon"']);
  });
});
