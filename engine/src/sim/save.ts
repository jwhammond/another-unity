// SPDX-License-Identifier: GPL-3.0-or-later
import { z } from 'zod';
import { adviceSettingSchema, responseStateSchema, shipFxSchema, startupActionSchema } from '../content/schema';
import { parseConversationString } from '../content/talkString';
import { ANYONE, NONE, type GameContent } from '../content/types';
import { newComputerState } from './computer';
import { normalizeSeed } from './rng';
import { newShipState, returnAwayTeam, SHIP_TOUR, STATION_CODE } from './ship';
import { newSystems } from './shipSystems';
import { conversationShape, STATE_VERSION, type WorldState } from './state';
import type { ShipFx } from '../content/types';

export class SaveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SaveError';
  }
}

const vec2 = z.object({ x: z.number(), z: z.number() }).strict();
const vec3 = z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }).strict();
const idx = z.number().int().min(-1);
const astroLocation = z.object({ sector: idx, star: idx, planet: idx, moon: idx, station: idx, phenomenon: idx }).strict();
const stationSchema = z.enum(Object.keys(STATION_CODE) as [keyof typeof STATION_CODE, ...(keyof typeof STATION_CODE)[]]);
const shipSchema = z.object({
  station: stationSchema,
  pos: vec3,
  orbit: z.number().int(),
  location: astroLocation,
  locationType: z.number().int(),
  transit: z.object({
    from: vec3, to: vec3, orbit: z.number().int(),
    destination: astroLocation, destType: z.number().int(), destStarId: z.number().int(),
    warp: z.boolean(), speed: z.number(), startTick: z.number().int().nonnegative(), ticks: z.number().int().nonnegative(),
  }).strict().nullable(),
  clockStopped: z.number().int().nonnegative(),
  lastSector: z.number().int(),
  flags: z.array(z.number().int()),
  visits: z.object({ first: z.boolean(), second: z.boolean() }).strict(),
  battleScenario: z.number().int(),
  viewscreenTarget: z.string().nullable(),
  equipment: z.array(z.string()).nullable(),
  lastTriggerCheck: z.number().int().nonnegative(),
  bridgeUse: z.string().nullable(),
  warpPending: z.boolean(),
  scriptedWarp: z.number().int().nullable(),
  warpSpeed: z.number(),
  universeMoves: z.array(z.object({ object: z.string(), start: z.number().int(), from: vec3, to: vec3 }).strict()),
  awaySince: z.number().int().nonnegative().nullable(),
  newWarpMovie: z.boolean(),
  warpMoviesSeen: z.number().int().nonnegative(),
  combat: z.object({
    scenario: z.number().int(),
    enterprise: z.string(),
    enemies: z.array(z.string()),
    friends: z.array(z.string()),
    destroyed: z.array(z.string()),
    warped: z.boolean(),
    redAlert: z.boolean(),
  }).strict().nullable(),
  // (a save from before the sensor records has none)
  sensorRecords: z.array(astroLocation).default([]),
  sensorScroll: z.number().int().nonnegative().default(0),
  lastSensorRecord: astroLocation.default({ sector: -1, star: -1, planet: -1, moon: -1, station: -1, phenomenon: -1 }),
  // (a save from before the holodeck has seen the ship's tour only, as a new game has)
  seenMovies: z.array(z.string()).default([SHIP_TOUR]),
  // (a save from before engineering has none: the ship's systems start as new, below)
  systems: z.object({
    units: z.array(z.object({
      current: z.number().int(), target: z.number().int(), max: z.number().int(), damage: z.number().int(), repair: z.number().int(),
      efficiency: z.number().int(), nextStep: z.number().int().nonnegative(), nextRepair: z.number().int().nonnegative(),
      // (combat's working fields, Plan 20: absent until a battle sets them)
      hitWeight: z.number().int().optional(), aiTarget: z.number().int().optional(), aiCap: z.number().int().optional(),
    }).strict()),
    pool: z.number().int(), torpedoes: z.number().int(), matterAntimatterOutput: z.number().int(), fusionOutput: z.number().int(),
    lastReactorTick: z.number().int().nonnegative(), lastTick: z.number().int().nonnegative(),
  }).strict().default(() => newSystems(undefined)),
}).strict();

const worldStateSchema: z.ZodType<WorldState, z.ZodTypeDef, unknown> = z.object({
  version: z.number().int(),
  tick: z.number().int().nonnegative(),
  rngSeed: z.number().int(),
  screen: z.string(),
  awayTeam: z.array(z.string()),
  currentActor: z.string(),
  objects: z.record(z.object({
    screen: z.string().nullable(),
    pos: vec2,
    state: z.number().int(),
    active: z.boolean(),
    inventory: z.boolean(),
    stunned: z.boolean(),
    name: z.string(),
    timer: z.number().nonnegative(),
    timerDue: z.number().int().nonnegative(),
    talk: z.string(),
    talkVoice: z.string().nullable(),
    universe: vec3.optional(),
    anim: z.number().int().optional(),
  }).strict()),
  regions: z.record(z.record(z.boolean())),
  triggers: z.record(z.object({ enabled: z.boolean(), due: z.number().int().nonnegative() }).strict()),
  counters: z.record(z.number().int()),
  pendingScreen: z.object({
    to: z.string(),
    entrance: z.string(),
    stepIn: z.boolean().optional(),
    stay: z.boolean().optional(),
    gameOver: z.number().int().optional(),
  }).strict().nullable(),
  phaser: z.record(z.object({
    health: z.number().int(),
    stunned: z.boolean(),
    regenAt: z.number().int().nonnegative(),
    destroyed: z.boolean(),
  }).strict()),
  phaserSetting: z.number().int().min(0).max(3),
  conversations: z.record(z.array(responseStateSchema)),
  conversationShapes: z.record(z.string()),
  advice: z.object({ id: z.string().nullable(), every: z.number().nonnegative(), due: z.number().int().nonnegative() }).strict(),
  awayFlags: z.object({ inputBlocked: z.boolean(), combadge: z.boolean() }).strict(),
  startups: z.record(z.object({
    advice: adviceSettingSchema,
    closeup: z.boolean(),
    combadge: z.boolean().nullable(),
    inputBlocked: z.boolean().nullable(),
    action: startupActionSchema.nullable(),
  }).strict()),
  onCloseup: z.boolean(),
  pendingHail: z.object({
    from: z.string().nullable(),
    conversation: z.string().nullable(),
    situation: z.number().int(),
    type: z.number().int(),
    scenario: z.number().int().optional(),
  }).strict().nullable(),
  beamTarget: z.string().nullable(),
  readings: z.array(z.object({ world: z.string(), group: z.number().int() }).strict()),
  computer: z.object({ hidden: z.array(z.number().int().nonnegative()), readings: z.array(z.number().int()) }).strict(),
  adviceMode: z.number().int(),
  conversationLog: z.array(z.array(z.object({ speaker: z.string().nullable(), text: z.string() }).strict())),
  beamWorld: z.number().int().min(1).max(8).nullable(),
  // (a save from before this field has no list: nothing is known to be loaded, so a reaction brings what it names)
  spritesLoaded: z.array(z.string()).default([]),
  onShip: z.object({ gameOver: z.number().int().nullable() }).strict().nullable(),
  ship: shipSchema,
}).strict();

/** UnityEngine::canSaveGameStateCurrently's refusal in a battle (save.cpp:156-159): ScummVM's own words. */
export const COMBAT_SAVE_REFUSED = "You can't save during combat.";

/**
 * The state as a save's text. The ship's units lose combat's working fields, hitWeight, aiTarget and aiCap, as
 * ShipSystems::sync saves only current, target, max, damage, repair and efficiency (ship.cpp:267-276): a load has
 * the template's, as absent means (shipSystems.ts UnitState; Plan 23 R4).
 */
export function serializeState(s: WorldState): string {
  return JSON.stringify(s, (key, value: unknown) => {
    if (key !== 'units' || !Array.isArray(value)) return value;
    return value.map((u: unknown) => {
      if (u === null || typeof u !== 'object' || !('nextRepair' in u)) return u;
      const { hitWeight: _h, aiTarget: _t, aiCap: _c, ...kept } = u as Record<string, unknown>;
      return kept;
    });
  });
}

/** What a save holds, and the ship effects a v3 save had queued: they apply once, in order, as the world loads (R1). */
export interface LoadedSave { state: WorldState; queued: ShipFx[] }

export function deserializeState(text: string, content: GameContent): WorldState {
  return deserializeSave(text, content).state;
}

export function deserializeSave(text: string, content: GameContent): LoadedSave {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new SaveError('save is not valid JSON');
  }
  const version = (data as { version?: unknown } | null)?.version;
  if (typeof version !== 'number') throw new SaveError('save has no version');
  if (version > STATE_VERSION) throw new SaveError(`save version ${version} is newer than this engine (${STATE_VERSION})`);
  if (version < 2) throw new SaveError(`save version ${version} is older than any this engine reads`);
  if (version === 2) data = migrateV2(data, content);
  let queued: ShipFx[] = [];
  if (version <= 3) ({ data, queued } = migrateV3(data, content));

  const result = worldStateSchema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new SaveError(`save is malformed: ${issue.path.join('.')}: ${issue.message}`);
  }
  const state = result.data;
  // (an older save may carry combat's working fields: ShipSystems::sync never loads them, so the template's apply)
  for (const u of state.ship.systems.units) { delete u.hitWeight; delete u.aiTarget; delete u.aiCap; }
  // (units are by index: a save made with another ship's units starts afresh)
  const units = content.ship?.data.units.length ?? 0;
  if (state.ship.systems.units.length !== units) state.ship.systems = newSystems(content.ship);
  checkMatchesContent(state, content);
  for (const fx of queued) {
    if ('universe' in fx && !Object.hasOwn(state.objects, fx.universe.object)) {
      throw new SaveError(`save does not match this game: a ship effect names unknown object "${fx.universe.object}"`);
    }
  }
  // (v2's applyScreenChange never ran endAwayTeam: a save taken back aboard still has its team, kit and wounds)
  if (version === 2 && state.onShip !== null) returnAwayTeam(state, content, state.tick);
  if (state.pendingScreen !== null) throw new SaveError('save has a screen change pending');
  state.rngSeed = normalizeSeed(state.rngSeed);
  return { state, queued };
}

/**
 * A v2 save has no ship: it gets a new one (R4), and the ship world's objects their positions in space. One taken
 * back aboard (`onShip` set) is on the bridge, where the ship's own state starts.
 */
function migrateV2(data: unknown, content: GameContent): unknown {
  const old = data as Record<string, unknown>;
  const ship = newShipState(content);
  const objects = Object.fromEntries(Object.entries((old.objects ?? {}) as Record<string, Record<string, unknown>>).map(([id, o]) => {
    const u = content.objects[id]?.universe;
    return [id, u ? { ...o, universe: { ...u } } : o];
  }));
  const ent = content.ship?.data.astro.enterprise;
  if (ent && objects[ent]) objects[ent] = { ...objects[ent], universe: { ...ship.pos } };
  return { ...old, version: 3, objects, ship };
}

/**
 * v3 to v4 (R1): the ship's new fields, the computer, the advice mode, the conversation log and the beam's world take
 * their starting values; `shipQueue` goes, and its effects are handed back to be applied once.
 */
function migrateV3(data: unknown, content: GameContent): { data: unknown; queued: ShipFx[] } {
  const { shipQueue, ...old } = data as Record<string, unknown> & { shipQueue?: unknown };
  const parsed = z.array(shipFxSchema).safeParse(shipQueue ?? []);
  if (!parsed.success) throw new SaveError(`save is malformed: shipQueue: ${parsed.error.issues[0].message}`);
  const phaser = Object.fromEntries(Object.entries((old.phaser ?? {}) as Record<string, Record<string, unknown>>).map(([id, p]) => [id, { destroyed: false, ...p }]));
  const ship = old.ship === undefined ? undefined : { ...newShipState(content), ...(old.ship as object) };
  // (the computer no longer replaces the station, M5: a v3 save in it is on the bridge)
  if (ship && (ship as { station: string }).station === 'computer') ship.station = 'bridge';
  // (a v3 save made while the team is away has no start time for the ship's timers, which the return delays by: it is now, M12)
  if (ship && old.onShip === null && typeof old.tick === 'number') (ship as { awaySince: number | null }).awaySince = old.tick;
  return {
    data: { ...old, version: STATE_VERSION, phaser, ship, computer: newComputerState(content), adviceMode: 0, conversationLog: [], beamWorld: null },
    queued: parsed.data,
  };
}

/** Every id the save refers to must be in the game, and the game's own ids must all be in the save. */
function checkMatchesContent(s: WorldState, content: GameContent): void {
  const mismatch = (what: string) => new SaveError(`save does not match this game: ${what}`);
  const isScreen = (id: string) => Object.hasOwn(content.screens, id);
  const isObject = (id: string) => Object.hasOwn(s.objects, id);

  const missing = Object.keys(content.objects).filter(id => !isObject(id));
  if (missing.length > 0) throw mismatch(`missing objects ${missing.join(', ')}`);
  if (!isScreen(s.screen)) throw mismatch(`unknown screen "${s.screen}"`);
  for (const id of s.awayTeam) {
    if (!isObject(id)) throw mismatch(`away team member "${id}" is not an object`);
  }
  if (!isObject(s.currentActor)) throw mismatch(`current actor "${s.currentActor}" is not an object`);
  const missingTriggers = content.triggers.map(t => t.id).filter(id => !Object.hasOwn(s.triggers, id));
  if (missingTriggers.length > 0) throw mismatch(`missing triggers ${missingTriggers.join(', ')}`);
  const missingRegions = Object.keys(content.screens).filter(id => !Object.hasOwn(s.regions, id));
  if (missingRegions.length > 0) throw mismatch(`missing regions for screens ${missingRegions.join(', ')}`);
  for (const [id, o] of Object.entries(s.objects)) {
    if (o.screen !== null && !isScreen(o.screen)) throw mismatch(`object "${id}" is on unknown screen "${o.screen}"`);
  }
  const differ = Object.values(content.conversations)
    .filter(conv => !Object.hasOwn(s.conversations, conv.id) || s.conversations[conv.id].length !== conv.responses.length
      || s.conversationShapes[conv.id] !== conversationShape(conv))
    .map(conv => conv.id);
  if (differ.length > 0) throw mismatch(`conversations differ: ${differ.join(', ')}`);
  if (s.advice.id !== null && !Object.hasOwn(content.advice, s.advice.id)) throw mismatch(`unknown advice "${s.advice.id}"`);
  for (const [screen, st] of Object.entries(s.startups)) {
    const a = st.action;
    for (const id of a ? [a.target, a.other, a.who] : []) {
      if (id !== undefined && id !== ANYONE && id !== NONE && !isObject(id)) throw mismatch(`the startup of screen "${screen}" names unknown object "${id}"`);
    }
  }
  if (s.pendingHail && s.pendingHail.conversation !== null && !Object.hasOwn(content.conversations, s.pendingHail.conversation)) {
    throw mismatch(`the pending hail names unknown conversation "${s.pendingHail.conversation}"`);
  }
  if (s.beamTarget !== null && !isScreen(s.beamTarget)) throw mismatch(`unknown transporter target "${s.beamTarget}"`);
  if (s.ship.bridgeUse !== null && !isObject(s.ship.bridgeUse)) throw mismatch(`the bridge uses unknown object "${s.ship.bridgeUse}"`);
  for (const m of s.ship.universeMoves) {
    if (!isObject(m.object)) throw mismatch(`a universe move names unknown object "${m.object}"`);
  }
  for (const id of s.ship.combat ? [s.ship.combat.enterprise, ...s.ship.combat.enemies, ...s.ship.combat.friends, ...s.ship.combat.destroyed] : []) {
    if (!isObject(id)) throw mismatch(`the battle names unknown object "${id}"`);
  }
  if (s.ship.viewscreenTarget !== null && !isObject(s.ship.viewscreenTarget)) {
    throw mismatch(`the viewscreen shows unknown object "${s.ship.viewscreenTarget}"`);
  }
  for (const id of s.ship.equipment ?? []) {
    if (!isObject(id)) throw mismatch(`the ship's equipment names unknown object "${id}"`);
  }
  for (const [screen, st] of Object.entries(s.startups)) {
    if (st.advice.id !== undefined && !Object.hasOwn(content.advice, st.advice.id)) {
      throw mismatch(`the startup of screen "${screen}" names unknown advice "${st.advice.id}"`);
    }
    const at = st.action?.at;
    if (at !== undefined && !Object.hasOwn(content.screens[screen]?.markers ?? {}, at)) {
      throw mismatch(`the startup of screen "${screen}" names unknown marker "${at}"`);
    }
  }
  if (s.pendingHail?.from != null && !isObject(s.pendingHail.from)) {
    throw mismatch(`the pending hail is from unknown object "${s.pendingHail.from}"`);
  }
  for (const [id, o] of Object.entries(s.objects)) {
    const ref = parseConversationString(o.talk);
    if (ref && !Object.hasOwn(content.conversations, ref.conversation)) {
      throw mismatch(`object "${id}" talks to unknown conversation "${ref.conversation}"`);
    }
  }
  const extra = Object.keys(s.conversations).filter(id => !Object.hasOwn(content.conversations, id));
  if (extra.length > 0) throw mismatch(`unknown conversations ${extra.join(', ')}`);
  const noStartup = Object.keys(content.screens).filter(id => !Object.hasOwn(s.startups, id));
  if (noStartup.length > 0) throw mismatch(`missing screen startups ${noStartup.join(', ')}`);
  const noPhaser = Object.values(content.objects).filter(d => d.phaser && !Object.hasOwn(s.phaser, d.id)).map(d => d.id);
  if (noPhaser.length > 0) throw mismatch(`missing phaser data for ${noPhaser.join(', ')}`);
}
