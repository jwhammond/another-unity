// SPDX-License-Identifier: GPL-3.0-or-later
import { z } from 'zod';
import { COMBAT_CUE_NAMES, CONSOLE_TEXT_NAMES, SHIP, type CombatCueName, type ConsoleTextName } from './types';
import type {
  AdviceDef,
  AnimFx,
  CombatData,
  ComputerTree,
  ChoiceOption,
  Condition,
  ConversationDef,
  Effect,
  ObjectDef,
  PhaserDef,
  ResponseDef,
  RuleGroup,
  ScreenDef,
  ScreenStartupDef,
  ShipData,
  ShipFx,
  StartupActionDef,
  TriggerDef,
  Universe,
} from './types';

const vec2 = z.object({ x: z.number(), z: z.number() }).strict();
const id = z.string().min(1);
const stop = { stop: z.boolean().optional() };

const check = z.union([
  z.object({ emptyAt: id }).strict(),
  z.object({
    object: id,
    state: z.number().int().optional(),
    status: z.enum(['inTeam', 'inInventory', 'notInInventory']).optional(),
    at: id.optional(),
    screen: id.optional(),
    passIfInactive: z.literal(true).optional(),
  }).strict(),
]);

export const conditionSchema: z.ZodType<Condition> = z.object({
  other: id.optional(),
  who: id.optional(),
  near: z.object({ dist: z.number().nonnegative(), at: id.optional(), px: z.number().nonnegative().optional() }).strict().optional(),
  skill: z.number().int().min(0).max(0xffff).optional(),
  counter: z.object({ mode: z.enum(['when', 'until']), value: z.number().int().min(0).max(0xffff) }).strict().optional(),
  checks: z.array(check).max(4).optional(),
  stop: z.boolean().optional(),
}).strict();

const choiceOption: z.ZodType<ChoiceOption> = z.lazy(() =>
  z.object({ text: z.string(), do: z.array(ruleGroupSchema) }).strict());

export const effectSchema: z.ZodType<Effect> = z.lazy(() => z.union([
  z.object({
    alter: z.object({
      object: id,
      at: id.optional(),
      universe: z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int(), speed: z.number().int().optional() }).strict().optional(),
      get: z.literal(true).optional(),
      drop: z.literal(true).optional(),
      active: z.boolean().optional(),
      talkTo: z.literal(true).optional(),
      halt: z.literal(true).optional(),
      stunned: z.boolean().optional(),
      voice: z.string().optional(),
      timer: z.number().nonnegative().optional(),
      anim: animFxSchema.optional(),
      talk: z.string().optional(),
      sayNow: z.string().min(1).refine(s => !s.startsWith('@'), 'a conversation now is converseNow').optional(),
      converseNow: z.string().startsWith('@').optional(),
      name: z.string().optional(),
      state: z.number().int().optional(),
      describe: z.literal(true).optional(),
    }).strict().refine(
      a => [a.talk, a.sayNow, a.converseNow].filter(s => s !== undefined).length <= 1,
      'only one of talk, sayNow and converseNow',
    ),
    ...stop,
  }).strict(),
  z.object({ path: z.object({ enable: z.array(id).optional(), disable: z.array(id).optional() }).strict(), ...stop }).strict(),
  z.object({ trigger: z.object({ id: id, enabled: z.boolean() }).strict(), ...stop }).strict(),
  z.object({
    screen: z.object({
      to: id,
      entrance: id.optional(),
      gather: z.literal(true).optional(),
      stepIn: z.literal(true).optional(),
      stay: z.literal(true).optional(),
      gameOver: z.number().int().min(0).optional(),
    }).strict().refine(s => s.to === SHIP || s.entrance !== undefined, 'a screen change needs an entrance'),
    ...stop,
  }).strict(),
  z.object({ say: z.object({ who: id, text: z.string(), voice: z.string().optional() }).strict(), ...stop }).strict(),
  z.object({ describe: z.object({ object: id }).strict(), ...stop }).strict(),
  z.object({ play: z.object({ movie: z.string().optional(), sound: z.string().optional() }).strict(), ...stop }).strict(),
  z.object({ call: z.object({ hook: id, args: z.record(z.unknown()).optional() }).strict(), ...stop }).strict(),
  z.object({
    converse: z.object({
      conversation: id,
      situation: z.number().int().min(0),
      key: z.number().int().min(0),
      to: z.enum(['enabled', 'disabled', 'locked']),
    }).strict(),
    ...stop,
  }).strict(),
  z.object({
    act: z.object({
      verb: z.enum(['look', 'get', 'walk', 'talk', 'use']),
      object: id.optional(),
      who: id.optional(),
      other: id.optional(),
      at: id.optional(),
    }).strict(),
    ...stop,
  }).strict(),
  z.object({
    react: z.object({
      who: z.union([z.enum(['actor', 'team', 'random']), z.object({ object: id }).strict()]),
      do: z.union([
        z.enum(['stun', 'kill', 'revive', 'beamUp']),
        z.object({ damage: z.number().int().min(-128).max(126).refine(n => n !== 0, 'damage of 0 does nothing') }).strict(),
        z.object({ beamIn: id }).strict(),
        z.object({ beamTo: z.object({ screen: id.optional(), entrance: id }).strict() }).strict(),
      ]),
      shot: z.literal(true).optional(),
      chodak: z.literal(true).optional(),
    }).strict(),
    ...stop,
  }).strict(),
  z.object({ beam: z.object({ to: id.nullable(), world: z.number().int().positive().optional() }).strict(), ...stop }).strict(),
  z.object({ advice: adviceSettingSchema.extend({ screen: id.optional() }).strict(), ...stop }).strict(),
  z.object({ startup: z.object({ screen: id, action: startupActionSchema.nullable() }).strict(), ...stop }).strict(),
  z.object({
    awayFlags: z.object({
      inputBlocked: z.boolean().optional(),
      combadge: z.boolean().optional(),
      closeup: z.boolean().optional(),
      screen: id.optional(),
    }).strict(),
    ...stop,
  }).strict(),
  z.object({
    communicate: z.object({
      from: id.optional(),
      conversation: id.optional(),
      situation: z.number().int().min(0).optional(),
      scenario: z.number().int().min(0).max(0xffff).optional(),
      type: z.union([z.number().int().min(0).max(0x11), z.literal(0xff)]),
    }).strict().refine(
      // (only the conversation hails, 4, 5, 6 and 8, need a conversation; a battle hail has its scenario; 7 may be bare, and the rest carry nothing)
      h => !([4, 5, 6, 8].includes(h.type)) || (h.from !== undefined && h.type !== 8) || (h.conversation !== undefined && h.situation !== undefined),
      'a hail needs a conversation and a situation, or a hailer whose talk string names them',
    ).refine(
      h => ![0xa, 0xb, 0x10, 0x11].includes(h.type) || h.scenario !== undefined,
      'a battle hail needs its scenario',
    ),
    ...stop,
  }).strict(),
  z.object({ wait: z.object({ seconds: z.number().nonnegative() }).strict(), ...stop }).strict(),
  z.object({ restartTimers: z.literal(true), ...stop }).strict(),
  z.object({ missing: z.object({ kind: z.enum(['conversation', 'object', 'movie', 'screen']), id }).strict(), ...stop }).strict(),
  z.object({ ship: shipFxSchema, ...stop }).strict(),
  z.object({ choose: z.object({ question: z.string(), options: z.tuple([choiceOption, choiceOption]) }).strict(), ...stop }).strict(),
]));

export const ruleGroupSchema: z.ZodType<RuleGroup> = z.lazy(() =>
  z.object({ when: conditionSchema.optional(), do: z.array(effectSchema) }).strict());

const verbRules = z.array(ruleGroupSchema).optional();

export const objectDefSchema: z.ZodType<ObjectDef> = z.object({
  id,
  name: z.string(),
  screen: id.nullable(),
  at: id.optional(),
  pos: vec2.optional(),
  state: z.number().int().optional(),
  active: z.boolean().optional(),
  inventory: z.boolean().optional(),
  crew: z.boolean().optional(),
  skills: z.number().int().min(0).max(0xffff).optional(),
  timer: z.number().nonnegative().optional(),
  description: z.object({ text: z.string(), voice: z.string().optional() }).strict().optional(),
  transition: id.optional(),
  talk: z.string().optional(),
  talkVoice: z.string().optional(),
  universe: z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }).strict().optional(),
  width: z.number().nonnegative().optional(),
  pixelWidth: z.number().int().nonnegative().optional(),
  actionSquare: z.number().int().min(0).max(255).optional(),
  descriptions: z.record(z.object({ text: z.string(), voice: z.string().optional() }).strict()).optional(),
  phaser: z.lazy(() => phaserDefSchema).optional(),
  on: z.object({ use: verbRules, get: verbRules, look: verbRules, timer: verbRules }).strict().optional(),
}).strict();

const pixelMetricSchema = z.object({
  kind: z.enum(['perspective', 'flat']),
  slope: z.number(),
  horizonY: z.number(),
  meanScale: z.number().positive(),
  topY: z.number(),
  metersPerPixel: z.number().positive(),
  floor: z.array(z.object({
    region: z.string(),
    points: z.array(z.object({ x: z.number().int(), y: z.number().int(), scale: z.number().int().min(0).max(256) }).strict()),
  }).strict()),
}).strict();

export const screenDefSchema: z.ZodType<ScreenDef> = z.object({
  id,
  markers: z.record(vec2),
  pixelMetric: pixelMetricSchema.optional(),
  regions: z.record(z.boolean()).optional(),
  world: id.optional(),
  startup: z.lazy(() => screenStartupSchema).optional(),
}).strict();

export const triggerDefSchema: z.ZodType<TriggerDef> = z.object({
  id,
  type: z.enum(['normal', 'timer', 'proximity']),
  context: z.enum(['away', 'ship']),
  target: id,
  enabled: z.boolean(),
  seconds: z.number().nonnegative().optional(),
  proximity: z.object({
    dist: z.number().int().nonnegative(), from: id, to: id, reversed: z.boolean(), instant: z.boolean(),
  }).strict().optional(),
}).strict().refine(t => (t.type === 'proximity') === (t.proximity !== undefined), 'a proximity trigger, and only a proximity trigger, has a proximity test');

export const gameFileSchema = z.object({
  id,
  start: z.object({
    screen: id,
    entrance: id,
    awayTeam: z.array(id).min(1),
    leader: id,
    seed: z.number().int().optional(),
  }).strict(),
  missions: z.array(z.object({ world: id, number: z.number().int().positive().optional(), screen: id, entrance: id, beamEffect: z.literal(false).optional() }).strict()).optional(),
  rules: z.lazy(() => gameRulesSchema).optional(),
}).strict();

const int8 = z.number().int().min(-128).max(127);

export const phaserDefSchema: z.ZodType<PhaserDef> = z.object({
  health: int8,
  threshold: int8,
  damageFrom: int8,
  gtpFrom: int8,
  gtpUpTo: int8.optional(),
  on: z.object({
    stun: z.array(ruleGroupSchema).optional(),
    gtp: z.array(ruleGroupSchema).optional(),
    kill: z.array(ruleGroupSchema).optional(),
  }).strict().optional(),
}).strict();

export const adviceSettingSchema = z.object({
  id: id.optional(),
  every: z.number().nonnegative().optional(),
  off: z.literal(true).optional(),
}).strict();

export const startupActionSchema: z.ZodType<StartupActionDef> = z.object({
  verb: z.enum(['use', 'get', 'look', 'walk', 'talk']),
  target: id,
  who: id.optional(),
  other: id.optional(),
  at: id.optional(),
}).strict();

export const screenStartupSchema: z.ZodType<ScreenStartupDef> = z.object({
  advice: adviceSettingSchema.optional(),
  closeup: z.boolean().optional(),
  combadge: z.boolean().optional(),
  inputBlocked: z.boolean().optional(),
  action: startupActionSchema.optional(),
}).strict();

export const responseStateSchema = z.enum(['set', 'enabled', 'disabled', 'locked']);

const responseDefSchema: z.ZodType<ResponseDef> = z.object({
  situation: z.number().int().min(0).max(0xfffe),
  key: z.number().int().min(0).max(0xffff),
  text: z.string().optional(),
  voice: z.string().optional(),
  voices: z.record(z.string()).optional(),
  turn: z.enum(['left', 'right']).optional(),
  state: responseStateSchema,
  who: z.array(id),
  replier: z.union([
    z.object({ object: id }).strict(),
    z.object({ crew: id }).strict(),
    z.object({ teamCrew: id }).strict(),
  ]).optional(),
  replies: z.array(z.object({ text: z.string(), voice: z.string().optional() }).strict()).optional(),
  joined: z.literal(true).optional(),
  next: z.number().int().min(0).max(0xfffe).optional(),
  changes: z.array(z.object({
    to: responseStateSchema,
    situation: z.number().int().min(0),
    key: z.number().int().min(0),
  }).strict()).optional(),
  results: z.array(z.array(ruleGroupSchema)).optional(),
}).strict();

export const conversationDefSchema: z.ZodType<ConversationDef> = z.object({
  id,
  ship: z.literal(true).optional(),
  number: z.number().int().min(0).optional(),
  responses: z.array(responseDefSchema),
}).strict();

export const adviceFileSchema: z.ZodType<Record<string, AdviceDef>> = z.record(z.object({
  easy: z.record(z.string()).optional(),
  hard: z.record(z.string()).optional(),
}).strict());

const lineRef = z.object({ conversation: id, situation: z.number().int().min(0) }).strict();

export const gameRulesSchema = z.object({
  talkDistance: z.number().nonnegative().optional(),
  stepIn: z.number().nonnegative().optional(),
  doctor: id.optional(),
  items: z.object({
    phaser: id.optional(),
    tricorder: id.optional(),
    medicalTricorder: id.optional(),
    medkit: id.optional(),
    communicator: id.optional(),
  }).strict().optional(),
  lines: z.object({
    failLook: lineRef.optional(),
    failTalk: lineRef.optional(),
    failUse: lineRef.optional(),
    failOther: lineRef.optional(),
    failPhaser: lineRef.optional(),
    tricorderNothing: lineRef.optional(),
    noAdvice: lineRef.optional(),
    gameOver: lineRef.optional(),
    medical: z.object({ conversation: id, order: z.array(id) }).strict().optional(),
  }).strict().optional(),
}).strict();

export const shipFxSchema: z.ZodType<ShipFx> = z.union([
  z.object({ newWarpMovie: z.literal(true) }).strict(),
  z.object({ reveal: z.number().int().nonnegative() }).strict(),
  z.object({ repair: z.literal(true) }).strict(),
  z.object({ computer: z.enum(['record', 'hide', 'show']), entry: z.number().int().nonnegative() }).strict(),
  z.object({
    universe: z.object({
      object: id,
      x: z.number().int(),
      y: z.number().int(),
      z: z.number().int(),
      speed: z.number().int().optional(),
    }).strict(),
  }).strict(),
]);

export const animFxSchema: z.ZodType<AnimFx> = z.union([
  z.object({ play: z.number().int().min(0), wait: z.literal(true).optional() }).strict(),
  z.object({ stop: z.literal(true) }).strict(),
  z.object({ sprite: z.number().int().min(0) }).strict(),
]);

const int = z.number().int();
const text = z.string();
const astroThing = { id: int, type: int, seed: int, x: int, y: int, z: int, name: text, range: int };

export const universeSchema: z.ZodType<Universe> = z.object({
  sectors: z.array(z.object({
    numStars: int, numPhenomena: int, alignment: int, firstStar: int, firstPhenomenon: int, station: int,
    description: text, name: text, region: int,
  }).strict()),
  stars: z.array(z.object({
    ...astroThing, flags: int, spectralClass: int, magnitude: int, orbitScale: int,
    systemName: text, scriptedName: text, scriptedDescription: text, special: int,
  }).strict()),
  phenomena: z.array(z.object(astroThing).strict()),
  stations: z.array(z.object(astroThing).strict()),
  specials: z.array(z.object({ ...astroThing, sector: int, star: int, planet: int }).strict()),
  flags: z.array(int),
  regionChatter: z.array(int),
  warpSpeeds: z.array(int),
  impulseSpeeds: z.array(int),
  scriptedWarps: z.array(z.object({ code: int, sector: int, star: int, planet: int, type: int, index: int }).strict()),
  planetOrbits: z.array(int),
  reveals: z.array(int),
}).strict();

export const shipDataSchema: z.ZodType<ShipData> = z.object({
  bridge: z.object({
    items: z.array(z.object({ object: id, x: int, y: int, width: int, height: int, action: int, depth: int, description: text }).strict()),
    objects: z.array(z.object({ object: id, x: int, y: int, depth: int, file: text }).strict()),
    turbolift: z.array(z.object({ code: int, text }).strict()),
  }).strict(),
  transporter: z.object({
    exits: z.array(z.object({ code: int, text }).strict()),
    teams: z.array(z.object({ world: int, members: z.array(id), items: z.array(id) }).strict()),
    targets: z.array(z.object({ x: int, y: int }).strict()),
    pads: z.array(z.object({
      rect: z.tuple([int, int, int, int]), stand: z.tuple([int, int]), scale: int,
    }).strict()).optional(),
    walkOn: z.array(z.object({ x: int, y: int, direction: int, scale: int }).strict()).optional(),
    walkOff: z.array(z.object({ x: int, y: int, direction: int, scale: int }).strict()).optional(),
  }).strict(),
  crew: z.object({ leaderOrder: z.array(id), voices: z.array(int), voiceOf: z.record(int).optional() }).strict(),
  speeds: z.object({ warp: z.array(int), impulse: z.array(int) }).strict(),
  units: z.array(z.object({
    name: text, type: int, current: int, target: int, max: int, chargeTicks: int, dischargeTicks: int,
    damage: int, repair: int, baseDamage: int, maxDamage: int, efficiency: int, hitWeight: int.optional(), depth: int.optional(),
  }).strict()),
  astro: z.object({
    enterprise: id,
    starbaseBattle: int,
    defaultBattle: int,
    triggers: z.object({ arriveStarbase: id, arriveStar: id, firstVisit: id, runAway: id, secondVisitCheck: id, secondVisit: id }).strict(),
  }).strict(),
  equipment: z.array(id),
  contacts: z.object({
    comms: z.array(z.object({ object: id, sprite: z.boolean(), file: z.string().regex(/^[a-z0-9_]+$/).optional() }).strict()),
    lounge: z.array(id),
  }).strict(),
  viewscreenSprites: z.record(z.string().regex(/^\d+$/), z.string().regex(/^[a-z0-9_]+$/)).optional(),
}).strict();

export const computerTreeSchema = z.object({
  entries: z.array(z.object({ title: text, heading: text, text, flags: int, subentries: z.array(int) }).strict()),
  entryIds: z.array(int),
  readingParents: z.record(z.string(), int),
  hidden: z.array(int),
  startReadings: z.array(int),
  readings: z.array(z.object({ key: int, world: id, group: int, index: int, entry: int, parent: int }).strict()),
}).strict() as unknown as z.ZodType<ComputerTree>;

const vec3 = z.tuple([z.number(), z.number(), z.number()]);
/** An original file name, lower case: name.ext. */
const file = z.string().regex(/^[a-z0-9_]+\.[a-z0-9]+$/);
const shipKind = z.enum(['chodak', 'romulan', 'enterprise', 'klingon', 'probe', 'ferengi', 'starbase', 'garidian', 'shuttle', 'mother']);
const combatUnit = z.object({
  name: text, type: int, current: int, target: int, max: int, chargeTicks: int, dischargeTicks: int,
  damage: int, repair: int, baseDamage: int, maxDamage: int, efficiency: int, hitWeight: int, depth: int.optional(),
}).strict();

export const combatDataSchema: z.ZodType<CombatData> = z.object({
  kinds: z.array(z.object({
    name: shipKind, flags: int, base: text, maxSpeed: int, detailDistance: int, reducedDistance: int,
    contactCue: int, destroyedCue: int, targetCue: int, className: text, scannerImage: int, radarColour: int,
    effects: z.object({
      phaserSprite: file.nullable(), phaserSound: file.nullable(), photonSprite: file.nullable(), photonSound: file.nullable(), shieldSprite: file,
    }).strict(),
    tactics: file.nullable(),
    models: z.object({ detail: file.nullable(), reduced: file.nullable(), damaged: file.nullable(), debris: z.array(file.nullable()).length(6) }).strict(),
  }).strict()).length(10),
  enemyUnits: z.array(combatUnit),
  flight: z.object({ turns: z.array(int), speeds: z.array(z.number().finite()), turnScales: z.array(z.number().finite()) }).strict(),
  powerLevels: z.array(z.array(int)),
  hitLists: z.object({ enterprise: z.array(z.array(int)), other: z.array(z.array(int)) }).strict(),
  phasers: z.object({
    enterprise: z.array(vec3), other: z.array(vec3),
    units: z.object({ enterprisePhaser: int, otherPhaser: int, enterpriseTube: int, otherTube: int }).strict(),
  }).strict(),
  scanner: z.object({ enterprise: z.array(z.array(int)), other: z.array(z.array(int)) }).strict(),
  bearing: z.array(z.array(int).length(3)).length(8),
  shieldNames: z.array(text).length(8),
  cueIds: z.object(Object.fromEntries(COMBAT_CUE_NAMES.map(n => [n, int])) as Record<CombatCueName, typeof int>).strict(),
  consoleText: z.object(Object.fromEntries(CONSOLE_TEXT_NAMES.map(n => [n, z.string()])) as Record<ConsoleTextName, z.ZodString>).strict().optional(),
  cues: z.array(z.object({ speaker: int, file: text.nullable(), gap: int }).strict()),
  effects: z.object({
    phaser: file.nullable(), photon: file.nullable(), billboard: file.nullable(),
    shields: z.array(file.nullable()), genericDebris: z.array(file.nullable()), booms: z.array(file),
  }).strict(),
  models: z.record(file, z.object({
    url: z.string().regex(/^space\/[a-z0-9_.]+\.glb$/), geometry: file, materials: file.nullable(), size: vec3, centre: vec3, parts: int,
    vertices: z.array(int).optional(),
  }).strict()),
  tactics: z.record(file, z.object({
    file, size: int, kernel: int, pages: z.array(z.object({ name: text, offset: int }).strict()), code: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/),
  }).strict()),
  battles: z.record(z.string().regex(/^\d+$/), z.object({
    screen: id, enter: id.nullable(), exit: id.nullable(), warp: id.nullable(), quietContacts: z.boolean(),
    ships: z.array(z.object({
      object: id, type: int, position: vec3, heading: int.nullable(), decloak: int, strength: int, hullLow: int, tactics: file.nullable(),
    }).strict()),
  }).strict()),
  media: z.object({ music: file, pictures: z.array(file), sprites: z.array(file), sounds: z.array(file) }).strict(),
  sources: z.record(z.string(), z.string().regex(/^[a-z_0-9]+\.(?:cpp|h):\d+(?:-\d+)?$/)),
  animations: z.record(file, z.number().int().min(1).max(23)).optional(),
  damageMaterials: z.record(file, z.array(z.boolean())).optional(),
  trig: z.object({ sin: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/), cos: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/) }).strict().optional(),
}).strict();
