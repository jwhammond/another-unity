// SPDX-License-Identifier: GPL-3.0-or-later
import type { RuleVerb } from '../content/types';
import { describe } from './effects';
import { useAwayTeamItem } from './items';
import { R } from './result';
import { runList } from './rules';
import { talkTo } from './talk';
import type { ActionContext, World } from './world';

function rules(world: World, id: string, verb: RuleVerb) {
  return world.content.objects[id]?.on?.[verb] ?? [];
}

/** runAction's WALK (unity.cpp:1966-1987). */
async function walk(world: World, ctx: ActionContext): Promise<number> {
  const walker = world.walkerIdFor(ctx.who);
  if (ctx.target !== null) {
    const transition = world.content.objects[ctx.target]?.transition;
    if (transition) {
      // walk to the transition square, then use it
      const use: ActionContext = { verb: 'use', target: transition, who: ctx.who, other: null, walked: false };
      if (walker !== undefined && world.walkThenAct(walker, { ...world.obj(transition).pos }, use)) return R.WALKING | R.DIDSOMETHING;
      // (with nobody here to walk, the transition is used at once, unity.cpp:1976)
      return perform(world, use);
    }
    if (walker === undefined) return 0;
    world.walkTo(walker, { ...world.obj(ctx.target).pos });
    return R.WALKING | R.DIDSOMETHING;
  }
  if (ctx.to && walker !== undefined) {
    world.walkTo(walker, { ...ctx.to });
    return R.WALKING | R.DIDSOMETHING;
  }
  return 0;
}

async function runAction(world: World, ctx: ActionContext): Promise<number> {
  if (ctx.verb === 'walk') return walk(world, ctx);
  if (ctx.target === null) return 0;
  const target = ctx.target;

  switch (ctx.verb) {
    case 'use': {
      if (ctx.other !== null && world.state.objects[ctx.other]) {
        // the phaser and the medical items work on their own
        const handled = await useAwayTeamItem(world, ctx, target);
        if (handled !== null) return handled;
      }
      let r = await runList(world, rules(world, target, 'use'), ctx, `${target}/use`);
      // if nothing here was about the other object, try it the other way round
      const other = ctx.other;
      if (!(r & R.MATCHOTHER) && other !== null && other !== target && world.state.objects[other]) {
        r |= await runList(world, rules(world, other, 'use'), { ...ctx, target: other, other: target }, `${other}/use`);
      }
      return r;
    }
    case 'get':
      return runList(world, rules(world, target, 'get'), ctx, `${target}/get`);
    case 'look': {
      const look = rules(world, target, 'look');
      // without a script, the description is shown
      if (look.length === 0) {
        await describe(world, target, ctx.who);
        return R.DIDSOMETHING;
      }
      return runList(world, look, ctx, `${target}/look`);
    }
    case 'timer':
      return runList(world, rules(world, target, 'timer'), ctx, `${target}/timer`);
    case 'talk':
      return talkTo(world, ctx, target);
  }
}

/** A port of performAction: screen changes wait until the outermost action is done. */
export async function perform(world: World, ctx: ActionContext): Promise<number> {
  // (conversation results act on the outermost action's target, unity.cpp:1850-1858)
  const oldTalkTarget = world.talkTarget;
  if (world.actionDepth === 0) {
    world.actionWho = ctx.who;
    world.talkTarget = ctx.target;
  }
  world.actionDepth++;
  const depth = world.actionDepth;
  world.bus.emit({ type: 'actionStarted', verb: ctx.verb, target: ctx.target, who: ctx.who, other: ctx.other, depth });
  try {
    const result = await runAction(world, ctx);
    // (a throwing action emits no actionEnded: the throw ends the trace with an error)
    world.bus.emit({ type: 'actionEnded', verb: ctx.verb, target: ctx.target, result, depth });
    return result;
  } finally {
    world.actionDepth--;
    if (world.actionDepth === 0) {
      world.talkTarget = oldTalkTarget;
      world.applyScreenChange();
    }
  }
}
