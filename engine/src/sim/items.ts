// SPDX-License-Identifier: GPL-3.0-or-later
import { runConversation } from './conversation';
import { unlogged } from './talkLog';
import { firePhaser, recover, toInt8 } from './phaser';
import { R } from './result';
import type { ActionContext, World } from './world';

/** useAwayTeamItem (awayteam.cpp:1256-1310): the phaser and the medical items work on their own; null if not handled. */
export async function useAwayTeamItem(world: World, ctx: ActionContext, target: string): Promise<number | null> {
  const item = ctx.other;
  if (item === null) return null;
  const items = world.content.rules.items;
  const actor = world.walkerIdFor(ctx.who) ?? world.state.currentActor;

  if (item === items.phaser && world.obj(item).inventory) return firePhaser(world, actor, target, ctx);

  const pd = world.state.phaser[target];
  const def = world.content.objects[target];
  if ((item !== items.medicalTricorder && item !== items.medkit) || !def?.crew || !pd || !def.phaser) return null;

  const medical = world.content.rules.lines.medical;
  const member = medical ? medical.order.indexOf(target) : -1;
  // (the reference check makes sure of these)
  if (!medical || member < 0) throw new Error(`no medical lines for "${target}"`);

  // the actor reports on (or treats) the patient
  const threshold = def.phaser.threshold;
  let situation: number;
  if (item === items.medicalTricorder) {
    if (actor === target) situation = 4;
    else if (pd.health === def.phaser.health) situation = 6 + member;
    else if (pd.health >= threshold) situation = 15 + member;
    else if (pd.health >= 0) situation = 24 + member;
    else situation = 33 + member;
  } else if (pd.health >= threshold) {
    situation = 2;
  } else {
    // Dr. Crusher does a better job
    const doctor = actor === world.content.rules.doctor;
    pd.health = toInt8(threshold + (pd.health >= 0 ? (doctor ? 4 : 0) : (doctor ? 2 : 0)));
    pd.regenAt = world.clock.now;
    if (pd.health > threshold) recover(world, target);
    situation = 15 + member;
  }

  // (not logged: awayteam.cpp:1305-1308)
  await unlogged(world, () => runConversation(world, medical.conversation, situation, ctx.who));
  return R.DIDSOMETHING;
}
