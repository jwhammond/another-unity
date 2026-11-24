// SPDX-License-Identifier: GPL-3.0-or-later
import type { ReactFx } from '../content/types';
import { damageObject, recover, toInt8 } from './phaser';
import { entranceSlot } from './screens';
import { startTimer } from './timers';
import type { ActionContext, World } from './world';

/** joinScreen (awayteam.cpp:1046-1070). */
export function joinScreen(world: World, id: string, screen: string | null): void {
  const o = world.obj(id);
  const crew = world.content.objects[id]?.crew === true;
  const wasHere = o.screen === world.state.screen;
  o.screen = screen;
  // (a beam places them: that wins over where a walk in progress got to)
  world.stopWalk(id, true);
  world.halt(id);
  // crew members beamed down join the away team
  if (crew && !world.state.awayTeam.includes(id)) world.state.awayTeam.push(id);
  world.bus.emit({ type: 'objectChanged', id });

  if (screen === world.state.screen) {
    // (putOnScreen starts the timer of anything not already here)
    if (!wasHere && !(world.state.onCloseup && crew)) startTimer(world, id);
    return;
  }
  // (or they wait on another screen)
  if (id === world.state.currentActor) world.selectNextMember();
}

/** beamToShip (awayteam.cpp:1072-1080). */
export function beamToShip(world: World, id: string): void {
  joinScreen(world, id, null);
  if (!world.content.objects[id]?.crew) return;
  world.state.awayTeam = world.state.awayTeam.filter(m => m !== id);
}

function targets(world: World, r: ReactFx, ctx: ActionContext): string[] {
  const here = world.state.screen;
  const who = r.who;
  if (who === 'actor') {
    const id = world.walkerIdFor(ctx.who);
    return id === undefined ? [] : [id];
  }
  // (including anyone who is down)
  if (who === 'team') return world.state.awayTeam.filter(id => world.obj(id).screen === here);
  if (who === 'random') {
    const active = world.state.awayTeam.filter(id => world.isActiveAwayTeamMember(id));
    return active.length > 0 ? [active[world.rng.next(active.length - 1, 'reactMember')]] : [];
  }
  const o = world.state.objects[who.object];
  if (!o) return [];
  // an object is brought here if its sprite isn't loaded: it is for anything listed on a screen the team has entered
  const loaded = world.state.spritesLoaded;
  if (!loaded.includes(who.object)) {
    loaded.push(who.object);
    if (o.screen !== here) {
      o.screen = here;
      startTimer(world, who.object);
      world.bus.emit({ type: 'objectChanged', id: who.object });
    }
  }
  return [who.object];
}

/** ReactionBlock::execute (object.cpp:1465-1620). */
export async function react(world: World, r: ReactFx, ctx: ActionContext): Promise<number> {
  const objects = targets(world, r, ctx);
  if (objects.length === 0) return 0;

  const here = world.state.screen;
  const shooter = ctx.target;
  const chodak = r.chodak === true;
  const shoot = async (id: string) => {
    if (r.shot && shooter !== null) await world.presenter.show({ kind: 'phaserShot', from: shooter, to: id });
  };
  const health = (id: string) => world.state.phaser[id];
  const threshold = (id: string) => world.content.objects[id]?.phaser?.threshold ?? 0;
  const d = r.do;

  if (d === 'revive') {
    // to just above being down
    for (const id of objects) {
      const pd = health(id);
      if (pd && pd.health <= threshold(id)) {
        pd.health = toInt8(threshold(id) + 1);
        recover(world, id);
        world.obj(id).state = 1;
      }
    }
  } else if (typeof d === 'object' && 'damage' in d) {
    for (const id of objects) {
      await shoot(id);
      await damageObject(world, id, d.damage);
    }
  } else if (d === 'stun') {
    for (const id of objects) {
      const pd = health(id);
      if (!pd || pd.health <= threshold(id)) continue;
      await shoot(id);
      await damageObject(world, id, pd.health - threshold(id) + 1);
    }
  } else if (d === 'kill') {
    // (down to nothing, which only a medkit fixes)
    for (const id of objects) {
      const pd = health(id);
      if (!pd || pd.health === 0) continue;
      await shoot(id);
      await damageObject(world, id, pd.health);
    }
  } else if (typeof d === 'object' && 'beamIn' in d) {
    const pos = world.marker(here, d.beamIn);
    for (const id of objects) {
      world.obj(id).pos = { ...pos };
      joinScreen(world, id, here);
    }
    await world.presenter.show({ kind: 'beam', objects, out: false, chodak });
  } else if (typeof d === 'object' && 'beamTo' in d) {
    const dest = d.beamTo.screen ?? here;
    // (the beam reads the screen's entrances first: one it lacks is a warning, and no one moves, ReactionBlock::execute)
    if (!Object.hasOwn(world.content.screens[dest]?.markers ?? {}, d.beamTo.entrance)) {
      world.bus.emit({ type: 'warning', message: `no entrance ${d.beamTo.entrance} on ${dest} to beam to` });
      return 0;
    }
    if (dest !== here) await world.presenter.show({ kind: 'beam', objects, out: true, chodak });
    // object i lands on the entrance's slot i % 4 (ReactionBlock::execute's beam, object.cpp)
    objects.forEach((id, i) => {
      world.obj(id).pos = entranceSlot(world, dest, d.beamTo.entrance, i);
      joinScreen(world, id, dest);
    });
    if (dest === here) await world.presenter.show({ kind: 'beam', objects, out: false, chodak });
  } else {
    // beam up to the ship
    await world.presenter.show({ kind: 'beam', objects, out: true, chodak });
    for (const id of objects) beamToShip(world, id);
  }
  return 0;
}
