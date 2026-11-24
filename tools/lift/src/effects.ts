// SPDX-License-Identifier: GPL-3.0-or-later
import {
  ACTOR, ANYONE, CURRENT, NONE, SHIP,
  type ActFx, type AdviceSetting, type AlterFx, type AnimFx, type Effect, type ReactFx, type RuleGroup,
  type ScreenFx, type StartupActionDef, type StartupVerb,
} from '@another-unity/engine';
import type { EntryListT, EntryT } from '@another-unity/rawcheck/ir';
import { liftCondition } from './conditions';
import { currentScreens, demote, hereMarker, never, noop, objectScreen, ownerScreen, ownerWorld, type LiftCtx, type Owner } from './context';
import { hookCall } from './hooks';
import {
  ACTOR_ID, ANYONE_ID, conversationKey, ENTERPRISE_ID, NONE_ID, parseId, regionName, screenKey, SHIP_WORLD, SPACE_WORLD,
} from './ids';
import { convertTalk, hailNumbers, stripUseWords, talkConversationKey, talkVoiceType } from './talk';
import { voiceKey } from './voice';

type E<C extends EntryT['class']> = Extract<EntryT, { class: C }>;

export const isNoop = (fx: Effect): boolean => 'wait' in fx && fx.wait.seconds === 0;

const compact = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/** A file name as the content refers to it: lowercase, without its extension. */
const stem = (file: string) => file.replace(/\0/g, '').trim().toLowerCase().replace(/\.[^.]*$/, '');

export function liftGroups(list: EntryListT, ctx: LiftCtx, owner: Owner, pointer: string): RuleGroup[] {
  return list.map((group, g) => liftGroup(group, ctx, owner, `${pointer}/${g}`));
}

function liftGroup(group: EntryT[], ctx: LiftCtx, owner: Owner, pointer: string): RuleGroup {
  const stats = ctx.stats.for(pointer);
  stats.groups++;
  const conditions: number[] = [];
  const results: number[] = [];
  group.forEach((e, i) => (e.class === 'ConditionBlock' ? conditions : results).push(i));

  let when: RuleGroup['when'];
  if (conditions.length > 1) ctx.problems.error(pointer, 'a group with more than one ConditionBlock');
  else if (conditions.length === 1) {
    const i = conditions[0];
    const c = group[i];
    if (i !== 0) ctx.problems.error(`${pointer}/${i}`, 'a ConditionBlock that is not first in its group');
    else if (c.class === 'ConditionBlock') {
      const before = ctx.problems.errors.length;
      when = liftCondition(c, ctx, owner, `${pointer}/${i}`);
      // (secondary content: a condition that can't be lifted never passes)
      if (demote(ctx, before)) when = never();
      stats.entries.ConditionBlock = (stats.entries.ConditionBlock ?? 0) + 1;
    }
  }

  // the results run by _order, stably, after the condition (sortLastEntry, object.cpp:319-333)
  // (every _order is read, even in a group of one, so the lossless check sees it)
  const ordered = results.map(i => ({ i, order: group[i]._order })).sort((a, b) => a.order - b.order || a.i - b.i);
  const effects: Effect[] = [];
  for (const { i } of ordered) {
    const e = group[i];
    const before = ctx.problems.errors.length;
    let fx = liftEntry(e, ctx, owner, `${pointer}/${i}`);
    // (secondary content: an entry that can't be lifted does nothing)
    if (demote(ctx, before)) fx = [noop()];
    stats.entries[e.class] = (stats.entries[e.class] ?? 0) + 1;
    stats.effects += fx.length;
    stats.noops += fx.filter(isNoop).length;
    // a stop on an entry ends the list once the entry has run (runGroup, object.cpp:1016-1034)
    if (e._stopHere !== 0) fx[fx.length - 1] = { ...fx[fx.length - 1], stop: true } as Effect;
    effects.push(...fx);
    // an alter of a missing object returns RESULT_FAILOTHER, which ends this group's results (but not the list):
    // the later entries never run, so they aren't lifted (object.cpp:1291-1297)
    if (e.class === 'AlterBlock' && alterTargetMissing(e, ctx)) break;
  }
  return when ? { when, do: effects } : { do: effects };
}

export function liftEntry(e: EntryT, ctx: LiftCtx, owner: Owner, pointer: string): Effect[] {
  switch (e.class) {
    case 'ConditionBlock':
      ctx.problems.error(pointer, 'a ConditionBlock among the results');
      return [noop()];
    case 'AlterBlock': {
      if (alterTargetMissing(e, ctx)) {
        ctx.problems.warn(pointer, `no object ${e.target} to alter, so the original skips the rest of this group (object.cpp:1291-1297)`);
        return [noop()];
      }
      const missing: Effect[] = [];
      const a = liftAlter(e, ctx, owner, pointer, missing);
      return [{ alter: a }, ...missing];
    }
    case 'ReactionBlock': return [liftReaction(e, ctx, owner, pointer)];
    case 'CommandBlock': return [liftCommand(e, ctx, owner, pointer)];
    case 'ScreenBlock': return liftScreenBlock(e, ctx, owner, pointer);
    case 'PathBlock': return [liftPath(e, ctx, owner, pointer)];
    case 'GeneralBlock': return liftGeneral(e, ctx, pointer);
    case 'ConversationBlock': return [liftConverse(e, ctx, owner, pointer)];
    case 'BeamBlock': return [liftBeam(e, ctx, pointer)];
    case 'TriggerBlock': return [liftTrigger(e, ctx, pointer)];
    case 'CommunicateBlock': return [liftCommunicate(e, ctx, pointer)];
    case 'ChoiceBlock': return [liftChoice(e, ctx, owner, pointer)];
  }
  const unknown: never = e;
  throw new Error(`unknown entry ${JSON.stringify(unknown)}`);
}

/** alter_anim (object.cpp:1392-1427): 31000+n a sprite, 30000+n play and wait, 29000-29999 or negative stop. */
export function liftAnim(raw: number): AnimFx {
  const anim = (raw << 16) >> 16;
  if (anim >= 31000) return { sprite: anim - 31000 };
  if (anim >= 30000) return { play: anim - 30000, wait: true };
  if (anim >= 29000 || anim < 0) return { stop: true };
  return { play: anim };
}

/** findObject (data.cpp:605-610) finds no object; 0x10 is whoever is acting, who always exists. */
function alterTargetMissing(e: E<'AlterBlock'>, ctx: LiftCtx): boolean {
  const { target } = e;
  return target !== ANYONE_ID && !ctx.raw.objects.has(target);
}

/** A talk string naming a conversation the export lacks (M3 Decision 3): the original would fail opening it. */
export function absentConversation(ctx: LiftCtx, s: string, world: number | null, where: string, dropped = 'this records it as missing'): Effect | null {
  const key = talkConversationKey(s, world);
  if (key === null || ctx.raw.conversations.has(key)) return null;
  ctx.problems.warn(where, `no conversation ${key} in the export: the original would fail opening it (conversation.cpp:246-263), so ${dropped}`);
  return { missing: { kind: 'conversation', id: key } };
}

function liftAlter(e: E<'AlterBlock'>, ctx: LiftCtx, owner: Owner, pointer: string, missing: Effect[]): AlterFx {
  const {
    target, alter_flags, alter_reset, alter_state, x_pos, y_pos, alter_name, alter_hail, alter_timer, alter_anim,
    play_description, universe_x, universe_y, universe_z, voice_id, voice_group, voice_subgroup,
  } = e;
  const { ids, markers, problems } = ctx;
  // 0x10 is whoever is acting (object.cpp:1291-1292)
  const a: AlterFx = { object: target === ANYONE_ID ? ANYONE : ids.object(target, pointer) };
  const enterprise = target === ENTERPRISE_ID;

  if (x_pos !== 0xffff && y_pos !== 0xffff && !enterprise) {
    // on the object's own screen, or the current one for an object with none (alter.ts)
    const object = target === ANYONE_ID ? undefined : ctx.raw.objects.get(target);
    const own = object ? objectScreen(ctx, object)?.slug : undefined;
    a.at = own ? markers.point(own, x_pos, y_pos, pointer) : hereMarker(ctx, owner, x_pos, y_pos, pointer);
    // an item the effect moves can be on another screen when it runs (the sim looks the marker up on the current one),
    // so the position is also a marker of the screen the effect belongs to
    if (own) hereMarker(ctx, owner, x_pos, y_pos, pointer);
  }
  if (universe_x !== 0xffff) {
    // the Enterprise warps there, at the speed in x_pos (object.cpp:1310-1318)
    a.universe = { x: universe_x, y: universe_y, z: universe_z, ...(enterprise && x_pos !== 0xffff ? { speed: x_pos } : {}) };
  }
  // the flags, in AlterBlock::execute's order
  if (alter_flags & 0x08) a.get = true;
  if (alter_flags & 0x04) a.drop = true;
  // (deactivating comes after activating, so both together end inactive)
  if (alter_flags & 0x80) a.active = false;
  else if (alter_reset & 0x01) a.active = true;
  if (alter_reset & ~0x01) problems.warn(pointer, `alter_reset bits 0x${(alter_reset & ~0x01).toString(16)} do nothing in the original`);
  if (alter_flags & 0x01) a.talkTo = true;
  if (alter_flags & 0x40) a.halt = true;
  if (alter_flags & 0x02) problems.warn(pointer, 'alter flag 0x02 (walk) does nothing in the original (object.cpp:1365)');
  // (unstunning comes after stunning)
  if (alter_flags & 0x10) a.stunned = false;
  else if (alter_flags & 0x20) a.stunned = true;

  const said = alter_hail.startsWith('1') ? alter_hail.slice(1) : stripUseWords(alter_hail);
  if (voice_id !== 0xffffffff) {
    const key = voiceKey(voice_group, voice_subgroup, voice_id, talkVoiceType(said));
    if (key) {
      a.voice = key;
      // (a conversation string isn't what the voice says, so it isn't its transcript)
      if (!said.startsWith('@')) ctx.voices.add(key, said, pointer);
    }
  }
  if (alter_timer !== 0xffff) a.timer = alter_timer;
  if (alter_anim !== 0xffff) a.anim = liftAnim(alter_anim);
  if (alter_hail !== '') {
    // (a talk string is read in its object's world, so a ship conversation's alter of an object of a fixed world names that world's
    // conversation, though the conversation itself can run in any; a "1@" hail starts now, in the world of whoever is talking)
    const targetWorld = target === ANYONE_ID ? 0 : parseId(target).world;
    const talkWorld = !alter_hail.startsWith('1') && targetWorld !== 0 ? targetWorld : owner.talkWorld;
    const absent = absentConversation(ctx, said, talkWorld, pointer);
    if (absent) missing.push(absent);
    else if (alter_hail.startsWith('1@')) a.converseNow = convertTalk(said, owner.talkWorld, ids, problems, pointer);
    else if (alter_hail.startsWith('1')) {
      if (said === '') problems.warn(pointer, 'an empty "1" hail says nothing');
      else a.sayNow = said;
    } else a.talk = convertTalk(said, talkWorld, ids, problems, pointer);
  }
  if (alter_name !== '') a.name = alter_name;
  if (alter_state !== 0xff) a.state = alter_state;
  // (any non-zero value, 0xff included: object.cpp:1459-1460)
  if (play_description !== 0) a.describe = true;
  return a;
}

function liftReaction(e: E<'ReactionBlock'>, ctx: LiftCtx, owner: Owner, pointer: string): Effect {
  const { target, dest_world, dest_screen, dest_entrance, target_type, action_type, damage_amount, beam_type, dest_x, dest_y } = e;
  const { problems } = ctx;
  let who: ReactFx['who'];
  switch (target_type) {
    case 1: who = 'actor'; break;
    case 3: who = 'team'; break;
    case 6:
      // (findObject finds nothing, so nobody is picked and the block returns 0: object.cpp:1492-1495, 1515-1516)
      if (!ctx.raw.objects.has(target)) {
        problems.warn(pointer, `reaction target ${target} isn't in the export, so it does nothing (object.cpp:1492-1495, 1515-1516)`);
        return noop();
      }
      who = { object: ctx.ids.object(target, pointer) };
      break;
    case 7: who = 'random'; break;
    default:
      problems.warn(pointer, `reaction target type ${target_type} picks nobody, so it does nothing (object.cpp:1509-1512)`);
      return noop();
  }
  // one bit: a phaser shot for damage, the Chodak transporter for beams (object.cpp:1518-1520)
  const shot = beam_type !== 0 ? { shot: true as const } : {};
  const chodak = beam_type !== 0 ? { chodak: true as const } : {};

  if (damage_amount === 0x7f) return { react: { who, do: 'revive' } };
  if (damage_amount !== 0) return { react: { who, do: { damage: (damage_amount << 24) >> 24 }, ...shot } };
  switch (action_type) {
    case 0: return { react: { who, do: 'stun', ...shot } };
    case 1: return { react: { who, do: 'kill', ...shot } };
    case 2: {
      return { react: { who, do: { beamIn: hereMarker(ctx, owner, dest_x, dest_y, pointer) }, ...chodak } };
    }
    case 3: {
      if (dest_world === 0) return { react: { who, do: 'beamUp', ...chodak } };
      const world = ownerWorld(ctx, owner, pointer);
      if (dest_world !== 0xffff && dest_world !== world) {
        problems.warn(pointer, "the original won't beam to another world (object.cpp:1611-1613)");
        return noop();
      }
      if (dest_entrance === 0xffff) {
        problems.warn(pointer, 'no entrance to beam to');
        return noop();
      }
      const entrance = `entrance_${dest_entrance}`;
      // (the current screen of a list with none: the sim checks its entrances when it runs, object.cpp:1593-1597)
      if (dest_screen === 0xffff && !owner.screen) return { react: { who, do: { beamTo: { entrance } }, ...chodak } };
      const destKey = dest_screen === 0xffff ? ownerScreen(ctx, owner, pointer).key : screenKey(world, dest_screen);
      if (dest_entrance >= (ctx.entrances.get(destKey) ?? 0)) {
        problems.warn(pointer, `no entrance ${dest_entrance} on ${destKey} to beam to`);
        return noop();
      }
      // (member i lands on slot i % 4: entrance_<n>.<i>; Decision 5)
      const screen = dest_screen === 0xffff ? undefined : ctx.ids.screen(world, dest_screen, pointer);
      return { react: { who, do: { beamTo: { ...(screen ? { screen } : {}), entrance } }, ...chodak } };
    }
    default:
      problems.warn(pointer, `reaction action ${action_type} does nothing (object.cpp:1615-1617)`);
      return noop();
  }
}

/**
 * An action's actor as the content names it: 0x10 is the current member (the default), and any id of 0xff
 * (ffffff) is nobody, $none, as CommandBlock::execute (object.cpp:1650-1657) and startAwayTeam
 * (awayteam.cpp:334-336) map only 0x10; getWalker (unity.cpp:876-879) still walks the current member for it.
 */
function actor(ids: LiftCtx['ids'], who: string, pointer: string): string | undefined {
  if (who === ANYONE_ID) return undefined;
  if (parseId(who).id === 0xff) return NONE;
  return ids.object(who, pointer);
}

const VERBS: Readonly<Record<number, ActFx['verb']>> = { 2: 'look', 3: 'get', 4: 'walk', 5: 'talk', 6: 'use' };

function liftCommand(e: E<'CommandBlock'>, ctx: LiftCtx, owner: Owner, pointer: string): Effect {
  const { target, target_x, target_y, command_id } = e;
  const { ids } = ctx;
  const verb = VERBS[command_id];
  if (!verb) {
    return hookCall(ctx, `unity.command.c${command_id}`, {}, `CommandBlock command ${command_id}, which ScummVM ignores with a warning`,
      'engines/unity/object.cpp:1630-1638 (CommandBlock::execute)', pointer);
  }
  const [object, who, other] = target;
  const act: ActFx = { verb };
  // 0x10 as the object is the current member too, as getWalker reads it (unity.cpp:876-886; M3 Decision 6)
  if (object === ANYONE_ID) act.object = ANYONE;
  else if (parseId(object).world !== 0xff) act.object = ids.object(object, pointer);
  // 0x10 is the current member (the default), an id of 0xff nobody; 0x20 whoever is acting now; any other
  // object acts itself, as getWalker returns any object on the screen (unity.cpp:876-886; carry note 37)
  if (who === ACTOR_ID) act.who = ACTOR;
  else {
    const by = actor(ids, who, pointer);
    if (by !== undefined) act.who = by;
  }
  if (other !== NONE_ID) act.other = ids.object(other, pointer);
  if (target_x !== 0xffff && target_y !== 0xffff) act.at = hereMarker(ctx, owner, target_x, target_y, pointer);
  return { act };
}

/**
 * setAdvice (unity.cpp:982-997): 0xfffe turns the advice off; 0xffff leaves that part alone. An interval of 0xfffe
 * with no id does nothing: setAdvice is only called with an id (object.cpp:1680-1691, awayteam.cpp:317-320).
 */
export function adviceSetting(ctx: LiftCtx, world: () => number, id: number, timer: number, where: string): AdviceSetting {
  if (id === 0xfffe || (timer === 0xfffe && id !== 0xffff)) return { off: true };
  return {
    ...(id !== 0xffff ? { id: ctx.ids.advice(world(), id, where) } : {}),
    ...(timer !== 0xffff && timer !== 0xfffe ? { every: timer } : {}),
  };
}

/** kStartupActions (awayteam.cpp:325-327). */
const STARTUP_VERBS: readonly StartupVerb[] = ['use', 'get', 'look', 'get', 'walk', 'talk', 'use'];

export function startupAction(
  ctx: LiftCtx, s: { target: string; action: number; who: string; other: string; x: number; y: number }, screen: string, where: string,
): StartupActionDef | null {
  // (a target id of 0xff means no action: startAwayTeam, awayteam.cpp:323)
  if (parseId(s.target).id === 0xff) return null;
  const verb = STARTUP_VERBS[s.action];
  if (!verb) {
    ctx.problems.warn(where, `unknown startup action ${s.action}, which the original skips`);
    return null;
  }
  const a: StartupActionDef = { verb, target: ctx.ids.object(s.target, where) };
  const by = actor(ctx.ids, s.who, where);
  if (by !== undefined) a.who = by;
  if (s.other !== NONE_ID) a.other = ctx.ids.object(s.other, where);
  if (s.x !== 0xffff && s.y !== 0xffff) a.at = ctx.markers.point(screen, s.x, s.y, where);
  return a;
}

/** A screen change; `key` is null for $current, whose screen (and so its entrance count) isn't known until it runs. */
function screenChange(ctx: LiftCtx, to: string, key: string | null, entrance: number, pointer: string): ScreenFx {
  // 0xff: coming back from a close-up, the team stays where it was (startAwayTeam, awayteam.cpp:307-309).
  // The sim honours `stay` only after a close-up, as the original does; in world 7 every 0xff goes into or
  // out of the close-up s_0704, so the 0x40 and 0x80 bits 0xff also carries never apply (Plan 6 Decision 12).
  if (entrance === 0xff) return { to, entrance: 'entrance_0', stay: true };
  // the low bits are the entrance, 0x40 gathers the team, 0x80 steps in (placeAwayTeam, awayteam.cpp:356-392)
  let index = entrance & 0x0f;
  if (key !== null) {
    const count = Math.max(ctx.entrances.get(key) ?? 0, 1);
    if (index >= count) {
      ctx.problems.warn(pointer, `entrance ${index} is beyond the ${count} of ${key}; the original uses entrance 0 (awayteam.cpp:358-363)`);
      index = 0;
    }
  }
  const fx: ScreenFx = { to, entrance: `entrance_${index}` };
  if (entrance & 0x40) fx.gather = true;
  if (entrance & 0x80) fx.stepIn = true;
  return fx;
}

function liftScreenBlock(e: E<'ScreenBlock'>, ctx: LiftCtx, owner: Owner, pointer: string): Effect[] {
  const {
    new_world, new_screen, new_entrance, advice_screen, new_advice_id, new_advice_timer, startup_screen, startup_target,
    startup_action, startup_who, startup_other, startup_x, startup_y, flags_screen, combadge, closeup, input_blocked,
  } = e;
  const { ids } = ctx;
  const world = () => ownerWorld(ctx, owner, pointer);
  const out: Effect[] = [];

  if (new_world !== 0xffff || new_screen !== 0xff) {
    const dest = new_world === 0xffff ? world() : new_world;
    if (dest === 0 || dest === SHIP_WORLD) {
      // back to the ship; screen 0xfe ends the game, with the entrance as the reason (unity.cpp:1883-1894);
      // only world 0 turns an entrance of 0xff into 0, so world 0x5f keeps 0xff as the reason (object.cpp:1666-1673)
      const reason = dest === 0 && new_entrance === 0xff ? 0 : new_entrance;
      out.push({ screen: { to: SHIP, ...(new_screen === 0xfe ? { gameOver: reason } : {}) } });
    } else if (new_screen === 0xff && !owner.screen && owner.world !== null && dest === owner.world) {
      // the screen the team is on when it runs (M3 Decision 2)
      out.push({ screen: screenChange(ctx, CURRENT, null, new_entrance, pointer) });
    } else if (dest === SPACE_WORLD) {
      // (the space world's screens are battles, not places: the original would start an away team there and fail, so the change is recorded as missing)
      const key = screenKey(dest, new_screen === 0xff ? 0 : new_screen);
      ctx.problems.warn(pointer, `a screen change to ${key}, a battle of the space world: the original would fail starting an away mission there (unity.cpp:1850-1860), so this is recorded as missing`);
      out.push({ missing: { kind: 'screen', id: key } });
    } else {
      const screen = new_screen === 0xff ? ownerScreen(ctx, owner, pointer).number : new_screen;
      out.push({ screen: screenChange(ctx, ctx.ids.screen(dest, screen, pointer), screenKey(dest, screen), new_entrance, pointer) });
    }
  }

  // a startup record is the Nth of w_NNstrt.bst, read on entering screen N: a screen the export lacks is never entered,
  // so its record is never read (getScreenStartup, data.cpp:1163-1192; M3 Decision 4)
  const record = (n: number, what: string): string | undefined => {
    const key = screenKey(world(), n);
    if (ctx.raw.screens.has(key)) return ids.screen(world(), n, pointer);
    ctx.problems.warn(pointer, `${key} isn't in the export, so its startup record (${what}) is never read and this changes nothing (getScreenStartup, data.cpp:1163-1192)`);
    return undefined;
  };

  if (advice_screen === 0xff) {
    // (now, and only with an id: object.cpp:1680-1683)
    if (new_advice_id !== 0xffff) out.push({ advice: adviceSetting(ctx, world, new_advice_id, new_advice_timer, pointer) });
  } else {
    // for the screen's next visit: the id always, the interval if given (object.cpp:1684-1691)
    const screen = record(advice_screen, 'advice');
    if (screen) out.push({ advice: { ...adviceSetting(ctx, world, new_advice_id, new_advice_timer, pointer), screen } });
  }

  if (startup_screen !== 0xffff) {
    const screen = record(startup_screen, 'startup action');
    const s = { target: startup_target, action: startup_action, who: startup_who, other: startup_other, x: startup_x, y: startup_y };
    if (screen) out.push({ startup: { screen, action: startupAction(ctx, s, screen, pointer) } });
  }

  // (setAwayTeamFlags runs even when both are 0xff: unity.cpp:975-980)
  const flag = (b: number) => (b === 0xff ? undefined : b !== 0);
  if (flags_screen === 0xffff) out.push({ awayFlags: compact({ inputBlocked: flag(input_blocked), combadge: flag(combadge) }) });
  else {
    const screen = record(flags_screen, 'flags');
    if (screen) {
      out.push({ awayFlags: compact({ inputBlocked: flag(input_blocked), combadge: flag(combadge), closeup: closeup === 0xff ? undefined : closeup === 1, screen }) });
    }
  }
  return out.length > 0 ? out : [noop()];
}

function liftPath(e: E<'PathBlock'>, ctx: LiftCtx, owner: Owner, pointer: string): Effect {
  const { regions_on, regions_off } = e;
  // (the sim switches them on the current screen; a list with none may run on any screen of its world)
  const screens = owner.screen ? [owner.screen] : owner.world === null && owner.file.startsWith('o_') ? [ownerScreen(ctx, owner, pointer)] : currentScreens(ctx, owner, pointer);
  const known = new Set(screens.flatMap(s => [...(ctx.regions.get(s.slug) ?? [])]));
  // the original sets them in this order, so each region ends as its last change left it (object.cpp:1723-1732)
  const last = new Map<number, boolean>();
  for (let i = 0; i < 4; i++) {
    if (regions_on[i] !== 0xff) last.set(regions_on[i], true);
    if (regions_off[i] !== 0xff) last.set(regions_off[i], false);
  }
  const enable: string[] = [];
  const disable: string[] = [];
  for (const [region, on] of last) {
    if (!known.has(region)) {
      if (owner.screen) ctx.problems.warn(pointer, `no region ${region} on ${owner.screen.slug} (setRegionType only warns)`);
      else if (owner.world !== null) ctx.problems.warn(pointer, `no region ${region} on any screen this list can run on (setRegionType only warns)`);
      continue;
    }
    (on ? enable : disable).push(regionName(region));
  }
  if (enable.length === 0 && disable.length === 0) return noop();
  return { path: { ...(enable.length > 0 ? { enable } : {}), ...(disable.length > 0 ? { disable } : {}) } };
}

function liftGeneral(e: E<'GeneralBlock'>, ctx: LiftCtx, pointer: string): Effect[] {
  const { movie_id, sound_id, command } = e;
  const out: Effect[] = [];
  if (movie_id !== 0xffff) {
    const movie = ctx.raw.movies.movies.find(m => m.id === movie_id);
    if (movie) out.push({ play: { movie: stem(movie.filename) } });
    else {
      ctx.problems.warn(pointer, `no movie ${movie_id} in movie.map: ScummVM asserts on it (object.cpp:1736), so this records it as missing`);
      out.push({ missing: { kind: 'movie', id: String(movie_id) } });
    }
  }
  if (sound_id !== 0xffff) {
    const file = ctx.raw.executable._presetSounds[String(sound_id)];
    if (file !== undefined) out.push({ play: { sound: stem(file) } });
    else ctx.problems.warn(pointer, `no preset sound ${sound_id}, so the original plays nothing`);
  }
  if (command !== 0xffff) out.push(generalCommand(ctx, command, pointer));
  return out.length > 0 ? out : [noop()];
}

/** GeneralBlock::execute's commands (object.cpp:1755-1807): type × 1000 + value. */
function generalCommand(ctx: LiftCtx, command: number, pointer: string): Effect {
  const type = Math.floor(command / 1000);
  const value = command % 1000;
  switch (type) {
    case 1: return { ship: { newWarpMovie: true } };
    case 2: return { ship: { reveal: value } };
    case 3: return { wait: { seconds: value } };
    case 4: return { restartTimers: true };
    case 7: return { ship: { repair: true } };
    case 8: return { ship: { computer: 'record', entry: value } };
    case 9: return { ship: { computer: 'hide', entry: value } };
    case 10: return { ship: { computer: 'show', entry: value } };
    default:
      return hookCall(ctx, `unity.general.g${type}`, { value }, `GeneralBlock command type ${type}, which ScummVM only warns about`,
        'engines/unity/object.cpp:1805-1807 (GeneralBlock::execute)', pointer);
  }
}

const CONVERSE_TO: Readonly<Record<number, 'enabled' | 'disabled' | 'locked'>> = { 2: 'enabled', 3: 'disabled', 4: 'locked' };

function liftConverse(e: E<'ConversationBlock'>, ctx: LiftCtx, owner: Owner, pointer: string): Effect {
  const { world_id, conversation_id, response_id, state_id, action_id } = e;
  // 0xffff is the current world, 0 the ship (object.cpp:1816-1820)
  const world = world_id === 0xffff ? ownerWorld(ctx, owner, pointer) : world_id === 0 ? SHIP_WORLD : world_id;
  const to = CONVERSE_TO[action_id];
  if (!to) {
    // (ConversationBlock::readFrom only allows 2-4; the content model has no "set" here)
    ctx.problems.warn(pointer, `conversation action ${action_id} is none of enable, disable and lock, so it does nothing here`);
    return noop();
  }
  const absent = conversation_id === 0xffff ? conversationKey(world, conversation_id) : undefined;
  if (absent !== undefined) {
    // (a block with every field 0xffff, as the space world's scripts have: getConversation opens a file that isn't there, M3 Decision 3)
    ctx.problems.warn(pointer, `no conversation ${absent} in the export: the original would fail opening it (conversation.cpp:246-263), so this records it as missing`);
    return { missing: { kind: 'conversation', id: absent } };
  }
  const conversation = ctx.ids.conversation(world, conversation_id, pointer);
  // (a response's id is its situation and its state the key: Conversation::setState only warns about a missing one)
  const target = ctx.raw.conversations.get(conversationKey(world, conversation_id));
  if (target && !target.responses.some(r => r.id === response_id && r.state === state_id)) {
    ctx.problems.warn(pointer, `${conversationKey(world, conversation_id)} has no response ${response_id}/${state_id}, so this changes nothing`);
  }
  return { converse: { conversation, situation: response_id, key: state_id, to } };
}

function liftBeam(e: E<'BeamBlock'>, ctx: LiftCtx, pointer: string): Effect {
  const { world_id, screen_id } = e;
  // (0xffff changes nothing; world 0 clears it: object.cpp:1828-1838)
  if (world_id === 0xffff) return noop();
  if (world_id === 0) return { beam: { to: null } };
  if (screen_id === 0xffff) {
    ctx.problems.error(pointer, `a beam to world ${world_id} with no screen`);
    return noop();
  }
  // world 8 is world 5, later (beamDown, awayteam.cpp:112-113)
  const world = world_id === 8 ? 5 : world_id;
  const key = screenKey(world, screen_id);
  if (!ctx.raw.screens.has(key)) {
    // (the original would fail starting the away mission: M3 Decision 3)
    ctx.problems.warn(pointer, `no screen ${key} in the export: the original would fail beaming there, so this beam is recorded as missing`);
    return { missing: { kind: 'screen', id: key } };
  }
  // (the transporter picks the team by the original's number, so a world 8 beam carries it: BeamFx.world)
  return { beam: { to: ctx.ids.screen(world, screen_id, pointer), ...(world_id === 8 ? { world: 8 } : {}) } };
}

function liftTrigger(e: E<'TriggerBlock'>, ctx: LiftCtx, pointer: string): Effect {
  const { trigger_id, enable_trigger } = e;
  const t = ctx.raw.triggers.find(tr => tr.id === trigger_id);
  if (t?.type === 3) {
    ctx.problems.warn(pointer, `trigger ${trigger_id} is unused (type 3) and can never fire, so turning it on or off does nothing`);
    return noop();
  }
  return { trigger: { id: ctx.ids.trigger(trigger_id, pointer), enabled: enable_trigger } };
}

export const BATTLE_HAILS: readonly number[] = [0xa, 0xb, 0x10, 0x11];
/** The hail types that open a ship conversation (CommunicateBlock::execute and dispatchPendingHail: 4, 5, 6 and 8; 7 reads its number only to compare it with 99). */
const CONVERSATION_HAILS: readonly number[] = [4, 5, 6, 8];
const OWN_TALK = 99;

/** A ship conversation the export lacks is `missing` (M3 Decision 3): the original would fail opening it (conversation.cpp:246-263). */
function shipConversation(ctx: LiftCtx, conversation: number, situation: number, type: number, pointer: string): Effect {
  const key = conversationKey(SHIP_WORLD, conversation);
  if (!ctx.raw.conversations.has(key)) {
    ctx.problems.warn(pointer, `no conversation ${key} in the export: the original would fail opening it (conversation.cpp:246-263), so this hail is recorded as missing`);
    return { missing: { kind: 'conversation', id: key } };
  }
  return { communicate: { conversation: ctx.ids.conversation(SHIP_WORLD, conversation, pointer), situation, type } };
}

function liftCommunicate(e: E<'CommunicateBlock'>, ctx: LiftCtx, pointer: string): Effect {
  const { target, conversation_id, situation_id, hail_type } = e;
  if (hail_type === 0xff) return { communicate: { type: 0xff } };
  if (BATTLE_HAILS.includes(hail_type)) {
    // the number is a battle scenario (unity.cpp dispatchPendingHail), from the hailer's talk string when it has one
    const fromTalk = parseId(target).id !== 0xff ? hailNumbers(ctx.raw.objects.get(target)?.talk_string ?? '') : undefined;
    return { communicate: { scenario: fromTalk?.conversation ?? conversation_id, type: hail_type } };
  }
  if (hail_type === 7 && conversation_id === OWN_TALK) {
    // the target's own talk string (dispatchPendingHail), not a ship conversation file
    return parseId(target).id === 0xff ? { communicate: { type: 7 } } : { communicate: { from: ctx.ids.object(target, pointer), type: 7 } };
  }
  if (!CONVERSATION_HAILS.includes(hail_type) && hail_type !== 7) {
    // 0-3 are unused, 9 opens the transporter, the rest are for space combat: none opens a conversation (dispatchPendingHail), and their number is often 0xffff
    return { communicate: { type: hail_type } };
  }
  // the hailer's talk string can name the conversation (object.cpp:1849-1877)
  if (hail_type !== 7 && hail_type !== 8 && parseId(target).id !== 0xff) {
    if (!ctx.raw.objects.has(target)) {
      ctx.problems.warn(pointer, `hailer ${target} isn't in the export, so the original warns and does nothing (object.cpp:1855-1861)`);
      return noop();
    }
    const from = ctx.ids.object(target, pointer);
    const talk = ctx.raw.objects.get(target)?.talk_string ?? '';
    const numbers = hailNumbers(talk);
    if (numbers?.threeFields) {
      ctx.problems.warn(pointer, `${target}'s talk string "${talk}" has three fields, which sscanf("@%d,%d") reads as conversation ${numbers.conversation}, situation ${numbers.situation} (object.cpp:1858)`);
      return { communicate: { conversation: ctx.ids.conversation(SHIP_WORLD, numbers.conversation, pointer), situation: numbers.situation, type: hail_type } };
    }
    if (!ctx.full.has(target)) {
      // a stub has no talk string (Decision 6), so the hail takes the numbers the hailer's file has
      ctx.problems.warn(pointer, `hailer ${target} is a stub, so the hail uses its file's talk string "${talk}" (a later alter of it isn't followed)`);
      if (!numbers) return noop();
      return { communicate: { conversation: ctx.ids.conversation(SHIP_WORLD, numbers.conversation, pointer), situation: numbers.situation, type: hail_type } };
    }
    // (so the closure lifts the ship conversation the sim will look up by number)
    if (numbers && ctx.raw.conversations.has(conversationKey(SHIP_WORLD, numbers.conversation))) {
      ctx.ids.conversation(SHIP_WORLD, numbers.conversation, pointer);
    }
    return { communicate: { from, type: hail_type } };
  }
  return shipConversation(ctx, conversation_id, situation_id, hail_type, pointer);
}

function liftChoice(e: E<'ChoiceBlock'>, ctx: LiftCtx, owner: Owner, pointer: string): Effect {
  const { _questionstring, _choicestring, _choice } = e;
  return {
    choose: {
      question: _questionstring,
      options: [
        { text: _choicestring[0], do: liftGroups(_choice[0], ctx, owner, `${pointer}/_choice/0`) },
        { text: _choicestring[1], do: liftGroups(_choice[1], ctx, owner, `${pointer}/_choice/1`) },
      ],
    },
  };
}
