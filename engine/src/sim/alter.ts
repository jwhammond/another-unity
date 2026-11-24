// SPDX-License-Identifier: GPL-3.0-or-later
import { ANYONE, type AlterFx } from '../content/types';
import { perform } from './actions';
import { pixelAt, projectionOf } from './pixels';
import { describe } from './effects';
import { R } from './result';
import { say } from './talk';
import { startTimer } from './timers';
import type { ActionContext, World } from './world';

/** AlterBlock::execute (object.cpp:1288-1462), in its order. */
export async function alter(world: World, a: AlterFx, ctx: ActionContext): Promise<number> {
  // $anyone is whoever is acting
  const id = a.object === ANYONE ? ctx.who : a.object;
  const o = world.state.objects[id];
  // (this stops the rest of the results)
  if (!o) return R.FAILOTHER;
  const here = world.state.screen;

  if (a.at !== undefined) {
    // (moving an object stops its walk: object.cpp:1304)
    world.stopWalk(id, true);
    // (the original moves to pixels, whatever screen the object is on: a marker its own screen lacks is the current screen's)
    const own = o.screen !== null && world.content.screens[o.screen]?.markers[a.at] !== undefined;
    o.pos = world.marker(own ? (o.screen as string) : here, a.at);
    if (!own && o.screen !== null && o.screen !== here) {
      // (and as the pixel on the screen the object is on, which can measure it otherwise)
      const from = projectionOf(world, here);
      const to = projectionOf(world, o.screen);
      if (from && to) {
        const px = pixelAt(from, o.pos);
        o.pos = to.toWorld(px.x, px.y);
      }
    }
  }

  if (a.universe) world.applyShipEffect({ universe: { object: id, ...a.universe } });

  if (a.get && !o.inventory) {
    // (object.cpp:1329)
    world.stopWalk(id, true);
    o.screen = null;
    o.active = true;
    o.inventory = true;
  }

  if (a.drop) {
    // onto the current screen (putOnScreen starts the timer of anything not already here)
    const wasHere = o.screen === here && !o.inventory;
    o.screen = here;
    o.inventory = false;
    if (!wasHere) startTimer(world, id);
  }

  if (a.active === true) {
    o.active = true;
    startTimer(world, id);
  }

  if (a.active === false) {
    o.active = false;
    o.inventory = false;
    o.timerDue = 0;
  }

  // the object running this script is talked to now
  if (a.talkTo && ctx.target !== null) {
    await perform(world, { verb: 'talk', target: ctx.target, who: world.state.currentActor, other: null, walked: false });
  }

  if (a.halt) world.halt(id);

  if (a.stunned !== undefined) o.stunned = a.stunned;

  if (a.voice !== undefined) o.talkVoice = a.voice;

  if (a.timer !== undefined) {
    o.timer = a.timer;
    startTimer(world, id);
  }

  // (the object's anim_index, object.cpp:1408: what its picture follows, and what a save keeps; a new sprite leaves it)
  if (a.anim && !('sprite' in a.anim)) o.anim = 'play' in a.anim ? a.anim.play : -1;
  if (a.anim) await world.presenter.anim(id, a.anim);

  const source = ctx.target;
  if (a.converseNow !== undefined) {
    // a conversation, right now, started by whoever is acting
    const who = world.content.objects[ctx.who]?.crew ? ctx.who : world.state.currentActor;
    const voice = source !== null ? world.state.objects[source]?.talkVoice ?? undefined : undefined;
    await say(world, source, who, a.converseNow, voice);
  } else if (a.sayNow !== undefined) {
    // the object says something right now
    if (o.active) await say(world, source, id, a.sayNow, a.voice);
  } else if (a.talk !== undefined) {
    o.talk = a.talk;
    o.talkVoice = a.voice ?? null;
  }

  if (a.name !== undefined) o.name = a.name;
  if (a.state !== undefined) o.state = a.state;
  world.bus.emit({ type: 'objectChanged', id });

  if (a.describe) await describe(world, id, ctx.who);
  return 0;
}
