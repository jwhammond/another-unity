// SPDX-License-Identifier: GPL-3.0-or-later
import type { Check, Condition } from '@another-unity/engine';
import type { EntryT } from '@another-unity/rawcheck/ir';
import { hereMarker, objectScreen, ownerWorld, type LiftCtx, type Owner } from './context';
import { ANYONE_ID, isCrewId, NONE_ID, NOT_OTHER_ID, parseId } from './ids';

export type ConditionBlockT = Extract<EntryT, { class: 'ConditionBlock' }>;
type ObjectCheck = Exclude<Check, { emptyAt: string }>;

/** ConditionBlock::check (object.cpp:1083-1282), as a `when`. */
export function liftCondition(e: ConditionBlockT, ctx: LiftCtx, owner: Owner, pointer: string): Condition {
  const {
    target, WhoCan, how_close_dist, how_close_x, how_close_y, skill_check, counter_value, counter_when,
    condition, check_x, check_y, check_univ_x, check_univ_y, check_univ_z, check_screen, check_status, check_state,
  } = e;
  const { ids, markers, problems } = ctx;
  const c: Condition = {};

  if (target === NOT_OTHER_ID) c.other = '$none';
  else if (target !== NONE_ID) c.other = ids.object(target, pointer);

  // (0x10 is anyone: no check)
  if (WhoCan !== NONE_ID && WhoCan !== ANYONE_ID) c.who = ids.object(WhoCan, pointer);

  if (how_close_dist !== 0xffff) {
    if (how_close_x !== 0xffff) {
      const at = hereMarker(ctx, owner, how_close_x, how_close_y, pointer);
      // (with no screen of its own the distance is at full scale: which screen's row it is isn't known until it runs)
      c.near = { dist: markers.distance(owner.screen?.slug ?? null, how_close_dist, how_close_y, `${pointer} near`), at, px: how_close_dist };
    } else {
      // measured from the target (the owner), or at full scale for lists that run anywhere (an item is always close enough)
      c.near = { dist: markers.distance(owner.screen?.slug ?? null, how_close_dist, owner.y ?? 399, `${pointer} near`), px: how_close_dist };
    }
  }

  // (a skill of 0 means no check)
  if (skill_check !== 0xffff && skill_check !== 0) c.skill = skill_check;

  if (counter_when === 1) c.counter = { mode: 'when', value: counter_value };
  else if (counter_when === 0) c.counter = { mode: 'until', value: counter_value };

  const checks: Check[] = [];
  for (let i = 0; i < 4; i++) {
    const id = condition[i];
    const anyone = id === ANYONE_ID;
    // (object.cpp:1192-1197: the original skips the whole check for an object it can't find)
    if (id !== NONE_ID && !anyone && !ctx.raw.objects.has(id)) {
      problems.warn(pointer, `check ${i} names ${id}, which isn't in the export (object.cpp:1192-1197: the original skips these)`);
      continue;
    }
    // (object.cpp:1256 compares positions in space only for a named object, and only when x is set)
    if (id !== NONE_ID && check_univ_x[i] !== 0xffff) {
      problems.error(pointer, `check ${i} compares positions in space, which the content model can't express`);
      continue;
    }
    if (id === NONE_ID) {
      // nothing may stand at this spot
      if (check_x[i] !== 0xffff && check_y[i] !== 0xffff) {
        checks.push({ emptyAt: hereMarker(ctx, owner, check_x[i], check_y[i], pointer) });
      }
      continue;
    }

    const ch: ObjectCheck = { object: anyone ? '$anyone' : ids.object(id, pointer) };
    if (check_state[i] !== 0xff) ch.state = check_state[i];
    if (check_status[i] !== 0xff) {
      // (non-zero: on the team for crew, in the inventory for anything else; there is no "not on the team")
      ch.status = check_status[i] === 0 ? 'notInInventory' : anyone || isCrewId(id) ? 'inTeam' : 'inInventory';
    }
    // a screen number is in the checked object's world (crew and anyone: the current one)
    const world = anyone || parseId(id).world === 0 ? null : parseId(id).world;
    let screen: string | undefined;
    // (0xfe: an inactive object passes the whole condition at once)
    const passIfInactive = check_screen[i] === 0xfe;
    if (!passIfInactive && check_screen[i] !== 0xff) screen = ids.screen(world ?? ownerWorld(ctx, owner, pointer), check_screen[i], pointer);
    if (check_x[i] !== 0xffff) {
      // the marker is looked up on the check's screen, else the object's own, else the owner's (refs.ts)
      const object = anyone ? undefined : ctx.raw.objects.get(id);
      const own = object ? objectScreen(ctx, object)?.slug : undefined;
      const on = screen ?? own;
      ch.at = on ? markers.point(on, check_x[i], check_y[i], pointer) : hereMarker(ctx, owner, check_x[i], check_y[i], pointer);
    }
    if (screen !== undefined) ch.screen = screen;
    if (passIfInactive) ch.passIfInactive = true;
    checks.push(ch);
  }
  if (checks.length > 0) c.checks = checks;
  return c;
}
