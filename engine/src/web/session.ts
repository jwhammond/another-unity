// SPDX-License-Identifier: GPL-3.0-or-later
import { MixerChannels } from '../audio/channels';
import type { Mixer, Playing } from '../audio/mixer';
import { ContentError, parseGame } from '../content/parse';
import { SHIP, type CombatData, type GameContent, type ShipFx } from '../content/types';
import type { DevPort } from '../dev/overlay';
import { RuleTrace } from '../dev/trace';
import type { SimEvent } from '../sim/events';
import { perform } from '../sim/actions';
import { clickRow, listRows, maxListScroll, scrollList } from '../sim/computer';
import { ending } from '../sim/ending';
import { COMBAT_SAVE_REFUSED, deserializeSave, deserializeState } from '../sim/save';
import { GAME_END, markMovieSeen, NO_SCENARIO, STATION_CODE, sectorOf, type Station, type Vec3i } from '../sim/ship';
import { ensureCombat, prefetchCombat } from '../sim/combatData';
import { BattleAssetHolder, fetchBytes, type BattleAssetState } from './battleAssets';
import { audioUrl, BattleSound } from './battleSound';
import { CombatViewHost, hudKeepOut, type CombatViewSource, type CombatViewState, type SpaceSceneModule } from './combatView';
import { consoleFontsLoader } from './consoleFonts';
import { consoleRepaintLoader, decodePlate } from './consoleRepaint';
import { RecordingScreen, seeThrough, type ArtPicture, type ConsoleBlit, type ConsoleRepaint } from '../view/combat/spaceArt';
import { newRadarMemory } from '../view/combat/files';
import type { BattleAssets } from '../view/combat/assets';
import type { ConsoleArt } from '../view/combat/console';
import { FULL_RECT, SPLIT_RECT } from '../view/combat/projection';
import { Palette } from '../view/indexed';
import { contacts, gotoShipScreen, hailObject, holodeckPlay, leaveHolodeck, loungeTalk, seenMovieStems, stationOf } from '../sim/stations';
import { answerHail, battleDef, resolveCombat, shipKind } from '../sim/combat';
import type { CombatAssists } from '../sim/combat/assists';
import { scrollLog, standDown as standDownBattle } from '../sim/combat/tactical';
import { updateBattle } from '../sim/combat/battle';
import { applyCommand, CONSOLE_PAGES, type CombatCommand } from '../sim/combat/commands';
import { SIM_SEAMS } from '../sim/combat/seams';
import { setupBattle } from '../sim/combat/setup';
import { shipTickToMs, STEP_TIME, systemsToBattleClock } from '../sim/combat/time';
import { NO_SEAMS, type BattleContext, type BattleState } from '../sim/combat/types';
import { autoResolve, battleCommand, consolePage, finishResolved, pauseBattle, syncBattleClock, WARP_WAIT } from '../sim/tacticalScreen';
import type { BattlePort } from './battlePort';
import { computerPercent } from '../sim/shipSystems';
import { createInitialState, type WorldState } from '../sim/state';
import { World, type WorldOptions } from '../sim/world';
import type { UiSession } from '../ui/app';
import { bindHotspotLabels, roomHotspotLabels, showHotspotLabels } from '../ui/hotspotLabels';
import { Input } from '../ui/input';
import type { SavesPort } from '../ui/savesPort';
import { SLOTS, saveName, type SaveSlots } from '../ui/saves';
import { UiStore } from '../ui/store';
import { BrowserPresenter } from '../view/browserPresenter';
import { introPiece, loopFor, musicFor, screenAudio, type GamePackage } from '../view/package';
import { FixedLoop } from '../view/loop';
import { adminArtFromPresentation, facesFromPresentation, type AdminArt, type Faces } from '../ui/faces';
import { artFromPresentation, artPicture, defaultLoaders, imageTexture, leanLoaders, shipArtFromPresentation, type ArtLoaders, type ArtSource, type ShipArt } from '../view/art';
import { areaViewport, loadShipPlate, pointerInViewport, PLATE_H, PLATE_W, type ShipPlate } from '../view/shipPlate';
import { createSpaceView, type SpaceView } from '../view/space';
import { hailStill, viewscreenImage, viewSheet } from './viewscreenImage';
import { loadShipSet, screenViewport, type ShipSet, type Viewport } from '../view/shipSet';
import { Stage } from '../view/stage';
import { PresentationClock } from '../view/timeline';
import { tricorderCue } from './cues';
import { createAstroScene, type AstroScene } from '../view/astro';
import { cursorPoint, DISPLAY_SWITCHES, displayOn, moveCursor, newMapCamera, padClick, spin, startSpin, ticksOf, toggleDisplay, turnBy } from '../sim/astroCamera';
import { addSensorRecord, engage, stopTransit, locationName, scrollSensors, SENSOR_ROWS, maxWarp, planetCount, previewCourse, journeyTime, distanceTo, type CourseError } from '../sim/astro';
import { makePlanets, moonText, phenomenonText, planetText, sectorText, starText, stationText, THING } from '../sim/planets';
import { NOWHERE, type AstroLocation } from '../sim/ship';
import { buildEntries, destinationName, locationSubtype, locationType, paletteOf, phenomenonAt, starAt, stationAt, type MapInput } from '../view/astroLayout';
import { clickMap, cursorMoved, cursorToSelection, destOrbit, locationOf, selectionOf, settleSelection, viewFor } from '../view/astroSelect';
import { engineeringPort } from './engineeringSession';
import { holodeckPort } from './holodeckSession';
import { TransporterDirector } from './transporterDirector';
import { exitCursorPort } from './exitCursor';
import { astroFontsPort } from './astroFontsSession';
import { addToPad, canEnergize, chooseRecommended, energizeAndArrive, moveToEquipment, moveToKit, removeFromPad, restoreTransporter, transporterRoom, clipDifficulty } from '../sim/transporter';
import { BRIDGE_LOOK, BRIDGE_SHADOWS } from '../view/bridgeLook';
import type { Settings } from './settings';
import { FEEDBACK_SAVE_MAX, recentLines, type FeedbackGame, type FeedbackPort, type FeedbackTransport } from './feedback';
import { CONSOLE_SOUNDS, pageStorage, SettingsRecord, type ConsoleSound, type SettingsOverrides, type SettingsPort } from './settingsPort';
import type { AstroSelection, BridgeItemView, ShipPort } from './shipPort';
import { WebGLRenderTarget, type Camera, type Scene, type Texture, type WebGLRenderer } from 'three';

/** What a phone lets the crew's animation strips take (see StageOptions.stripBudget), in bytes. */
export const STRIP_BUDGET = 96 * 1048576;
/** The same on a desktop, which has the memory for more but not for a room's whole crew at once. */
export const DESKTOP_STRIP_BUDGET = 384 * 1048576;

/** The save slot the autosave uses; the save menu's slots start at 1. */
export const AUTOSAVE_SLOT = 0;
/** The game over the original's QUIT ends with: 0x20, the credits and then the title (phase4_rest.md §6.2). */
const QUIT_GAME_OVER = 0x20;

/** The port takes slots 1-9 only (the autosave, slot 0, is load-only there). */
function portSlot(slot: number, loading: boolean): void {
  const ok = Number.isInteger(slot) && ((slot >= 1 && slot <= SLOTS) || (loading && slot === AUTOSAVE_SLOT));
  if (!ok) throw new Error(`no such save slot: ${slot}`);
}

export interface SessionParts {
  /** Draws a frame: the app passes the WebGL renderer's; tests draw nothing. */
  render?: (stage: Stage, over?: { scene: Scene; camera: Camera; viewport?: Viewport; before?: (r: WebGLRenderer) => void; after?: (r: WebGLRenderer) => void; /** The frame is cleared instead of the stage drawn under the box. */ clear?: boolean }) => void;
  /**
   * Runs a job on the WebGL renderer between frames: the app passes its renderer's; tests have none. The space view's
   * warm-up before a battle's first frame (Plan 34 Task 8).
   */
  prepare?: (job: (r: WebGLRenderer) => Promise<void>) => Promise<void>;
  /** How art files are loaded (a test gives its own). */
  artLoaders?: ArtLoaders;
  /**
   * The renderer's pixel ratio: device pixels per CSS pixel of the drawing buffer, which the boxes drawn in and the
   * pointer's mapping use. The app's is capped at 2 on a low-memory device (device.ts pixelRatioFor); without one, the device's.
   */
  pixelRatio?: () => number;
  /** `?dev&ship3d`: a ship station with a glb and a plate is drawn from the 3D set instead of the plate (R14). */
  ship3d?: boolean;
  labels?: HTMLElement | null;
  /** Null without Web Audio: the game plays silent, with timed lines. */
  audio?: Mixer | null;
  /** Null without IndexedDB: no save slots (export and import still work). */
  saves?: SaveSlots | null;
  log?: (level: 'warn' | 'error', message: string) => void;
  /** The site's feedback check and send (apps/web/src/feedback): without it, the console has no FEEDBACK. */
  feedback?: FeedbackTransport;
  /** Game speed: 1 is real time (the app's `?speed=N`). */
  speed?: number;
  /**
   * `?art=0` (true) or `?art=1` (false): the art off or on for this page load (R10), over the settings record's `art` and never
   * written back to it (Plan 32). Without it, the record's.
   */
  artOff?: boolean;
  /** ?panel=0: the HUD's own away-team bar even where the original's panel is published (art.panel). */
  panelOff?: boolean;
  /**
   * The bridge stub: no screen's music or ambience until the team beams down (`playIntro`), so the click that
   * wakes the audio on the bridge doesn't start them under the arrival movie.
   */
  holdMusic?: boolean;
  /**
   * The difficulty setting, 0-2 (R6): the app's `?difficulty=`, for this page load only (Plan 32: never written back). Without it,
   * the settings record's.
   */
  difficulty?: number;
  /** A dev ship start (M11): the triggers a new game on the ship enables, kept across a restart. */
  devShip?: string[];
  /**
   * Tactical fights in the combat sim (Plan 23 R2: the app's ?dev, until M8's switch-on), not the M4 dialog. The
   * dialog's Win, Flee and Lose stay beside it as a test shortcut.
   */
  realCombat?: boolean;
  /** False for a dev start somewhere else, which begins over at once. */
  opening?: boolean;
  /**
   * Hold the opening movies until `beginOpening`: the app's loading screen is still up when the session is made, and
   * the movie must not start (or the sim run) under it.
   */
  deferOpening?: boolean;
  /** Half-resolution plates (`plate.half.webp`, where the game was published with them): for a phone's memory. */
  lowRes?: boolean;
  /** Test hook (Plan 30): a pack's picture as a texture (default imageTexture). */
  artImage?: (bytes: Uint8Array, type: string, size: [number, number], o: { name: string; flipY: boolean }) => Promise<Texture>;
  /** Test hook (Plan 30): a pack's picture for the console's art layer (default artPicture). */
  artPicture?: (bytes: Uint8Array, type: string, size: [number, number]) => Promise<ArtPicture>;
  /** Test hook (Plan 30): the console's repaint plate loaded and decoded (default consoleRepaint.ts' decodePlate). */
  loadPlate?: (url: string) => Promise<void>;
  /** Loads the space view's module (the combat chunk: M8 spec §8); a test gives its own. */
  combatView?: () => Promise<SpaceSceneModule>;
  /**
   * Told what loading is on now, as each step begins (the app's loading screen shows it), and for a step that has
   * parts (the first room's art files), how far through it is, 0 to 1. With it, `start` also waits for that first
   * room's art, so the loading screen does not end on a greybox.
   */
  progress?: (label: string, within?: number) => void;
}

/** What `SessionParts.progress` says, in order: the steps of Session.start. */
export const SESSION_STEPS = ['Building the world', 'Loading rooms', 'Loading art'] as const;

/**
 * The difficulty setting is kept with the other settings (settings.ts' record, Plan 32), as ScummVM keeps it in ConfMan
 * (metaengine.cpp:38-90), not in the save (R6). The levels' names, as ScummVM's options give them (metaengine.cpp:57-60).
 */
export const DIFFICULTY_NAMES = ['Ensign', 'Lieutenant', 'Captain'] as const;

export const SAVE_REFUSED = 'You can only save while nothing is happening.';

/** Where a new game starts instead of game.yaml's start: a mission's beam-down screen, or the dev tools' ?start=. */
export interface StartAt {
  screen: string;
  entrance: string;
  /** A dev start's own away team (the dev tools' ?team=), instead of game.yaml's. */
  awayTeam?: string[];
  leader?: string;
}

export const CHANGE_REFUSED = 'You can only load, import or restart while nothing is happening.';
/** A load or restart that failed after the old game was torn down leaves nothing to go back to. */
export const SWAP_FAILED = 'The game could not be loaded or restarted; reload the page.';
export const SHIP_REFUSED = 'Wait until nothing is happening, then try again.';
export const JUMP_REFUSED = 'You can only jump while nothing is happening.';
/** How far, in the original's pixels, the pointer moves from a press before it is a drag (kDragDistance, awayteam.cpp:84). */
const DRAG_DISTANCE = 16;
/** The original's screen width, which DRAG_DISTANCE is counted on. */
const SCREEN_WIDTH = 640;

/** The bridge sprites' animations (bridge.cpp start, talk.cpp): startAnim(0) is the idle loop, and a ship speaker plays kAnimShipTalk. */
const BRIDGE_IDLE = 0;
const BRIDGE_TALK = 2;

/** kAnimStanding (transporter.cpp:411): what a padded crew member plays. */
const ANIM_STANDING = 0x18;
/** The walking animations the transporter's crew play (transporter.cpp: the direction of each leg of the walk, 0, 3 and 9). */
const WALK_ANIMS = [0, 3, 9];
/** tdoor.spr, drawn over the crew at the transporter's doorway: 70x176 at (0, 112), the plate's own wall (transporter.cpp:222). */
const DOORWAY: [number, number, number, number] = [0, 112, 70, 176];
/** What a station's loaded set is kept under: its plate, or its glb and camera. */
/** The longest the last station's picture and panel are held over a station whose own picture is loading, in milliseconds (B5). */
const SHIP_HOLD_MS = 1500;
const shipSetKey = (station: string, art: ShipArt): string => (art.kind === 'plate' ? `${station}|${art.plate}` : `${station}|${art.gltf}|${art.camera}`);
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const consoleLog = (level: 'warn' | 'error', text: string) => {
  console[level](text);
};

/**
 * One running game in the browser: the world, and the stage, presenter, input and UI state that show it.
 * Loading a save swaps in a new world; the stage, store and clock carry on.
 */
export class Session {
  readonly store = new UiStore();
  readonly clock = new PresentationClock();
  readonly stage: Stage;
  /** Drives `tick` and `frame` from animation frames: the app calls `loop.start()`. */
  readonly loop: FixedLoop;
  world!: World;
  input!: Input;
  presenter!: BrowserPresenter;
  private off: (() => void) | null = null;
  /** Made on first use (the dev tools'), so a player's game doesn't format trace lines. */
  private ruleTrace: RuleTrace | null = null;
  /** Problems with the last hot-reloaded content, for the dev overlay. */
  problems: string[] = [];
  private offTrace: (() => void) | null = null;
  private pendingContent: { pkg: GamePackage; content: GameContent } | null = null;
  /** Reloaded content the running game doesn't fit: the next restart starts it. */
  private pendingRestart: { pkg: GamePackage; content: GameContent } | null = null;
  /** A load or restart is under way. */
  private swapping = false;
  /** What the controls showed last frame (Input.canAct, idle): an action can end without an event. */
  private controls = '';
  /**
   * While set, no screen's music loop starts: the bridge holds it until the team beams down, and a beam-down piece holds
   * it while it plays (Sound::updateMusic starts a loop only once no music plays).
   */
  private musicHeld = false;
  /** The bridge holds the ambience with the music until the team beams down. */
  private ambienceHeld = false;
  /** The beam-down piece playing now: playIntro while it plays gives it again. */
  private intro: Promise<void> | null = null;
  /** Counts holds: a beam-down piece from before the latest hold doesn't release it when it ends. */
  private holds = 0;
  private introPlaying: Playing | null = null;
  /** The astrogation map, made on first use. */
  private map: AstroScene | null = null;
  /** What astrogation has chosen (AstrogationScreen::_selection): nowhere until the first visit, when it is where the ship is. Presentation, kept for the session. */
  private astroLoc: AstroLocation = { ...NOWHERE };
  private astroStarted = false;
  /** The scripted warp's course whose place is on the map (a scripted warp chooses its place as it arrives). */
  private astroAuto: unknown = null;
  /** The map's camera and cursor (AstrogationScreen's view, angles, cursor and tabs): presentation, kept for the session. */
  private mapCam = newMapCamera();
  /** Whether the last frame was at astrogation, so that the map's spin starts afresh each visit. */
  private astroHere = false;
  private canvas: HTMLElement | null = null;
  /**
   * The settings in force (Plan 32): the stored record, with this load's URL overrides over it. Worlds take the difficulty (R6) and
   * the combat assists (spec §5) when they are made; a change applies to the running one at once.
   */
  private readonly settings: SettingsRecord;
  /** Whether the admin PADD was up at the last change to the store, and the battle's pause from before it opened. */
  private adminWas = false;
  private adminBattle: { run: object; paused: boolean } | null = null;

  /** The difficulty setting (R6). */
  private get level(): 0 | 1 | 2 {
    return this.settings.now.difficulty;
  }

  /** The combat assists (spec §5). */
  private get combatAssists(): CombatAssists {
    return this.settings.now.assists;
  }

  /** How art files are loaded: the part's, else the default (without mip chains on a device short of memory). */
  private readonly loaders: ArtLoaders;
  /** The battle's models, sprites and stills (M8 spec §8): loaded as a real battle starts, freed as it ends or the world is replaced. */
  private readonly battleAssets: BattleAssetHolder;
  /** The space view (M8 spec §3): its chunk, loaded as the first battle is drawn, and the scene of the battle being drawn. */
  private readonly combatView: CombatViewHost;
  /** Where the space view goes for the world's battle: the console's box, or the game frame when wide (BattlePort.viewBox: Plan 27 R3). */
  private combatBox: ((wide: boolean) => DOMRect | null) | null = null;
  /**
   * Tactical's F1 Combat Options (Plan 32 Task 11): the battle the screen is up over and the pause it had, which closing gives back; and where
   * the screen's preview window is (BattlePort.previewBox).
   */
  private optionsHeld: { run: object; paused: boolean } | null = null;
  private optionsBox: (() => DOMRect | null) | null = null;
  /** What the wide view's HUD covers of it (BattlePort.hudBoxes), for the target's arrow (Plan 32 Task 9). */
  private hudBoxes: Parameters<BattlePort['hudBoxes']>[0] = null;
  /** The battle's port, made once: the console, the assists panel in the settings and the dev view share it, and its auto-resolve's state (Plan 29). */
  private battlePortOnce: BattlePort | null = null;
  /** The radar's grid memory, kept for the session as TacticalScreen keeps it (Plan 27). */
  private readonly radarMemory = newRadarMemory();
  /** The battle's sound (Plan 28): the crew's cues and the effects on Sound's eight channels, through the mixer; none without Web Audio. */
  private readonly battleSound: BattleSound | null;
  /** The console's fonts and pictures, made once a set and fonts are in (consoleArt). */
  private readonly consoleFonts = consoleFontsLoader({
    presentation: () => this.pkg.presentation, assets: () => this.pkg.assets, bump: () => this.store.bump(), warn: m => this.log('warn', m),
    fetchBytes,
  });
  /** The console's repaint (Plan 30 R7): fetched on first use while the art is on, kept for the session. */
  private readonly consoleRepaint = consoleRepaintLoader({
    presentation: () => this.pkg.presentation, assets: () => this.pkg.assets, lowRes: () => this.parts.lowRes === true, bump: () => this.store.bump(), warn: m => this.log('warn', m),
    fetchBytes, decode: (bytes, type, size) => (this.parts.artPicture ?? artPicture)(bytes, type, size),
    loadPlate: url => (this.parts.loadPlate ?? decodePlate)(url),
  });
  private consoleArtFor: { stills: object; fonts: unknown; combat: object; repaint: unknown; art: ConsoleArt } | null = null;
  /** A battle `?dev` draws on the whole canvas, apart from the world's (previewBattle): for the e2e tests and the screenshot check. */
  private preview: CombatViewSource | null = null;
  /** The preview's context, for stepPreview (previewBattle's; previewState's has none). */
  private previewCtx: BattleContext | null = null;

  private constructor(public pkg: GamePackage, public content: GameContent, private readonly parts: SessionParts) {
    const overrides: SettingsOverrides = {
      ...(parts.difficulty !== undefined ? { difficulty: clipDifficulty(parts.difficulty) } : {}),
      ...(parts.artOff !== undefined ? { art: !parts.artOff } : {}),
    };
    this.settings = new SettingsRecord(pageStorage, overrides);
    this.loaders = parts.artLoaders ?? (parts.lowRes ? leanLoaders(defaultLoaders) : defaultLoaders);
    this.battleAssets = new BattleAssetHolder(() => this.pkg.assets, {
      model: url => this.loaders.model(url),
      texture: (url, color) => this.loaders.texture(url, color),
      bytes: url => fetchBytes(url),
      // (the art's pictures, at half their size at a low resolution: Plan 30 R15)
      image: (bytes, type, size, o) => (parts.artImage ?? imageTexture)(bytes, type, parts.lowRes ? [Math.max(1, size[0] >> 1), Math.max(1, size[1] >> 1)] : size, o),
    }, m => this.log('warn', m), () => this.store.bump(), () => (this.stage.debugView.art ? this.pkg.presentation.art.space ?? null : null));
    // (prefers-reduced-motion, as the browser says it now: M8 spec §3.2)
    const motion = typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia('(prefers-reduced-motion: reduce)') : null;
    this.combatView = new CombatViewHost(parts.combatView ?? (() => import('../view/combat/spaceScene')), m => this.log('warn', m), () => this.store.bump(), () => motion?.matches ?? false, () => this.settings.now.combat, parts.prepare);
    const audio = parts.audio;
    this.battleSound = audio ? new BattleSound(new MixerChannels(audio), {
      cues: () => this.content.ship?.combat?.cues ?? [],
      sounds: () => this.content.ship?.combat?.media.sounds ?? [],
      url: file => audioUrl(this.pkg.assets, file),
      // (the Enterprise's systems are the ship's during a battle: startWorldBattle's `enterprise: ship.systems`)
      computerOn: () => !this.content.ship || computerPercent(this.content.ship, this.world.state.ship.systems) > 0,
      // (read at each effect, as the combat options are: a change from the PADD applies to the next one)
      threeD: () => this.settings.now.threeD,
      preload: urls => void audio.preload(urls),
    }) : null;
    this.stage = new Stage({
      roomUrl: screen => this.pkg.assets.room(screen),
      clock: this.clock,
      labels: parts.labels ?? null,
      // (the away team's rooms only: aboard, the stage may still hold the last room, but the ship's screens are what is shown)
      hotspotLabels: () => roomHotspotLabels(this.world),
      warn: m => this.log('warn', m),
      // (aboard the ship the room under the panels is not on show: its plate would only sit in memory)
      art: { room: screen => (this.world.state.onShip !== null ? undefined : this.artSource().room(screen)), card: id => this.artSource().card(id), phaser: () => this.artSource().phaser?.() },
      artOff: !this.settings.now.art,
      artLoaders: this.loaders,
      stripBudget: parts.lowRes ? STRIP_BUDGET : DESKTOP_STRIP_BUDGET,
      artProgress: parts.progress && ((done, total) => parts.progress?.(SESSION_STEPS[2], total === 0 ? 1 : done / total)),
    });
    this.loop = new FixedLoop(() => this.tick(), dt => this.frame(dt), { speed: parts.speed });
    this.applyAudio();
    // (the HUD's Hotspots button and H key change the setting through the record)
    bindHotspotLabels(this.settings.now.hotspots, hotspots => this.changeSettings({ hotspots }));
    // (the admin PADD stops the game however it opens or goes: its own buttons, Escape, a load's reset)
    this.store.subscribe(() => this.adminChanged());
    this.musicHeld = parts.holdMusic ?? false;
    this.ambienceHeld = this.musicHeld;
    this.clock.speed = this.loop.speed;
  }

  private artFor: { pkg: GamePackage; source: ArtSource } | null = null;

  /** The package's art (rebuilt when a hot swap changes the package). */
  private artSource(): ArtSource {
    if (this.artFor?.pkg !== this.pkg) this.artFor = { pkg: this.pkg, source: artFromPresentation(this.pkg.presentation, this.pkg.assets, m => this.log('warn', m), { lowRes: this.parts.lowRes }) };
    return this.artFor.source;
  }

  private facesFor: { pkg: GamePackage; faces: Faces } | null = null;

  /** The portraits and icons the HUD shows (none with the art off: the HUD keeps its text). */
  private faces(): Faces | undefined {
    if (!this.stage.debugView.art) return undefined;
    if (this.facesFor?.pkg !== this.pkg) this.facesFor = { pkg: this.pkg, faces: facesFromPresentation(this.pkg.presentation, this.pkg.assets, this.content.rules.items.communicator, { panel: !this.parts.panelOff }) };
    return this.facesFor.faces;
  }

  private shipArtFor: { pkg: GamePackage; source: (station: string) => ShipArt | undefined } | null = null;
  /** The ship's drawn stations by station and file: loading (neither), loaded, or failed (warned once, the flat panel stays). */
  private readonly shipSets = new Map<string, { station: string; art: ShipArt; set: ShipSet | null; failed: boolean; dropped: boolean }>();
  /** Where the ship panel's picture box is on the page, while it is up. */
  private shipBox: (() => DOMRect | null) | null = null;

  /** The game's bitmap fonts for astrogation's text, loaded once for the panel and the map alike (art.fonts). */
  private readonly astroFontsLoader = astroFontsPort({
    artOn: () => this.stage.debugView.art, presentation: () => this.pkg.presentation, assets: () => this.pkg.assets, bump: () => this.store.bump(),
    fetchBytes: async url => new Uint8Array(await (await fetch(url)).arrayBuffer()),
  });
  /** The same fonts for the admin console's words, whatever the art setting: they are the original's (spec §3 Decision 4). */
  private readonly adminFontsLoader = astroFontsPort({
    artOn: () => true, presentation: () => this.pkg.presentation, assets: () => this.pkg.assets, bump: () => this.store.bump(),
    fetchBytes: async url => new Uint8Array(await (await fetch(url)).arrayBuffer()),
  });
  /** Whether a set was drawn last frame: the panel's look changes with it. */
  private shipArtLook = 'false false false';

  private shipArtOf(station: string): ShipArt | undefined {
    if (this.shipArtFor?.pkg !== this.pkg) this.shipArtFor = { pkg: this.pkg, source: shipArtFromPresentation(this.pkg.presentation, this.pkg.assets, m => this.log('warn', m), { set3d: this.parts.ship3d === true, lowRes: this.parts.lowRes }) };
    return this.shipArtFor.source(station);
  }

  /** The entry for a station's art, once it is asked for (the first ask starts the load); null with art off or none. */
  private shipEntry(station: string): { art: ShipArt; set: ShipSet | null } | null {
    if (!this.stage.debugView.art) return null;
    const art = this.shipArtOf(station);
    if (!art) return null;
    const key = shipSetKey(station, art);
    let entry = this.shipSets.get(key);
    if (!entry) {
      const e = { station, art, set: null as ShipSet | null, failed: false, dropped: false };
      entry = e;
      this.shipSets.set(key, e);
      const loaders = this.loaders;
      const loaded = art.kind === 'plate' ? this.loadPlate(art, loaders) : loadShipSet(art.gltf, art.camera, loaders, object => this.artSource().card(object));
      loaded.then(set => {
        // (the team left, or art went off, while it loaded)
        if (e.dropped) set.dispose();
        else {
          e.set = set;
          this.store.bump();
        }
      }, (err: unknown) => {
        e.failed = true;
        this.log('warn', `the ${station} ${art.kind === 'plate' ? 'plate' : 'set'} could not be loaded (${message(err)}): using the flat panel`);
      });
    }
    return entry;
  }

  /** A plate with its crew's cards stood on it (a card that doesn't load is left out; the plate still draws). */
  private async loadPlate(art: Extract<ShipArt, { kind: 'plate' }>, loaders: ArtLoaders): Promise<ShipSet> {
    const plate = await loadShipPlate(art, loaders);
    await Promise.all(art.crew.map(async c => {
      const card = this.artSource().card(`bridge.${c.object}`);
      if (!card) return;
      // (the idle animation, the start of the original's loop, when the card has one; `playCards` moves it to the talk one while it speaks)
      const idle = card.anims?.[BRIDGE_IDLE] !== undefined ? { anim: BRIDGE_IDLE, all: true, only: [BRIDGE_IDLE, BRIDGE_TALK] } : {};
      // (set into the repainted plate: its edge, colours and shadow; bridgeLook.ts)
      const look = { look: BRIDGE_LOOK, shadow: BRIDGE_SHADOWS[c.object] };
      await plate.placeCards([{ key: c.object, art: card, at: c.at, depth: c.depth, ...idle, ...look }]).catch((err: unknown) => this.log('warn', `the crew card of ${c.object} could not be loaded (${message(err)})`));
    }));
    return plate;
  }

  /** A station's set if its load has been asked for and has finished; unlike `shipEntry`, asking never starts the load (what only looks, as the debug handle does, must not). */
  private loadedShipSet(station: string): ShipSet | null {
    if (!this.stage.debugView.art) return null;
    const art = this.shipArtOf(station);
    return art ? (this.shipSets.get(shipSetKey(station, art))?.set ?? null) : null;
  }

  /** The set to draw for a station, once it has loaded; null with art off or no set. */
  private shipSetFor(station: string): ShipSet | null {
    return this.shipEntry(station)?.set ?? null;
  }

  /**
   * The station whose own set was drawn last, that set, and the box it was drawn in: held on show while the next station's loads (B5). The
   * box is kept as it was, since the next station's panel may have none while it is flat.
   */
  private shipShown: { station: string; set: ShipSet; box: DOMRect } | null = null;

  /** The station a held set is held for, and since when (Date.now()): a hold lasts SHIP_HOLD_MS at most, from the station's change. */
  private shipHoldFrom: { station: string; at: number } | null = null;
  /** The station the ship was at when last looked, as the world changed: a move from it starts the hold's clock (B5). */
  private shipStationSeen: string | null = null;

  /** Starts the hold's clock as the station changes (an event, or a new world), not when a frame or a panel next looks. */
  private noteShipStation(): void {
    const station = this.shipStationNow();
    if (station === this.shipStationSeen) return;
    this.shipStationSeen = station;
    this.shipHoldFrom = station === null ? null : { station, at: Date.now() };
  }

  /**
   * The set held on show for a station whose own set is still loading (B5): the one drawn last, so a move between stations never shows the
   * flat panel for a moment. None once the station's set is in, or failed (the flat panel is its picture then), or at astrogation, whose map
   * fills the screen while its plate loads, or after SHIP_HOLD_MS: the panel held over it takes no clicks, so the new station's panel shows then,
   * flat, and its picture pops in when it comes. Only looks: the frame starts the station's load (a panel's render asks this too).
   */
  private heldShipSet(station: string | null): ShipSet | null {
    const last = this.shipShown;
    const art = station === null ? undefined : this.shipArtOf(station);
    const e = station === null || !art ? undefined : this.shipSets.get(shipSetKey(station, art));
    // (an entry not made yet is a load the next frame starts)
    const loading = station !== null && last !== null && last.station !== station && this.stage.debugView.art && !this.atAstrogation() && art !== undefined && (e === undefined || (e.set === null && !e.failed));
    if (!loading || station === null || last === null) return null;
    // (a change no event told of: its clock starts now)
    if (this.shipHoldFrom?.station !== station) this.shipHoldFrom = { station, at: Date.now() };
    return Date.now() - this.shipHoldFrom.at < SHIP_HOLD_MS ? last.set : null;
  }

  /** Starts loading the art of the stations the turbolift goes to, as its list opens, so a move there shows at once (B5); not on a phone, which keeps only the station it is at. */
  private preloadStations(stations: string[]): void {
    if (this.parts.lowRes === true || this.world.state.onShip === null) return;
    for (const station of stations) this.shipEntry(station);
  }

  /**
   * Frees the stations' art the player isn't at. On a desktop every station visited stays while the team is aboard, so a move back
   * shows at once (B5); on a phone, with its smaller memory, only the current one's (and one held on show while it loads), and the
   * bridge's plate is loaded again when the player goes back (R14). With `keep` null, all go.
   */
  private trimShipSets(keep: string[] | null): void {
    for (const [key, e] of this.shipSets) {
      if (keep !== null && (this.parts.lowRes !== true || keep.includes(e.station))) continue;
      e.dropped = true;
      e.set?.dispose();
      if (e.set !== null && e.set === this.shipShown?.set) this.shipShown = null;
      this.shipSets.delete(key);
    }
  }

  /** The viewscreen's picture (R7, R15): one scene, drawn into one render target that the window layers show. */
  private space: SpaceView | null = null;
  private spaceImage = '';
  private target: WebGLRenderTarget | null = null;
  /** The plates the target is set on as their window's colour; and the viewscreen plate a bridge draws as its frame. */
  private readonly windowOn = new WeakSet<ShipSet>();
  private readonly frameOn = new WeakMap<ShipSet, ShipSet | null>();

  /** Frees the viewscreen's scene and its render target (the team left the ship, or art went off). */
  private freeSpace(): void {
    this.space?.dispose();
    this.space = null;
    this.spaceImage = '';
    this.target?.dispose();
    this.target = null;
  }

  /** The window layer for a plate: the picture, in a target the size of the window's box on the screen. Returns the draw hook, or null with no window. */
  private windowLayer(plate: ShipPlate, rect: [number, number, number, number], viewport: Viewport, step: number, hailing: boolean): (r: WebGLRenderer) => void {
    const loaders = this.loaders;
    const space = (this.space ??= createSpaceView(1701, loaders, m => this.log('warn', m)));
    space.setBox(rect[2], rect[3]);
    const image = viewscreenImage(this.world, hailing);
    // (a caller with a repainted still shows it, placed as the original places the sprite; any other sprite plays its sheets, the
    // animation the viewscreen starts, each frame where the original draws it; without them its first frame, centred)
    const views = this.pkg.presentation.art.ship.viewscreen;
    const still = image.kind === 'sprite' ? hailStill(views?.hails, image.sprite, this.pkg.assets) : undefined;
    const sheet = image.kind === 'sprite' && still === undefined ? viewSheet(views?.views, image.sprite, this.pkg.assets) : undefined;
    const url = still?.url ?? (image.kind === 'sprite' ? this.pkg.assets.url(`art/ship/view/${image.sprite}.webp`) : undefined);
    const key = `${JSON.stringify(image)}|${url ?? ''}|${still ? `${still.scale}@${still.at}` : ''}|${sheet ? JSON.stringify(sheet.urls) : ''}`;
    if (key !== this.spaceImage) {
      this.spaceImage = key;
      const boxCentre: [number, number] = [rect[0] + rect[2] / 2, rect[1] + rect[3] / 2];
      space.set(image, url, still && { scale: still.scale, at: still.at, boxCentre }, sheet && { ...sheet, boxCentre });
    }
    space.update(step);
    // (the target is the window's box in device pixels; reallocated only when that size changes)
    const w = Math.max(1, Math.round((viewport.width * rect[2]) / PLATE_W));
    const h = Math.max(1, Math.round((viewport.height * rect[3]) / PLATE_H));
    if (!this.target) this.target = new WebGLRenderTarget(w, h);
    else if (this.target.width !== w || this.target.height !== h) this.target.setSize(w, h);
    const target = this.target;
    if (!this.windowOn.has(plate)) {
      plate.setWindow(target.texture);
      this.windowOn.add(plate);
    }
    return r => {
      const was = r.getRenderTarget();
      r.setRenderTarget(target);
      r.render(space.scene, space.camera);
      r.setRenderTarget(was);
    };
  }

  /** The station whose picture is drawn now: the viewscreen's while it is up, else the ship's own (the computer leaves it as it was). */
  private shipStationNow(): string | null {
    if (this.world.state.onShip === null) return null;
    if (this.world.viewscreen !== null) return 'viewscreen';
    if (this.world.computer !== null) return 'computer';
    return this.world.state.ship.station;
  }

  /** Parses the game and starts it, from a save if given. Throws ContentError, or SaveError for a bad save. */
  static async start(pkg: GamePackage, parts: SessionParts = {}, save?: string): Promise<Session> {
    parts.progress?.(SESSION_STEPS[0]);
    const session = new Session(pkg, parseGame(pkg.files), parts);
    // (set first: the ship's music waits for the opening's end)
    session.openingPending = save === undefined && session.content.ship !== undefined && parts.opening !== false;
    await session.use(save === undefined ? session.newWorld() : session.worldFromSave(save));
    if (parts.progress) {
      parts.progress(SESSION_STEPS[2], 0);
      await session.stage.artDone;
    }
    // (a new game on the ship opens with the movies, skippable and in order; a load doesn't: unity.cpp:1725-1736. They
    // wait on the store, which stops the world until they are done)
    if (session.openingPending && !parts.deferOpening) session.beginOpening();
    return session;
  }

  /** A new game on the ship's opening movies have not begun yet (`deferOpening`). */
  private openingPending = false;

  /** Starts the opening movies if a new game is waiting to; the app calls it when the player presses Start, before the loop runs. */
  beginOpening(): void {
    if (!this.openingPending) return;
    this.openingPending = false;
    void this.playOpening();
  }

  /** The opening movies (kMovieTeaser, kMovieTitle: unity.cpp:1735-1736), each skippable; one with no film is left out. The ship tour (movie 3) counts as seen and never plays. */
  async playOpening(): Promise<void> {
    const run = ++this.openingRun;
    this.openingActive = true;
    this.holdForOpening();
    try {
      for (const stem of this.pkg.presentation.opening ?? []) {
        // (a load or restart cancels the sequence: its remaining movies never play over the new game)
        if (run !== this.openingRun) return;
        if (this.pkg.assets.movie(stem) === undefined) continue;
        // (UnityEngine::playMovie remembers the movie for the holodeck, unity.cpp:363-364)
        markMovieSeen(this.world.state.ship, stem);
        try {
          await this.presenter.play({ movie: stem });
        } catch (err) {
          this.log('warn', message(err));
          return;
        }
      }
    } finally {
      if (run === this.openingRun) {
        this.openingActive = false;
        // (the bridge's music and ambience begin when the movies are over, not under them)
        if (this.releaseOpeningHold()) this.enteredScreen();
        this.shipMusicNow();
      }
    }
  }

  /** What the opening movies took from the music and ambience holds, to give back: null when they hold nothing. */
  private openingHold: { music: boolean; ambience: boolean } | null = null;

  private holdForOpening(): void {
    if (this.openingHold) return;
    this.openingHold = { music: this.musicHeld, ambience: this.ambienceHeld };
    this.musicHeld = true;
    this.ambienceHeld = true;
    const audio = this.parts.audio;
    if (!audio) return;
    void audio.setLoop('music', undefined);
    void audio.setLoop('ambience', undefined);
  }

  /** Gives the holds back as they were; true when neither was held before, so the screen's loops should start now. */
  private releaseOpeningHold(): boolean {
    const was = this.openingHold;
    this.openingHold = null;
    if (!was) return false;
    this.musicHeld = was.music;
    this.ambienceHeld = was.ambience;
    return !was.music || !was.ambience;
  }

  /** The opening sequence's run number: a newer run or a cancel makes the older loop stop. */
  private openingRun = 0;
  /** The opening movies are playing (their dialog is up, or the next one is about to be). */
  private openingActive = false;

  /** A load or restart ends the opening: its movie is skipped and no later one plays. */
  private cancelOpening(): void {
    if (!this.openingActive) return;
    this.openingRun++;
    this.openingActive = false;
    this.releaseOpeningHold();
    if (this.store.state.dialog?.kind === 'movie') this.store.answer(undefined);
  }

  /** The difficulty setting (R6). */
  get difficulty(): 0 | 1 | 2 {
    return this.level;
  }

  /** It can be changed only while no team is away (metaengine.cpp:84-86). */
  get canChangeDifficulty(): boolean {
    return this.world.state.onShip !== null || this.content.ship === undefined;
  }

  setDifficulty(level: number): void {
    this.changeSettings({ difficulty: clipDifficulty(level) });
  }

  /**
   * Applies a change to the settings at once and keeps the record (less a field this load's URL overrides): the mixer's levels, the
   * running world's difficulty and assists, the art, the hotspot labels. The difficulty only while no team is away.
   */
  private changeSettings(change: Partial<Settings>): void {
    if (change.difficulty !== undefined && change.difficulty !== this.level && !this.canChangeDifficulty) throw new Error('The difficulty can only be changed while no team is away.');
    // (the ticks not yet credited go at the old speed, as pauseBattle's do)
    if (change.assists !== undefined && this.world.battle) syncBattleClock(this.world, this.world.battle);
    const now = this.settings.change(change);
    this.world.difficulty = now.difficulty;
    this.world.assists = { ...now.assists };
    this.applyAudio();
    // (only a change to it: another setting must not undo the dev tools' Art switch. The stage loads the room's art as it turns on,
    // as that switch does; the ship's sets and the HUD's faces follow it)
    if ('art' in change && now.art !== this.stage.debugView.art) this.stage.setDebug({ art: now.art });
    // (shown, not set: setHotspotLabels would hand the change back here)
    showHotspotLabels(now.hotspots);
    this.store.bump();
  }

  /** The sound levels (Plan 32): VOICES/EFFECTS is the voice and effect buses, MUSIC/BACKGROUND the music and ambience. `?mute` still silences the master. */
  private applyAudio(): void {
    const audio = this.parts.audio;
    if (!audio) return;
    const { master, voices, music } = this.settings.now;
    audio.setMaster(master);
    audio.setLevel('voice', voices);
    audio.setLevel('sfx', voices);
    audio.setLevel('music', music);
    audio.setLevel('ambience', music);
  }

  /** The admin PADD is up (Plan 32). */
  get adminOpen(): boolean {
    return this.store.state.panel === 'admin';
  }

  /**
   * The PADD came up or went, by whatever way: as the original's admin menu does, it plays rgcd.mac and pauses the music
   * (phase4_rest.md §6.2, §9: `22ce4(0)`); at tactical the battle pauses too, and gets back the pause it had. The battle's clock runs on
   * world ticks (tacticalScreen.ts syncBattleClock), which `modal` already stops: the pause is for the console's Paused state, and to
   * match the original, where the admin menu stops the game.
   */
  private adminChanged(): void {
    const open = this.adminOpen;
    if (open === this.adminWas) return;
    this.adminWas = open;
    this.parts.audio?.pauseLoops(open);
    if (open) {
      this.consoleSound('rgcd');
      const run = this.world?.battle;
      if (run && this.world.state.onShip !== null && this.world.state.ship.station === 'tactical') {
        this.adminBattle = { run, paused: run.paused };
        pauseBattle(this.world, true);
      }
      return;
    }
    const held = this.adminBattle;
    this.adminBattle = null;
    // (a load from the console ends the battle it paused)
    if (held && this.world.battle === held.run) pauseBattle(this.world, held.paused);
  }

  /** One of the admin console's sounds (presentation.yaml's shipSounds by CONSOLE_SOUNDS), at `level` of its bus where given. */
  private consoleSound(name: ConsoleSound, level?: number): void {
    const audio = this.parts.audio;
    const stem = this.pkg.presentation.shipSounds?.[CONSOLE_SOUNDS[name]];
    const found = stem === undefined ? undefined : this.pkg.assets.sound(stem);
    if (audio && found) void audio.play(found.url, found.bus, false, level === undefined ? {} : { gain: level }).catch(() => null);
  }

  /** The admin PADD's port (Plan 32): the settings record, and the console's opening and closing. */
  private settingsPort(): SettingsPort {
    return {
      get: () => structuredClone(this.settings.now),
      set: change => this.changeSettings(change),
      canChangeDifficulty: () => this.canChangeDifficulty,
      adminOpen: () => this.adminOpen,
      openAdmin: () => this.openAdmin(),
      closeAdmin: () => { if (this.adminOpen) this.store.set({ panel: 'none' }); },
      sound: (name, level) => this.consoleSound(name, level),
      gameOver: () => this.world.state.onShip?.gameOver != null,
      newGame: () => this.restart(),
      quit: () => this.quit(),
    };
  }

  /**
   * QUIT's YES on the admin console: the original returns 0x20fe, its game over 0x20, which plays the credits and then the title
   * (phase4_rest.md §6.2). Here that is the game's end, as a won game's: the ship's game-over screen. A game without a ship starts again.
   */
  async quit(): Promise<void> {
    if (this.content.ship === undefined) return this.restart();
    if (this.adminOpen) this.store.set({ panel: 'none' });
    const world = this.world;
    await world.enqueue(async () => {
      if (world.state.onShip !== null) await gotoShipScreen(world, GAME_END | (QUIT_GAME_OVER << 8));
      else {
        world.state.pendingScreen = { to: SHIP, entrance: '', gameOver: QUIT_GAME_OVER };
        world.applyScreenChange();
      }
    });
    this.store.bump();
  }

  private adminArtFor: { pkg: GamePackage; artOn: boolean; art: AdminArt | undefined } | null = null;

  /**
   * The admin console's pictures: the original's own pixels, whatever the art setting, but for the console's body and the F1 screen, which are
   * their HD repaints with the art on (spec §3 Decision 4).
   */
  private adminArt(): AdminArt | undefined {
    const artOn = this.stage.debugView.art;
    if (this.adminArtFor?.pkg !== this.pkg || this.adminArtFor.artOn !== artOn) this.adminArtFor = { pkg: this.pkg, artOn, art: adminArtFromPresentation(this.pkg.presentation, this.pkg.assets, artOn) };
    return this.adminArtFor.art;
  }

  /**
   * Whether the admin PADD may open now, by any way in (Esc, the bridge strip's Admin, the bar's, the away panel's): not while a warp is pending,
   * as the original's Admin button and Esc are (phase4_rest.md §6.1), and not while a line is said (hidden ones too: Esc skips it instead), a
   * dialog is up or input is blocked: the console stops the game, which would hold the line or the scene half done under it. The game-over
   * screen is the exception: the original keeps its console up there, whatever is on the screen.
   */
  private canOpenAdmin(): boolean {
    if (this.world.state.ship.warpPending) return false;
    // (not over Tactical's F1 Combat Options: the PADD would close over a battle the screen holds paused, and closing it would give the battle back
    // its pause under the screen; the screen takes every key, and the bar is inert behind it, so this is for any other way in)
    if (this.optionsUp()) return false;
    if (this.world.state.onShip?.gameOver != null) return true;
    return this.store.state.subtitle === null && this.store.state.dialog === null && !this.world.state.awayFlags.inputBlocked;
  }

  /** Opens the admin PADD, unless canOpenAdmin refuses: then nothing shows. */
  private openAdmin(): boolean {
    if (!this.canOpenAdmin()) return false;
    if (!this.adminOpen) this.store.set({ panel: 'admin' });
    return true;
  }

  newWorld(at?: StartAt): World {
    const content = at ? { ...this.content, start: { ...this.content.start, ...at } } : this.content;
    // (a new game opens on the ship's bridge; a start `at` somewhere is a dev start, which keeps the away start)
    const onShip = at === undefined && content.ship !== undefined;
    const state = createInitialState(content, undefined, { onShip });
    // (a dev ship start's triggers, with every new game: a restart keeps it, M11)
    if (onShip) for (const id of this.parts.devShip ?? []) if (state.triggers[id]) state.triggers[id].enabled = true;
    const world = new World(content, state, w => this.presenterFor(w), this.worldOptions());
    this.pkg.registerHooks?.(world.hooks);
    world.start();
    return world;
  }

  /** Throws SaveError, before anything changes, for a save that doesn't fit this game. */
  worldFromSave(text: string): World {
    const { state, queued } = deserializeSave(text, this.content);
    return this.worldFromState(state, queued);
  }

  /** The rule trace, following the running world from its first use on. */
  get trace(): RuleTrace {
    if (!this.ruleTrace) {
      this.ruleTrace = new RuleTrace();
      this.offTrace = this.ruleTrace.attach(this.world);
    }
    return this.ruleTrace;
  }

  /** The game speed, for both the loop and presentation time (a voice's wait scales by it). */
  get speed(): number {
    return this.loop.speed;
  }

  set speed(speed: number) {
    this.loop.speed = speed;
    // (the loop's, as it may have refused a bad speed)
    this.clock.speed = this.loop.speed;
  }

  /**
   * A UI-only question (the combadge's) is up, or the admin PADD (Plan 32: the original's admin menu stops the game clock,
   * phase4_rest.md §6.2): the world and presentation time wait for it (Decision 17).
   */
  get modal(): boolean {
    return this.store.state.dialog?.kind === 'prompt' || this.adminOpen;
  }

  /**
   * A movie is up. As in the original, where `playMovie` blocks, nothing else runs: the sim stands still (no trigger starts
   * a conversation, no line is said) and so does the presentation clock (no voice or subtitle timer runs out). A movie
   * with no film is a title card held for a moment by that clock, which therefore keeps running.
   */
  get moviePlaying(): boolean {
    const d = this.store.state.dialog;
    return d?.kind === 'movie';
  }

  /** One sim tick (the loop's fixed step). */
  tick(): void {
    this.clock.speed = this.loop.speed;
    if (this.modal || this.moviePlaying) return;
    try {
      this.world.tick();
    } catch (err) {
      this.log('error', `tick: ${message(err)}`);
    }
  }

  /** One drawn frame: presentation time moves on, the stage draws, and errors the sim recorded are logged. */
  frame(dt: number): void {
    // (a battle can't be saved: the reload waits until it is over, save.cpp:156-159)
    if (this.pendingContent && this.quiet && !this.inCombat) this.applyContent();
    // (whoever drives the loop may have set its speed directly)
    this.clock.speed = this.loop.speed;
    const d = this.store.state.dialog;
    const step = this.modal || (d?.kind === 'movie' && d.url !== null) ? 0 : dt;
    this.clock.update(step);
    this.transporterDirector.update(transporterRoom(this.world), step * 1000);
    // (the HUD and save menu render from the store: tell them when what they can do changed, as when an action
    // or the last presentation wait ends without an event)
    const controls = `${this.input.canAct} ${this.idle}`;
    if (controls !== this.controls) {
      this.controls = controls;
      this.store.bump();
    }
    this.stage.frame(step);
    for (const err of this.world.errors.splice(0)) this.log('error', message(err));
    const map = this.atAstrogation() ? this.astroMap() : null;
    // (AstrogationScreen::start: each visit starts the map's spin from where it is)
    if (map !== null && !this.astroHere) { startSpin(this.mapCam, ticksOf(performance.now())); this.enterAstro(); }
    if (map !== null) this.followScriptedWarp();
    this.astroHere = map !== null;
    const station = this.shipStationNow();
    // (a station's set starts loading as the ship gets there, whether or not its panel has a box yet)
    if (station !== null && this.stage.debugView.art) this.shipEntry(station);
    // (the station drawn last stays on show while this one's set loads: B5)
    const held = this.heldShipSet(station);
    // (aboard, a station's art is kept, and the viewscreen's while the bridge draws it as a frame; away, or with art off, none is)
    const keepSets = !this.stage.debugView.art || station === null ? null : [station, ...(station === 'bridge' && this.bridgeViewscreenUp ? ['viewscreen'] : []), ...(held && this.shipShown ? [this.shipShown.station] : [])];
    this.trimShipSets(keepSets);
    if (keepSets === null) {
      this.freeSpace();
      this.shipShown = null;
    }
    // (the map has a plate of its own to sit in only when it is a plate: a 3D set has no map window)
    let set = this.shipBox !== null && station !== null ? this.shipSetFor(station) : null;
    if (map && set && this.shipEntry('astrogation')?.art.kind !== 'plate') set = null;
    const shown = set ?? held;
    const box = set ? this.shipBox?.() ?? null : held ? this.shipBox?.() ?? this.shipShown?.box ?? null : null;
    const canvas = this.canvas;
    const viewport = shown && box && canvas ? screenViewport(box, canvas.getBoundingClientRect(), this.pixelRatio()) : null;
    const drawn = shown !== null && viewport !== null && viewport.width > 0 && viewport.height > 0;
    this.mapView = null;
    let space = false;
    if (map && !drawn) {
      this.prepareMap(map, step, this.canvas && this.canvas.clientHeight > 0 ? this.canvas.clientWidth / this.canvas.clientHeight : 4 / 3);
      this.parts.render?.(this.stage, map);
    } else if (set && viewport && drawn) {
      set.update(step);
      // (setViewscreen takes the crew off the bridge, bridge.cpp; a crew member the sim has no object for isn't aboard)
      const aboard = this.crewOnBridge();
      // (the bridge's crew; the transporter's pad cards are kept by syncPadCards)
      if (station === 'bridge') {
        set.showCards(object => !this.bridgeViewscreenUp && aboard.has(object));
        // (a crew member who speaks plays the ship talk animation, kAnimShipTalk; when they stop, the idle one: talk.cpp turnSpeaker)
        const speaker = this.store.state.subtitle?.who;
        if ('playCards' in set) (set as ShipPlate).playCards(object => (object === speaker ? BRIDGE_TALK : BRIDGE_IDLE));
      }
      if (station === 'transporter' && 'placeCards' in set) {
        this.syncPadCards(set as ShipPlate);
        this.poseCards(set as ShipPlate);
      }
      // R15: the viewscreen's window. On its own station, the plate's; on the bridge with the viewscreen up, the viewscreen plate's rows 0-363
      // are drawn over the bridge as a frame, with its window
      let before: ((r: WebGLRenderer) => void) | undefined;
      let after: ((r: WebGLRenderer) => void) | undefined;
      if ('setFrame' in set) {
        const plate = set as ShipPlate;
        const vs = station === 'bridge' && this.bridgeViewscreenUp ? (this.shipSetFor('viewscreen') as ShipPlate | null) : null;
        if (station === 'bridge' && this.frameOn.get(plate) !== vs) {
          plate.setFrame(vs);
          this.frameOn.set(plate, vs);
          this.windowOn.delete(plate);
        }
        const rect = (vs ?? plate).frameParts().window?.rect ?? null;
        if (rect && (station === 'viewscreen' || vs)) before = this.windowLayer(plate, rect, viewport, step, station === 'viewscreen');
      }
      // R17: at astrogation the map is drawn over the plate, in the plate's map window
      if (map) {
        const art = this.shipEntry('astrogation')?.art;
        const area = art?.kind === 'plate' ? art.areas.map : undefined;
        const vp = area ? areaViewport(viewport, area) : viewport;
        this.mapView = vp;
        this.prepareMap(map, step, vp.width > 0 && vp.height > 0 ? vp.width / vp.height : 4 / 3);
        after = this.mapLayer(map, vp);
      }
      this.parts.render?.(this.stage, { scene: set.scene, camera: set.camera, viewport, ...(before ? { before } : {}), ...(after ? { after } : {}) });
      if (station !== null && box) this.shipShown = { station, set, box };
    } else if (held && viewport && drawn) {
      // (the last station's picture, as it was, until this one's is in: its panel is hidden meanwhile)
      held.update(step);
      this.parts.render?.(this.stage, { scene: held.scene, camera: held.camera, viewport });
    } else if (!(space = this.drawCombat(canvas))) {
      this.parts.render?.(this.stage);
    }
    // (the space view counts as art shown: the tactical panel goes transparent over it, and the store says when that flips)
    if (!map) this.setShipArtShown(set !== null || space, this.stage.debugView.hotspots, held !== null);
    else this.setShipArtShown(drawn, this.stage.debugView.hotspots, held !== null);
  }

  /**
   * The space view (M8 spec §3, behind ?dev): the world's battle at tactical in the tactical panel's 640 x 480 box, or a
   * `?dev` preview on the whole canvas. Draws it through the renderer's `over` viewport and says whether it drew.
   */
  private drawCombat(canvas: HTMLElement | null): boolean {
    const run = this.world.battle;
    const combat = this.content.ship?.combat;
    const assets = this.battleAssets.loaded;
    // (a preview whose set something else replaced or freed since (a battle's start or end, a load) is over)
    if (this.preview && this.preview.assets !== assets) {
      this.preview = null;
      this.previewCtx = null;
    }
    const atTactical = run && combat && assets && this.world.state.onShip !== null && this.world.state.ship.station === 'tactical';
    // (paused, resolved or the world busy, the battle's update waits and its flag stays as the last update left it: a
    // still battle shows no flash, rather than space held red until it steps again)
    const still = !!run && (run.paused || run.resolved !== null || this.world.busy);
    const source: CombatViewSource | null = this.preview ?? (atTactical ? { b: run.b, combat, assets, redFlash: run.redFlash && !still, still, ...(run.warpHold > 0 ? { warp: WARP_WAIT - run.warpHold } : {}) } : null);
    // (no battle at tactical and no preview: the last scene is freed, and no layout is read)
    if (!source) {
      this.combatView.frame(null, null);
      return false;
    }
    const rect = canvas?.getBoundingClientRect() ?? null;
    const dpr = this.pixelRatio();
    const shipBox = this.preview ? null : this.combatBox?.(source.b.view.wide) ?? null;
    // (the preview fills the canvas as a 640 x 480 frame; the world's battle, the console's box, or the game frame when wide)
    const box = !rect ? null : this.preview ? { x: 0, y: 0, width: Math.round(rect.width * dpr), height: Math.round(rect.height * dpr) } : shipBox ? screenViewport(shipBox, rect, dpr) : null;
    // (the wide view's HUD over it: the target's arrow keeps clear of its panels, in the window's 640 units across the frame; the arrow is the radar's, so with the radar off the panels are not read)
    const keepOut = shipBox && source.b.view.wide && this.settings.now.combat.radar && this.hudBoxes ? hudKeepOut(shipBox, this.hudBoxes(), FULL_RECT.width) : null;
    // (the Combat Options up over the battle (F1): its preview alone, the Enterprise with the options in the screen's window, the battle's view
    // kept but undrawn under the screen; Plan 32 Task 11)
    const hole = !this.preview && rect && this.optionsUp() ? this.optionsBox?.() ?? null : null;
    if (hole && rect && hole.width > 0 && hole.height > 0) {
      const shown = this.combatView.optionsPreview(source, screenViewport(hole, rect, dpr), performance.now());
      if (shown) {
        this.parts.render?.(this.stage, { scene: shown.scene, camera: shown.camera, viewport: shown.viewport, clear: true, ...(shown.before ? { before: shown.before } : {}), after: shown.after });
        return true;
      }
    } else this.combatView.releasePreview();
    const drawn = this.combatView.frame(keepOut ? { ...source, keepOut } : source, box && box.width > 0 && box.height > 0 ? box : null);
    if (!drawn) return false;
    // (the stage still holds the away team's last room: the frame is cleared instead, the view drawn in its box)
    this.parts.render?.(this.stage, { scene: drawn.scene, camera: drawn.camera, viewport: drawn.viewport, clear: true, ...(drawn.before ? { before: drawn.before } : {}), after: drawn.after });
    return true;
  }

  /** The drawing buffer's device pixels per CSS pixel: the renderer's (SessionParts.pixelRatio), else the device's. */
  private pixelRatio(): number {
    return this.parts.pixelRatio?.() || globalThis.devicePixelRatio || 1;
  }

  /** The space view now, for `?dev` and the tests. */
  combatViewState(): CombatViewState {
    return this.combatView.state();
  }

  /** The parity mode (M8 spec §9.3): the step's state as it is (no interpolation) and no shimmer. */
  setCombatParity(on: boolean): void {
    this.combatView.parity = on;
  }

  /**
   * `?dev`: sets up battle `scenario` apart from the world (every ship combat.yaml lists, the sim's seams and none of the
   * world's, on a copy of the ship's systems), runs it `steps` steps, loads its set and draws it on the whole canvas
   * until `endPreview`, taking `commands` first (a view, wide). It draws only when the frame draws no ship set or map
   * (away from the ship, or with art off), and it ends when something else loads or frees the battle set (a load, a
   * restart, a world battle's start or end). `battle` false when the battle has no Enterprise (setup's failure,
   * tactical.cpp:314-318), with setup's warnings, or when a load or restart replaced the world while combat.yaml was read.
   * `tick`: the world tick the battle is taken to start at (its clock, and the ship's timers rebased from it), for a run
   * that doesn't depend on when it is called; the world's own by default.
   */
  async previewBattle(scenario: number, o: { seed?: number; steps?: number; commands?: CombatCommand[]; tick?: number } = {}): Promise<{ battle: boolean; warnings: string[] }> {
    const world = this.world;
    const combat = await ensureCombat(world);
    // (a load or restart replaced the world while combat.yaml was read: it is not this world's to preview)
    if (this.world !== world) {
      this.endPreview();
      return { battle: false, warnings: [] };
    }
    const ship = world.content.ship;
    if (!combat || !ship) return { battle: false, warnings: ['no combat.yaml'] };
    const systems = structuredClone(world.state.ship.systems);
    const tick = o.tick ?? world.state.tick;
    const now = shipTickToMs(tick);
    systemsToBattleClock(systems, tick, now);
    const ctx: BattleContext = { combat, enterpriseUnits: ship.data.units, seams: { ...NO_SEAMS, ...SIM_SEAMS } };
    const { battle: b, warnings } = setupBattle(ctx, { scenario, seed: o.seed ?? 1, now, difficulty: world.difficulty, active: () => true, enterprise: systems });
    this.endPreview();
    if (!b) return { battle: false, warnings };
    for (const cmd of o.commands ?? []) applyCommand(ctx, b, cmd);
    for (let i = 0; i < (o.steps ?? 0); i++) updateBattle(ctx, b, b.lastStep + STEP_TIME);
    b.cues.length = 0;
    b.sounds.length = 0;
    await this.battleAssets.load(combat, scenario, b.ships.map(x => x.type));
    const assets = this.battleAssets.loaded;
    if (assets) {
      this.preview = { b, combat, assets };
      this.previewCtx = ctx;
    }
    return { battle: true, warnings };
  }

  /** `?dev`: runs the preview's battle on `steps` steps, its cues and sounds dropped (previewBattle's alone). */
  stepPreview(steps: number): void {
    const p = this.preview, ctx = this.previewCtx;
    if (!p || !ctx) return;
    for (let i = 0; i < steps; i++) updateBattle(ctx, p.b, p.b.lastStep + STEP_TIME);
    p.b.cues.length = 0;
    p.b.sounds.length = 0;
  }

  /**
   * `?dev`: the world's battle shows the warp overlay, as warpAway's showWarp does (tactical.cpp:818-854): its seam, called
   * outside a step, so its journal is let go after. False with no battle.
   */
  battleWarp(): boolean {
    const run = this.world.battle;
    if (!run) return false;
    run.ctx.seams.showWarp(run.ctx, run.b);
    run.journal.entries = [];
    run.journal.cursor = 0;
    return true;
  }

  /**
   * `?dev`: draws `b` (a battle's state from elsewhere: tracediff's replay) as the preview, with battle `b.scenario`'s set,
   * as previewBattle does (only when the frame draws no ship set or map). Nothing when a load or restart replaced the
   * world while combat.yaml was read.
   */
  async previewState(b: BattleState): Promise<void> {
    const world = this.world;
    const combat = await ensureCombat(world);
    if (this.world !== world) {
      this.endPreview();
      return;
    }
    if (!combat) throw new Error('no combat.yaml');
    this.endPreview();
    await this.battleAssets.load(combat, b.scenario, b.ships.map(x => x.type));
    const assets = this.battleAssets.loaded;
    if (assets) this.preview = { b, combat, assets };
  }

  /**
   * `?dev`: the preview's console as the game draws it, for the screenshot check's port side (Plan 27 R17): on the page a
   * battle opens on (CONN, tactical.cpp:301), nothing pressed, a new radar memory, no flash; RGBA 640 x 480, the view's rectangle
   * clear. With the art on and the console's repaint loaded (Plan 30 R7, R17), the frame is clear where the repaint shows through
   * (seeThrough, as the console's), and `repaint` and the pictures it drew (`blits`) are for the plate and the art layer under it
   * (drawArtLayer). Null without a preview, the combat chunk, or the set's stills, and while the game's fonts are still loading (a
   * shot taken then would have no text).
   */
  previewConsole(): { rgba: Uint8ClampedArray<ArrayBuffer>; repaint: ConsoleRepaint | null; blits: ConsoleBlit[] } | null {
    const p = this.preview;
    const chunk = this.combatView.chunk;
    const art = p ? this.consoleArtOf(p.assets.stills, p.combat) : null;
    if (!p || !chunk || !art || !this.consoleFonts.settled()) return null;
    const screen = new RecordingScreen();
    screen.pictures(art.images);
    const ui = { page: CONSOLE_PAGES.indexOf('conn'), pressed: -1, buttonTime: 0, arrow: -1, wall: 0 };
    const drawn = chunk.drawConsole(screen, art, { b: p.b, combat: p.combat, enterpriseUnits: this.content.ship?.data.units ?? [] }, ui, newRadarMemory());
    const palette = new Palette(chunk.consolePalette(art.palette, drawn.scanner, 0));
    const out = new Uint8ClampedArray(640 * 480 * 4);
    screen.toRgba(palette, out);
    for (let y = SPLIT_RECT.y; y < SPLIT_RECT.y + SPLIT_RECT.height; y++) {
      for (let x = SPLIT_RECT.x; x < SPLIT_RECT.x + SPLIT_RECT.width; x++) out[(y * 640 + x) * 4 + 3] = 0;
    }
    const rp = art.repaint;
    if (rp) seeThrough(screen, art.plate, screen.blits, art.images, rp.images, rp.opaque, out);
    return { rgba: out, repaint: rp ?? null, blits: [...screen.blits] };
  }

  /**
   * Ends the preview and frees its set, if the set is still the preview's: one something else loaded since (a world
   * battle's start) is kept. A world battle's set the preview replaced is not reloaded.
   */
  endPreview(): void {
    if (!this.preview) return;
    const mine = this.preview.assets === this.battleAssets.loaded;
    this.preview = null;
    this.previewCtx = null;
    this.combatView.release();
    if (mine) this.freeBattleSet();
  }

  /** The pads' places with who is on each, from the lifted room and the sim's pads; empty away from the transporter. Read-only. */
  private padSpots(): { pad: number; rect: [number, number, number, number]; stand: [number, number]; scale: number; crew: string | null }[] {
    const room = transporterRoom(this.world);
    if (room === null) return [];
    return (this.content.ship?.data.transporter.pads ?? []).map((p, pad) => ({ pad, rect: p.rect, stand: p.stand, scale: p.scale, crew: room.pads[pad] ?? null }));
  }

  /** The transporter room's map and what it waits for (the scan's lock-on). */
  private readonly transporterDirector = new TransporterDirector({
    targets: () => this.content.ship?.data.transporter.targets ?? [],
    sound: name => this.shipSound(name),
    bump: () => this.store.bump(),
    blipMs: () => this.pkg.presentation.art?.transporter?.blipMs ?? 100,
    walk: () => {
      const t = this.content.ship?.data.transporter;
      return t?.walkOn && t.walkOff && t.pads ? { on: t.walkOn, off: t.walkOff, pads: t.pads.map(p => ({ stand: p.stand, scale: p.scale })) } : null;
    },
    // (the crew walk where the room is drawn from a plate, and have a card to draw)
    walks: crew => this.stage.debugView.art && this.shipArtOf('transporter')?.kind === 'plate' && this.artSource().card(crew) !== undefined,
    removePad: pad => {
      const r = transporterRoom(this.world);
      if (r !== null) removeFromPad(this.world, r, pad);
      this.store.bump();
    },
  });

  /** What each transporter plate has placed, and the placements in flight (one after another, so an old one never lands over a new one). */
  private readonly padCards = new WeakMap<ShipSet, { signature: string; chain: Promise<void> }>();

  /**
   * R16: a padded crew member with a card is that card on their pad, playing the standing animation (kAnimStanding, transporter.cpp:411),
   * `pixelHeight x scale / 256` original pixels high with its feet on the pad's stand point. Crew without a card get none.
   */
  private syncPadCards(plate: ShipPlate): void {
    const cards = this.padSpots().flatMap(p => {
      const art = p.crew === null ? undefined : this.artSource().card(p.crew);
      // (they may be walking on or off: the directions the walk plays are loaded with the standing animation)
      return art === undefined || p.crew === null ? [] : [{ crew: p.crew, card: { key: `pad.${p.pad}`, art, at: p.stand, scale: p.scale / 256, depth: p.stand[1], anim: ANIM_STANDING, all: true, only: [ANIM_STANDING, ...WALK_ANIMS] } }];
    });
    const signature = cards.map(c => `${c.card.key}=${c.crew}`).join(',');
    const before = this.padCards.get(plate) ?? { signature: '', chain: Promise.resolve() };
    if (signature === before.signature) return;
    const keep = new Set(cards.map(c => c.card.key));
    const chain = before.chain.then(async () => {
      plate.removeCards(this.content.ship?.data.transporter.pads?.map((_, n) => `pad.${n}`).filter(k => !keep.has(k)) ?? []);
      await plate.placeCards(cards.map(c => c.card)).catch((err: unknown) => this.log('warn', `a crew card on the pads could not be loaded (${message(err)})`));
      // (a card that has just come is where its crew member is, at once: not on the pad for a frame before they set off from the door)
      this.poseCards(plate);
    });
    this.padCards.set(plate, { signature, chain });
  }

  /** The plates whose doorway has been put over the cards (`setOccluder`). */
  private readonly occluded = new WeakSet<ShipSet>();

  /**
   * Each frame, the cards of the crew who are walking: where their feet are, how big and which direction they face (`updateWalkers`, transporter.cpp:354), hidden
   * until they set off; the others stand on their pads. The doorway they walk out from behind is the plate's own wall drawn over them (tdoor.spr).
   */
  private poseCards(plate: ShipPlate): void {
    const room = transporterRoom(this.world);
    if (room === null) return;
    if (!this.occluded.has(plate) && this.content.ship?.data.transporter.walkOn) {
      plate.setOccluder(DOORWAY);
      this.occluded.add(plate);
    }
    const poses = this.transporterDirector.poses(room);
    const moves: Record<string, { at: [number, number]; scale: number; visible: boolean }> = {};
    const anims = new Map<string, number>();
    for (const p of this.padSpots()) {
      const pose = poses.get(p.pad);
      moves[`pad.${p.pad}`] = pose ? { at: pose.at, scale: pose.scale / 256, visible: pose.visible } : { at: p.stand, scale: p.scale / 256, visible: true };
      anims.set(`pad.${p.pad}`, pose ? pose.anim : ANIM_STANDING);
    }
    plate.moveCards(moves);
    plate.playCards(key => anims.get(key) ?? null);
  }

  /**
   * TransporterScreen::energize (transporter.cpp:585): before the beam-down, beamEffect(padSprites, true): the crew on the pads sparkle and dissolve away,
   * with the beam-out sound. Only where the room is drawn from a plate (the cards are what dissolve); world 6 beams with no effect.
   */
  private async beamOutPads(room: NonNullable<ReturnType<typeof transporterRoom>>): Promise<void> {
    const plate = this.shipSetFor('transporter');
    if (room.world === 6 || !this.stage.debugView.art || !plate || !('beam' in plate)) return;
    const keys = this.padSpots().flatMap(p => (p.crew === null ? [] : [`pad.${p.pad}`])).filter(k => (plate as ShipPlate).cards().includes(k));
    if (keys.length === 0) return;
    this.playSound(this.pkg.presentation.sounds.beamOut);
    await (plate as ShipPlate).beam(keys, true, this.artSource().card('beam_effect')?.anims, this.clock);
  }

  /** The crew walking on or off the pads now (for tests): where their feet are, their size, the animation they play and whether they have set off. */
  padWalks(): { pad: number; leaving: boolean; at: [number, number]; scale: number; anim: number; visible: boolean }[] {
    const room = transporterRoom(this.world);
    if (room === null) return [];
    return [...this.transporterDirector.poses(room)].map(([pad, pose]) => ({ pad, leaving: this.transporterDirector.leaving(room, pad), ...pose }));
  }

  /** What the transporter room's beam is doing to the pads' cards now (for tests): the cards dissolving and the sparkles drawn. */
  padBeams(): { cards: { key: string; level: number }[]; sparkles: string[] } {
    const plate = this.loadedShipSet('transporter');
    return plate && 'beamState' in plate ? (plate as ShipPlate).beamState() : { cards: [], sparkles: [] };
  }

  /** The bridge's crew who are aboard: each of the lifted bridge's sprite objects that the game has an object for (bridge.cpp start). */
  private crewOnBridge(): Set<string> {
    const objects = this.content.ship?.data.bridge.objects ?? [];
    return new Set(objects.map(o => o.object).filter(id => this.world.state.objects[id] !== undefined));
  }

  private setShipArtShown(shown: boolean, hotspots: boolean, held = false): void {
    const look = `${shown} ${hotspots} ${held}`;
    if (look === this.shipArtLook) return;
    this.shipArtLook = look;
    this.store.bump();
  }

  /** On the ship, at the astrogation screen: the map is drawn instead of a room. */
  private atAstrogation(): boolean {
    // (the computer and a hail leave the station as it was, and draw their own screens over it)
    return this.world.state.onShip !== null && this.content.ship !== undefined && this.world.state.ship.station === 'astrogation'
      && this.world.computer === null && this.world.viewscreen === null;
  }

  /** Where the map was drawn in the last frame, in the drawing buffer, while a plate frames it (R17); null when it fills the canvas. */
  private mapView: Viewport | null = null;

  /** The astrogation tables the executable has (art astro publish); the map has its own without them. */
  private astroTables(): MapInput['tables'] & { labels?: readonly string[] } {
    const t = this.pkg.presentation.art?.astro?.tables;
    return t ?? {};
  }

  /** What the map is drawn from: the universe, what the ship has charted, the camera and choice, and where the ship is going. */
  private mapInput(): MapInput {
    const ship = this.world.state.ship, u = this.content.ship!.universe;
    const tables = this.astroTables();
    const basis = { universe: u, flags: ship.flags, tables };
    const t = ship.transit;
    const { lightYears } = distanceTo(ship, cursorPoint(this.mapCam), destOrbit(basis, this.astroLoc));
    return {
      ...basis, cam: this.mapCam, selection: this.astroLoc, lightYears,
      ship: { pos: ship.pos, transit: t ? { to: t.to, name: destinationName(basis, t.destination) } : null },
      palette: paletteOf(this.pkg.presentation.art?.astro?.tables?.colours, this.pkg.presentation.art?.astro?.tables?.alignmentColours),
    };
  }

  /** Brings the map up to date for a frame, at the aspect of the rectangle it is drawn in. */
  private prepareMap(map: AstroScene, _step: number, aspect: number): void {
    map.setAspect(aspect);
    spin(this.mapCam, ticksOf(performance.now()));
    map.setArt(this.stage.debugView.art ? this.faces()?.astroMap() : undefined);
    map.setFonts(this.astroFontsLoader.astroFonts());
    map.update(this.mapInput(), ticksOf(performance.now()));
  }

  /** The hook that draws the map in its window of the plate, after the plate: cleared (its background) and drawn in that rectangle alone. */
  private mapLayer(map: AstroScene, vp: Viewport): (r: WebGLRenderer) => void {
    return r => {
      const px = r.getPixelRatio();
      r.setViewport(vp.x / px, vp.y / px, vp.width / px, vp.height / px);
      r.setScissor(vp.x / px, vp.y / px, vp.width / px, vp.height / px);
      r.setScissorTest(true);
      const autoClear = r.autoClear;
      r.autoClear = true;
      // (the window in the plate is painted black: the flat panel's bluer ground would show as a box)
      map.setBackground(0x000000);
      r.render(map.scene, map.camera);
      map.setBackground(0x0a0d14);
      r.autoClear = autoClear;
    };
  }

  /** Where a star (or a planet or moon of it, in the system view) is on the page now, in client pixels (the point a click picks it at); null when there is no map or it is not on it (uncharted, or in another view). */
  astroPoint(sector: number, star: number, planet = -1, moon = -1): { x: number; y: number } | null {
    const entry = this.map?.layout().entries.find(e => e.location.sector === sector && e.location.star === star && e.location.planet === planet && e.location.moon === moon
      && e.location.station === -1 && e.location.phenomenon === -1);
    const canvas = this.canvas;
    if (!entry || !this.map || !canvas) return null;
    const p = this.map.ndcOf(entry);
    const c = canvas.getBoundingClientRect();
    const dpr = this.pixelRatio();
    const vp = this.mapView;
    if (!vp) return { x: c.left + ((p.x + 1) / 2) * c.width, y: c.top + ((1 - p.y) / 2) * c.height };
    const px = vp.x + ((p.x + 1) / 2) * vp.width;
    const py = vp.y + ((p.y + 1) / 2) * vp.height;
    return { x: c.left + px / dpr, y: c.top + (Math.round(c.height * dpr) - py) / dpr };
  }

  private astroMap(): AstroScene {
    this.map ??= createAstroScene();
    return this.map;
  }

  /** Wires the canvas's pointer and the window's keys to the game; returns how to unwire them. */
  bind(canvas: HTMLElement): () => void {
    const ndc = (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / r.width) * 2 - 1, y: -(((e.clientY - r.top) / r.height) * 2 - 1) };
    };
    this.canvas = canvas;
    // at astrogation the canvas is the map: a drag turns it, a click picks a star, the wheel zooms
    let mapPress: { x: number; y: number; moved: boolean } | null = null;
    // (framed by a plate, the map is only its window: the pointer is mapped through the rectangle it was drawn in, and outside it a press,
    // a click and the wheel do nothing; the plate's own areas take their own events)
    const inMap = (e: MouseEvent): { x: number; y: number; inside: boolean } => {
      const vp = this.mapView;
      if (!vp) return { ...ndc(e), inside: true };
      return pointerInViewport(vp, canvas.getBoundingClientRect(), this.pixelRatio(), e.clientX, e.clientY);
    };
    const mapDown = (e: PointerEvent) => {
      if (e.button === 0 && inMap(e).inside) mapPress = { x: e.clientX, y: e.clientY, moved: false };
    };
    const mapMove = (e: PointerEvent) => {
      if (!mapPress || !this.map) return;
      const dx = e.clientX - mapPress.x, dy = e.clientY - mapPress.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) mapPress.moved = true;
      turnBy(this.mapCam, -dx * 0.45, dy * 0.45);
      mapPress.x = e.clientX;
      mapPress.y = e.clientY;
    };
    const mapUp = (e: PointerEvent) => {
      const press = mapPress;
      mapPress = null;
      if (!press || press.moved || !this.map) return;
      const at = inMap(e);
      const p = at.inside ? this.map.toMapPoint(at.x, at.y) : null;
      if (p) this.clickMap(p.x, p.y);
    };
    const wheel = (e: WheelEvent) => {
      if (!this.atAstrogation() || !this.map || !inMap(e).inside) return;
      e.preventDefault();
      this.map.zoom(e.deltaY > 0 ? 1.1 : 1 / 1.1);
    };
    const move = (e: PointerEvent) => {
      if (this.atAstrogation()) return mapMove(e);
      const id = this.stage.hover(ndc(e));
      const name = id === null ? null : this.world.state.objects[id]?.name ?? id;
      if (name !== this.store.state.hover) this.store.set({ hover: name });
      if (this.stage.overFloor !== this.store.state.hoverFloor) this.store.set({ hoverFloor: this.stage.overFloor });
    };
    // (browsers only start audio after the player does something: a click or a key)
    const wake = () => void this.parts.audio?.resume();
    // where the left button went down in the room, while it is down
    let pressedAt: { x: number; y: number } | null = null;
    const down = (e: PointerEvent) => {
      if (this.atAstrogation()) return mapDown(e);
      if (e.button !== 0) return;
      // (while the frame left is held on show the room takes no clicks: the player can't see the room a click would act on, B5; past the
      // hold's limit they go through, though the picture may stay while the room's model loads, and pick finds nothing till it is in)
      if (this.stage.inputHeld) return;
      pressedAt = { x: e.clientX, y: e.clientY };
      this.input.press(this.stage.pick(ndc(e)));
    };
    const drag = (e: PointerEvent) => {
      if (!pressedAt) return;
      // (in the original's pixels: its screen is 640 wide)
      const r = canvas.getBoundingClientRect();
      const scale = r.width > 0 ? SCREEN_WIDTH / r.width : 1;
      if (Math.max(Math.abs(e.clientX - pressedAt.x), Math.abs(e.clientY - pressedAt.y)) * scale >= DRAG_DISTANCE) this.input.dragged();
    };
    const up = (e: PointerEvent) => {
      if (mapPress) return mapUp(e);
      if (e.button !== 0 || !pressedAt) return;
      pressedAt = null;
      // (what is under the pointer now: a touch's events all go to where it started)
      const under = document.elementFromPoint(e.clientX, e.clientY);
      if (this.stage.inputHeld) this.input.release(null);
      else if (under?.closest('[data-drop="inventory"]')) this.input.release('inventory');
      else this.input.release(under === canvas ? this.stage.pick(ndc(e)) : null);
    };
    // (a press the browser cancelled, or that the window lost, ends with no release: let it go without acting)
    const cancel = () => {
      if (!pressedAt) return;
      pressedAt = null;
      this.input.release(null);
    };
    const menu = (e: MouseEvent) => {
      e.preventDefault();
      this.input.cycleMode();
    };
    const key = (e: KeyboardEvent) => {
      // (a dialog that took the key, Escape, has already answered: the same press does nothing more)
      if (e.defaultPrevented) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (this.input.key(e.key)) e.preventDefault();
    };
    // (Shift held hurries the away team's walks; a window that loses focus can miss the key coming up)
    const hurry = (e: KeyboardEvent) => {
      if (e.key === 'Shift') this.stage.hurry = e.type === 'keydown';
    };
    const relax = () => {
      this.stage.hurry = false;
    };
    // (off the room, onto the panel or out of the page: nothing is under the pointer, and the pointer is no longer lit)
    const leave = () => {
      this.stage.hover(null);
      if (this.store.state.hover !== null || this.store.state.hoverFloor) this.store.set({ hover: null, hoverFloor: false });
    };
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerleave', leave);
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('contextmenu', menu);
    canvas.addEventListener('wheel', wheel, { passive: false });
    window.addEventListener('pointermove', drag);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', cancel);
    window.addEventListener('blur', relax);
    window.addEventListener('keydown', hurry);
    window.addEventListener('keyup', hurry);
    // (in the capture phase: a click that only skips a line is stopped before the bubble)
    window.addEventListener('pointerdown', wake, true);
    window.addEventListener('keydown', wake);
    window.addEventListener('keydown', key);
    return () => {
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerleave', leave);
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('contextmenu', menu);
      canvas.removeEventListener('wheel', wheel);
      window.removeEventListener('pointermove', drag);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('blur', relax);
      window.removeEventListener('keydown', hurry);
      window.removeEventListener('keyup', hurry);
      relax();
      window.removeEventListener('pointerdown', wake, true);
      window.removeEventListener('keydown', wake);
      window.removeEventListener('keydown', key);
    };
  }

  async saveTo(slot: number, now = Date.now(), name = ''): Promise<void> {
    const saves = this.parts.saves;
    if (!saves) throw new Error('save slots are not available in this browser');
    // (no save during a battle: save.cpp:156-159)
    if (this.inCombat) throw new Error(COMBAT_SAVE_REFUSED);
    if (!this.idle) throw new Error(SAVE_REFUSED);
    const screen = this.world.state.screen;
    await saves.put(slot, this.world.save(), { label: saveName(slot, name), screen, savedAt: now });
  }

  /**
   * Whether the game could be written down now: the same quiet a save slot needs, with no screen change half done and no movie
   * up. A save taken in the middle of a scene would resume without the scene (the script is not part of the state).
   */
  get canAutosave(): boolean {
    return this.idle && !this.inCombat && this.world.state.pendingScreen === null && !this.openingActive;
  }

  /** A battle is on (TacticalScreen::inCombat): no save then (save.cpp:156-159). */
  private get inCombat(): boolean {
    return this.world.state.ship.combat !== null;
  }

  /** Where the player is, as one string: it changes with a screen or a ship station, which is when an autosave is due. */
  get whereabouts(): string {
    const s = this.world.state;
    return `${s.screen}|${s.onShip === null ? '' : s.ship.station}`;
  }

  /** Writes the game to the autosave slot (AUTOSAVE_SLOT) if it is idle; returns whether it did. */
  async autosave(now = Date.now()): Promise<boolean> {
    const saves = this.parts.saves;
    if (!saves || !this.canAutosave) return false;
    const screen = this.world.state.screen;
    await saves.put(AUTOSAVE_SLOT, this.world.save(), { label: `Autosave, ${new Date(now).toLocaleString()}`, screen, savedAt: now });
    return true;
  }

  /** From a continued game, a new one: the opening plays again (if the game has one), and the autosave is overwritten as soon as the game is idle. */
  async newGame(): Promise<void> {
    await this.restart();
    this.openingPending = this.content.ship !== undefined && this.parts.opening !== false;
  }

  async loadSlot(slot: number): Promise<void> {
    const text = await this.parts.saves?.get(slot);
    if (text === undefined) throw new Error(`slot ${slot} is empty`);
    await this.load(text);
  }

  /** Loads a save (an import too); a bad one throws SaveError and leaves the game as it was (Decision 11). */
  async load(text: string): Promise<void> {
    // (the opening's movies don't count as something happening: the load ends them)
    if (!this.openingActive) this.refuseUnlessIdle();
    // (read before anything is torn down, so a bad save changes nothing)
    const { state, queued } = deserializeSave(text, this.content);
    this.cancelOpening();
    // (a game loaded before the opening was begun, from the loading screen, goes without it)
    this.openingPending = false;
    await this.replace(() => this.worldFromState(state, queued));
    // (the loaded game runs the content it fits: a reload waiting for a restart is dropped with its problem)
    this.pendingRestart = null;
    this.problems = [];
  }

  /** Starts a new game, in reloaded content the old game didn't fit if there is some. */
  async restart(): Promise<void> {
    if (!this.openingActive) this.refuseUnlessIdle();
    this.cancelOpening();
    const next = this.pendingRestart;
    if (next) {
      this.pendingRestart = null;
      this.pkg = next.pkg;
      this.content = next.content;
    }
    this.problems = [];
    await this.replace(() => this.newWorld());
  }

  /**
   * The bridge's mission select (M3 Decision 12): a new game at `at`. Only before the loop runs, when nothing has
   * happened yet, so it needs no idle check (the screen's startup may be waiting to run).
   */
  async begin(at: StartAt): Promise<void> {
    if (this.loop.running || this.swapping) throw new Error(CHANGE_REFUSED);
    if (!this.content.screens[at.screen]?.markers[at.entrance]) throw new Error(`no ${at.entrance} on screen "${at.screen}" to begin at`);
    for (const id of at.awayTeam ?? []) if (!this.content.objects[id]) throw new Error(`no crew member "${id}" for the away team`);
    this.problems = [];
    await this.replace(() => this.newWorld(at));
  }

  /**
   * Nothing is happening: no action or walk, no dialog, input not blocked, no line being said and no
   * presentation wait left on the clock, and no load or restart under way. Back aboard the ship counts as idle,
   * so a finished mission can be saved or left.
   */
  private get idle(): boolean {
    const store = this.store.state;
    return this.quiet && !this.world.state.awayFlags.inputBlocked && store.subtitle === null;
  }

  /**
   * Nothing is running or waiting: no action or walk, no dialog, no presentation wait, no load or restart under
   * way. Hot reload swaps content in then: a subtitle left on screen is only cleared, and blocked input is part
   * of the game's state, so it carries over.
   */
  private get quiet(): boolean {
    return !this.swapping && !this.world.busy && this.store.state.dialog === null && this.clock.pending === 0;
  }

  /** Loading or restarting mid-action would leave the old world's action half done (Decision 11). */
  private refuseUnlessIdle(): void {
    if (!this.idle) throw new Error(CHANGE_REFUSED);
  }

  /** The combat assists (spec §5). */
  get assists(): CombatAssists {
    return { ...this.combatAssists };
  }

  /** Changes them, for this world and the next, and keeps them with the settings. The difficulty is a battle's from its start; the speed at once. */
  setAssists(assists: CombatAssists): void {
    this.changeSettings({ assists });
  }

  /** The battle's models, sprites and stills: what they are now, for `?dev` and the tests (M8 spec §8). */
  battleAssetState(): BattleAssetState | null {
    return this.battleAssets.state();
  }

  /** The battle's sound now (Plan 28): which of Sound's eight channels play, and whether the crew is silenced; null without Web Audio. */
  battleSoundState(): { channels: boolean[]; silenced: boolean } | null {
    return this.battleSound?.state() ?? null;
  }

  /**
   * Loads the set of battle `scenario` as its ships in combat.yaml are (all of them, active or not), as a battle's start
   * does, and resolves once it is ready: for `?dev` and the e2e tests, which load every battle's in turn. `freeBattleAssets` frees it.
   */
  async loadBattleAssetsFor(scenario: number): Promise<BattleAssetState | null> {
    const world = this.world;
    const combat = await ensureCombat(world);
    // (a load or restart replaced the world while combat.yaml was read: its battle is not this world's to draw)
    if (this.world !== world) return null;
    const battle = combat?.battles[scenario];
    if (!combat || !battle) return null;
    await this.battleAssets.load(combat, scenario, battle.ships.map(s => s.type));
    return this.battleAssets.state();
  }

  freeBattleAssets(): void {
    this.freeBattleSet();
  }

  /** The bytes the console's repaint pictures hold decoded (0 when freed): for `?dev`'s memory report. */
  consoleArtBytes(): number {
    return this.consoleRepaint.bytes();
  }

  /** Frees the battle's set, and the console's art made from its stills, which would otherwise hold them (M8 spec §8). */
  private freeBattleSet(): void {
    // (the view first, so its warm-up can't upload the freed set's textures again)
    this.combatView.release();
    this.battleAssets.free();
    this.consoleArtFor = null;
    // (the console's repaint: its pictures are bitmaps, closed here and loaded again at the next battle: Plan 31 R3)
    this.consoleRepaint.free();
    // (and the battle's sounds leave the mixer, but the ones the ship's screens keep)
    if (this.battleSound) this.parts.audio?.release(this.battleSound.urls());
  }

  /** The in-game battle view's port (behind ?dev until M8: Plan 23), made once: whoever asks shares auto-resolve's state. */
  battlePort(): BattlePort {
    this.battlePortOnce ??= this.makeBattlePort();
    return this.battlePortOnce;
  }

  private makeBattlePort(): BattlePort {
    let resolving = false;
    return {
      battle: () => {
        const run = this.world.battle;
        const combat = this.content.ship?.combat;
        if (!run || !combat || this.world.state.onShip === null || this.world.state.ship.station !== 'tactical') return null;
        const ui = this.store.state;
        return {
          b: run.b, combat, enterpriseUnits: run.ctx.enterpriseUnits, paused: run.paused, redFlash: run.redFlash, resolved: run.resolved, resolving,
          page: run.page, warp: run.warpHold > 0, queued: run.queue,
          overlay: ui.dialog !== null || ui.panel === 'admin' || this.optionsUp() ? 'dialog' : ui.panel !== 'none' ? 'panel' : null,
        };
      },
      command: cmd => battleCommand(this.world, cmd),
      pause: on => { pauseBattle(this.world, on); this.store.bump(); },
      autoResolve: async () => {
        // (a second ask while one runs does nothing: two panels, or a quick double press, start it once)
        if (resolving) return;
        resolving = true;
        this.store.bump();
        try {
          await autoResolve(this.world);
        } finally {
          // (the crew starts afresh, as its frames ran unheard: no stale later cue plays as the battle is handed back. Plan 28
          // final review; §6.3)
          this.battleSound?.autoResolved();
          resolving = false;
          this.store.bump();
        }
      },
      finish: () => finishResolved(this.world),
      assists: () => this.assists,
      setAssists: a => this.setAssists(a),
      keys: () => this.settings.now.keys,
      page: page => {
        consolePage(this.world, page);
        this.store.bump();
      },
      consoleArt: () => this.consoleArt(),
      flash: () => this.combatView.flash,
      viewBox: box => { this.combatBox = box; },
      hudBoxes: boxes => { this.hudBoxes = boxes; },
      logShown: index => {
        const run = this.world.battle;
        const ship = run?.b.ships[index];
        if (run && ship) scrollLog(ship, run.b.now);
      },
      beep: () => this.shipSound('shipBeep'),
      radar: () => this.radarMemory,
      chunk: () => this.combatView.chunk,
      pick: (fx, fy) => this.combatView.pick(fx, fy),
      optionsScreen: () => ({ settings: this.settingsPort(), picture: this.adminArt()?.final, fonts: this.adminFontsLoader.astroFonts() }),
      showOptions: open => this.showOptions(open),
      previewBox: box => { this.optionsBox = box; },
    };
  }

  /**
   * Tactical's F1 Combat Options came up or went (BattlePort.showOptions): the original's screen is modal over the battle, so the battle pauses
   * while it is up, as the admin PADD pauses it (adminChanged), and gets back the pause it had as it goes, if it is still the same battle.
   */
  /** Whether the Combat Options are up over the world's battle now: a hold whose battle has gone (ended, a load) is dropped. */
  private optionsUp(): boolean {
    if (this.optionsHeld && this.optionsHeld.run !== this.world.battle) {
      this.optionsHeld = null;
      this.optionsBox = null;
      this.combatView.releasePreview();
    }
    return this.optionsHeld !== null;
  }

  private showOptions(open: boolean): void {
    const run = this.world.battle;
    if (open) {
      if (!run || this.optionsHeld?.run === run) return;
      this.optionsHeld = { run, paused: run.paused };
      pauseBattle(this.world, true);
    } else {
      const held = this.optionsHeld;
      this.optionsHeld = null;
      this.optionsBox = null;
      this.combatView.releasePreview();
      if (held && run === held.run) pauseBattle(this.world, held.paused);
    }
    this.store.bump();
  }

  /**
   * The console's art (Plan 27): the battle set's stills (spc00a.pic and space.mrg's entries, in the space palette), the game's
   * fonts (art.fonts, the original's files: loaded whether the art is on or off) and combat.yaml's words. Null while the set loads,
   * or when the export has no stills (an export before Plan 24); without the fonts, or the words, it draws without them.
   */
  private consoleArt(): ConsoleArt | null {
    return this.consoleArtOf(this.battleAssets.loaded?.stills, this.content.ship?.combat);
  }

  /** consoleArt's, for a set's stills and combat.yaml: the world battle's, or a preview's. */
  private consoleArtOf(stills: BattleAssets['stills'] | undefined, combat: CombatData | undefined): ConsoleArt | null {
    if (!stills || !combat || stills.console.length < 2) return null;
    const fonts = this.consoleFonts.fonts();
    // (the repaint follows the art setting at once: Plan 30 R16)
    const repaint = this.stage.debugView.art ? this.consoleRepaint.repaint() : null;
    const c = this.consoleArtFor;
    if (c?.stills === stills && c.fonts === fonts && c.combat === combat && c.repaint === repaint) return c.art;
    const art: ConsoleArt = { plate: stills.console[0]!, images: stills.console.slice(1), palette: stills.palette, fonts, text: combat.consoleText ?? null, repaint };
    this.consoleArtFor = { stills, fonts, combat, repaint, art };
    return art;
  }

  /** What the ship's panels read and do (R6: a crew talk runs through perform whatever screen the object is on). */
  shipPort(): ShipPort {
    // (a station change queues behind nothing: it is refused unless the game is idle)
    const queue = async (task: () => Promise<void>): Promise<void> => {
      if (!this.idle) throw new Error(SHIP_REFUSED);
      await this.world.enqueue(task);
    };
    // (the room's own changes are instant, but the game must be idle as for any ship change)
    const room = async (change: (r: NonNullable<ReturnType<typeof transporterRoom>>) => void): Promise<void> => {
      // (checked here: a task that throws on the queue only records the error)
      if (!this.idle) throw new Error(SHIP_REFUSED);
      const r = transporterRoom(this.world);
      if (r === null) throw new Error('The ship is not at the transporter room.');
      await queue(async () => { change(r); });
      this.store.bump();
    };
    // (the screen's own clicks are instant, but the game must be idle as for any ship change)
    const computerChange = async (change: (view: NonNullable<World['computer']>) => void): Promise<void> => {
      if (!this.idle) throw new Error(SHIP_REFUSED);
      const view = this.world.computer;
      if (view === null) throw new Error('The ship is not at the computer.');
      change(view);
      this.store.bump();
    };
    const itemAction = (code: number): BridgeItemView['action'] => {
      if (code === 4) return 'astrogation';
      if (code === 0x31) return 'turbolift';
      if (code === 5) return 'computer';
      if (code === 0x32) return 'replay';
      if (code === 2) return 'comms';
      if (code === 7) return 'tactical';
      if (code === 0x30) return 'lounge';
      return code >= 0x33 && code <= 0x36 ? 'talk' : 'later';
    };
    return {
      ship: () => (this.world.state.onShip === null ? null : this.world.state.ship),
      // (the console's click on the way to astrogation and the computer, and from astrogation; the tactical station's own: bridge.cpp:303, 333, 429, 435)
      station: (name: Station) => {
        if (name === 'tactical') this.shipSound('tacticalAlert');
        else if (name === 'astrogation' || name === 'computer' || this.world.state.ship.station === 'astrogation') this.shipSound('shipBeep');
        return queue(() => gotoShipScreen(this.world, STATION_CODE[name]));
      },
      screen: code => queue(() => gotoShipScreen(this.world, code)),
      sound: name => this.shipSound(name),
      bridgeItems: () => (this.content.ship?.data.bridge.items ?? []).map(i => {
        const action = itemAction(i.action);
        const label = action === 'talk' ? this.world.state.objects[i.object]?.name ?? i.description : i.description;
        return { object: i.object, label, action, x: i.x, y: i.y, width: i.width, height: i.height };
      }),
      contacts: which => contacts(this.world, which).map(object => ({ object, label: this.world.state.objects[object]?.name ?? object })),
      comms: object => { this.shipSound('shipBeep'); return queue(() => hailObject(this.world, object)); },
      lounge: object => queue(() => loungeTalk(this.world, object)),
      combat: () => {
        const combat = this.world.state.ship.combat;
        if (combat === null || this.world.state.onShip === null || this.world.state.ship.station !== 'tactical') return null;
        const battle = battleDef(this.content, combat.scenario);
        const name = (id: string) => this.world.state.objects[id]?.name ?? id;
        return {
          ships: (battle?.ships ?? [])
            .filter(s => s.object === combat.enterprise || combat.enemies.includes(s.object) || combat.friends.includes(s.object))
            .map(s => ({ id: s.object, label: name(s.object), friendly: shipKind(this.content, s.type).friendly, destroyed: combat.destroyed.includes(s.object) })),
          redAlert: combat.redAlert,
          hailWaiting: this.world.state.pendingHail?.type === 8,
        };
      },
      resolve: outcome => queue(() => resolveCombat(this.world, outcome)),
      answerHail: () => queue(() => answerHail(this.world)),
      crewOnBridge: () => [...this.crewOnBridge()],
      screenRect: box => { this.shipBox = box; },
      hotspots: () => this.stage.debugView.hotspots,
      astroSprites: () => (this.stage.debugView.art ? this.faces()?.astro() ?? null : null),
      transporterSprites: () => (this.stage.debugView.art ? this.faces()?.transporter() ?? null : null),
      sensorSprites: () => (this.stage.debugView.art ? this.faces()?.sensor() ?? null : null),
      itemIcon: id => (this.stage.debugView.art ? this.faces()?.icon(id) : undefined),
      // (the space view draws the battle's own models, art on or off: the panel goes transparent over it)
      shipArt: station => (station === 'tactical' ? this.combatView.drawing : this.stage.debugView.art && this.shipSetFor(station) !== null),
      shipHeld: () => this.heldShipSet(this.shipStationNow()) !== null,
      preloadStations: stations => this.preloadStations(stations),
      shipPlate: station => {
        const e = this.shipEntry(station);
        return e?.set && e.art.kind === 'plate' ? { areas: e.art.areas } : null;
      },
      viewscreenImage: () => viewscreenImage(this.world, this.world.viewscreen !== null),
      viewscreenUp: () => this.bridgeViewscreenUp,
      // (the bridge's Admin button: the admin PADD, Plan 32)
      adminMenu: () => { this.openAdmin(); },
      toggleViewscreen: () => { this.bridgeViewscreenUp = !this.bridgeViewscreenUp; this.store.bump(); },
      turbolift: () => (this.content.ship?.data.bridge.turbolift ?? []).map(e => ({ code: e.code, label: e.text })),
      talk: object => queue(async () => {
        await perform(this.world, { verb: 'talk', target: object, who: this.content.start.leader, other: null, walked: false });
      }),
      sectorName: () => {
        const u = this.content.ship?.universe;
        return u ? (u.sectors[sectorOf(u, this.world.state.ship.pos)]?.name ?? '') : '';
      },
      sensorRecords: () => {
        const ship = this.world.state.ship, u = this.content.ship!.universe;
        const rows = ship.sensorRecords.slice(ship.sensorScroll, ship.sensorScroll + SENSOR_ROWS).map(l => locationName(u, l));
        return { rows, up: ship.sensorScroll > 0, down: ship.sensorScroll + SENSOR_ROWS < ship.sensorRecords.length };
      },
      sensorScroll: direction => { if (scrollSensors(this.world, direction === 1 ? -1 : 1)) { this.shipSound('shipSoftbop'); this.store.bump(); } },
      sensorGo: row => { this.shipSound('shipBeep'); return queue(async () => {
        const ship = this.world.state.ship;
        const record = ship.sensorRecords[ship.sensorScroll + row];
        if (!record) return;
        // (bridge.cpp:332-340: with a scripted warp waiting, the screen goes to astrogation without the choice)
        const preset = ship.warpPending ? null : record;
        await gotoShipScreen(this.world, STATION_CODE.astrogation);
        if (preset) {
          // (AstrogationScreen::enter, astrogation.cpp:1124-1128: the place is chosen and goes first in the records)
          this.setAstroSelection(selectionOf(preset), true);
          addSensorRecord(this.world, preset);
        }
      }); },
      stripReadout: () => {
        const ship = this.world.state.ship;
        const u = this.content.ship?.universe;
        const t = ship.transit;
        const dx = t ? t.to.x - ship.pos.x : 0, dy = t ? t.to.y - ship.pos.y : 0, dz = t ? t.to.z - ship.pos.z : 0;
        return {
          transit: t ? { warp: t.warp, speed: t.speed, lightYears: Math.sqrt(dx * dx + dy * dy + dz * dz) } : null,
          dest: u && (t || ship.locationType !== -1) ? { arriving: t !== null, name: locationName(u, t ? t.destination : ship.location) } : null,
        };
      },
      mapCamera: () => {
        const c = this.mapCam;
        return {
          view: c.view, panel: c.panel, azimuth: c.azimuth, elevation: c.elevation, spinning: c.spinning,
          cursorSector: [...c.cursorSector] as [number, number, number], cursor: [...c.cursor] as [number, number, number],
          display: Array.from({ length: DISPLAY_SWITCHES }, (_, i) => displayOn(c, i)),
        };
      },
      mapPad: button => { this.shipSound('shipBeep'); padClick(this.mapCam, button, ticksOf(performance.now())); this.store.bump(); },
      mapCursor: (axis, step) => { if (moveCursor(this.mapCam, axis, step)) { this.shipSound('shipBeep'); this.cursorMoved(); } },
      mapView: view => { this.shipSound('shipBeep'); this.mapCam.view = view; this.settleSelection(); this.store.bump(); },
      mapPanel: panel => { this.mapCam.panel = panel; this.store.bump(); },
      mapDisplay: item => { toggleDisplay(this.mapCam, item); if (item >= 2) this.settleSelection(); this.store.bump(); },
      selectionInfo: () => this.selectionInfo(),
      astroText: () => {
        const u = this.content.ship!.universe, cam = this.mapCam, pos = this.world.state.ship.pos;
        const index = cam.cursorSector[0] + cam.cursorSector[1] * 8 + cam.cursorSector[2] * 64;
        const galaxy = cam.view === 'galaxy';
        return {
          title: `${u.sectors[index]?.name ?? ''} ${cam.cursorSector.join('-')}`.toUpperCase(),
          cursor: [...(galaxy ? cam.cursorSector : cam.cursor)] as [number, number, number],
          ship: (galaxy ? [Math.trunc(pos.x / 20), Math.trunc(pos.y / 20), Math.trunc(pos.z / 20)] : [pos.x % 20, pos.y % 20, pos.z % 20]) as [number, number, number],
          labels: this.pkg.presentation.art?.astro?.tables?.labels ?? null,
          messages: this.pkg.presentation.art?.astro?.tables?.messages ?? null,
        };
      },
      sectors: () => {
        const u = this.content.ship!.universe;
        const flags = this.world.state.ship.flags;
        const out: { index: number; label: string; charted: boolean }[] = [];
        u.sectors.forEach((sector, index) => {
          if (sector.numStars === 0) return;
          const charted = Array.from({ length: sector.numStars }, (_, i) => u.stars[sector.firstStar + i])
            .some(star => ((flags[star.id] ?? 0) & 0x11) !== 0);
          out.push({ index, charted, label: charted ? sector.name : `Sector ${index}` });
        });
        return out;
      },
      stars: sectorIndex => {
        const u = this.content.ship!.universe;
        const sector = u.sectors[sectorIndex];
        if (!sector) return [];
        const flags = this.world.state.ship.flags;
        return Array.from({ length: sector.numStars }, (_, index) => {
          const star = u.stars[sector.firstStar + index];
          const known = ((flags[star.id] ?? 0) & 0x11) !== 0;
          return { index, label: known ? star.name : `Star ${index + 1}`, planets: planetCount(star) };
        });
      },
      selection: () => {
        const auto = this.world.autoEngage;
        return auto ? { sector: auto.sector, star: auto.star, planet: auto.planet } : selectionOf(this.astroLoc);
      },
      exitsEnabled: () => this.world.autoEngage === null,
      select: selection => this.setAstroSelection(selection),
      preview: course => previewCourse(this.world, course),
      engage: async course => {
        if (!this.idle) throw new Error(SHIP_REFUSED);
        if (!this.atAstrogation()) throw new Error('The ship is not at astrogation.');
        this.shipSound('shipBeep');
        let refused: CourseError | null = null;
        await this.world.enqueue(async () => {
          refused = engage(this.world, course);
          // (AstrogationScreen::buttonAt, astrogation.cpp:1985-1987: once engage() has taken the course, and after its warp movie, the
          // bridge; a refused course stays here. Queued behind the movie, which engage queued first)
          if (refused === null) void this.world.enqueue(async () => { await gotoShipScreen(this.world, STATION_CODE.bridge | 0x100); });
        });
        this.store.bump();
        return refused;
      },
      stopTransit: async () => {
        if (!this.idle) throw new Error(SHIP_REFUSED);
        await this.world.enqueue(async () => { stopTransit(this.world); });
        this.store.bump();
      },
      transit: () => {
        const ship = this.world.state.ship;
        const t = ship.transit;
        if (this.world.state.onShip === null || !t) return null;
        const progress = Math.max(0, Math.min(1, (this.world.clock.now - t.startTick) / t.ticks));
        const { distance } = distanceTo(ship, t.to, t.orbit);
        return { progress, eta: journeyTime(this.content.ship!.universe, t.speed, distance) };
      },
      maxWarp: () => maxWarp(this.content.ship!),
      impulseSteps: () => this.content.ship!.universe.impulseSpeeds.length,
      gameOver: () => this.world.state.onShip?.gameOver ?? null,
      ending: reason => ending(this.content, reason),
      restart: () => this.restart(),
      viewscreen: () => {
        const v = this.world.viewscreen;
        if (this.world.state.onShip === null || v === null) return null;
        return { target: v.target, label: (v.target ?? v.caller) != null ? this.world.state.objects[(v.target ?? v.caller)!]?.name ?? 'Unknown' : 'Incoming transmission' };
      },
      transporter: () => {
        const room = transporterRoom(this.world);
        if (room === null) return null;
        return {
          room,
          map: this.transporterDirector.view(room),
          walking: room.pads.flatMap((_, pad) => (this.transporterDirector.walking(room, pad) ? [pad] : [])),
          name: id => this.world.state.objects[id]?.name ?? id,
          canEnergize: canEnergize(room),
          exits: (this.content.ship?.data.transporter.exits ?? []).map(e => ({ code: e.code, label: e.text })),
        };
      },
      transporterPads: () => this.padSpots(),
      transporterShowMap: show => { const r = transporterRoom(this.world); if (r !== null) this.transporterDirector.showMap(r, show); },
      recommend: () => room(r => { this.transporterDirector.recommended(r); chooseRecommended(this.world, r); }),
      // (the computer says the name as they are chosen, transporter.cpp:759-763)
      pad: crew => room(r => { addToPad(this.world, r, crew); this.crewVoice(crew); }),
      // (a crew member with a card walks out, and is back in the list once gone; one without goes at once)
      unpad: pad => room(r => { if (!this.transporterDirector.dismiss(r, pad)) removeFromPad(this.world, r, pad); }),
      kit: item => room(r => moveToKit(r, item, true)),
      unkit: item => room(r => moveToEquipment(r, item, true)),
      // (the screen change and the beam-down piece follow from the `beamedDown` event)
      energize: async () => {
        if (!this.idle) throw new Error(SHIP_REFUSED);
        const r = transporterRoom(this.world);
        if (r === null || !canEnergize(r)) throw new Error('There is no transporter target, or nobody is on the pads.');
        this.shipSound('transporterConfirm');
        await this.beamOutPads(r);
        await queue(async () => { await energizeAndArrive(this.world, r); });
        this.store.bump();
      },
      leave: code => queue(() => gotoShipScreen(this.world, code)),
      ...engineeringPort({
        world: () => this.world, idle: () => this.idle, artOn: () => this.stage.debugView.art, presentation: () => this.pkg.presentation, assets: () => this.pkg.assets,
        difficulty: () => this.level, bump: () => this.store.bump(), sound: name => this.shipSound(name),
        fetchBytes: async url => new Uint8Array(await (await fetch(url)).arrayBuffer()),
      }),
      ...this.astroFontsLoader,
      ...exitCursorPort({ cursorArt: () => (this.stage.debugView.art ? this.faces()?.cursors() : undefined), bump: () => this.store.bump() }),
      ...holodeckPort({
        artOn: () => this.stage.debugView.art, presentation: () => this.pkg.presentation, assets: () => this.pkg.assets, bump: () => this.store.bump(),
        fetchBytes: async url => new Uint8Array(await (await fetch(url)).arrayBuffer()),
      }),
      holodeck: () => {
        if (this.world.state.onShip === null || this.world.state.ship.station !== 'holodeck') return null;
        // (the movie map's order, as runHolodeck lists them: movie.map)
        const seen = seenMovieStems(this.world, this.pkg.presentation.warpMovies);
        return { movies: (this.pkg.presentation.movieMap ?? []).filter(m => seen.has(m.stem.toLowerCase())).map(m => ({ stem: m.stem, title: m.title })) };
      },
      holodeckPlay: stem => queue(() => holodeckPlay(this.world, stem, this.pkg.presentation.warpMovies)),
      holodeckLeave: () => queue(() => leaveHolodeck(this.world)),
      computer: () => {
        const view = this.world.computer;
        const tree = this.content.ship?.computer;
        if (this.world.state.onShip === null || view === null || !tree) return null;
        const entry = tree.entries[view.selected];
        return {
          rows: listRows(this.world, view).map(r => ({ ...r, title: tree.entries[r.entry]?.title ?? '', selected: r.entry === view.selected })),
          heading: entry?.heading ?? '',
          text: entry?.text ?? '',
          canScrollUp: view.listScroll > 0,
          canScrollDown: view.listScroll < maxListScroll(this.world, view),
        };
      },
      computerRow: index => computerChange(view => { this.shipSound('computerSelect'); clickRow(this.world, view, index); }),
      computerScroll: by => computerChange(view => { const was = view.listScroll; scrollList(this.world, view, by); if (view.listScroll !== was) this.shipSound('shipSoftbop'); }),
      computerLeave: to => { this.shipSound('shipBeep'); return queue(() => gotoShipScreen(this.world, STATION_CODE[to])); },
      conversationLog: () => this.world.state.conversationLog.map(conversation => conversation.map(l => ({
        speaker: (l.speaker !== null ? this.world.state.objects[l.speaker]?.name : undefined) ?? 'Chorus',
        text: l.text,
      }))),
      subscribe: listener => this.store.subscribe(listener),
    };
  }

  /** AstrogationScreen::updateInfo: what the info tab says of what is chosen. The panel wraps it. */
  private selectionInfo(): { title: string; lines: string[] } {
    const u = this.content.ship!.universe, l = this.astroLoc, flags = this.world.state.ship.flags;
    const tables = this.astroTables();
    if (l.sector < 0) return { title: '', lines: [] };
    const none = { title: '', lines: [] as string[] };
    const type = locationType(u, l);
    let title = '', proper = '', text = '';
    if (type === -1) {
      if (this.mapCam.view !== 'galaxy') return none;
      title = `Sector ${u.sectors[l.sector]!.name}`;
      text = sectorText(u, l.sector, tables);
    } else if (type === THING.star) {
      const star = starAt(u, l)!;
      if (this.mapCam.view !== 'system') {
        title = star.name;
        proper = star.systemName;
        text = starText(u, star, flags, tables);
      } else {
        const subtype = locationSubtype(u, l);
        const planets = makePlanets(u, star, flags, tables);
        const planet = planets[l.planet];
        if (subtype === -1 || subtype === THING.asteroidBelt || !planet) return none;
        if (subtype === THING.planet) {
          const said = planetText(star, planet, flags, tables);
          if (said === null) return none;
          title = planet.name;
          text = said;
        } else if (subtype === THING.moon) {
          const moon = planet.moons[l.moon];
          if (!moon) return none;
          title = moon.name;
          text = moonText(moon);
        } else {
          const special = star.special === -1 ? undefined : u.specials[star.special];
          if (!special) return none;
          title = special.name;
          text = stationText(special, star, flags);
        }
      }
    } else if ((type & 0x90) === 0x80) {
      const station = stationAt(u, l)!;
      title = station.name;
      text = stationText(station, undefined, flags);
    } else if (type & 0x40) {
      const p = phenomenonAt(u, l)!;
      if (type === THING.hiddenPlace || !((flags[p.id] ?? 0) & 1)) return none;
      title = p.name;
      text = phenomenonText(p);
    }
    return { title: proper === '' ? title : `${title} ( ${proper} )`, lines: text.trim() === '' ? [] : [text.trim()] };
  }

  /** AstrogationScreen::start, each time the screen opens: the first time the ship's place is chosen; something chosen is shown close up. */
  private enterAstro(): void {
    const u = this.content.ship?.universe;
    if (!u) return;
    const ship = this.world.state.ship;
    if (!this.astroStarted) {
      this.astroStarted = true;
      this.astroLoc = ship.location.sector >= 0 ? { ...ship.location } : { ...NOWHERE };
    }
    // (somewhere between stars is in a sector all the same)
    if (this.astroLoc.sector < 0) this.astroLoc = { ...NOWHERE, sector: sectorOf(u, ship.pos) };
    const view = viewFor(this.astroLoc);
    if (view !== null) this.mapCam.view = view;
    // (setPanel(kPanelInfo); a scripted warp that is waiting opens the course instead, retarget)
    this.mapCam.panel = this.world.autoEngage === null ? 'info' : 'course';
    this.selectionChanged(true);
    this.settleSelection();
  }

  /** A scripted warp chooses its place as it arrives (AstrogationScreen::retarget): shown close up, with the cursor there. */
  private followScriptedWarp(): void {
    const auto = this.world.autoEngage;
    if (auto === this.astroAuto) return;
    this.astroAuto = auto;
    if (auto === null) return;
    this.astroLoc = locationOf(auto);
    this.mapCam.view = locationSubtype(this.content.ship!.universe, this.astroLoc) !== -1 ? 'system' : 'sector';
    this.mapCam.panel = 'course';
    this.selectionChanged(true);
    this.settleSelection(true);
  }

  /** AstrogationScreen::selectionChanged: the cursor goes to what is chosen, unless the choice came from the cursor. */
  private selectionChanged(setCursor: boolean): void {
    const u = this.content.ship?.universe;
    if (u && setCursor) cursorToSelection(u, this.mapCam, this.astroLoc);
    this.store.bump();
  }

  /** What the original does when it builds a view's entries (setView, a region switch, a visit): the end of buildSectorEntries and buildSystemEntries. */
  private settleSelection(keepHidden = false): void {
    const u = this.content.ship?.universe;
    if (!u || !this.map) return;
    const input = this.mapInput();
    const entries = buildEntries(input);
    const change = settleSelection(input, entries, keepHidden && (locationType(u, this.astroLoc) & 0xf0) === 0x40);
    if (change) {
      this.astroLoc = change.selection;
      this.selectionChanged(change.setCursor);
    }
  }

  /** A click on the map, at a point in the original's pixels (AstrogationScreen::pressButton's map part). */
  private clickMap(x: number, y: number): void {
    const u = this.content.ship?.universe;
    if (!u || !this.map) return;
    const hit = clickMap(u, this.mapCam, this.map.layout(), x, y);
    if (!hit) return;
    this.astroLoc = hit.selection;
    this.selectionChanged(hit.setCursor);
  }

  /** The panel's own choice (its selectors): the same as choosing it on the map, with the cursor going there. */
  private setAstroSelection(selection: AstroSelection | null, close = false): void {
    // (a choice made before the first visit's own, as a sensor record's, is the visit's choice)
    this.astroStarted = true;
    this.astroLoc = locationOf(selection);
    if (close) {
      const view = viewFor(this.astroLoc);
      if (view !== null) this.mapCam.view = view;
    }
    this.selectionChanged(selection !== null);
    if (close) this.settleSelection();
  }

  /** AstrogationScreen::cursorMoved: what's under the cursor is chosen, if charted. */
  private cursorMoved(): void {
    const u = this.content.ship?.universe;
    if (!u) return;
    this.astroLoc = cursorMoved(u, this.world.state.ship.flags, this.mapCam);
    this.selectionChanged(false);
  }

  /** Ends the line being said (a click while someone speaks); the current world's presenter, after a load too. */
  skipLine(): void {
    this.presenter.skipLine();
  }

  uiPort(): UiSession {
    return { store: this.store, input: () => this.input, faces: () => this.faces(), saves: this.parts.saves ? this.savesPort() : undefined, settings: this.settingsPort(), adminArt: () => this.adminArt(), adminFonts: () => this.adminFontsLoader.astroFonts(), feedback: this.parts.feedback ? this.feedbackPort(this.parts.feedback) : undefined };
  }

  /**
   * The dev overlay's view of the session. A jump changes screen inside the running world (no world is
   * replaced), and is refused unless the game is idle, as a load is: dev tools don't force it.
   */
  devPort(): DevPort {
    return {
      world: () => this.world,
      stage: this.stage,
      trace: this.trace,
      jump: (screen, entrance) => {
        if (!this.idle) throw new Error(JUMP_REFUSED);
        this.world.jump(screen, entrance);
      },
      problems: () => this.problems,
      // (refused while something is happening: say so in the log)
      restart: () => {
        this.restart().catch((err: unknown) => this.log('warn', message(err)));
      },
    };
  }

  /**
   * Dev: new content from Vite's hot reload (Decision 12). Problems are listed and the game carries on. Good
   * content is never refused: it waits, and is swapped in on the first frame the game is quiet, keeping the
   * game's state, transcript and message (the same teardown as a load).
   */
  reloadContent(pkg: GamePackage): void {
    try {
      this.pendingContent = { pkg, content: parseGame(pkg.files) };
      // (an older reload's problems are gone; "restart to play it" stays until this one is swapped in)
      if (!this.pendingRestart) this.problems = [];
      this.store.bump();
    } catch (err) {
      this.reloadFailed(err);
    }
  }

  /**
   * Dev: a hot reload that failed (content with problems, or a game module that threw). The game carries on;
   * an older reload waiting to swap in, or to restart, must not take effect behind the broken one.
   */
  reloadFailed(err: unknown): void {
    this.pendingContent = null;
    this.pendingRestart = null;
    this.problems = err instanceof ContentError ? err.problems : [message(err)];
    this.log('warn', `the changed content has ${this.problems.length} problem(s): the game carries on without it`);
    this.store.bump();
  }

  private applyContent(): void {
    const next = this.pendingContent;
    if (!next) return;
    this.pendingContent = null;
    // (the running game, read into the new content before anything is torn down)
    const text = this.world.save();
    let state: WorldState;
    try {
      state = deserializeState(text, next.content);
    } catch (err) {
      // (the running world, and loads, keep the content it fits; a restart starts the new one)
      this.pendingRestart = next;
      this.problems = [`the running game doesn't fit the changed content (${message(err)}): restart to play it`];
      this.store.bump();
      return;
    }
    this.pendingRestart = null;
    this.problems = [];
    this.pkg = next.pkg;
    this.content = next.content;
    // (replace logs a failure itself; the overlay shows it too)
    this.replace(() => this.worldFromState(state), true).catch((err: unknown) => {
      this.problems = [message(err)];
      this.store.bump();
    });
  }

  private presenterFor(world: World): BrowserPresenter {
    return new BrowserPresenter(world, {
      stage: this.stage,
      sound: this.parts.audio ?? null,
      store: this.store,
      clock: this.clock,
      assets: this.pkg.assets,
      voices: this.pkg.voices,
      readings: this.pkg.readings,
      screenTexts: this.pkg.screenTexts,
      warpMovies: this.pkg.presentation.warpMovies,
      effect: sound => this.playSound(this.pkg.presentation.sounds[sound]),
      settings: () => this.settings.now,
    });
  }

  private worldFromState(state: WorldState, queued: ShipFx[] = []): World {
    const world = new World(this.content, state, w => this.presenterFor(w), this.worldOptions());
    this.pkg.registerHooks?.(world.hooks);
    // (a v3 save's queued ship effects wait for `use`, which applies them once the session listens: their warnings and trace events count)
    world.queuedShipFx = queued;
    // (the transporter room isn't saved: a save made there opens it again, M9)
    restoreTransporter(world);
    return world;
  }

  /**
   * Tears the running game down (its listeners, presenter and scene), clears the UI, and only then builds the
   * new world, so nothing the old one left behind reaches it. The old world is frozen for good (Decision 11).
   * Another load or restart is refused until this one is done. If building or showing the new world fails, the
   * old one is already gone: this throws SWAP_FAILED (with the cause), and the page has to be reloaded.
   * A hot reload (`keepLog`) keeps the transcript and message; a load or restart clears them.
   */
  private async replace(build: () => World, keepLog = false): Promise<void> {
    this.swapping = true;
    try {
      this.off?.();
      this.off = null;
      // (a battle the load or restart ends draws nothing more: its set goes with it, and its crew falls quiet, as endCombat's
      // CuePlayer::reset, tactical.cpp:361: Plan 28 R13)
      this.freeBattleSet();
      this.battleSound?.combat(false);
      this.offTrace?.();
      this.offTrace = null;
      // (the frame on show stays until the loaded game's screen is ready, the stage's hold at most from here, even if the build fails: B5)
      this.stage.detach(true);
      // (a station's hold under way ends: the loaded game's station starts its own as it is shown)
      this.shipHoldFrom = null;
      this.shipStationSeen = null;
      this.presenter.dispose();
      this.store.reset(keepLog);
      try {
        await this.use(build());
      } catch (err) {
        this.log('error', `${SWAP_FAILED} (${message(err)})`);
        throw new Error(`${SWAP_FAILED} (${message(err)})`, { cause: err });
      }
    } finally {
      this.swapping = false;
    }
  }

  /** The settings a new world takes (R6): the difficulty, how tactical fights, the assists. */
  private worldOptions(): WorldOptions {
    return { difficulty: this.level, combat: this.parts.realCombat ? 'real' : 'dialog', assists: this.combatAssists, ...(this.pkg.combat ? { combatSource: this.pkg.combat } : {}) };
  }

  /** Shows and runs `world` from now on. */
  private async use(world: World): Promise<void> {
    // (ScummVM's TacticalScreen outlives a load and a restart, which are both a pending load (save.cpp:191-205,
    // unity.cpp:526-532): the last difficulty and the last battle go on to the new world: Plan 23 R8)
    if (this.world) {
      // (a battle the load interrupts ends as endCombat(false) ends it (save.cpp:195-197, tactical.cpp:344-362): the red
      // alert off and, as Combat::clear frees only its ships (combat.cpp:140-155), its console and view kept for the
      // next battle. Its destroyed ships' scripts and the bridge's USE don't run: they'd act on objects the load replaces)
      const old = this.world.battle;
      if (old) {
        standDownBattle(old.b);
        this.world.combatMemory.previous = old.b;
      }
      world.combatMemory = this.world.combatMemory;
    }
    this.presenter = world.presenter as BrowserPresenter;
    this.world = world;
    this.noteShipStation();
    // (astrogation's own state, which is not saved: a new world starts as the first visit does, the ship's place chosen)
    this.astroLoc = { ...NOWHERE };
    this.astroStarted = false;
    this.astroAuto = null;
    this.mapCam = newMapCamera();
    this.input = new Input(world, this.store, {
      skipLine: () => this.skipLine(),
      playSound: sound => this.playSound(this.pkg.presentation.sounds[sound]),
      admin: () => this.openAdmin(),
    });
    this.off = world.bus.on(e => this.onEvent(e));
    world.waitForSpeech = () => this.speech;
    // (a macrotask, so the page paints between auto-resolve's runs of steps)
    world.yieldToHost = () => new Promise(resolve => setTimeout(resolve, 0));
    // (a view that readies a battle before drawing it: the battle's clock waits for its first frame, Plan 34 Task 8)
    if (this.parts.prepare) world.battleView = () => this.combatView.drawing;
    this.offTrace = this.ruleTrace?.attach(world) ?? null;
    world.applyQueuedShipFx();
    // (a game loaded with a battle coming reads combat.yaml now, as the scenario's setting would have)
    if (world.state.onShip !== null && world.state.ship.battleScenario !== NO_SCENARIO) prefetchCombat(world);
    this.store.bump();
    this.parts.progress?.(SESSION_STEPS[1]);
    await this.stage.attach(world);
    this.enteredScreen();
    // (a game loaded aboard goes on with its station's music)
    this.shipMusicNow();
  }

  /** BridgeScreen::_viewscreenUp. */
  private bridgeViewscreenUp = false;

  private onEvent(e: SimEvent): void {
    // (a battle's frame at tactical, every frame: its cues and effects play, and nothing on screen changes, so no bump. Plan 28 R3)
    if (e.type === 'battleAudio') {
      this.battleSound?.frame(e);
      return;
    }
    this.noteShipStation();
    if (tricorderCue(e, this.content)) this.tricorderChirp();
    // (a battle is coming: combat.yaml is read now, so it is there when tactical opens: M8 spec §8)
    if (e.type === 'battleScenario' && e.scenario !== NO_SCENARIO) prefetchCombat(this.world);
    // (the combat sim's battle loads its models and sprites as it starts, and frees them as it ends; the M4 dialog draws none)
    if (e.type === 'combat') {
      const run = this.world.battle;
      const combat = this.content.ship?.combat;
      if (e.on && run && combat) {
        void this.battleAssets.load(combat, e.scenario, run.b.ships.map(s => s.type));
        // (the console's repaint, freed with the last battle's set, decodes alongside this one's load, so the console opens on it: consoleArtOf's rule)
        if (this.stage.debugView.art) this.consoleRepaint.repaint();
      }
      else if (!e.on) this.freeBattleSet();
      // (the crew's cues start afresh as a real battle starts, its effect sounds loading, and stop as any battle ends:
      // CuePlayer::reset, tactical.cpp:302, 361. Plan 28 R13)
      if (run || !e.on) this.battleSound?.combat(e.on);
    }
    if (e.type === 'shipCue') { this.shipSound(e.cue); return; }
    if (e.type === 'shipScreen') this.shipMusic(e.code);
    // (only the rule trace reads these: nothing on screen changes)
    switch (e.type) {
      case 'ruleSkipped': case 'effectRan': case 'actionStarted': case 'actionEnded':
      case 'triggerFired': case 'timerFired': case 'rng': case 'conditionPassed':
        return;
    }
    if (e.type === 'bridgeViewscreen') { this.bridgeViewscreenUp = e.up; this.store.bump(); }
    else if (e.type === 'shipScreen' && (e.code & 0xff) === 0) {
      // (BridgeScreen::start: down, unless the code's parameter says up, bridge.cpp:163-165)
      this.bridgeViewscreenUp = (e.code >> 8) !== 0;
    }
    if (e.type === 'warning') this.log('warn', e.message);
    else if (e.type === 'screenChanged') {
      // (a screen's own text is cleared as the team enters one: awayteam.cpp:182, 252)
      if (this.store.state.screenTexts.length > 0) this.store.set({ screenTexts: [] });
      this.enteredScreen();
    }
    else if (e.type === 'beamedDown') {
      // Sound::playIntroMusic, after the beam (UnityEngine::beamDown, awayteam.cpp:136-139)
      this.playIntro(e.effect).catch((err: unknown) => this.log('warn', message(err)));
    } else if (e.type === 'leftAwayMission') {
      // (aboard, no screen's music or ambience plays: the ship's own come with its screens)
      if (this.content.ship !== undefined) this.holdMusic();
      this.store.set({ message: e.gameOver === null ? 'The away team is back aboard the ship.' : `The game is over (${e.gameOver}).` });
    }
    this.store.bump();
  }

  /** A screen's loops start, and its sounds and voices load (spec §7.3). */
  private enteredScreen(): void {
    const audio = this.parts.audio;
    if (!audio) return;
    const screen = this.world.state.screen;
    const { presentation, assets, voices } = this.pkg;
    const url = (stem: string | undefined) => (stem === undefined ? undefined : assets.sound(stem)?.url);
    if (!this.ambienceHeld) void audio.setLoop('ambience', url(loopFor(presentation.ambience, this.content, screen)));
    const music = musicFor(presentation, this.content, screen, id => this.world.state.objects[id]?.active ?? false);
    if (!this.musicHeld) void audio.setLoop('music', url(music), music === undefined ? undefined : presentation.loops?.[music]);
    // (the screens' own sounds stay decoded when a battle's are released: the bridge shares its cues)
    const screenUrls = screenAudio(this.content, screen, assets, voices);
    audio.keep(screenUrls);
    void audio.preload(screenUrls);
  }

  /** The tricorder's chirp, unless any sound effect is playing (`!_snd->sfxPlaying()`, object.cpp:1277). */
  private tricorderChirp(): void {
    const audio = this.parts.audio;
    const stem = this.pkg.presentation.sounds.tricorderChirp;
    const found = stem === undefined ? undefined : this.pkg.assets.sound(stem);
    if (!audio || !found || audio.playing('sfx') > 0) return;
    void audio.play(found.url, found.bus);
  }

  /**
   * Sound::playIntroMusic (sound.cpp:225-236): one of the world's beam-down pieces, once; then the screen's
   * loops, as Sound::updateMusic only starts one once no music plays.
   */
  playIntro(piece = true): Promise<void> {
    if (this.intro) return this.intro;
    const intro = this.beamDownPiece(piece).finally(() => {
      if (this.intro === intro) this.intro = null;
    });
    this.intro = intro;
    return intro;
  }

  private async beamDownPiece(piece: boolean): Promise<void> {
    const audio = this.parts.audio;
    // (beamDown plays the piece only with the transporter's effect: world 6 has none, TransporterScreen::energize)
    const stem = !piece ? undefined : introPiece(this.pkg.presentation, this.content, this.world.state.screen);
    const found = stem === undefined ? undefined : this.pkg.assets.sound(stem);
    const hold = this.holds;
    this.musicHeld = true;
    this.ambienceHeld = false;
    try {
      if (audio && found) {
        await audio.setLoop('music', undefined);
        this.introPlaying = await audio.play(found.url, found.bus);
        await this.introPlaying?.ended;
      }
    } finally {
      this.introPlaying = null;
      // (the bridge may have held the music again meanwhile: that hold stays)
      if (hold === this.holds) this.musicHeld = false;
    }
    if (hold === this.holds) this.enteredScreen();
  }

  /**
   * Back to the bridge: the screen's music and ambience stop and stay off, and a beam-down piece still playing
   * stops, until the next playIntro plays the world's piece again.
   */
  holdMusic(): void {
    this.holds++;
    this.musicHeld = true;
    this.ambienceHeld = true;
    this.introPlaying?.stop();
    this.intro = null;
    const audio = this.parts.audio;
    if (!audio) return;
    void audio.setLoop('music', undefined);
    void audio.setLoop('ambience', undefined);
  }

  /**
   * A sound the ship's screens make (presentation.yaml's `shipSounds`, by name): an effect or music file, else a voice line. Voice lines come one
   * after another, as the original waits for each (`waitForSpeech`, computer.cpp:308-314); the rest play at once.
   */
  shipSound(name: string): void {
    const audio = this.parts.audio;
    const stem = this.pkg.presentation.shipSounds?.[name];
    if (!audio || stem === undefined) return;
    const sound = this.pkg.assets.sound(stem);
    if (sound) { void audio.play(sound.url, sound.bus).catch(() => null); return; }
    const voice = this.pkg.assets.voice(stem);
    if (voice) this.speak(voice);
  }

  /** The end of the voice lines queued so far on the ship: what the computer's music waits for. */
  private speech: Promise<void> = Promise.resolve();

  private speak(url: string): void {
    const audio = this.parts.audio;
    if (!audio) return;
    this.speech = this.speech.then(async () => {
      const playing = await audio.play(url, 'voice').catch(() => null);
      if (!playing) return;
      // (a voice that never reports its end is given up on, as the presenter's are)
      await Promise.race([playing.ended, new Promise<void>(resolve => setTimeout(resolve, playing.duration * 1000 + 1500))]);
    });
  }

  /** The computer's voice for a crew member put on a pad (fe09 and their voice as four hex digits: transporter.cpp:759-763). */
  private crewVoice(crew: string): void {
    const voice = this.content.ship?.data.crew.voiceOf?.[crew];
    if (voice === undefined) return;
    const url = this.pkg.assets.voice(`fe09${voice.toString(16).padStart(4, '0')}`);
    if (url) this.speak(url);
  }

  /**
   * The music a ship screen starts (presentation.yaml's `shipMusic`, with the loop's gain and point from `loops`): the station's start in the
   * original, except the computer's, which begins once the computer has spoken. The viewscreen keeps what plays; the holodeck has none
   * (runHolodeck stops it). Not while the opening movies run (the bridge's begin when they are over) or away from the ship.
   */
  private shipMusic(code: number): void {
    const audio = this.parts.audio;
    if (!audio || this.openingPending || this.openingActive || this.world.state.onShip === null) return;
    const screen = code & 0xff;
    if (screen === STATION_CODE.viewscreen) return;
    const station = stationOf(code);
    if (station === 'holodeck') { void audio.setLoop('music', undefined); return; }
    const stem = station === undefined ? undefined : this.pkg.presentation.shipMusic?.[station];
    const found = stem === undefined ? undefined : this.pkg.assets.sound(stem);
    if (stem === undefined || !found) return;
    const start = () => { void audio.setLoop('music', found.url, this.pkg.presentation.loops?.[stem]); };
    if (station !== 'computer') { start(); return; }
    // (the screen may have changed again while the computer spoke)
    const run = this.world;
    void this.speech.then(() => { if (this.world === run && this.world.computer !== null) start(); });
  }

  /** What the mixer has started, oldest first (Mixer.started), for the dev tools and tests; nothing without audio. */
  soundLog(): { bus: string; url: string; loop: boolean }[] {
    return this.parts.audio?.started.map(e => ({ ...e })) ?? [];
  }

  /** The ship's own music for where the ship is now (a load, or the opening's end). */
  private shipMusicNow(): void {
    if (this.world.state.onShip !== null) this.shipMusic(this.world.computer !== null ? STATION_CODE.computer : STATION_CODE[this.world.state.ship.station]);
  }

  private playSound(stem: string | undefined): void {
    const found = stem === undefined ? undefined : this.pkg.assets.sound(stem);
    if (found) void this.parts.audio?.play(found.url, found.bus);
  }

  private savesPort(): SavesPort {
    return {
      gameId: this.pkg.id,
      list: () => this.parts.saves?.list() ?? Promise.resolve([]),
      canSave: () => this.idle && !this.inCombat,
      refusal: () => (this.inCombat ? COMBAT_SAVE_REFUSED : null),
      save: async (slot, name) => {
        portSlot(slot, false);
        await this.saveTo(slot, Date.now(), name);
      },
      load: async slot => {
        portSlot(slot, true);
        await this.loadSlot(slot);
      },
      exportText: () => this.world.save(),
      importText: text => this.load(text),
    };
  }

  /** Where the player is and how the game is set, for a feedback report. */
  feedbackGame(): FeedbackGame {
    const s = this.world.state;
    let settings: Settings | null = null;
    try {
      settings = this.settingsPort().get();
    } catch {
      // (no settings record: the report goes without it)
    }
    const combat = s.ship.combat;
    return {
      game: this.pkg.id,
      screen: s.screen,
      onShip: s.onShip !== null,
      station: s.onShip === null ? null : s.ship.station,
      gameOver: s.onShip?.gameOver === true,
      awayTeam: [...s.awayTeam],
      currentActor: s.currentActor,
      beamWorld: s.beamWorld,
      combat: combat ? { scenario: combat.scenario, step: this.battlePort().battle()?.b.steps ?? null } : null,
      difficulty: this.difficulty,
      settings,
      recentLines: recentLines(this.store.state.transcript),
    };
  }

  /**
   * The report's save: the game as it is now; mid-battle or mid-action, when it can't be saved, the last autosave instead, with a note
   * saying so. A save over FEEDBACK_SAVE_MAX is left out, with a note.
   */
  private async feedbackSave(): Promise<{ save: string | null; saveNote: string | null }> {
    let save: string | null = null;
    let saveNote: string | null = null;
    if (this.idle && !this.inCombat) save = this.world.save();
    else {
      save = (await this.parts.saves?.get(AUTOSAVE_SLOT).catch(() => undefined)) ?? null;
      saveNote = save === null ? 'The game could not be saved just then, and there is no autosave.' : 'The game could not be saved just then: this is the last autosave.';
    }
    if (save !== null && save.length > FEEDBACK_SAVE_MAX) return { save: null, saveNote: `The save was left out: ${save.length} characters, over ${FEEDBACK_SAVE_MAX}.` };
    return { save, saveNote };
  }

  private feedbackPort(transport: FeedbackTransport): FeedbackPort {
    return {
      check: box => transport.check(box),
      send: async ({ message, email, includeSave, token, trap }) => {
        const { save, saveNote } = includeSave ? await this.feedbackSave() : { save: null, saveNote: 'The player left the save out.' };
        return transport.send({ message, email, save, saveNote, game: this.feedbackGame() }, token, trap);
      },
    };
  }

  private log(level: 'warn' | 'error', text: string): void {
    (this.parts.log ?? consoleLog)(level, text);
  }
}
