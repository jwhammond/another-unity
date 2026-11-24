// SPDX-License-Identifier: GPL-3.0-or-later
import type { GameContent, Universe } from '../content/types';
import { newSystems, type SystemsState } from './shipSystems';
import type { ObjectState, WorldState } from './state';
import type { World } from './world';

/** The ship's stations (the original's screen codes, STATION_CODE). */
export type Station = 'bridge' | 'transporter' | 'viewscreen' | 'astrogation' | 'computer' | 'tactical' | 'engineering' | 'holodeck';
export const STATION_CODE: Record<Station, number> = { bridge: 0, transporter: 1, viewscreen: 2, astrogation: 4, computer: 5, tactical: 7, engineering: 9, holodeck: 0xa };
/** The game-over code that ends the whole game (unity.cpp). */
export const GAME_END = 0xfe;
/** A battle hail's "no scenario" (CommunicateFx.scenario). */
export const NO_SCENARIO = 0xffff;

export interface Vec3i { x: number; y: number; z: number }

/** AstroLocation (astrogation.h:46): -1 is none. */
export interface AstroLocation { sector: number; star: number; planet: number; moon: number; station: number; phenomenon: number }
export const NOWHERE: AstroLocation = { sector: -1, star: -1, planet: -1, moon: -1, station: -1, phenomenon: -1 };

/** A journey under way, in ticks (R1). */
export interface Transit {
  from: Vec3i; to: Vec3i; orbit: number;
  destination: AstroLocation; destType: number; destStarId: number;
  warp: boolean; speed: number; startTick: number; ticks: number;
}

/** A thing moving through space (UnityEngine::UniverseMove, unity.cpp:425-476). `start` is a tick. */
export interface UniverseMove { object: string; start: number; from: Vec3i; to: Vec3i }

/** The battle being fought (Combat::setup, combat.cpp:157-236): who is in it, and how it has gone. */
export interface CombatState {
  scenario: number;
  enterprise: string;
  /** Active ships at setup, in screen order (Combat::setup). */
  enemies: string[];
  friends: string[];
  destroyed: string[];
  warped: boolean;
  redAlert: boolean;
}

export interface ShipState {
  station: Station;
  pos: Vec3i;
  orbit: number;
  location: AstroLocation;
  locationType: number;
  transit: Transit | null;
  /** The tick the clock stopped at; 0 while it runs (stopClock/startClock). */
  clockStopped: number;
  lastSector: number;
  /** Astrogation::_flags, by thing id: 1 charted, 4|8 visited, 0x10 revealed. */
  flags: number[];
  visits: { first: boolean; second: boolean };
  battleScenario: number;
  viewscreenTarget: string | null;
  /** shipEquipment(): what the transporter offers; loaded on first use, as the original does. */
  equipment: string[] | null;
  lastTriggerCheck: number;
  /** UnityEngine::_bridgeUse: the object the bridge uses on its next update. */
  bridgeUse: string | null;
  /** Astrogation::_warpPending. */
  warpPending: boolean;
  /** Astrogation::_scriptedWarp, by its code. */
  scriptedWarp: number | null;
  /** Astrogation::_warpSpeed (0 leaves the speed as it is). */
  warpSpeed: number;
  universeMoves: UniverseMove[];
  /** UnityEngine::_awayTeamStartTime in ticks, while a team is away. */
  awaySince: number | null;
  /** Astrogation::_newWarpMovie and _warpMoviesSeen (astrogation.cpp:113-114). */
  newWarpMovie: boolean;
  warpMoviesSeen: number;
  /** _inCombat and the battle. */
  combat: CombatState | null;
  /** Astrogation::_sensorRecords (newest first), _sensorScroll and _lastSensorRecord: where the ship has been sent, for the bridge to go again. */
  sensorRecords: AstroLocation[];
  sensorScroll: number;
  lastSensorRecord: AstroLocation;
  /**
   * UnityEngine::_seenMovies: the movies played so far, for the holodeck to show again. By stem (a warp movie, which the sim knows by its
   * index, as `warp:<index>`); the ship's tour counts as seen from the start (unity.cpp:1727).
   */
  seenMovies: string[];
  /** ShipSystems: the ship's units (levels, damage, repairs), the power pool and the torpedoes, which engineering sets and the tick runs. */
  systems: SystemsState;
}

/** The ship's tour, which counts as seen in a new game (kMovieShipTour: movie 3 of movie.map). */
export const SHIP_TOUR = 'shiptour';

/** UnityEngine::playMovie's `_seenMovies.push_back` (unity.cpp:363-364): a movie is seen once. */
export function markMovieSeen(ship: ShipState, key: string): void {
  const k = key.toLowerCase();
  if (!ship.seenMovies.includes(k)) ship.seenMovies.push(k);
}

/** Where a new game starts (astrogation.cpp: the origin of the first leg). */
export const START_POS: Vec3i = { x: 90, y: 90, z: 90 };

/** Astrogation::sector(): sectors are 20 units on a side, 8 to an axis. */
export function sectorOf(_u: Universe, p: Vec3i): number {
  return Math.trunc(p.x / 20) + Math.trunc(p.y / 20) * 8 + Math.trunc(p.z / 20) * 64;
}

/** A game with no ship gets an empty one, so every state has the field. */
export function newShipState(c: GameContent): ShipState {
  const pos = { ...START_POS };
  return {
    station: 'bridge',
    pos,
    orbit: 0,
    location: { ...NOWHERE },
    locationType: -1,
    transit: null,
    clockStopped: 0,
    lastSector: c.ship ? sectorOf(c.ship.universe, pos) : -1,
    flags: c.ship ? [...c.ship.universe.flags] : [],
    visits: { first: false, second: false },
    battleScenario: NO_SCENARIO,
    viewscreenTarget: null,
    equipment: null,
    lastTriggerCheck: 0,
    bridgeUse: null,
    warpPending: false,
    scriptedWarp: null,
    warpSpeed: 0,
    universeMoves: [],
    awaySince: null,
    newWarpMovie: false,
    warpMoviesSeen: 1,
    combat: null,
    sensorRecords: [],
    sensorScroll: 0,
    lastSensorRecord: { ...NOWHERE },
    seenMovies: [SHIP_TOUR],
    systems: newSystems(c.ship),
  };
}

/** The Enterprise's object (the ship world's 5f0100). */
export function enterprise(world: World): ObjectState {
  const ship = world.content.ship;
  if (!ship) throw new Error('this game has no ship');
  return world.obj(ship.data.astro.enterprise);
}

/**
 * UnityEngine::endAwayTeam (awayteam.cpp:144-170): everyone is healed back on the ship, and whatever was carried stays
 * there, in the ship's equipment. Nobody is acting on the ship but the captain (_current_away_team_member = NULL, which
 * the bridge's talk and the "anyone" fallbacks read as objectID(0, 0, 0): the game's leader).
 */
export function returnAwayTeam(s: WorldState, content: GameContent, now: number): void {
  for (const d of Object.values(content.objects)) {
    const pd = d.crew ? d.phaser : undefined;
    if (!pd || !s.phaser[d.id]) continue;
    s.phaser[d.id].health = pd.health;
    s.phaser[d.id].stunned = false;
  }
  const equipment = (s.ship.equipment ??= [...(content.ship?.data.equipment ?? [])]);
  for (const [id, o] of Object.entries(s.objects)) {
    if (!o.inventory) continue;
    o.inventory = false;
    o.screen = null;
    if (!equipment.includes(id)) equipment.push(id);
  }
  s.awayTeam = [];
  s.currentActor = content.start.leader;
  // (the ship's timers stop while the team is out: awayteam.cpp:183-184)
  if (s.ship.awaySince !== null) delayShipTimers({ state: s, content }, now - s.ship.awaySince);
  s.ship.awaySince = null;
}

/** UnityEngine::delayShipTimers (unity.cpp:820-827): each ship timer trigger with a due tick moves on by `ticks`. */
export function delayShipTimers(world: { state: WorldState; content: GameContent }, ticks: number): void {
  for (const t of world.content.triggers) {
    if (t.context !== 'ship' || t.type !== 'timer') continue;
    const ts = world.state.triggers[t.id];
    if (ts?.due) ts.due += ticks;
  }
}
