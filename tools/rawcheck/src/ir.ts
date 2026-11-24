// SPDX-License-Identifier: GPL-3.0-or-later
import { COMBAT_CUE_NAMES, CONSOLE_TEXT_NAMES, type CombatCueName, type ConsoleTextName } from '@another-unity/engine';
import { z } from 'zod';
import { ConversationId, ObjectId, ScreenId, WorldId } from './manifest';

const int = z.number().int();
export const u8 = int.min(0).max(0xff);
export const u16 = int.min(0).max(0xffff);
export const u32 = int.min(0).max(0xffffffff);
export const s8 = int.min(-128).max(127);
export const s16 = int.min(-32768).max(32767);
const four = <T extends z.ZodTypeAny>(t: T) => z.array(t).length(4);
const header = { _order: s8, _stopHere: u8 };

export const ConditionBlock = z.object({
  class: z.literal('ConditionBlock'), ...header,
  target: ObjectId, WhoCan: ObjectId,
  how_close_dist: u16, how_close_x: u16, how_close_y: u16, skill_check: u16,
  counter_value: u16, counter_when: u8,
  condition: four(ObjectId), check_x: four(u16), check_y: four(u16), check_unknown: four(u16),
  check_univ_x: four(u16), check_univ_y: four(u16), check_univ_z: four(u16),
  check_screen: four(u8), check_status: four(u8), check_state: four(u8),
}).strict();

export const AlterBlock = z.object({
  class: z.literal('AlterBlock'), ...header,
  target: ObjectId, alter_flags: u8, alter_reset: u8, alter_state: u8, x_pos: u16, y_pos: u16,
  alter_name: z.string(), alter_hail: z.string(), alter_timer: u16, alter_anim: u16,
  play_description: u8, y_adjust: u16, cursor_id: u8, cursor_flag: u8,
  universe_x: u16, universe_y: u16, universe_z: u16, voice_id: u32, voice_group: u32, voice_subgroup: u16,
}).strict();

export const ReactionBlock = z.object({
  class: z.literal('ReactionBlock'), ...header,
  target: ObjectId, dest_world: u16, dest_screen: u16, dest_entrance: u16, target_type: u8,
  action_type: u8, damage_amount: u8, beam_type: u8, dest_x: u16, dest_y: u16, dest_unknown: u16,
}).strict();

export const CommandBlock = z.object({
  class: z.literal('CommandBlock'), ...header,
  target: z.array(ObjectId).length(3), target_x: u16, target_y: u16, command_id: u32,
}).strict();

export const ScreenBlock = z.object({
  class: z.literal('ScreenBlock'), ...header,
  new_world: u16, new_screen: u8, new_entrance: u8, advice_screen: u8, new_advice_id: u16,
  new_advice_timer: u16, startup_screen: u16, startup_target: ObjectId, startup_action: u8,
  startup_who: ObjectId, startup_other: ObjectId, startup_x: u16, startup_y: u16,
  flags_screen: u16, combadge: u8, closeup: u8, input_blocked: u8,
}).strict();

export const PathBlock = z.object({
  class: z.literal('PathBlock'), ...header, regions_on: four(u8), regions_off: four(u8),
}).strict();

export const GeneralBlock = z.object({
  class: z.literal('GeneralBlock'), ...header, movie_id: u16, sound_id: u16, command: u16,
}).strict();

export const ConversationBlock = z.object({
  class: z.literal('ConversationBlock'), ...header,
  world_id: u16, conversation_id: u16, response_id: u16, state_id: u16, action_id: u16,
}).strict();

export const BeamBlock = z.object({
  class: z.literal('BeamBlock'), ...header, world_id: u16, unknown1: u16, unknown3: u16, screen_id: u16,
}).strict();

export const TriggerBlock = z.object({
  class: z.literal('TriggerBlock'), ...header, trigger_id: u32, enable_trigger: z.boolean(),
}).strict();

export const CommunicateBlock = z.object({
  class: z.literal('CommunicateBlock'), ...header,
  target: ObjectId, conversation_id: u16, situation_id: u16, hail_type: u8,
}).strict();

const NonChoiceEntry = z.union([
  ConditionBlock, AlterBlock, ReactionBlock, CommandBlock, ScreenBlock, PathBlock,
  GeneralBlock, ConversationBlock, BeamBlock, TriggerBlock, CommunicateBlock,
]);
type NonChoiceEntryT = z.infer<typeof NonChoiceEntry>;

export interface ChoiceBlockT {
  class: 'ChoiceBlock';
  _order: number;
  _stopHere: number;
  _boxX: number;
  _boxY: number;
  _object: string;
  _questionstring: string;
  _choicestring: string[];
  _choice: EntryListT[];
}
export type EntryT = NonChoiceEntryT | ChoiceBlockT;
/** An entry list: groups, each in execution order. */
export type EntryListT = EntryT[][];

export const EntryList: z.ZodType<EntryListT> = z.lazy(() => z.array(z.array(Entry)));

export const ChoiceBlock: z.ZodType<ChoiceBlockT> = z.object({
  class: z.literal('ChoiceBlock'), ...header,
  _boxX: u16, _boxY: u16, _object: ObjectId, _questionstring: z.string(),
  _choicestring: z.array(z.string()).length(2), _choice: z.array(EntryList).length(2),
}).strict();

export const Entry: z.ZodType<EntryT> = z.union([NonChoiceEntry, ChoiceBlock]);

export const ALL_BLOCK_CLASSES = [
  'AlterBlock', 'BeamBlock', 'ChoiceBlock', 'CommandBlock', 'CommunicateBlock', 'ConditionBlock',
  'ConversationBlock', 'GeneralBlock', 'PathBlock', 'ReactionBlock', 'ScreenBlock', 'TriggerBlock',
] as const;

export const Description = z.object({
  entry_id: u32, text: z.string(), voice_id: u32, voice_group: u32, voice_subgroup: u32,
}).strict();

export const PhaserData = z.object({
  max_health: s8, threshold: s8, damage_setting: s8, gtp_setting: s8, gtp_min_setting: s8,
  stun_entries: EntryList, gtp_entries: EntryList, kill_entries: EntryList,
}).strict();

export const GameObject = z.object({
  id: ObjectId, curr_screen: u8,
  width: s16, height: s16, x: s16, y: s16, z: s16, universe_x: s16, universe_y: s16, universe_z: s16,
  y_adjust: s16, anim_index: u16, sprite_id: u16, region_id: u32, flags: u8, state: u8,
  objwalktype: u8, name: z.string(), transition: ObjectId, skills: u16, timer: u16,
  talk_string: z.string(), use_verb: z.string(), use_preposition: z.string(),
  voice_id: u32, voice_group: u32, voice_subgroup: u16, cursor_id: u8, cursor_flag: u8,
  descriptions: z.array(Description),
  use_entries: EntryList, get_entries: EntryList, look_entries: EntryList, timer_entries: EntryList,
  phaser_data: PhaserData.nullable(),
}).strict();
export type GameObjectT = z.infer<typeof GameObject>;

/** Every class used in some lists, including inside choices' branches. */
export function entryClasses(lists: EntryListT[], into = new Set<string>()): Set<string> {
  for (const list of lists) {
    for (const group of list) {
      for (const entry of group) {
        into.add(entry.class);
        if (entry.class === 'ChoiceBlock') entryClasses(entry._choice, into);
      }
    }
  }
  return into;
}

/** An object's lists: use, get, look, timer, then stun, gtp, kill if it has phaser data. */
export function objectLists(o: GameObjectT): EntryListT[] {
  const lists = [o.use_entries, o.get_entries, o.look_entries, o.timer_entries];
  if (o.phaser_data) lists.push(o.phaser_data.stun_entries, o.phaser_data.gtp_entries, o.phaser_data.kill_entries);
  return lists;
}

export const ConversationFile = z.object({
  id: ConversationId, our_world: u16, our_id: u16,
  responses: z.array(z.object({
    id: u16, state: u16, text: z.string(), voice_tags: z.string(),
    response_state: int.min(1).max(4), next_situation: u16, target: ObjectId,
    voice_id: u32, voice_group: u32, voice_subgroup: u16,
    whocansayblocks: z.array(z.object({ whocansay: ObjectId }).strict()),
    textblocks: z.array(z.object({
      text: z.string(), continued: z.boolean(), voice_id: u32, voice_group: u32, voice_subgroup: u16,
    }).strict()),
    changeactions: z.array(z.object({ type: int.min(0x30).max(0x33), response_id: u16, state_id: u16 }).strict()),
    results: z.array(EntryList),
  }).strict()),
}).strict();
export type ConversationFileT = z.infer<typeof ConversationFile>;

const Point = z.object({ x: s16, y: s16 }).strict();

export const ScreenFile = z.object({
  id: ScreenId, world: u8, screen: u8,
  objects: z.array(ObjectId).nullable(),
  location: z.object({
    background: z.string(), polygons: z.string(),
    entrypoints: z.array(z.array(Point).length(4)),
  }).strict().nullable(),
  polygons: z.array(z.object({
    id: u32, type: u8, points: z.array(Point), distances: z.array(u16),
  }).strict()),
}).strict();
export type ScreenFileT = z.infer<typeof ScreenFile>;

const AdviceLine = z.object({ name: z.string(), text: z.string() }).strict();

export const WorldFile = z.object({
  id: WorldId, world: u8,
  startups: z.array(z.object({
    advice_id: u16, advice_timer: u16, closeup: u8, combadge: u8, input_blocked: u8,
    screen: u16, target: ObjectId, who: ObjectId, other: ObjectId, action: u8, x: u16, y: u16,
  }).strict()),
  advice: z.record(z.string().regex(/^\d+$/), z.object({ easy: z.array(AdviceLine), hard: z.array(AdviceLine) }).strict()).nullable(),
}).strict();
export type WorldFileT = z.infer<typeof WorldFile>;

export const TriggersFile = z.array(z.object({
  id: u32, type: int.min(0).max(3), target: ObjectId, enabled: z.boolean(), context: int.min(0).max(1),
  timer_start: u32,
  dist: u16.nullable(), from: ObjectId.nullable(), to: ObjectId.nullable(),
  reversed: z.boolean().nullable(), instant: z.boolean().nullable(),
}).strict());

export const PhaserMap = z.object({ file: z.literal('phaser.map'), _phaserableObjects: z.array(ObjectId) }).strict();
export const IconMap = z.object({ file: z.literal('icon.map'), _iconSprites: z.record(ObjectId, z.string()) }).strict();
export const MovieMap = z.object({
  file: z.literal('movie.map'),
  movies: z.array(z.object({ id: u32, filename: z.string(), description: z.string() }).strict()),
}).strict();
export const SpriteList = z.object({ file: z.literal('sprite.lst'), _spriteFilenames: z.array(z.string()) }).strict();
export const AstStatFile = z.object({
  file: z.literal('ast_stat.dat'), offset: u32, count: u32, _flags: z.array(u16),
}).strict();

/** A ShipSystems unit as ShipSystems::load reads it (ship.cpp:51-85): the Enterprise's (_shipUnits) and every other ship's (_enemyShip). */
export const ShipUnitIR = z.object({
  name: z.string(), type: int, depth: int, paletteIndex: int, current: int, target: int, max: int,
  chargeTicks: int, dischargeTicks: int, damage: int, repair: int, baseDamage: int, maxDamage: int,
  efficiency: int, hitWeight: int,
}).strict();
const float32 = z.number().finite();

const Numbered = z.record(z.string().regex(/^\d+$/), z.string());
export const ExecutableFile = z.object({
  file: z.literal('sttng.ovl'),
  _presetSounds: Numbered, _adviceNames: Numbered,
  _crewVoices: z.array(u32), _leaderOrder: z.array(u32),
  _awayTeamScreenData: z.array(z.object({ defaultMembers: z.array(ObjectId), inventoryItems: z.array(ObjectId) }).strict()),
  _failHailEntries: z.array(z.object({ actionId: u32, source: ObjectId, failFlag: u32, hail: z.string() }).strict()),
  _actionStrings: z.array(z.string()),
  _transporterTargets: z.array(z.object({ x: s16, y: s16 }).strict()),
  _tricorderReadings: z.array(z.object({ key: u32, parent: u32, entry: u32 }).strict()),
  _computerEntryIds: z.array(s16),
  _backgroundSoundDefaults: z.array(z.object({ formatString: z.string(), first: u32, last: u32 }).strict()),
  _phaserMuzzles: z.array(z.object({ x: s16, y: s16, frame: s16 }).strict()),
  _scriptedWarps: z.array(z.object({ code: u32, sector: s16, star: s16, planet: s16, type: s16, index: s16 }).strict()),
  _planetOrbits: z.array(s16),
  _transporterPads: z.array(z.object({
    rect: z.object({ left: s16, top: s16, right: s16, bottom: s16 }).strict(),
    stand: z.object({ x: s16, y: s16 }).strict(), scale: u32,
  }).strict()),
  _transporterSpriteNames: z.array(z.string()),
  _transporterWalkOn: z.array(z.object({ x: s16, y: s16, direction: int, scale: u32 }).strict()),
  _transporterWalkOff: z.array(z.object({ x: s16, y: s16, direction: int, scale: u32 }).strict()),
  _bridgeItems: z.array(z.object({ id: ObjectId, x: u32, y: u32, width: u32, height: u32, action: u32, depth: u32, description: z.string() }).strict()),
  _bridgeObjects: z.array(z.object({ id: ObjectId, x: u32, y: u32, depth: int, filename: z.string() }).strict()),
  _bridgeScreenEntries: z.array(z.object({ code: u32, text: z.string() }).strict()),
  _transporterExits: z.array(z.object({ code: u32, text: z.string() }).strict()),
  _warpSpeeds: z.array(u32), _impulseSpeeds: z.array(u32),
  _sectorRegions: z.array(s16), _regionChatter: z.array(s16),
  _astroReveals: z.array(u32), _warpMovies: z.array(z.string()),
  _encounterThresholds: z.array(s16), _hazardDamage: z.array(s16), _hazardVoices: z.array(z.string()),
  _shipUnits: z.array(ShipUnitIR),
  _enemyShip: z.array(ShipUnitIR),
  _combatShips: z.array(z.object({ base: z.string(), maxSpeed: int, detailDistance: int, reducedDistance: int }).strict()),
  _flightTurns: z.array(int), _flightSpeeds: z.array(float32), _flightTurnScales: z.array(float32),
  _cues: z.array(z.object({ speaker: int, filename: z.string(), gap: int }).strict()),
  _arrowCursor: z.object({ width: u32, height: u32, hotspotX: u32, hotspotY: u32, pixels: z.array(u8) }).strict(),
}).strict();

/** A constant ScummVM hard-codes, with the lines it is on in the unity-engine branch (Plan 18 R1). */
const cited = <T extends z.ZodTypeAny>(value: T) =>
  z.object({ source: z.string().regex(/^[a-z_0-9]+\.(?:cpp|h):\d+(?:-\d+)?$/), value }).strict();
const ints = (n: number) => z.array(int).length(n);
const rows = (n: number, width: number) => z.array(ints(width)).length(n);

/** combat.json: what space combat reads that isn't in sttng.ovl (Plan 18 Task 2). Numbers are raw (R3). */
export const CombatFile = z.object({
  file: z.literal('scummvm'),
  _powerLevels: z.array(z.array(int)).length(5),
  archive: z.array(z.string()),
  kShipKinds: cited(z.array(z.object({ name: z.string(), flags: u32 }).strict()).length(10)),
  kContactCues: cited(ints(10)),
  kDestroyedCues: cited(ints(10)),
  kTargetCues: cited(ints(10)),
  kSurpriseObjects: cited(z.object({ screen: u8, ids: z.array(u8) }).strict()),
  kEnterpriseHitLists: cited(rows(8, 14)),
  kOtherHitLists: cited(rows(6, 14)),
  kRaceBits: cited(z.object({ shield: u8, phaser: u8, photon: u8, phaserSound: u8, photonSound: u8 }).strict()),
  kRaces: cited(z.array(z.object({ letter: z.string().length(1), mask: u8 }).strict()).length(10)),
  kEnterprisePhasers: cited(rows(6, 3)),
  kOtherPhasers: cited(rows(2, 3)),
  kWeaponUnits: cited(z.object({ enterprisePhaser: u8, otherPhaser: u8, enterpriseTube: u8, otherTube: u8 }).strict()),
  kTacticOverrides: cited(z.array(z.object({ object: u32, file: z.string() }).strict())),
  kClassNames: cited(z.array(z.string()).length(10)),
  kScannerImages: cited(ints(10)),
  kEnterpriseAreas: cited(rows(11, 4)),
  kOtherAreas: cited(rows(11, 4)),
  kRadarColours: cited(z.array(u8).length(10)),
  // (Plan 23 R1: kBearing, kShieldNames, and every cue combat plays by a literal id, each cited by the line that plays it)
  kBearing: cited(rows(8, 3)),
  kShieldNames: cited(z.array(z.string()).length(8)),
  kCueIds: z.object(Object.fromEntries(COMBAT_CUE_NAMES.map(n => [n, cited(int)])) as Record<CombatCueName, ReturnType<typeof cited<typeof int>>>).strict(),
  // (Plan 27 R15: the console's own words, each cited by the line that draws it; an export before Plan 27 has none)
  kConsoleText: z.object(Object.fromEntries(CONSOLE_TEXT_NAMES.map(n => [n, cited(z.string())])) as Record<ConsoleTextName, ReturnType<typeof cited<z.ZodString>>>).strict().optional(),
}).strict();
export type CombatFileT = z.infer<typeof CombatFile>;

/** trig.json (Plan 22 Task 1): sinf and cosf of each whole angle, 16384 to a turn, as ScummVM's build computes them (space3d.cpp:33-36). */
export const TrigFile = z.object({
  file: z.literal('scummvm'),
  sin: z.array(float32).length(0x4000),
  cos: z.array(float32).length(0x4000),
}).strict();
export type TrigFileT = z.infer<typeof TrigFile>;
