// SPDX-License-Identifier: GPL-3.0-or-later
import { NONE, type RuleGroup } from '../content/types';
import { TICKS_PER_SECOND } from './clock';
import { R } from './result';
import { runList } from './rules';
import type { ActionContext, World } from './world';

/** How long a member who is down takes to regain each point of health (kRecoveryTime, awayteam.cpp:922). */
export const RECOVERY_TICKS = 15 * TICKS_PER_SECOND;

/** Health is an int8 in the original (object.h:400-402), and wraps like one. */
export function toInt8(n: number): number {
  return ((n + 128) & 0xff) - 128;
}

function lists(world: World, id: string): { stun?: RuleGroup[]; gtp?: RuleGroup[]; kill?: RuleGroup[] } {
  return world.content.objects[id]?.phaser?.on ?? {};
}

/** recover (awayteam.cpp:977-984): back on their feet. */
export function recover(world: World, id: string): void {
  const pd = world.state.phaser[id];
  if (pd) pd.stunned = false;
  world.bus.emit({ type: 'recovered', id });
}

/** collapse (awayteam.cpp:961-975): whatever the member was going to do is cancelled. */
function collapse(world: World, id: string): void {
  world.halt(id);
  world.bus.emit({ type: 'collapsed', id });
}

/** firePhaser (awayteam.cpp:1219-1254). */
export async function firePhaser(world: World, actor: string, target: string, ctx: ActionContext): Promise<number> {
  const pd = world.state.phaser[target];
  const def = world.content.objects[target]?.phaser;
  const actorPd = world.state.phaser[actor];
  if (!pd || !def || world.content.objects[target]?.crew || world.isIncapacitated(actor) || (actorPd && actorPd.health <= 0)) {
    return R.FAILPHASER;
  }

  const r = await runList(world, world.content.objects[target]?.on?.use ?? [], ctx, `${target}/use`);
  // (the script took over)
  if (r & (R.WALKING | R.STOPPED)) return r;

  await world.presenter.show({ kind: 'phaserShot', from: actor, to: target });
  const setting = world.state.phaserSetting;
  const gtpUpTo = def.gtpUpTo ?? -1;
  const on = lists(world, target);
  if (gtpUpTo !== -1 && setting <= gtpUpTo) await runList(world, on.gtp ?? [], ctx, `${target}/phaser/gtp`);

  // (unlike other damage, these run with the shooter and the phaser, and a target reaching 0 is only stunned)
  if (setting >= def.damageFrom) {
    pd.health = toInt8(pd.health - (setting - def.damageFrom + 1));
    if (setting >= def.gtpFrom && gtpUpTo === -1) await runList(world, on.gtp ?? [], ctx, `${target}/phaser/gtp`);
    if (pd.health < 0) {
      await runList(world, on.kill ?? [], ctx, `${target}/phaser/kill`);
    } else if (pd.health <= def.threshold && !pd.stunned) {
      await runList(world, on.stun ?? [], ctx, `${target}/phaser/stun`);
      pd.stunned = true;
      pd.regenAt = world.clock.now;
    }
  }

  return (r & ~R.FAILOTHER) | R.DIDSOMETHING;
}

/** damageObject (awayteam.cpp:986-1009): damage from a script; negative damage heals. */
export async function damageObject(world: World, id: string, damage: number): Promise<void> {
  const pd = world.state.phaser[id];
  const def = world.content.objects[id]?.phaser;
  if (!pd || !def) return;

  const ctx: ActionContext = { verb: 'use', target: id, who: NONE, other: null, walked: false };
  const crew = world.content.objects[id]?.crew === true;
  const on = lists(world, id);
  pd.health = toInt8(Math.max(pd.health - damage, -1));

  if (pd.health < 1) {
    await runList(world, on.kill ?? [], ctx, `${id}/phaser/kill`);
    if (!pd.stunned) {
      pd.regenAt = world.clock.now;
      if (crew) collapse(world, id);
    }
  } else if (pd.health <= def.threshold && !pd.stunned) {
    await runList(world, on.stun ?? [], ctx, `${id}/phaser/stun`);
    pd.stunned = true;
    pd.regenAt = world.clock.now;
    if (crew) collapse(world, id);
  }
}

/** updateAwayTeamHealth (awayteam.cpp:1011-1033): members who are down slowly recover, unless they're down to nothing. */
export function updateHealth(world: World): void {
  const current = world.state.currentActor;
  if (world.isIncapacitated(current) || !world.obj(current).active) world.selectNextMember();

  const now = world.clock.now;
  for (const id of world.state.awayTeam) {
    const pd = world.state.phaser[id];
    const def = world.content.objects[id]?.phaser;
    if (!pd || !def) continue;
    if (pd.health <= def.threshold && pd.health > 0 && now - pd.regenAt >= RECOVERY_TICKS) {
      pd.health = toInt8(pd.health + 1);
      pd.regenAt = now;
    }
    // (but they only get up once the team is with them)
    if (pd.stunned && pd.health > def.threshold && world.obj(id).screen === world.state.screen) recover(world, id);
  }
}

/** The phaser's setting: 0 off, 1 low, 2 medium, 3 high. The gauge only works with the phaser in the inventory (awayteam.cpp:784). */
export function setPhaserSetting(world: World, setting: number): boolean {
  const phaser = world.content.rules.items.phaser;
  if (phaser === undefined || !world.state.objects[phaser]?.inventory) return false;
  if (!Number.isInteger(setting) || setting < 0 || setting > 3) throw new RangeError(`phaser setting must be 0 to 3, not ${setting}`);
  world.state.phaserSetting = setting;
  return true;
}
