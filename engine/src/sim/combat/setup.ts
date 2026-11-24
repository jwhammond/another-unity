// SPDX-License-Identifier: GPL-3.0-or-later
import { SHIP_FLAGS, type CombatShipDef } from '../../content/types';
import { STARTING_POWER, STARTING_TORPEDOES, type SystemsState } from '../shipSystems';
import { CONDITION_TIME, DEFAULT_ZOOM, setView, updateView, VIEW } from './battle';
import { bindContext } from './libm';
import { fr, hex, v3 } from './math';
import { newRandom, seedRandom } from './random';
import { combatTicks } from './time';
import {
  ENTERPRISE_UNITS, KIND, MAX_SHIPS, MAX_TORPEDOES, NO_EXIT, cueId, playCue, TRAIL_LENGTH,
  anim, type BattleContext, type BattleState, type CameraPose, type CombatConsole, type CombatInput, type CombatShip, type CombatView, type Torpedo,
} from './types';

/**
 * Combat::setup and createShip (combat.cpp:157-384), and what the Combat constructor starts with (combat.cpp:115-136):
 * a battle from a space-world screen. Split from battle.ts at Plan 20's start (Plan 19's follow-up).
 */

/** What starts a battle (Combat::setup's inputs, combat.cpp:157-279). TacticalScreen::start's own part (red alert, power level, Delegate at Ensign: tactical.cpp:304-336) is Plan 22's. */
export interface BattleInput {
  scenario: number;
  /** _vm->_rnd->getRandomNumber(0x7fffffff) (combat.cpp:164): Plan 22 draws it from the game's random source. */
  seed: number;
  /** The battle clock's time, ms (shipTickToMs of the world's tick). */
  now: number;
  /** UnityEngine::difficulty(): 0 Ensign, 1 Lieutenant, 2 Captain. */
  difficulty: 0 | 1 | 2;
  /** Whether a battle object is active now (OBJFLAG_ACTIVE, combat.cpp:219): the object's state, not the file's. */
  active(object: string): boolean;
  /** The Enterprise's persistent systems on the battle clock (systemsToBattleClock): shared, not copied (spec §4.4). */
  enterprise: SystemsState;
  /** The battle before, if any: what Combat keeps from one battle to the next (carryOver). */
  previous?: BattleState;
  /** Delegate as TacticalScreen::start sets it before setup (tactical.cpp:304-308; tactical.ts' startBattle); else as the last battle left it. */
  delegate?: boolean;
}

export interface SetupResult { battle: BattleState | null; warnings: string[] }

/** The Combat constructor's console (combat.cpp:115-134). */
export function newConsole(): CombatConsole {
  return {
    redAlert: false, delegate: false, weaponsLock: false, shieldsRaised: false, shieldsFilled: false,
    sensorCheckTime: 0, sensorQuality: 100, sensorsReliable: true, sensorsBlank: false, sensorsDamaged: false,
    powerLevel: 0, spread: 0, spreadDegrees: 0, salvo: [{ loaded: 0, setting: 0 }, { loaded: 0, setting: 0 }],
    selfDestructTime: 0, lamps: [2, 2, 2, 2, 2, 2, 2, 2], targetFacing: 0, connPage: false, redFlash: false, warped: false, radarOpen: true, radarShown: true, radarSeen: true,
    scriptLock: false, kernelReady: false, engageLock: false, engageButton: false, eventViewTime: 0,
    menu: [], menuRows: [], menuScroll: 0, menuSelected: -1,
  };
}
/** A camera at the origin looking forward (Combat's Camera before setup places it). */
export const newCamera = (): CameraPose => ({ pos: v3(), axes: [1, 0, 0, 0, 1, 0, 0, 0, 1] });

/** The Combat constructor's camera (combat.cpp:115-125): the chase view at the default zoom. */
export function newView(): CombatView {
  return {
    view: VIEW.chase, viewShip: null, viewExpiry: 0, viewFrame: 0, orbitAngle: 0, lastOrbit: 0, lastOrbitStep: 0, cycleShip: 0, cycleView: 0, lastCycle: 0,
    zoom: DEFAULT_ZOOM, zoomLevel: 0, wide: false, camera: newCamera(), stepCamera: newCamera(), viewDistance: 0, dropped: false, seed: 0,
  };
}
/** The Combat constructor's keys (combat.cpp:115-129): none held, no axis let go. */
export function newInput(): CombatInput {
  return { held: 0, releaseStart: [0, 0, 0], lastPhaserKey: 0, lastTorpedoKey: 0 };
}

/**
 * What ScummVM's Combat keeps from one battle to the next: the TacticalScreen's Combat lives for the session, and
 * setup (combat.cpp:157-176) resets only some of it. The rest stays as the last battle left it (shields raised, the
 * spread, Delegate, when each control was let go, the camera's orbit and cycle). Faithful, quirks and all.
 */
export function carryOver(previous: BattleState | undefined): { console: CombatConsole; view: CombatView; input: CombatInput } {
  const console = newConsole();
  const view = newView();
  const input = newInput();
  if (previous) {
    const p = previous.console;
    Object.assign(console, {
      redAlert: p.redAlert, delegate: p.delegate, weaponsLock: p.weaponsLock, shieldsRaised: p.shieldsRaised, powerLevel: p.powerLevel,
      spread: p.spread, spreadDegrees: p.spreadDegrees, lamps: [...p.lamps], targetFacing: p.targetFacing, connPage: p.connPage, radarOpen: p.radarOpen,
    });
    const v = previous.view;
    // (not `wide`: TacticalScreen::start sets it back, tactical.cpp:281)
    Object.assign(view, { orbitAngle: v.orbitAngle, lastOrbit: v.lastOrbit, lastOrbitStep: v.lastOrbitStep, cycleShip: v.cycleShip, cycleView: v.cycleView, lastCycle: v.lastCycle });
    // (the camera too, which setup's chase view then places again: Combat::clear leaves it, combat.cpp:140-155)
    Object.assign(view, { camera: structuredClone(v.camera), viewDistance: v.viewDistance });
    Object.assign(input, { releaseStart: [...previous.input.releaseStart], lastPhaserKey: previous.input.lastPhaserKey, lastTorpedoKey: previous.input.lastTorpedoKey });
  }
  // (combat.cpp:161-176: these are reset)
  Object.assign(console, {
    scriptLock: false, kernelReady: false, engageLock: false, engageButton: false, menuScroll: 0, menuSelected: -1, eventViewTime: 0,
    shieldsFilled: false, sensorCheckTime: 0, sensorQuality: 100, sensorsReliable: true, sensorsBlank: false, sensorsDamaged: false, radarSeen: true,
    selfDestructTime: 0, redFlash: false, warped: false, menu: [], menuRows: [],
    // (the view starts narrow, tactical.cpp:281, so the radar shows if it is open)
    radarShown: console.radarOpen,
  });
  return { console, view, input };
}

/** Moves the times carryOver kept by `delta` ms, keeping 0 ("not let go", "never") as 0 and a time as a time. */
function rebaseCarried(view: CombatView, input: CombatInput, delta: number): void {
  const f = (t: number) => (t === 0 ? 0 : t + delta || -1);
  view.lastOrbit = f(view.lastOrbit);
  view.lastCycle = f(view.lastCycle);
  input.releaseStart = [f(input.releaseStart[0]), f(input.releaseStart[1]), f(input.releaseStart[2])];
  input.lastPhaserKey = f(input.lastPhaserKey);
  input.lastTorpedoKey = f(input.lastTorpedoKey);
}

/** A Torpedo as `_torpedoes.resize(kMaxTorpedoes)` makes it, inactive (combat.h:215-224, combat.cpp:179-181). */
function newTorpedo(): Torpedo {
  return {
    active: false, lock: false, speed: 0, frame: 0, homingDistance: 0, launchTime: 0, homingTime: 0, expiry: 0,
    pos: v3(), angles: [0, 0, 0], shooter: null, target: null,
  };
}

/** The enemy template's systems (combat.cpp:355-378): every unit full and whole, then scaled by the ship's strength, which the difficulty halves or doubles. */
function enemySystems(ctx: BattleContext, strength: number, difficulty: number): SystemsState {
  // Ensigns face weaker ships, and Captains stronger ones
  let s = strength;
  if (difficulty === 0) s >>= 1;
  else if (difficulty === 2) s <<= 1;
  const units = ctx.combat.enemyUnits.map(u => {
    let current = u.max, max = u.max;
    if (s !== 100) {
      current = Math.trunc((current * s) / 100);
      max = Math.trunc((max * s) / 100);
    }
    // (target stays the template's max while max is scaled: combat.cpp:362 sets it before 370-377 scale current and
    // max. So an Ensign's enemy charges toward a target above its max. A quirk, kept: Plan 22 checks it against a trace.)
    return { current, target: u.max, max, damage: 0, repair: u.repair, efficiency: u.efficiency, nextStep: 0, nextRepair: 0 };
  });
  // (ShipSystems::reset, ship.cpp:87-93)
  return { units, pool: STARTING_POWER, torpedoes: STARTING_TORPEDOES, matterAntimatterOutput: 0, fusionOutput: 0, lastReactorTick: 0, lastTick: 0 };
}

/**
 * Combat::createShip (combat.cpp:281-384): a ship of `type` from its object, at index `index` (0 for the
 * Enterprise). Its position is the object's × 10 (the lift has done the × 10), its heading the sprite id in degrees,
 * and it may arrive cloaked for `decloak` seconds.
 */
export function createShip(ctx: BattleContext, b: BattleState, def: CombatShipDef, index: number, enterprise: SystemsState): CombatShip {
  const kind = ctx.combat.kinds[def.type]!;
  const detail = kind.models.detail;
  const size = detail !== null ? ctx.combat.models[detail]?.size : undefined;
  const pos = v3(def.position[0], def.position[1], def.position[2]);
  // (the sprite is the heading, in degrees: (int)((int16)sprite_id / 360.0f * 16384.0f) & 0x3fff)
  const yaw = def.heading === null ? 0 : Math.trunc(fr(fr(def.heading / 360) * 16384)) & 0x3fff;
  // some ships arrive cloaked, and decloak after a number of seconds
  let decloakTime = 0;
  if (def.decloak !== -1 && def.decloak !== 0) {
    decloakTime = b.now + def.decloak * 1000;
    // (the decloak cue, a second in: combat.cpp:324)
    if (def.decloak < 2) playCue(b, cueId(ctx, 'decloak'), 1000);
  }
  const isEnterprise = def.type === KIND.enterprise;
  return {
    type: def.type, flags: kind.flags, index, object: def.object,
    pos, velocity: v3(), angles: [yaw, 0, 0],
    radius: size ? fr(Math.max(size[0], Math.max(size[1], size[2]))) : 0,
    controls: { yaw: 0, pitch: 0, roll: 0, throttle: 0, stopping: false },
    speed: 0, history: [0, 0], targetSpeed: 0, baseMaxSpeed: fr(kind.maxSpeed), maxSpeed: fr(kind.maxSpeed), rates: [0, 0, 0],
    destroyed: false, removed: false, decloakTime, target: null,
    models: { detail, reduced: kind.flags & SHIP_FLAGS.reduced ? kind.models.reduced : null, damaged: kind.flags & SHIP_FLAGS.damageTextures ? kind.models.damaged : null },
    damagedMaterials: [],
    systems: isEnterprise ? enterprise : enemySystems(ctx, def.strength, b.difficulty),
    condition: 100,
    // (combat.cpp:349-354: the lift has worked out threshold² / 100 and max_health)
    hullLowThreshold: def.hullLow, hooksRun: 0,
    log: [], logRead: 0, logScrollTime: 0, logFrozen: false, logTime: 0, torpedoLogTime: 0,
    removeTime: 0, selfDestructTime: 0, conditionTime: b.now + CONDITION_TIME,
    banks: [], activeBeams: 0,
    shieldFlash: anim(), shieldAttacker: null, shieldFrom: v3(), shieldImpact: v3(), shieldAngles: [0, 0],
    explosion: anim(),
    tactics: def.tactics, script: null, engaged: false, waypoint: v3(), waypointActive: false,
    fireTime: 0, strategyTime: 0, holdTime: 0, scriptTime: 0, freezeTime: 0,
    inputHistory: Array.from({ length: 4 }, () => Array<number>(8).fill(0)),
    trail: Array.from({ length: TRAIL_LENGTH }, () => ({ pos: { ...pos }, angles: [yaw, 0, 0] as [number, number, number] })),
  };
}

/**
 * Combat::setup (combat.cpp:157-279): the battle from a space-world screen. The Enterprise goes to index 0; the
 * other active ships follow, numbered 1.. in the screen's order (their index picks shield_N), at most MAX_SHIPS in
 * all; a second Enterprise is skipped (Plan 18's rulings). Without an Enterprise there is no battle.
 */
export function setupBattle(ctx: BattleContext, input: BattleInput): SetupResult {
  bindContext(ctx);
  const warnings: string[] = [];
  const def = ctx.combat.battles[input.scenario];
  if (!def) return { battle: null, warnings: [`battle screen ${hex(input.scenario)} has no Enterprise`] };
  const { console, view, input: keys } = carryOver(input.previous);
  if (input.delegate !== undefined) console.delegate = input.delegate;
  // (the battle clock is the world's tick as ms, and that can go back between battles (a load, or a world tick that
  // stood still): what the last battle left is rebased by as much, as time.ts's rule says. ScummVM's clock never goes back.)
  if (input.previous && input.now < input.previous.now) rebaseCarried(view, keys, input.now - input.previous.now);
  const b: BattleState = {
    scenario: input.scenario, difficulty: input.difficulty, random: newRandom(),
    now: input.now, lastStep: input.now, steps: 0,
    ships: [], target: null,
    torpedoes: Array.from({ length: MAX_TORPEDOES }, newTorpedo), debris: [],
    enter: def.enter, exit: def.exit, warp: def.warp,
    // (combat.cpp:198-199: battle 0x34's surprises)
    contactCues: !def.quietContacts,
    console, view: { ...view, zoom: DEFAULT_ZOOM, zoomLevel: 0, seed: input.seed >>> 0 }, input: { ...keys, held: 0 },
    exitCode: NO_EXIT, cues: [], sounds: [], silenced: false,
  };
  seedRandom(b.random, input.seed);

  // the ships are the screen's objects, in order
  let index = 1;
  let target: CombatShip | null = null;
  for (const ship of def.ships) {
    if (!input.active(ship.object)) continue;
    if (ship.type === KIND.enterprise) {
      if (b.ships[0]?.type === KIND.enterprise) {
        warnings.push(`battle screen ${hex(input.scenario)} contains more than one Enterprise`);
        continue;
      }
      b.ships.unshift(createShip(ctx, b, ship, 0, input.enterprise));
    } else {
      // (combat.cpp:229: the Enterprise counts toward the 8 once it is in, so a screen listing it after eight others
      // fights nine ships. A quirk, kept: no battle the game has does it.)
      if (b.ships.length >= MAX_SHIPS) {
        warnings.push(`too many ships in battle screen ${hex(input.scenario)}`);
        continue;
      }
      target = createShip(ctx, b, ship, index++, input.enterprise);
      b.ships.push(target);
    }
  }
  const enterprise = b.ships[0];
  if (!enterprise || enterprise.type !== KIND.enterprise) {
    // (no battle the game reaches is like this)
    warnings.push(`battle screen ${hex(input.scenario)} has no Enterprise`);
    return { battle: null, warnings };
  }
  if (input.enterprise.units.length < ENTERPRISE_UNITS || ctx.enterpriseUnits.length < ENTERPRISE_UNITS) {
    throw new Error(`the Enterprise has ${Math.min(input.enterprise.units.length, ctx.enterpriseUnits.length)} units: combat needs ${ENTERPRISE_UNITS}`);
  }
  b.target = target?.index ?? null;

  // Worf says what's there
  for (const ship of b.ships.slice(1)) {
    const cue = ctx.combat.kinds[ship.type]!.contactCue;
    if (cue === -1) continue;
    if (!b.contactCues && (ship.type === KIND.chodak || ship.type === KIND.probe)) continue;
    playCue(b, cue);
  }

  for (const ship of b.ships.slice(1)) ship.target = 0;
  enterprise.target = b.target;
  for (const ship of b.ships) {
    ctx.seams.setupWeapons(ctx, b, ship);
    ctx.seams.loadScript(ctx, b, ship);
  }
  // (the Enterprise holds fire for a moment, and its menu is locked until its tactics have set it up)
  enterprise.fireTime = b.now + combatTicks(0x369);
  ctx.seams.engage(ctx, b, 2);
  for (let i = 0; i < 2; i++) {
    const tube = enterprise.systems.units[19 + i]!;
    const loaded = tube.max ? Math.trunc((tube.current * 10) / tube.max) : 0;
    b.console.salvo[i] = { loaded, setting: loaded };
  }
  ctx.seams.updateLamps(ctx, b);
  // (combat.cpp:273-277: the chase view, placed now; nothing to interpolate from before it)
  setView(b, 0, VIEW.chase);
  updateView(b);
  ctx.seams.updateCamera(ctx, b);
  b.view.stepCamera = structuredClone(b.view.camera);
  return { battle: b, warnings };
}
