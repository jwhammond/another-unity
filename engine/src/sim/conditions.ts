// SPDX-License-Identifier: GPL-3.0-or-later
import { ANYONE, NONE, type Condition, type Vec2 } from '../content/types';
import { distance, samePos } from './geometry';
import { furtherThan, pixelAt, pixelsOf, screenPixels } from './pixels';
import { R } from './result';
import type { Rng } from './rng';
import type { ActionContext, World } from './world';

/** The skill levels are compared one hex digit at a time, and a lack of skill only fails some of the time. */
export function passesSkillCheck(rng: Rng, required: number, skills: number): boolean {
  const need = required.toString(16).padStart(4, '0');
  const have = skills.toString(16).padStart(4, '0');
  for (let i = 0; i < 4; i++) {
    if (need.charCodeAt(i) <= have.charCodeAt(i)) continue;
    // (this is the difference in ASCII, as in the original)
    const diff = need.charCodeAt(i) - have.charCodeAt(i);
    if (((rng.next(255, 'skill') * diff + 0x80) >> 8) === 1) return false;
  }
  return true;
}

/**
 * Whether the walker is further than dist from dest (object.cpp:1135-1137). On a screen with a pixel metric, in the
 * original's pixels: dist back in pixels at dest's row, where the lifter converted it.
 */
function tooFar(world: World, from: Vec2, dest: Vec2, dist: number, px?: number): boolean {
  const p = screenPixels(world);
  if (!p) return distance(dest, from) > dist;
  const d = pixelAt(p, dest);
  // (the original's own pixels when the lift kept them: a target that has moved is at another row than dist was lifted at)
  return furtherThan(d, pixelAt(p, from), px ?? pixelsOf(p, dist, d.y));
}

/** A port of ConditionBlock::check; returns result flags (0 or MATCHOTHER alone means pass). */
export function checkCondition(world: World, cond: Condition, ctx: ActionContext, counterKey: string): number {
  let r = 0;

  if (cond.other === NONE) {
    if (ctx.other !== null) return R.FAILOTHER;
  } else if (cond.other !== undefined) {
    if (cond.other !== ctx.other) return R.FAILOTHER;
    r |= R.MATCHOTHER;
  }

  if (ctx.other !== null && !world.state.objects[ctx.other]) return r | R.NOTARGET;

  const walkerId = world.walkerIdFor(ctx.who);
  const walker = walkerId === undefined ? undefined : world.obj(walkerId);
  if (cond.near && !ctx.walked) {
    if (!walker || walkerId === undefined) return r | R.NOTARGET | R.WALKING;
    let dest: Vec2 | undefined;
    if (cond.near.at) {
      dest = world.marker(world.state.screen, cond.near.at);
    } else if (ctx.target !== null) {
      const target = world.obj(ctx.target);
      // an inventory item is always close enough
      dest = target.inventory ? walker.pos : target.pos;
    }
    if (dest && tooFar(world, walker.pos, dest, cond.near.dist, cond.near.px)) {
      if (world.walkThenAct(walkerId, { ...dest }, ctx, cond.near.dist, cond.near.px)) return r | R.WALKING | R.DIDSOMETHING;
    }
  }

  if (cond.who !== undefined && cond.who !== ctx.who) return r | R.AWAYTEAM;

  if (cond.skill && walker) {
    // (the walker's own skills, object.cpp:1150-1151)
    const skills = world.content.objects[walkerId ?? ctx.who]?.skills ?? 0;
    if (!passesSkillCheck(world.rng, cond.skill, skills)) return r | R.FAILSKILL;
  }

  if (cond.counter) {
    const value = world.state.counters[counterKey] ?? cond.counter.value;
    if (cond.counter.mode === 'when') {
      // do when: fail until the counter has run out, then pass once
      world.state.counters[counterKey] = (value - 1) & 0xffff;
      if (value !== 0) return r | R.COUNTER_DOWHEN;
    } else {
      // do until: pass until the counter runs out
      if (((value << 16) >> 16) <= 0) return r | R.COUNTER_DOUNTIL;
      world.state.counters[counterKey] = (value - 1) & 0xffff;
    }
  }

  for (const check of cond.checks ?? []) {
    if ('emptyAt' in check) {
      // nothing may stand at this spot
      if (world.isObjectAt(world.marker(world.state.screen, check.emptyAt))) return r | R.FAILPOS;
      continue;
    }

    const id = check.object === ANYONE ? world.state.currentActor : check.object;
    const o = world.state.objects[id];
    if (!o) continue; // (the original skips these)

    if (check.state !== undefined && o.state !== check.state) return r | R.FAILSTATE;

    if (!o.active) {
      if (check.passIfInactive) return r;
      if (check.state === undefined) return r | R.INACTIVE;
    } else if (world.content.objects[id]?.crew && world.isIncapacitated(id)) {
      return r | R.STUNNED;
    }
    if (check.status === 'inTeam') {
      if (!world.isActiveAwayTeamMember(id)) return r | R.AWAYTEAM;
    } else if (check.status === 'inInventory') {
      if (!o.inventory) return r | R.INVENTORY;
    } else if (check.status === 'notInInventory') {
      // (there is no inverse away team check)
      if (o.inventory) return r | R.INVENTORY;
    }

    if (check.at !== undefined) {
      // (the original compares raw x/y: a marker that isn't on the object's screen just doesn't match; carry note 34.
      // Caveat: it compares raw pixels whatever screen the object is on, so an object on another screen at the same
      // pixel, without this marker, passes there but gives FAILPOS here)
      const screen = o.screen ?? world.state.screen;
      const at = world.content.screens[screen]?.markers[check.at];
      if (!at || !samePos(o.pos, at)) return r | R.FAILPOS;
    }

    if (check.screen !== undefined && o.screen !== check.screen) return r | R.FAILSCREEN;

    // (in the original an active object has no inactive marker, so the screen check fails)
    if (o.active && check.passIfInactive) return r | R.FAILSCREEN;
  }

  return r;
}
