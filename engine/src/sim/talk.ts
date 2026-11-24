// SPDX-License-Identifier: GPL-3.0-or-later
import { parseConversationString } from '../content/talkString';
import type { Vec2 } from '../content/types';
import { sayAdvice } from './advice';
import { entryForReading, readingKey, recordReading } from './computer';
import { runConversation } from './conversation';
import { distance } from './geometry';
import { fullScalePixels, furtherThan, pixelAt, screenPixels } from './pixels';
import { R } from './result';
import { sayLine, talking, unlogged } from './talkLog';
import type { ActionContext, World } from './world';

/** The reading that opens the tricorder without recording anything (kTricorderReadings, unity.h:222). */
export const ALL_READINGS = 0x8000;

/** Like C's atoi: leading digits, or 0. */
function atoi(s: string): number {
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? 0 : n;
}

/** say (talk.cpp:200-214): true if anything was said. */
export async function say(world: World, obj: string | null, who: string, str: string, voice?: string): Promise<boolean> {
  // nothing more is said once the screen is about to change
  if (world.state.pendingScreen !== null || str === '') return false;
  const oldTarget = world.talkTarget;
  if (world.talkTarget === null) world.talkTarget = world.state.objects[who] ? who : null;
  try {
    return await talking(world, () => sayString(world, obj, who, str, voice));
  } finally {
    world.talkTarget = oldTarget;
  }
}

/** sayString (talk.cpp:259-329). */
async function sayString(world: World, obj: string | null, who: string, text: string, voice?: string): Promise<boolean> {
  let str = text;
  if (str[0] === '1') {
    // (the callers deal with these)
    world.bus.emit({ type: 'warning', message: `unexpected immediate talk string "${text}"` });
    str = str.slice(1);
    if (str === '') return false;
  }

  switch (str[0]) {
    case '@': {
      const ref = parseConversationString(str);
      if (!ref) {
        world.bus.emit({ type: 'warning', message: `bad conversation string "${str}"` });
        return false;
      }
      // ?n is a random situation, from 0 to n
      const situation = ref.situation.startsWith('?') ? world.rng.next(atoi(ref.situation.slice(1)), 'situation') : atoi(ref.situation);
      return runConversation(world, ref.conversation, situation, who);
    }

    case '!': {
      // advice, at the level given (or 2)
      const next = str[1] ?? '';
      const level = /^\d$/.test(next) ? Number(next) : 2;
      // (advice isn't logged: talk.cpp:298-307)
      return unlogged(world, async () => {
        let said = await sayAdvice(world, obj, level);
        const noAdvice = world.content.rules.lines.noAdvice;
        if (!said && noAdvice && next !== '0' && world.isActiveAwayTeamMember(who)) {
          said = await say(world, obj, who, `@${noAdvice.conversation},${noAdvice.situation}`);
        }
        return said;
      });
    }

    case '^':
      return world.presenter.screenText(atoi(str.slice(1)));

    case '~':
      await tricorderReading(world, atoi(str.slice(1)));
      return true;

    case '|':
      await sayLine(world, who, str.slice(1), voice);
      return true;

    default:
      await sayLine(world, who, str, voice);
      return true;
  }
}

/** runTricorder (tricorder.cpp:92-108): records the reading's world and group, then opens the viewer unless it was negative. */
export async function tricorderReading(world: World, reading: number): Promise<void> {
  if (reading !== ALL_READINGS) {
    // (the original's key includes the current world, tricorder.cpp:98-103)
    const where = world.content.screens[world.state.screen]?.world ?? world.content.id;
    const group = Math.abs(reading);
    if (!world.state.readings.some(r => r.world === where && r.group === group)) {
      world.state.readings.push({ world: where, group });
      world.bus.emit({ type: 'reading', world: where, group });
    }
    // (a reading is recorded with any others in its group, 9 down to 0, so index 0 ends up first: tricorder.cpp:98-103)
    const ship = world.content.ship;
    if (ship) {
      for (let i = 9; i >= 0; i--) {
        const key = readingKey(world.content, where, group, i);
        if (key !== undefined && entryForReading(world.content, key) !== 0) recordReading(world, key);
      }
    }
    // (a negative reading is recorded silently)
    if (reading < 0) return;
  }
  await world.presenter.tricorder(reading);
}

/**
 * Where a talker further than reach from the target walks up to: beside it by its width, on the talker's side
 * (unity.cpp:2022-2031). On a screen with a pixel metric, in the original's pixels: its raw pixel width to the side,
 * two rows below the target; otherwise in metres, by its width in metres.
 */
function talkWalkUp(world: World, from: Vec2, to: Vec2, target: string, reach: number): Vec2 | undefined {
  const p = screenPixels(world);
  if (!p) {
    if (distance(from, to) <= reach) return undefined;
    const width = world.content.objects[target]?.width ?? 0;
    return { x: from.x < to.x ? to.x - width : to.x + width, z: to.z };
  }
  const a = pixelAt(p, from);
  const t = pixelAt(p, to);
  if (!furtherThan(a, t, fullScalePixels(p, reach))) return undefined;
  // (the original's raw width, unscaled; ~0 counts as none)
  const w = world.content.objects[target]?.pixelWidth ?? 0;
  return p.toWorld(a.x < t.x ? t.x - w : t.x + w, t.y + 2);
}

/** runAction's TALK (unity.cpp:1989-2025). */
export async function talkTo(world: World, ctx: ActionContext, target: string): Promise<number> {
  const o = world.obj(target);
  if (o.talk === '') return R.EMPTYTALK;

  // in the away missions, the talker first walks up beside the target
  const reach = world.content.rules.talkDistance;
  if (reach !== undefined && !ctx.walked) {
    const actorId = world.walkerIdFor(ctx.who);
    const actor = actorId === undefined ? undefined : world.obj(actorId);
    const dest = actor && actorId !== target ? talkWalkUp(world, actor.pos, o.pos, target, reach) : undefined;
    if (dest && actorId !== undefined && world.walkThenAct(actorId, dest, ctx)) return R.WALKING | R.DIDSOMETHING;
  }

  // the target says plain lines itself; otherwise whoever is talking to it starts the conversation
  let speaker = target;
  if (o.talk[0] === '@' || o.talk[0] === '!') {
    speaker = world.state.objects[ctx.who] ? ctx.who : world.state.currentActor;
  }
  await say(world, target, speaker, o.talk, o.talkVoice ?? undefined);
  return R.DIDSOMETHING;
}
