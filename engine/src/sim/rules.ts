// SPDX-License-Identifier: GPL-3.0-or-later
import type { Effect, RuleGroup } from '../content/types';
import { checkCondition } from './conditions';
import { runEffect } from './effects';
import { R } from './result';
import type { ActionContext, World } from './world';

const PASS = R.MATCHOTHER | R.DIDSOMETHING;

/** An effect's kind, for the trace: its one key besides `stop`. */
const effectName = (fx: Effect): string => Object.keys(fx).find(k => k !== 'stop') ?? 'unknown';

async function runGroup(world: World, group: RuleGroup, ctx: ActionContext, key: string, r0: number): Promise<number> {
  let r = r0;
  if (group.when) r |= checkCondition(world, group.when, ctx, key);
  if ((group.when || group.do.length > 0) && r & ~PASS) {
    // (for the dev tools' rule trace: which group didn't run, and why)
    world.bus.emit({ type: 'ruleSkipped', target: ctx.target, verb: ctx.verb, group: key, result: r });
    return r;
  }

  world.bus.emit({ type: 'ruleRan', target: ctx.target, verb: ctx.verb, group: key });
  if (group.when) world.bus.emit({ type: 'conditionPassed', group: key, other: ctx.other });

  // the condition comes first in the original's list, and can stop it
  if (group.when) {
    r |= R.DIDSOMETHING;
    if (group.when.stop) return r | R.STOPPED;
  }

  // the results run in order, until one of them fails or stops the list
  for (const fx of group.do) {
    let result = await runEffect(world, fx, ctx, key);
    if (fx.stop) result |= R.STOPPED;
    world.bus.emit({ type: 'effectRan', group: key, effect: effectName(fx), result });
    r |= result | R.DIDSOMETHING;
    if (result & ~PASS) break;
  }
  return r;
}

/** A port of EntryList::runGroup (object.cpp:1016-1034) on its own: group `index` of a list, as combat's hooks run one (damage.cpp:671, 692). */
export async function runGroupAt(world: World, groups: RuleGroup[], index: number, ctx: ActionContext, path: string): Promise<number> {
  return runGroup(world, groups[index]!, ctx, `${path}/${index}`, 0);
}

/** A port of EntryList::execute. */
export async function runList(world: World, groups: RuleGroup[], ctx: ActionContext, path: string): Promise<number> {
  let r = 0;
  for (let i = 0; i < groups.length; i++) {
    // once a walk has started, every later group fails its checks
    r &= R.WALKING | R.MATCHOTHER | R.DIDSOMETHING;
    r = await runGroup(world, groups[i], ctx, `${path}/${i}`, r);
    if (r & R.STOPPED) break;
  }
  return r;
}
