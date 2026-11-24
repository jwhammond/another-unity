// SPDX-License-Identifier: GPL-3.0-or-later
import type { Line, ObjectDef, PhaserDef, RuleGroup, RuleVerb } from '@another-unity/engine';
import { objectOwner, objectScreen, type LiftCtx, type Owner } from './context';
import { absentConversation, liftGroups } from './effects';
import { isCrewId, NONE_ID, parseId } from './ids';
import type { GameObjectT } from './raw';
import { convertTalk, talkVoiceType } from './talk';
import { resolveVoice, speakerByte, voiceKey } from './voice';

/** What the room file needs to place a hotspot (room.ts). */
export interface HotspotInput {
  object: string;
  screen: string;
  x: number;
  y: number;
  width: number;
  height: number;
  flags: number;
  objwalktype: number;
  spriteId: number;
  /** The raw y_adjust: the row the object is drawn and picked at (-1: its own y). */
  yAdjust: number;
}

export interface LiftedObject {
  def: ObjectDef;
  hotspot?: HotspotInput;
}

/** shipEquipment (awayteam.cpp:89-101): without the transporter room, the team takes these, if active (not the communicator). */
export const START_EQUIPMENT: readonly string[] = ['007000', '007001', '007003', '007004'];

/** Object::loadObject's fields as an ObjectDef; a stub (`full` false) leaves out the rules and phaser data. */
export function liftObject(o: GameObjectT, ctx: LiftCtx, full: boolean): LiftedObject {
  const {
    id, curr_screen, width, height, x, y, flags, state, objwalktype, name, transition, skills, timer, talk_string,
    voice_id, voice_group, voice_subgroup, descriptions, use_entries, get_entries, look_entries, timer_entries,
    phaser_data, sprite_id, universe_x, universe_y, universe_z, y_adjust,
  } = o;
  // (curr_screen is consumed through objectScreen, which places the object; crew and items have none that matters)
  void curr_screen;
  const { world } = parseId(id);
  const where = `o_${id}`;
  const { ids, markers, problems } = ctx;
  const slug = ids.object(id, where);
  const screen = objectScreen(ctx, o);
  const def: ObjectDef = { id: slug, name, screen: screen?.slug ?? null };

  if (screen && x !== -1 && y !== -1) def.at = markers.named(screen.slug, slug, x, y, where);
  // (a place in space: the ship world's Enterprise, planets and stars; 0xffff, or -1, is none)
  if (universe_x !== 0xffff && universe_x !== -1) def.universe = { x: universe_x, y: universe_y, z: universe_z };
  if (state !== 0) def.state = state;
  if ((flags & 0x20) === 0) def.active = false;
  if (flags & 0x40 || (START_EQUIPMENT.includes(id) && flags & 0x20)) def.inventory = true;
  if (isCrewId(id)) def.crew = true;
  if (flags & 0x80) problems.error(where, "starts stunned (flag 0x80), which the content model can't express");
  // a stub names nothing else, so the closure stops at it (Decision 6); it has no skills or timer either
  if (full && skills !== 0) def.skills = skills;
  if (full && timer !== 0 && timer !== 0xffff) def.timer = timer;
  if (full && transition !== NONE_ID) {
    if (ctx.raw.objects.has(transition)) def.transition = ids.object(transition, where);
    else problems.warn(where, `no object ${transition} in the export: the original would fail following it (unity.cpp:1970), so the transition is dropped`);
  }
  if (full && talk_string !== '' && !absentConversation(ctx, talk_string, world, `${where}#/talk_string`, 'the talk string is dropped')) {
    def.talk = convertTalk(talk_string, world, ids, problems, `${where}#/talk_string`);
    const key = voiceKey(voice_group, voice_subgroup, voice_id, talkVoiceType(talk_string));
    if (key) {
      def.talkVoice = key;
      ctx.voices.add(key, talk_string, where);
    }
  }
  if (width !== -1 && screen) def.width = markers.distance(screen.slug, width, y, `${where} width`);
  // (the TALK walk-up's raw width, unity.cpp:2028: -1, read into an unsigned int, is ~0, which means none)
  if (width !== -1) def.pixelWidth = width;
  if (objwalktype === 3) def.actionSquare = parseId(id).id;
  const lines = full ? liftDescriptions(descriptions, ctx, where) : undefined;
  if (lines) def.descriptions = lines;

  if (full) {
    const owner = objectOwner(ctx, o);
    if (phaser_data) def.phaser = liftPhaser(phaser_data, ctx, owner, slug, where);
    const on: Partial<Record<RuleVerb, RuleGroup[]>> = {};
    const lists = [['use', use_entries, 'use_entries'], ['get', get_entries, 'get_entries'], ['look', look_entries, 'look_entries'], ['timer', timer_entries, 'timer_entries']] as const;
    for (const [verb, list, key] of lists) {
      ids.list(`${where}#/${key}`, `${slug}/${verb}`);
      if (list.length > 0) on[verb] = liftGroups(list, ctx, owner, `${where}#/${key}`);
    }
    if (Object.keys(on).length > 0) def.on = on;
  }

  const hotspot = screen && x !== -1 && y !== -1
    ? { object: slug, screen: screen.slug, x, y, width, height, flags, objwalktype, spriteId: sprite_id, yAdjust: y_adjust }
    : undefined;
  return hotspot ? { def, hotspot } : { def };
}

/** playDescriptionFor (unity.cpp:1105-1119): the first description for the crew member looking. */
function liftDescriptions(list: GameObjectT['descriptions'], ctx: LiftCtx, where: string): Record<string, Line> | undefined {
  const out: Record<string, Line> = {};
  for (const d of list) {
    const { entry_id, text, voice_id, voice_group, voice_subgroup } = d;
    const crew = ctx.crew.get(entry_id);
    if (!crew) {
      ctx.problems.warn(where, `a description for crew member ${entry_id}, who isn't in the export`);
      continue;
    }
    if (out[crew]) continue;
    const key = voiceKey(voice_group, voice_subgroup, voice_id, 'l');
    const voice = key ? resolveVoice(key, speakerByte(entry_id)) : undefined;
    if (voice) ctx.voices.add(voice, text, where);
    out[crew] = voice ? { text, voice } : { text };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function liftPhaser(p: NonNullable<GameObjectT['phaser_data']>, ctx: LiftCtx, owner: Owner, slug: string, where: string): PhaserDef {
  const { max_health, threshold, damage_setting, gtp_setting, gtp_min_setting, stun_entries, gtp_entries, kill_entries } = p;
  // gtp_setting is "up to" (-1 unset), gtp_min_setting "from" (awayteam.cpp:1233-1242)
  const def: PhaserDef = { health: max_health, threshold, damageFrom: damage_setting, gtpFrom: gtp_min_setting };
  if (gtp_setting !== -1) def.gtpUpTo = gtp_setting;
  const on: NonNullable<PhaserDef['on']> = {};
  const lists = [['stun', stun_entries, 'stun_entries'], ['gtp', gtp_entries, 'gtp_entries'], ['kill', kill_entries, 'kill_entries']] as const;
  for (const [name, list, key] of lists) {
    ctx.ids.list(`${where}#/phaser_data/${key}`, `${slug}/phaser/${name}`);
    if (list.length > 0) on[name] = liftGroups(list, ctx, owner, `${where}#/phaser_data/${key}`);
  }
  if (Object.keys(on).length > 0) def.on = on;
  return def;
}
