// SPDX-License-Identifier: GPL-3.0-or-later
import type { CombatCueName, CombatData, ShipUnit } from '../../content/types';
import type { SystemsState } from '../shipSystems';
import type { CombatAssists } from './assists';
import type { AngleOracle, M3, V3 } from './math';
import type { DrawHook, RandomState } from './random';

/**
 * The battle's state (spec §4.4): plain objects that structuredClone copies, with ships named by their index in
 * `BattleState.ships` (ScummVM's pointers). Field names follow combat.h's (CombatShip, combat.h:138-213; Torpedo
 * 215-224; DebrisPiece and Debris 227-246; Combat 264-524) so a trace compares field by field.
 */

/** combat.h:45-57: the kinds, as CombatData.kinds indexes them. */
export const KIND = { chodak: 0, romulan: 1, enterprise: 2, klingon: 3, probe: 4, ferengi: 5, starbase: 6, garidian: 7, shuttle: 8, mother: 9 } as const;

/** combat.h:60-66: what has happened to a ship, in the low bits of CombatShip.flags (its kind's flags, SHIP_FLAGS, are the high ones). */
export const SHIP_STATE = { firedUpon: 1, firedUponNew: 2, hasFired: 4, shielding: 8, flashing: 0x10, dying: 0x80 } as const;

/** Combat::_exitCode (combat.h:411): no exit yet. Any other value is a ship screen code. */
export const NO_EXIT = 0xffff;
/** UnityEngine::kShipGameEnd | 0x100 (damage.cpp:616-617, tactical.cpp:370-373): the Enterprise is lost. */
export const GAME_OVER_EXIT = 0xfe | 0x100;

/** kMaxShips, kMaxTorpedoes (combat.cpp:51-52). */
export const MAX_SHIPS = 8;
export const MAX_TORPEDOES = 99;
/** kMaxRange (combat.cpp:57): beyond it the target is out of range. */
export const MAX_RANGE = 110000;
/** CombatShip::kTrailLength (combat.h:206). */
export const TRAIL_LENGTH = 31;

/** FlightControls (combat.h:79-83): -100 to 100 each. */
export interface FlightControls { yaw: number; pitch: number; roll: number; throttle: number; stopping: boolean }

/** TextureAnimation (combat.h:86-98): `frames` names the sprite (null: stopped). */
export interface Animation { frames: string | null; frame: number; frameTime: number; lastFrame: number }
/** A stopped TextureAnimation, as TextureAnimation() leaves one (combat.h:91). Each call is a new object: weapons, damage and setup share this one helper. */
export const anim = (): Animation => ({ frames: null, frame: 0, frameTime: 0, lastFrame: 0 });

/** PhaserBank (combat.h:100-110), filled by setupWeapons (weapons.ts). The beam's model is the presentation's, but for its tip. */
export interface PhaserBank {
  unit: number; offset: V3; active: boolean; miss: boolean; missOffset: V3; endTime: number; lastUpdate: number;
  beam: Animation; charge: number; setting: number; savedSetting: number;
  /**
   * beamModel's first vertex, which updateBeams moves onto what the beam hits (weapons.cpp:378-380): the end less
   * the start, in internal coordinates (x right, y down, z forward). 0 until the beam first reaches anything.
   */
  tip: V3;
}

/** TacticScript (combat.h:114-136), loaded by loadScript (Plan 21): a copy of the file, which the script changes as it runs. */
export interface TacticScript {
  file: string; data: Uint8Array; pc: number; idle: number; kernel: number; trace: number;
  /** kNumQueues (10) queues of WHEN tokens, the newest first. */
  queues: number[][]; depth: number; buffer: boolean;
  /** The top first. */
  returns: number[];
}

/** CombatShip::Pose (combat.h:202-205). */
export interface Pose { pos: V3; angles: [number, number, number] }

/** CombatShip (combat.h:138-213). */
export interface CombatShip {
  /** Index into CombatData.kinds. */
  type: number;
  /** The kind's SHIP_FLAGS, and SHIP_STATE. */
  flags: number;
  /** 0 for the Enterprise; the others 1.. in the screen's order. Always the ship's index in BattleState.ships. */
  index: number;
  /** The space world's object (Object *source). */
  object: string;
  /** World coordinates: x, y forward and z up. */
  pos: V3; velocity: V3;
  /** Yaw, pitch and roll, 16384 to a turn. */
  angles: [number, number, number];
  radius: number;
  controls: FlightControls;
  speed: number; history: [number, number]; targetSpeed: number;
  baseMaxSpeed: number; maxSpeed: number;
  /** This step's turn, 16384 to a turn. */
  rates: [number, number, number];
  destroyed: boolean; removed: boolean;
  /** Cloaked until then (battle ms), or 0. */
  decloakTime: number;
  /** A ship's index, or null. */
  target: number | null;
  /** CombatData.models keys: models[0], models[1] and damageMaterials (combat.cpp:291-300, 382-383). */
  models: { detail: string | null; reduced: string | null; damaged: string | null };
  damagedMaterials: number[];
  /** ShipSystems: the Enterprise's is the ship's own (`world.state.ship.systems`, spec §4.4); the others' are built from CombatData.enemyUnits. */
  systems: SystemsState;
  condition: number; hullLowThreshold: number; hooksRun: number;
  /** The last 15 lines (logMessage, damage.cpp:81-91). */
  log: string[]; logRead: number; logScrollTime: number; logFrozen: boolean; logTime: number; torpedoLogTime: number;
  removeTime: number; selfDestructTime: number; conditionTime: number;
  banks: PhaserBank[]; activeBeams: number;
  shieldFlash: Animation; shieldAttacker: number | null; shieldFrom: V3; shieldImpact: V3; shieldAngles: [number, number];
  explosion: Animation;
  /** The tactics file loadScript loads (Combat::loadScript, tactics.cpp:157-173: kTacticOverrides, else its kind's), from the def; null for none. */
  tactics: string | null;
  script: TacticScript | null;
  engaged: boolean; waypoint: V3; waypointActive: boolean;
  fireTime: number; strategyTime: number; holdTime: number; scriptTime: number; freezeTime: number;
  /** inputHistory[4][8] (combat.h:200). */
  inputHistory: number[][];
  /** Where it has been, newest first (TRAIL_LENGTH poses). */
  trail: Pose[];
}

/** Torpedo (combat.h:215-224). */
export interface Torpedo {
  active: boolean; lock: boolean; speed: number; frame: number; homingDistance: number;
  launchTime: number; homingTime: number; expiry: number; pos: V3; angles: [number, number, number];
  shooter: number | null; target: number | null;
}

/** DebrisPiece and Debris (combat.h:227-246). */
export interface DebrisPiece {
  model: string | null; pos: V3; velocity: V3; angles: [number, number, number]; rates: [number, number, number];
  boom: Animation; boomTime: number; boomStarted: boolean;
}
export interface Debris { ship: number; pieces: DebrisPiece[]; scale: number; alpha: number; fadeTime: number; removeTime: number }

/** Combat::ManeuverItem (combat.h:358-364). */
export interface ManeuverItem { heading: boolean; open: boolean; payload: number; label: string; buttons: ManeuverItem[] }

/** What the tactical screen's controls set (combat.h:391-410), the tactics locks and the maneuver menu (combat.h:365-369, 422). */
export interface CombatConsole {
  redAlert: boolean; delegate: boolean; weaponsLock: boolean; shieldsRaised: boolean; shieldsFilled: boolean;
  sensorCheckTime: number; sensorQuality: number; sensorsReliable: boolean; sensorsBlank: boolean; sensorsDamaged: boolean;
  powerLevel: number;
  /** The torpedo spread, 16384 to a turn, and its cell's degrees. */
  spread: number; spreadDegrees: number;
  /** The fore and aft tubes. */
  salvo: [{ loaded: number; setting: number }, { loaded: number; setting: number }];
  selfDestructTime: number;
  /** 0 bears on the target, 1 damaged, 2 doesn't bear. */
  lamps: number[];
  targetFacing: number; connPage: boolean; redFlash: boolean; warped: boolean;
  /** The console's radar is open (ScummVM's always is; M8's phone drawer can close it): the `radar` command. */
  radarOpen: boolean;
  /**
   * The radar is on screen: open, and the view not wide (tactical.cpp:1315-1316). Each step asks the sensors first while
   * it is and the Enterprise lives (the radar's draw, tactical.cpp:1111-1113; Plan 23 R10). The `wide` and `radar` commands set it.
   */
  radarShown: boolean;
  /**
   * The radar's last answer: whether its blips show (drawRadar returns after the grid when checkSensors says no,
   * tactical.cpp:1112-1113). Each step that asks the sensors keeps theirs (battle.ts updateBattle). The sim never reads it (Plan 27 R5).
   */
  radarSeen: boolean;
  scriptLock: boolean; kernelReady: boolean; engageLock: boolean; engageButton: boolean; eventViewTime: number;
  menu: ManeuverItem[];
  /** _menuRows as [heading, button] (button -1 for the heading itself). */
  menuRows: [number, number][];
  menuScroll: number; menuSelected: number;
}

/** The camera's state, which the presentation reads (combat.h:439-450; Combat::kView*, combat.h:284-303). */
export interface CombatView {
  view: number; viewShip: number | null; viewExpiry: number; viewFrame: number;
  orbitAngle: number; lastOrbit: number; lastOrbitStep: number;
  cycleShip: number; cycleView: number; lastCycle: number;
  zoom: number; zoomLevel: number;
  /** TacticalScreen::_wide: the Full/Split toggle. */
  wide: boolean;
  /**
   * Combat::_camera (combat.h:434-438), placed by the updateCamera seam at the end of each step (camera.ts, M8): the sim
   * never reads it. `stepCamera` is the camera the step before left, which the view interpolates from (M8 spec Decision 7).
   */
  camera: CameraPose;
  stepCamera: CameraPose;
  /** Combat::_viewDistance (combat.h:443): kViewFlyIn's last distance to the ship. The camera's. */
  viewDistance: number;
  /**
   * kViewDrop has just turned into tracking (updateView, ScummVM's updateCamera, combat.cpp:933-939): the camera seam
   * places its one chase camera at 2r and clears it. The sim never reads it.
   */
  dropped: boolean;
  /** The battle's seed (setupBattle's), which the view seeds its own generator from (M8 spec Decision 10). The sim never reads it. */
  seed: number;
}

/** Combat::Camera (combat.h:434-437): where it is, in internal coordinates (x right, y down, z forward), and its axes, whose rows are its right, down and forward. */
export interface CameraPose { pos: V3; axes: M3 }

/**
 * The keys held (Combat::_held, FlightAction bits, combat.h:249-260) and when each axis was let go (_releaseStart).
 * lastPhaserKey and lastTorpedoKey are Combat's _lastPhaserKey and _lastTorpedoKey, which ScummVM declares and zeroes
 * (combat.h:424, combat.cpp:122) and never reads: kept for the trace. A reader would compare them as uint32, as the
 * carried times can be rebased below 0 (Plan 19's follow-up).
 */
export interface CombatInput { held: number; releaseStart: [number, number, number]; lastPhaserKey: number; lastTorpedoKey: number }

/**
 * A crew cue the battle asks for (_vm->_cues->play, playLater and playAfter, cues.h:45-48): the presentation's CuePlayer
 * plays them (Plan 28, audio/cues.ts). `after` is playAfter's: once the last cue has finished. `silenced` is set when the
 * request is made after the Enterprise is lost (`b.silenced`, CuePlayer::_silenced), so the player falls silent at that
 * request, in the frame's order: CuePlayer::blocked tests _silenced at play() time (cues.cpp:62-63: only an effect's
 * cue, speaker 8, still plays), and update() runs no delayed or chained cue once it is set (cues.cpp:132-133).
 */
export interface CueRequest { cue: number; delay: number; interrupt: boolean; after?: boolean; silenced?: true }

/**
 * A sound effect the battle asks for (Combat::playEffect, weapons.cpp:154-168): the sound, the ship it comes from
 * (null: at the camera), and its distance from the camera as it was asked for (weapons.cpp:156; 0 with no ship). The
 * presentation drops it from kSoundRange (8500), sets the volume by that distance and picks an effect channel
 * (weapons.cpp:157-167; Plan 28's audio/effects.ts). `bearing` is the port's, for 3D SOUND (Plan 34 Task 6): the ship's
 * direction from the camera's forward, in radians, positive to the right, on the camera's right and forward (none with no ship).
 */
export interface SoundRequest { sound: string; ship: number | null; distance: number; bearing?: number }

/**
 * What a world script left behind (Plan 22 implements the scripts): whether a viewscreen hail is pending,
 * `_vm->_pendingHail.type == 7` (damage.cpp:474), and processHails' answer (damage.cpp:693; tactical.cpp:377-436),
 * true when a hail was taken.
 */
export interface HookResult { hailPending: boolean; answered: boolean }
/** No script ran, or it left nothing pending. */
export const NO_HOOK: Readonly<HookResult> = Object.freeze({ hailPending: false, answered: false });

export interface BattleState {
  scenario: number;
  difficulty: 0 | 1 | 2;
  random: RandomState;
  /** Combat::_now and _lastStep, battle ms. */
  now: number; lastStep: number;
  /** Steps taken: for tests, traces and the debug view (not in the original). */
  steps: number;
  ships: CombatShip[];
  /** Combat::_target: the Enterprise's target. */
  target: number | null;
  torpedoes: Torpedo[];
  debris: Debris[];
  enter: string | null; exit: string | null; warp: string | null;
  contactCues: boolean;
  console: CombatConsole;
  view: CombatView;
  input: CombatInput;
  exitCode: number;
  /** Cues asked for since the presentation last took them. */
  cues: CueRequest[];
  /** Sound effects asked for since the presentation last took them (weapons.cpp:154-168). */
  sounds: SoundRequest[];
  /** CuePlayer::_silenced (cues.h:52): nobody speaks once the Enterprise is lost (damage.cpp:533-534). battleAudio carries it (Plan 28). */
  silenced: boolean;
}

/**
 * Where weapons, damage, the AI, tactics, the tactical screen and the camera plug into the step (spec §4.1; Plan 19's
 * R1). Plan 19 calls each at ScummVM's place in setup and step and implements none; NO_SEAMS does nothing. Plan 20
 * provides weapons.cpp's and damage.cpp's, Plan 21 ai.cpp's and tactics.cpp's, Plan 22 tactical.cpp's (hail, bridge,
 * engineering) and M8 the camera's, combined as `{ ...NO_SEAMS, ...weapons, ...ai }`.
 *
 * The world scripts (Plan 20 adds them, Plan 22 implements them) run the ship's space object's scripts, then
 * TacticalScreen::processHails, and say what that left (HookResult). The sim keeps the bookkeeping ScummVM keeps in
 * CombatShip (hooksRun, the strength bucket, the hull-low test on condition), and the seam does what reads or
 * writes the object (its script lists, phaser_data, OBJFLAG_*). Sound effects are requests in the state
 * (`b.sounds`, SoundRequest), as cues are (Plan 19's R7).
 *
 * The AI's reach outside the battle (Plan 21 adds them, Plan 22 implements them): warpAway shows the warp overlay
 * (showWarp, ai.cpp:246), and retreat reads astrogation's position and sets its scripted warp (ai.cpp:292-296).
 *
 * The Enterprise's `systems` is the world's own object (createShip, combat.cpp:356), so a structuredClone of a battle
 * cuts that link: the clone's Enterprise no longer writes the ship's systems. That matters to auto-resolve and
 * snapshots (Plan 22).
 */
export interface CombatSeams {
  // weapons.cpp (Plan 20)
  setupWeapons(ctx: BattleContext, b: BattleState, ship: CombatShip): void;
  updateBeams(ctx: BattleContext, b: BattleState, ship: CombatShip): void;
  updateTorpedoes(ctx: BattleContext, b: BattleState): void;
  updateSelfDestruct(ctx: BattleContext, b: BattleState): void;
  updateLamps(ctx: BattleContext, b: BattleState): void;
  firePhasers(ctx: BattleContext, b: BattleState, ship: CombatShip): void;
  fireTorpedoes(ctx: BattleContext, b: BattleState, ship: CombatShip, spread: number): void;
  setWeaponsLock(ctx: BattleContext, b: BattleState, on: boolean): void;
  raiseShields(ctx: BattleContext, b: BattleState, on: boolean): void;
  setPowerLevel(ctx: BattleContext, b: BattleState, level: number, force: boolean): void;
  setSpread(ctx: BattleContext, b: BattleState, cell: number): void;
  armSelfDestruct(ctx: BattleContext, b: BattleState): void;
  // damage.cpp (Plan 20)
  destroy(ctx: BattleContext, b: BattleState, ship: CombatShip): void;
  updateEffects(ctx: BattleContext, b: BattleState, ship: CombatShip): void;
  updateDebris(ctx: BattleContext, b: BattleState): void;
  // ai.cpp (Plan 21)
  enemySystemsCheck(ctx: BattleContext, b: BattleState, ship: CombatShip): void;
  runAI(ctx: BattleContext, b: BattleState, ship: CombatShip): void;
  autoTarget(ctx: BattleContext, b: BattleState, ship: CombatShip): void;
  starbase(ctx: BattleContext, b: BattleState, ship: CombatShip): void;
  avoidCollision(ctx: BattleContext, b: BattleState, ship: CombatShip): void;
  steerTowards(ctx: BattleContext, b: BattleState, ship: CombatShip, point: V3): void;
  filterInputs(ctx: BattleContext, b: BattleState, ship: CombatShip): void;
  setDelegate(ctx: BattleContext, b: BattleState, on: boolean, cues: boolean): void;
  // tactics.cpp (Plan 21)
  loadScript(ctx: BattleContext, b: BattleState, ship: CombatShip): void;
  runScript(ctx: BattleContext, b: BattleState, ship: CombatShip): void;
  engage(ctx: BattleContext, b: BattleState, mode: number): void;
  clickManeuver(ctx: BattleContext, b: BattleState, row: number): void;
  scrollManeuvers(ctx: BattleContext, b: BattleState, direction: number): void;
  engageManeuver(ctx: BattleContext, b: BattleState): void;
  // the world's scripts (damage.cpp:656-732; Plan 22's)
  /**
   * Whether the ship has its space object, `ship->source` (damage.cpp:658, 679, 698, 719): without one runEventHook and
   * hailResponse return before they mark the hook run, and afterHit does nothing (Plan 23 R5). Every lifted ship has
   * its object; a game whose content lacks it says no.
   */
  hasSource(ctx: BattleContext, b: BattleState, ship: CombatShip): boolean;
  /** runEventHook's script (damage.cpp:661-672): LOOK group `hook` of the ship's object, if it has one, then processHails. hooksRun is the sim's. */
  eventScript(ctx: BattleContext, b: BattleState, ship: CombatShip, hook: number): HookResult;
  /** hailResponse's script (damage.cpp:682-693): USE group `bucket - 1`, if the object has that many, then processHails. hooksRun is the sim's. */
  hailScript(ctx: BattleContext, b: BattleState, ship: CombatShip, bucket: number): HookResult;
  /** afterHit's hull-low script (damage.cpp:701-714), the condition test passed: if the object has phaser_data with stun_entries, is not stunned and not OBJFLAG_STUNNED, run them, mark it stunned, then processHails. */
  hullLowScript(ctx: BattleContext, b: BattleState, ship: CombatShip): HookResult;
  /** runDestroyedHook (damage.cpp:718-732): the kill_entries once, then the object is inactive, then processHails. Also TacticalScreen::endCombat's (tactical.cpp:349-353). */
  destroyedScript(ctx: BattleContext, b: BattleState, ship: CombatShip): HookResult;
  /** `ship->source->flags &= ~OBJFLAG_ACTIVE` as a ship is destroyed (damage.cpp:519-520). */
  deactivate(ctx: BattleContext, b: BattleState, ship: CombatShip): void;
  // the AI's reach outside the battle (ai.cpp; Plan 21 adds them, Plan 22 implements them)
  /**
   * TacticalScreen::showWarp (tactical.cpp:818-850), which warpAway calls (ai.cpp:246): the warp overlay for
   * combatTicks(0x369) ms (waitAndDraw, tactical.cpp:841), the keys and buttons let go. The step goes on at the same
   * `now`; ScummVM's clock runs on meanwhile, so its next update skips ahead (combat.cpp:409-419). Plan 22 shows it
   * and moves the battle clock on by as much.
   */
  showWarp(ctx: BattleContext, b: BattleState): void;
  /** Astrogation's position, `astro._x`, `_y` and `_z` (astrogation.h:186), which retreat reads (ai.cpp:292-293). */
  astrogationPosition(ctx: BattleContext, b: BattleState): readonly [number, number, number];
  /** Astrogation::scriptedWarp(code, speed) (astrogation.cpp:633-647), which retreat calls (ai.cpp:296): astrogation warps to the scripted destination `code`. */
  scriptedWarp(ctx: BattleContext, b: BattleState, code: number, speed: number): void;
  // tactical.cpp (Plan 22's): the hail and the Bridge and Engineering buttons, which leave the battle for the ship's screens
  hail(ctx: BattleContext, b: BattleState): void;
  bridge(ctx: BattleContext, b: BattleState): void;
  engineering(ctx: BattleContext, b: BattleState): void;
  /**
   * The camera's placement (combat.cpp:848-948, M8), and only that: the view state it reads (which view, of whom,
   * the expiry) is the sim's, set by updateView just before (battle.ts). One exception: kViewFlyIn's cut to tracking
   * (combat.cpp:893-896) depends on the camera's position and _viewDistance, which are the camera's, so M8 makes
   * that cut, with setView.
   */
  updateCamera(ctx: BattleContext, b: BattleState): void;
}

const nothing = (): void => {};
const noHook = (): HookResult => NO_HOOK;
const yes = (): boolean => true;
const ORIGIN: readonly [number, number, number] = Object.freeze([0, 0, 0] as const);
/** Frozen: a context takes a copy (`{ ...NO_SEAMS, ...mine }`) and changes that. The world scripts run nothing and leave nothing pending; astrogation is at 0, 0, 0. */
export const NO_SEAMS: Readonly<CombatSeams> = Object.freeze({
  setupWeapons: nothing, updateBeams: nothing, updateTorpedoes: nothing, updateSelfDestruct: nothing, updateLamps: nothing,
  firePhasers: nothing, fireTorpedoes: nothing, setWeaponsLock: nothing, raiseShields: nothing, setPowerLevel: nothing,
  setSpread: nothing, armSelfDestruct: nothing, destroy: nothing, updateEffects: nothing, updateDebris: nothing,
  enemySystemsCheck: nothing, runAI: nothing, autoTarget: nothing, starbase: nothing, avoidCollision: nothing,
  steerTowards: nothing, filterInputs: nothing, setDelegate: nothing, loadScript: nothing, runScript: nothing,
  engage: nothing, clickManeuver: nothing, scrollManeuvers: nothing, engageManeuver: nothing,
  hasSource: yes, eventScript: noHook, hailScript: noHook, hullLowScript: noHook, destroyedScript: noHook, deactivate: nothing,
  showWarp: nothing, astrogationPosition: () => ORIGIN, scriptedWarp: nothing,
  hail: nothing, bridge: nothing, engineering: nothing, updateCamera: nothing,
});

/** What a battle reads but never writes: the lifted data, the Enterprise's unit definitions, the seams and a trace hook. */
export interface BattleContext {
  combat: CombatData;
  /** ship.yaml's units: the Enterprise's 35 (NUM_SHIP_UNITS), the same index as its systems' units. */
  enterpriseUnits: readonly ShipUnit[];
  seams: CombatSeams;
  onDraw?: DrawHook;
  /**
   * Hears ScummVM's warning()s from tactics (an unknown token, verb or branch, a bad branch address, a queue stack
   * over- or underflow, no kernel page, a bad tactic file): the battle goes on as ScummVM's does. Tests and the dev
   * view listen; nothing else need.
   */
  onWarning?: (message: string) => void;
  /**
   * A parity replay's say over angleFromSinCos (math.ts' AngleOracle): ScummVM's atan2f angle where its trace logged
   * one apart from Math's (tracediff's `libm-atan2f` allowance). The game never sets it.
   */
  angleOracle?: AngleOracle;
  /** Hears the end of each step, as ScummVM's trace does (combat.cpp's update loop): a trace's snapshots every 15 steps. */
  onStep?: (b: BattleState) => void;
  /** The player's assists (spec §5; assists.ts): only Story's difficulty changes what the sim does. Absent is the original. */
  assists?: Readonly<CombatAssists>;
}

/** ScummVM's warning() (common/textconsole.h): the message to whoever listens (BattleContext.onWarning), and nothing else. */
export function warn(ctx: BattleContext, message: string): void {
  ctx.onWarning?.(message);
}

/** NUM_SHIP_UNITS (ship.h): the Enterprise has 35 units, which updateMaxSpeed and setup read by index. */
export const ENTERPRISE_UNITS = 35;

/** A lifted cue id (combat.yaml's `cueIds`): a table without it is a data bug, so this throws, naming the cue. */
export function cueId(ctx: Pick<BattleContext, 'combat'>, name: CombatCueName): number {
  const id = ctx.combat.cueIds?.[name];
  if (typeof id !== 'number') throw new Error(`combat data has no cue id '${name}' (cueIds.${name})`);
  return id;
}
/** The lifted name of one of the Enterprise's shields (combat.yaml's `shieldNames`), or a throw naming the index. */
export function shieldName(ctx: BattleContext, shield: number): string {
  const name = ctx.combat.shieldNames?.[shield];
  if (typeof name !== 'string') throw new Error(`combat data has no shield name ${shield} (shieldNames[${shield}])`);
  return name;
}
/** The lifted bearing row for a target facing (combat.yaml's `bearing`), or a throw naming the facing. */
export function bearingRow(ctx: BattleContext, facing: number): readonly number[] {
  const row = ctx.combat.bearing?.[facing];
  if (!row) throw new Error(`combat data has no bearing row ${facing} (bearing[${facing}])`);
  return row;
}

/** CuePlayer::play(id, important) and playLater(id, delay, important) (cues.h:45-46): asks the presentation for a crew cue (Plan 19's R7). `interrupt` is `important`; tagged `silenced` once the Enterprise is lost (cues.cpp:62-63). */
export function playCue(b: BattleState, cue: number, delay = 0, interrupt = false): void {
  b.cues.push(b.silenced ? { cue, delay, interrupt, silenced: true } : { cue, delay, interrupt });
}
/** CuePlayer::playAfter(id, important) (cues.h:47-48): once the last cue has finished. */
export function playCueAfter(b: BattleState, cue: number, interrupt = false): void {
  b.cues.push(b.silenced ? { cue, delay: 0, interrupt, after: true, silenced: true } : { cue, delay: 0, interrupt, after: true });
}

/** `ship->type == kCombatEnterprise` (CombatShip::type, combat.h:139; combat.h:47): the one test weapons, damage and setup share. */
export function isEnterprise(ship: { type: number }): boolean {
  return ship.type === KIND.enterprise;
}

/** A ship's unit definitions (the port's stand-in for ShipUnit::type, which updateCondition reads at combat.cpp:764), the same index as its systems' units: the Enterprise's are ship.yaml's, the others combat.yaml's enemy template. */
export function unitDefs(ctx: BattleContext, ship: CombatShip): readonly ShipUnit[] {
  return isEnterprise(ship) ? ctx.enterpriseUnits : ctx.combat.enemyUnits;
}
