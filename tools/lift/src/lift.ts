// SPDX-License-Identifier: GPL-3.0-or-later
import {
  ContentError, parseGame,
  type AdviceDef, type CombatData, type ComputerTree, type ConversationDef, type GameContent, type GameRules, type MissionDef, type GameStart, type ObjectDef, type ScreenDef,
  type ScreenStartupDef, type ShipData, type TriggerDef, type Universe,
} from '@another-unity/engine';
import { stringify } from 'yaml';
import { pointerWorld, setLenient, Stats, type LiftCtx } from './context';
import { liftCombat, type LiftedCombat } from './combat';
import type { SpriteFrames } from './combatAssets';
import { liftConversation } from './conversations';
import { defaultStart, hardcodedConversations, liftMissions, liftRules, liftStart } from './hardcoded';
import { HookStubs, hooksModule, type HookStub } from './hooks';
import {
  adviceSlug, assignObjectSlugs, hex2, IdTable, isCrewId, parseId, Scope, SHIP_WORLD, SPACE_WORLD, screenKey, screenSlug, worldKey, worldSlug, type Known,
} from './ids';
import { losslessCheck, type LosslessResult, type ScopeValue } from './ignored';
import { Markers, type CoordsFile } from './markers';
import { liftObject, type HotspotInput } from './objects';
import { applyOverrides, type Overrides } from './overrides';
import { liftMovies, presentationFor, type PresentationFile } from './presentation';
import { liftComputer } from './computer';
import { liftShip, viewscreenSprites } from './ship';
import { liftUniverse } from './universe';
import { liftReadings, type ReadingsFile } from './readings';
import { liftScreenTexts, type ScreenTextsFile } from './screentexts';
import { Problems } from './problems';
import { fitProjection, METERS_PER_PIXEL, type ProjectionOverride } from './projection';
import type { RawIR, TriggerT } from './raw';
import { roomFile, type RoomFile, type SpriteBounds } from './room';
import { liftStartup, registerScreen, screenDef } from './screens';
import { FieldTracker } from './track';
import { speakerByte, VoiceIndex, type VoicesFile } from './voice';
import { liftAdvice, liftTriggers } from './world';

export const GAME_ID = 'unity';

export interface LiftOptions {
  /** The worlds lifted in full (world 0's crew and items always are). */
  worlds: number[];
  /** The world game.yaml starts in (default: `defaultStart(worlds)`). The mission select (M3 Plan 8) starts the others. */
  start?: number;
  /** overrides/coords.yaml. */
  metersPerPixel?: number;
  projections?: Record<string, ProjectionOverride>;
  /** overrides/contexts.yaml: a screen (IR key) for lists that can run anywhere, by IR file. */
  contexts?: Record<string, { screen: string }>;
  /** Sprite sizes from Plan 3's images export, for hotspots. */
  sprites?: SpriteBounds;
  /** Sprite frame counts from the same export, for combat's effects (combatAssets.loadSpriteFrames). */
  spriteFrames?: SpriteFrames;
  /** The decoded sounds' stems (lowercase), to count the voices that are mapped. */
  audio?: ReadonlySet<string>;
  /** Hooks that have a games/unity/hooks/ported/<name>.ts. */
  ported?: ReadonlySet<string>;
}

export interface Coverage {
  generated: 'tools/lift';
  world: string;
  objects: number;
  stubs: number;
  conversations: number;
  screens: number;
  rules: { groups: number; entries: Record<string, number>; effects: number; noops: number };
  hooks: { name: string; ported: boolean; usedBy: number }[];
  voices: { lines: number; mapped: number | null; missing: string[] };
  fields: { consumed: number; ignored: number; total: number };
  layout: { flat: string[]; noPolygons: string[] };
  warnings: string[];
}

export interface Lifted<T> {
  def: T;
  /** Where it is written, relative to games/unity. */
  path: string;
  /** The IR it came from. */
  source: string;
}

export interface LiftedContent {
  game: { id: string; start: GameStart; missions?: MissionDef[]; rules: GameRules };
  screens: Map<string, Lifted<ScreenDef>>;
  objects: Map<string, Lifted<ObjectDef>>;
  conversations: Map<string, Lifted<ConversationDef>>;
  triggers: TriggerDef[];
  advice: Record<string, AdviceDef>;
  rooms: Map<string, { room: RoomFile; path: string }>;
  ids: Record<string, Record<string, string>>;
  coords: CoordsFile;
  voices: VoicesFile;
  hooks: HookStub[];
  coverage: Map<string, Coverage>;
  presentation: PresentationFile;
  readings: ReadingsFile;
  screenTexts: ScreenTextsFile;
  /** The ship's computer: absent when the export has no computer.db. */
  computer?: ComputerTree;
  /** The universe: absent when the export has no astro.db. */
  universe?: Universe;
  ship: ShipData;
  /** combat.yaml (Plan 18): absent for an export without combat.json. */
  combat?: CombatData;
  /** What combat.yaml wants that the export lacks (Plan 18 Task 7): each is a warning too. */
  combatGaps?: string[];
}

export interface LiftResult {
  files: Map<string, string>;
  lifted: LiftedContent;
  content: GameContent | null;
  problems: Problems;
  applied: string[];
}

const sorted = <T>(values: Iterable<T>): T[] => [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const worldOfScreen = (key: string) => parseInt(key.slice(2, 4), 16);
const worldOfConversation = (key: string) => parseInt(key.slice(1, 4), 16);
/** A stub object's rule lists and phaser data aren't lifted, so they aren't in scope. */
const STUB_SKIP: ReadonlySet<string> = new Set([
  'object.use_entries', 'object.get_entries', 'object.look_entries', 'object.timer_entries', 'object.phaser_data',
  'object.descriptions',
]);

interface Pass {
  ctx: LiftCtx;
  screens: Map<string, Lifted<ScreenDef>>;
  objects: Map<string, Lifted<ObjectDef>>;
  conversations: Map<string, Lifted<ConversationDef>>;
  triggers: TriggerDef[];
  includeTrigger: (t: TriggerT) => boolean;
  advice: Record<string, AdviceDef>;
  rooms: Map<string, { room: RoomFile; path: string }>;
  game: { id: string; start: GameStart; missions?: MissionDef[]; rules: GameRules };
  ship: ShipData;
  combat?: LiftedCombat;
}

/** The lookup tables blocks index into: read in full, since which entries a world uses varies. */
function readTables(ir: RawIR): void {
  for (const [, file] of Object.entries(ir.executable._presetSounds)) void file;
  for (const [, name] of Object.entries(ir.executable._adviceNames)) void name;
  for (const m of ir.movies.movies) void [m.id, m.filename];
  void ir.sprites._spriteFilenames.length;
  // (the readings' entries are only used with computer.db: without it they are still read, and the lift warns)
  for (const r of ir.executable._tricorderReadings) void r.entry;
}

/** Primary content (Decision 6): what was asked for. Only it widens the scope or fails the run. */
interface Primary {
  objects: ReadonlySet<string>;
  conversations: ReadonlySet<string>;
}

function initialScope(ir: RawIR, worlds: number[], problems: Problems): { scope: Scope; primary: Primary } {
  const scope = new Scope();
  for (const id of ir.manifest.objects) {
    const { world } = parseId(id);
    // (the ship world's objects are all primary: the Enterprise, the planets, the bridge's things and the ship's scripts; the space world's are the battles')
    if (world === 0 || world === SHIP_WORLD || world === SPACE_WORLD || worlds.includes(world)) scope.objects.add(id);
  }
  for (const key of ir.manifest.screens) {
    if (!worlds.includes(worldOfScreen(key))) continue;
    scope.screens.add(key);
    const s = ir.screens.get(key);
    // (an object list names the screen's objects; each object's own curr_screen places it)
    for (const id of s?.objects ?? []) {
      const o = ir.objects.get(id);
      if (!o) problems.error(key, `the object list names ${id}, which isn't in the export`);
      else if (o.curr_screen !== s?.screen) problems.warn(key, `the object list names ${id}, whose curr_screen is ${o.curr_screen}`);
      else scope.objects.add(id);
    }
  }
  for (const key of ir.manifest.conversations) if (worlds.includes(worldOfConversation(key))) scope.conversations.add(key);
  const primary = { objects: new Set(scope.objects), conversations: new Set(scope.conversations) };
  // (the fixed lines' conversations are secondary: the engine needs them, but nothing in them is asked for)
  for (const key of hardcodedConversations()) if (ir.conversations.has(key)) scope.conversations.add(key);
  return { scope, primary };
}

/** Adds what the last pass referred to, and the screens the objects in scope start on; true if the scope grew. */
function widen(ir: RawIR, known: Known, scope: Scope, pass: Pass): boolean {
  const screens = new Scope();
  for (const id of scope.objects) {
    const o = ir.objects.get(id);
    const { world } = parseId(id);
    if (!o || world === 0 || (o.flags & 0x40) !== 0) continue;
    const key = screenKey(world, o.curr_screen);
    if (known.screens.has(key)) screens.screens.add(key);
  }
  const referred = scope.addAll(pass.ctx.ids.need);
  const placed = scope.addAll(screens);
  return referred || placed;
}

function objectPath(id: string, def: ObjectDef): string {
  const { world, id: n } = parseId(id);
  if (isCrewId(id)) return `objects/crew/${hex2(n)}-${def.id}.yaml`;
  if (world === 0) return `objects/items/${def.id}.yaml`;
  const local = def.id.slice(def.id.indexOf('.') + 1);
  const where = def.screen ? def.screen.slice(def.screen.indexOf('.') + 1) : 'offscreen';
  return `objects/${worldSlug(world)}/${where}/${local}.yaml`;
}

function runPass(ir: RawIR, slugs: Map<string, string>, known: Known, scope: Scope, primary: Primary, options: LiftOptions, problems: Problems): Pass {
  const mpp = options.metersPerPixel ?? METERS_PER_PIXEL;
  const ctx: LiftCtx = {
    raw: ir, ids: new IdTable(slugs, known, problems, scope), problems, markers: new Markers(problems, mpp), hooks: new HookStubs(),
    voices: new VoiceIndex(), stats: new Stats(), crew: new Map(), regions: new Map(), entrances: new Map(),
    contexts: options.contexts ?? {}, full: primary.objects, lenient: false,
  };
  for (const id of ir.manifest.objects) if (isCrewId(id)) ctx.crew.set(parseId(id).id, slugs.get(id) ?? id);
  const own = (key: string) => options.worlds.includes(worldOfScreen(key));

  // screens first: everything else places markers on them (a stub's screen too, for its marker and regions)
  const screenKeys = sorted(scope.screens);
  for (const key of screenKeys) {
    const s = ir.screens.get(key);
    if (s) registerScreen(ctx, s, fitProjection(s.polygons, options.projections?.[screenSlug(s.world, s.screen)], mpp));
  }

  const objects = new Map<string, Lifted<ObjectDef>>();
  const hotspots: HotspotInput[] = [];
  for (const id of sorted(scope.objects)) {
    const o = ir.objects.get(id);
    if (!o) continue;
    const lifted = liftObject(o, ctx, primary.objects.has(id));
    objects.set(lifted.def.id, { def: lifted.def, path: objectPath(id, lifted.def), source: `o_${id}` });
    if (lifted.hotspot) hotspots.push(lifted.hotspot);
  }

  // a conversation that primary content only names is secondary: lifted leniently (Decision 6)
  const conversations = new Map<string, Lifted<ConversationDef>>();
  for (const key of sorted(scope.conversations)) {
    const c = ir.conversations.get(key);
    if (!c) continue;
    setLenient(ctx, !primary.conversations.has(key));
    const def = liftConversation(c, ctx);
    setLenient(ctx, false);
    const path = `conversations/${worldSlug(worldOfConversation(key))}/c${key.slice(5)}.yaml`;
    conversations.set(def.id, { def, path, source: key });
  }

  // (every ship-context trigger but the unused ones: the ship's own scripts run them)
  const includeTrigger = (t: TriggerT) => primary.objects.has(t.target) || scope.triggers.has(t.id) || (t.context === 0 && t.type !== 3);
  const triggers = liftTriggers(ctx, includeTrigger);

  // the advice of the lifted worlds, and any other advice primary content names
  const adviceWorlds = new Set([...options.worlds.map(worldKey), ...[...scope.advice].map(k => k.split('/')[0])]);
  const advice: Record<string, AdviceDef> = {};
  for (const wk of sorted(adviceWorlds)) {
    const w = ir.worlds.get(wk);
    if (w) Object.assign(advice, liftAdvice(ctx, w));
  }
  // (advice that is named but missing only sets an id that says nothing: setAdvice)
  for (const key of sorted(scope.advice)) {
    const [wk, n] = key.split('/');
    const slug = adviceSlug(parseInt(wk.slice(2), 16), Number(n));
    if (!advice[slug]) advice[slug] = {};
  }

  // the lifted worlds' startups (a stub's screen has none); they can add markers, so they come before the screens
  const startups = new Map<string, ScreenStartupDef | undefined>();
  for (const key of screenKeys.filter(own)) {
    const s = ir.screens.get(key);
    const w = s ? ir.worlds.get(worldKey(s.world)) : undefined;
    if (s && w) startups.set(key, liftStartup(ctx, w, s.screen, screenSlug(s.world, s.screen)));
  }

  const rules = liftRules(ctx, mpp);
  const startWorld = options.start ?? defaultStart(options.worlds);
  const missions = liftMissions(ctx, options.worlds, key => !!ir.screens.get(key)?.location);
  const mission = missions.find(m => m.world === worldSlug(startWorld));
  const located = screenKeys.filter(k => worldOfScreen(k) === startWorld && ir.screens.get(k)?.location);
  if (located.length === 0) problems.error('lift', `no located screen in ${worldSlug(startWorld)}, so there is nowhere to start`);
  const first = mission?.screen ?? (located.length > 0 ? screenSlug(worldOfScreen(located[0]), parseInt(located[0].slice(4), 16)) : '');
  const game = { id: GAME_ID, start: liftStart(ctx, first), ...(missions.length > 0 ? { missions } : {}), rules };

  const screens = new Map<string, Lifted<ScreenDef>>();
  const rooms = new Map<string, { room: RoomFile; path: string }>();
  for (const key of screenKeys) {
    const s = ir.screens.get(key);
    if (!s) continue;
    const def = screenDef(ctx, s, startups.get(key));
    const local = `${worldSlug(s.world)}/s${hex2(s.screen)}`;
    screens.set(def.id, { def, path: `screens/${local}.yaml`, source: own(key) ? `${key} and ${worldKey(s.world)}` : key });
    // (rooms only for the lifted worlds: a stub's screen isn't built)
    if (own(key)) rooms.set(def.id, { room: roomFile(ctx, s, hotspots, ir.sprites._spriteFilenames, options.sprites), path: `rooms/${local}.json` });
  }
  // (the bridge's, the teams' and the crew's objects widen the scope like any other reference)
  const lifted = liftShip(ir, ctx);
  // (the Enterprise's own views: what its alters play, wherever they are)
  const defs = [...[...objects.values()].map(o => o.def), ...[...conversations.values()].map(c => c.def), triggers, [...startups.values()], [...screens.values()].map(s => s.def)];
  const ship: ShipData = { ...lifted, viewscreenSprites: viewscreenSprites(defs, lifted.astro.enterprise, ir.sprites._spriteFilenames, problems) };
  const combat = liftCombat(ir, ctx, options.spriteFrames);
  return { ctx, screens, objects, conversations, triggers, includeTrigger, advice, rooms, game, ship, ...(combat ? { combat } : {}) };
}

function coverage(world: number, pass: Pass, scope: Scope, full: ReadonlySet<string>, lossless: LosslessResult, problems: Problems, options: LiftOptions): Coverage {
  const inWorld = (pointer: string) => pointerWorld(pointer) === world;
  const stats = pass.ctx.stats.for(worldKey(world));
  const bytes = [...pass.ctx.crew.keys()].map(speakerByte);
  const voices = options.audio
    ? pass.ctx.voices.check(options.audio, bytes, inWorld)
    : { lines: pass.ctx.voices.check(new Set(), bytes, inWorld).lines, mapped: null, missing: [] };
  return {
    generated: 'tools/lift',
    world: worldSlug(world),
    objects: [...full].filter(id => parseId(id).world === world).length,
    // global: every stub the lift made, across all worlds, so each world's coverage file reports the same count
    stubs: [...scope.objects].filter(id => !full.has(id)).length,
    conversations: [...scope.conversations].filter(k => worldOfConversation(k) === world).length,
    screens: [...scope.screens].filter(k => worldOfScreen(k) === world).length,
    rules: { groups: stats.groups, entries: Object.fromEntries(sorted(Object.keys(stats.entries)).map(k => [k, stats.entries[k]])), effects: stats.effects, noops: stats.noops },
    hooks: pass.ctx.hooks.list().filter(h => h.usedBy.some(inWorld))
      .map(h => ({ name: h.name, ported: options.ported?.has(h.name) ?? false, usedBy: h.usedBy.filter(inWorld).length })),
    voices,
    fields: { consumed: lossless.consumed, ignored: lossless.ignored, total: lossless.total },
    // screens to check by hand (Decision 24)
    layout: {
      flat: sorted([...scope.screens].filter(k => worldOfScreen(k) === world)
        .map(k => screenSlug(world, parseInt(k.slice(4), 16))).filter(slug => pass.ctx.markers.projection(slug)?.params.kind === 'flat')),
      noPolygons: sorted([...scope.screens].filter(k => worldOfScreen(k) === world && pass.ctx.raw.screens.get(k)?.location
        && !pass.ctx.raw.screens.get(k)?.polygons.some(p => p.type === 0 || p.type === 1))
        .map(k => screenSlug(world, parseInt(k.slice(4), 16)))),
    },
    warnings: problems.warnings.filter(inWorld),
  };
}

export function liftContent(raw: RawIR, options: LiftOptions, problems: Problems): LiftedContent {
  const tracker = new FieldTracker();
  const ir = tracker.trackRaw(raw);
  readTables(ir);
  // (read through the tracked IR, so the lossless check sees the fields as read)
  const slugs = assignObjectSlugs([...ir.objects.values()]);
  const presentation = presentationFor(options.worlds, ir.executable._backgroundSoundDefaults, {
    screens: new Set(ir.manifest.screens), objectSlug: id => slugs.get(id),
  });
  Object.assign(presentation, liftMovies(ir.movies.movies, ir.executable._warpMovies, problems));
  const readings = liftReadings(ir, options.worlds, problems);
  const screenTexts = liftScreenTexts(ir, options.worlds, problems);
  const computer = liftComputer(ir, problems);
  const universe = liftUniverse(ir, problems);
  const known: Known = {
    objects: new Set(ir.manifest.objects), conversations: new Set(ir.manifest.conversations),
    screens: new Set(ir.manifest.screens), triggers: new Set(ir.triggers.map(t => t.id)),
  };
  const { scope, primary } = initialScope(ir, options.worlds, problems);
  const full = primary.objects;

  // lift, then widen the scope to what primary content referred to, until it stops growing
  let p = new Problems();
  let pass = runPass(ir, slugs, known, scope, primary, options, p);
  for (let rounds = 1; widen(ir, known, scope, pass); rounds++) {
    if (rounds === 10) {
      problems.error('lift', 'the scope was still growing after 10 passes');
      break;
    }
    p = new Problems();
    pass = runPass(ir, slugs, known, scope, primary, options, p);
  }
  problems.errors.push(...p.errors);
  problems.warnings.push(...p.warnings);

  // the lossless check looks at the raw (untracked) values in scope
  const values: ScopeValue[] = [
    { value: raw.manifest, root: 'manifest' },
    ...sorted(scope.objects).map(id => ({ value: raw.objects.get(id), root: 'object', ...(full.has(id) ? {} : { skip: STUB_SKIP }) })),
    ...sorted(scope.conversations).map(key => ({ value: raw.conversations.get(key), root: 'conversation' })),
    ...sorted(scope.screens).map(key => ({ value: raw.screens.get(key), root: 'screen' })),
    // (the world files read: the lifted worlds' and those whose advice is named)
    ...sorted(new Set([...options.worlds.map(worldKey), ...[...scope.advice].map(k => k.split('/')[0])])).map(wk => ({ value: raw.worlds.get(wk), root: 'world' })),
    ...raw.triggers.filter(pass.includeTrigger).map(t => ({ value: t, root: 'triggers[]' })),
    { value: raw.movies, root: 'maps.movie' },
    { value: raw.sprites, root: 'maps.sprite' },
    { value: raw.executable, root: 'executable' },
    ...(raw.combat ? [{ value: raw.combat, root: 'combat' }] : []),
  ];
  const lossless = losslessCheck(tracker.used, values, raw.manifest.files);
  problems.errors.push(...lossless.problems);

  const crewSpeakers = Object.fromEntries(sorted(pass.ctx.crew.keys()).map(n => [pass.ctx.crew.get(n) ?? '', speakerByte(n)]));
  return {
    game: pass.game,
    screens: pass.screens,
    objects: pass.objects,
    conversations: pass.conversations,
    triggers: pass.triggers,
    advice: pass.advice,
    rooms: pass.rooms,
    ids: pass.ctx.ids.toYaml(),
    coords: pass.ctx.markers.coordsYaml(),
    voices: pass.ctx.voices.file(crewSpeakers),
    hooks: pass.ctx.hooks.list(),
    coverage: new Map(options.worlds.map(w => [worldSlug(w), coverage(w, pass, scope, full, lossless, problems, options)])),
    presentation,
    readings,
    screenTexts,
    ...(computer ? { computer } : {}),
    ...(universe ? { universe } : {}),
    ship: pass.ship,
    ...(pass.combat ? { combat: pass.combat.data, combatGaps: pass.combat.gaps } : {}),
  };
}

const yaml = (value: unknown) => stringify(value, { lineWidth: 0, aliasDuplicateObjects: false });
export const YAML_HEADER = '# Generated by tools/lift';
const header = (source: string) => `${YAML_HEADER} from ${source}. Edit games/unity/overrides/ instead.\n`;
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

export function renderFiles(lifted: LiftedContent, ported: ReadonlySet<string>): Map<string, string> {
  const files = new Map<string, string>();
  files.set('game.yaml', header('the hard-coded rules (tools/lift/src/hardcoded.ts)') + yaml(lifted.game));
  for (const s of lifted.screens.values()) files.set(s.path, header(s.source) + yaml(s.def));
  for (const o of lifted.objects.values()) files.set(o.path, header(o.source) + yaml(o.def));
  for (const c of lifted.conversations.values()) files.set(c.path, header(c.source) + yaml(c.def));
  files.set('triggers.yaml', header('triggers.json') + yaml(lifted.triggers));
  files.set('advice.yaml', header('the worlds\' wWWWa000.dat') + yaml(lifted.advice));
  files.set('ids.yaml', header('the export\'s ids') + yaml(lifted.ids));
  files.set('presentation.yaml', header('the worlds\' music, beam-down pieces and arrival movies, and the engine\'s own sounds (tools/lift/src/presentation.ts)') + yaml(lifted.presentation));
  files.set('coords.yaml', header('the screens\' polygons and every position') + yaml(lifted.coords));
  files.set('readings.yaml', header('computer.db\'s entries for the tricorder\'s readings') + yaml(lifted.readings));
  files.set('screentexts.yaml', header('the screens\' t_WWSS00.bst: the text a script shows on the screen itself') + yaml(lifted.screenTexts));
  if (lifted.computer) files.set('computer.yaml', header('computer.db and the ship\'s computer tables') + yaml(lifted.computer));
  files.set('ship.yaml', header('sttng.ovl: the bridge, the transporter\'s teams and the ship\'s stats') + yaml(lifted.ship));
  if (lifted.combat) files.set('combat.yaml', header('sttng.ovl\'s combat tables, ScummVM\'s combat constants (combat.json), the space world\'s battles and the tactics files') + yaml(lifted.combat));
  files.set('universe.yaml', header('astro.db, sector.ast and ast_stat.dat: the universe') + yaml(lifted.universe ?? {}));
  files.set('voices.yaml', header('every voice the content uses') + yaml(lifted.voices));
  for (const r of lifted.rooms.values()) files.set(r.path, json(r.room));
  files.set('hooks/generated.ts', hooksModule(lifted.hooks, ported));
  for (const [world, cov] of lifted.coverage) files.set(`coverage/${world}.json`, json(cov));
  return new Map(sorted(files.keys()).map(path => [path, files.get(path) ?? '']));
}

/** The engine's own check: the lifted YAML must load. */
export function checkContent(files: Map<string, string>, problems: Problems): GameContent | null {
  const sources = [...files].filter(([path]) => path.endsWith('.yaml')).map(([path, text]) => ({ path, text }));
  try {
    return parseGame(sources);
  } catch (e) {
    if (!(e instanceof ContentError)) throw e;
    for (const p of e.problems) problems.error('content', p);
    return null;
  }
}

export function liftGame(raw: RawIR, options: LiftOptions, overrides?: Overrides): LiftResult {
  const problems = new Problems();
  const lifted = liftContent(raw, {
    ...options,
    metersPerPixel: options.metersPerPixel ?? overrides?.coords.metersPerPixel,
    projections: { ...overrides?.coords.screens, ...options.projections },
    contexts: { ...overrides?.contexts, ...options.contexts },
  }, problems);
  const applied = overrides ? applyOverrides(lifted, overrides, problems) : [];
  const files = renderFiles(lifted, options.ported ?? new Set());
  const content = checkContent(files, problems);
  return { files, lifted, content, problems, applied };
}
