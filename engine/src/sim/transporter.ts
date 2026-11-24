// SPDX-License-Identifier: GPL-3.0-or-later
import type { ItemRoles } from '../content/types';
import type { World } from './world';

/** UnityEngine::difficulty() (awayteam.cpp:103): ScummVM's default is the middle level; the levels are 0-2 (R6). */
export const DEFAULT_DIFFICULTY = 1;

/** The setting's value as UnityEngine::difficulty clips it (awayteam.cpp:104): 0-2, else the default for what isn't a number. */
export function clipDifficulty(value: unknown): 0 | 1 | 2 {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_DIFFICULTY;
  return Math.min(Math.max(Math.trunc(n), 0), 2) as 0 | 1 | 2;
}
/** The world with no transporter effect and no sliders (transporter.cpp:196, 552). */
const WORLD_WITHOUT_EFFECT = 6;
/** The world without phasers (transporter.cpp:179). */
const WORLD_WITHOUT_PHASERS = 3;
/** The pads (transporter.cpp: four). */
export const PADS = 4;

/** TransporterScreen's state (transporter.h), as the sim needs it: no walkers, door or sliders. */
export interface TransporterRoom {
  /** beamTarget's screen, or null: there is nothing to beam to, and no energize (`_hasTarget`). */
  target: string | null;
  /** The original's world number, from the target's world; 0 with no target. */
  world: number;
  /** Four crew slugs, or null for an empty pad. */
  pads: (string | null)[];
  /** Aboard and not on a pad, in id order. */
  crew: string[];
  /** shipEquipment() minus the kit and the communicator, the phaser added unless world 3. */
  equipment: string[];
  kit: string[];
  /** _movedMedkit and _movedMedicalTricorder: set by hand, so Crusher's pad no longer decides them. */
  movedByHand: { medkit: boolean; medicalTricorder: boolean };
  /** The items the rules name (the medical ones, for Crusher's pad). */
  roles: ItemRoles;
  /**
   * What the screen is doing that the original waits for before it energizes (`canEnergize`: `_showMap && _lockStage != 2`, or `!_walkers.empty()`): the
   * map still searching for its target, or someone walking onto or off a pad. The view sets it; the sim only reads it.
   */
  hold?: boolean;
}

/** The original's world number of a screen (the mission table lists them); 0 when it isn't one of those. */
export function worldNumberOf(world: World, screen: string): number {
  const c = world.content;
  const slug = c.screens[screen]?.world ?? c.id;
  return c.missions?.find(m => m.world === slug)?.number ?? 0;
}

/** TransporterScreen::start (transporter.cpp:166-200): the room as the ship's equipment and crew offer it. */
export function openTransporter(world: World): TransporterRoom {
  const ship = world.content.ship;
  if (!ship) throw new Error('this game has no ship');
  const state = world.state.ship;
  const roles = world.content.rules.items;
  const beam = world.state.beamTarget;
  // (_beam_world: world 8's beams land on world 5's screens, so the screen alone would pick world 5's team: BeamFx.world)
  const number = beam === null ? 0 : world.state.beamWorld ?? worldNumberOf(world, beam);
  // (_hasTarget = world != 0 && world < _transporterTargets.size(): transporter.cpp:168)
  const hasTarget = beam !== null && number !== 0 && number < ship.data.transporter.targets.length;

  // the ship's equipment, loaded on first use (shipEquipment, awayteam.cpp:89-100); the communicator always goes
  state.equipment ??= [...ship.data.equipment];
  const equipment = state.equipment.filter(id => id !== roles.communicator && id !== roles.phaser);
  // (there are no phasers on world 3)
  if (number !== WORLD_WITHOUT_PHASERS && roles.phaser !== undefined) {
    world.obj(roles.phaser).active = true;
    equipment.push(roles.phaser);
  }

  const room: TransporterRoom = {
    target: hasTarget ? beam : null,
    world: number,
    pads: Array<string | null>(PADS).fill(null),
    crew: Object.values(world.content.objects).filter(d => d.crew).map(d => d.id),
    equipment,
    kit: [],
    movedByHand: { medkit: false, medicalTricorder: false },
    roles,
  };

  // the phaser and tricorder always go (transporter.cpp:195-200: from the end of the list)
  for (let i = room.equipment.length - 1; i >= 0; i--) {
    const id = room.equipment[i];
    if (id === roles.phaser || id === roles.tricorder) moveToKit(room, id, false);
  }

  // world 6 skips all this, and the caller energizes at once; on the easier levels the right team is chosen already
  // (transporter.cpp:202-206, 217-219)
  if (number === WORLD_WITHOUT_EFFECT || world.difficulty < 2) chooseRecommended(world, room);
  return room;
}

/** The ship's room while the ship is at the transporter. Only reads (M9): gotoShipScreen opens it, and restoreTransporter after a load. */
export function transporterRoom(world: World): TransporterRoom | null {
  if (world.state.onShip === null || world.state.ship.station !== 'transporter') return null;
  return world.transporter;
}

/** A loaded save at the transporter has no room yet (it is not saved): start it as TransporterScreen::start does (M9). */
export function restoreTransporter(world: World): void {
  if (world.state.onShip === null || world.state.ship.station !== 'transporter' || world.transporter !== null) return;
  world.transporter = openTransporter(world);
}

/**
 * TransporterScreen::update (transporter.cpp:419-426): on the easiest level it all happens by itself. True if it energized
 * (as a queued action: the beam changes screen).
 */
export function transporterTick(world: World): boolean {
  const room = transporterRoom(world);
  if (room === null || world.difficulty !== 0 || !canEnergize(room)) return false;
  void world.enqueue(async () => { await energizeAndArrive(world, room); });
  return true;
}

/** TransporterScreen::chooseRecommended (transporter.cpp:429-447): this world's team on the pads, its items in the kit. */
export function chooseRecommended(world: World, room: TransporterRoom): void {
  const recommended = world.content.ship?.data.transporter.teams.find(t => t.world === room.world);
  if (!recommended) return;
  for (const member of recommended.members) {
    if (room.crew.includes(member)) addToPad(world, room, member);
  }
  for (const item of recommended.items) {
    if (room.equipment.includes(item)) moveToKit(room, item, true);
  }
}

/** TransporterScreen::addToPad (transporter.cpp:457-486): the first free pad if none is given or it is taken; none free, nothing. */
export function addToPad(world: World, room: TransporterRoom, crew: string, pad = -1): void {
  if (!room.crew.includes(crew)) return;
  if (pad < 0 || pad >= PADS || room.pads[pad] !== null) {
    pad = room.pads.indexOf(null);
    if (pad < 0) return;
  }
  room.pads[pad] = crew;
  room.crew = room.crew.filter(c => c !== crew);
  // Crusher takes the medical equipment (transporter.cpp:481-488)
  if (crew === world.content.rules.doctor) {
    for (let i = room.equipment.length - 1; i >= 0; i--) {
      const id = room.equipment[i];
      if ((id === room.roles.medkit && !room.movedByHand.medkit) || (id === room.roles.medicalTricorder && !room.movedByHand.medicalTricorder)) {
        moveToKit(room, id, false);
      }
    }
  }
}

/** TransporterScreen::removeFromPad (transporter.cpp:491-509): back in the crew list in id order; Crusher's medical kit goes back too. */
export function removeFromPad(world: World, room: TransporterRoom, pad: number): void {
  const crew = room.pads[pad];
  if (crew === undefined || crew === null) return;
  room.pads[pad] = null;
  const order = Object.keys(world.content.objects);
  const at = room.crew.findIndex(c => order.indexOf(c) > order.indexOf(crew));
  room.crew.splice(at < 0 ? room.crew.length : at, 0, crew);
  if (crew === world.content.rules.doctor) {
    for (let i = room.kit.length - 1; i >= 0; i--) {
      const id = room.kit[i];
      if ((id === room.roles.medkit && !room.movedByHand.medkit) || (id === room.roles.medicalTricorder && !room.movedByHand.medicalTricorder)) {
        moveToEquipment(room, id, false);
      }
    }
  }
}

/** TransporterScreen::moveToKit (transporter.cpp:511-523). */
export function moveToKit(room: TransporterRoom, item: string, byHand: boolean): void {
  const at = room.equipment.indexOf(item);
  if (at < 0) return;
  room.equipment.splice(at, 1);
  room.kit.push(item);
  if (byHand) markMoved(room, item);
}

/** TransporterScreen::moveToEquipment (transporter.cpp:525-538). */
export function moveToEquipment(room: TransporterRoom, item: string, byHand: boolean): void {
  const at = room.kit.indexOf(item);
  if (at < 0) return;
  room.kit.splice(at, 1);
  room.equipment.push(item);
  if (byHand) markMoved(room, item);
}

function markMoved(room: TransporterRoom, item: string): void {
  if (item === room.roles.medkit) room.movedByHand.medkit = true;
  if (item === room.roles.medicalTricorder) room.movedByHand.medicalTricorder = true;
}

/** TransporterScreen::canEnergize (transporter.cpp:541-549): a target and someone on a pad, with the map locked on (or hidden) and nobody walking (`hold`). */
export function canEnergize(room: TransporterRoom): boolean {
  return room.hold !== true && room.target !== null && room.pads.some(p => p !== null);
}

/**
 * TransporterScreen::energize (transporter.cpp:551-588) and UnityEngine::beamDown (awayteam.cpp:109-140). Returns
 * whether the beam effect and the beam-down piece play: world 6 has neither. It also sets the advice mode (R5: written
 * and saved, but nothing reads it, as in the original).
 */
export function energize(world: World, room: TransporterRoom): boolean {
  if (!canEnergize(room) || room.target === null) throw new Error('no transporter target or nobody on the pads');
  const effect = room.world !== WORLD_WITHOUT_EFFECT;
  const team = room.pads.filter((p): p is string => p !== null);
  // the advice depends on choosing the right team, on the middle level (transporter.cpp:572-582)
  let advice: number = world.difficulty;
  if (advice === 1) {
    advice = 0;
    const recommended = world.content.ship?.data.transporter.teams.find(t => t.world === room.world);
    if (recommended && recommended.members.some(m => !team.includes(m))) advice = 2;
  }
  world.state.adviceMode = advice;
  beamDown(world, team, [...room.kit], room.target, room.world, effect);
  world.transporter = null;
  return effect;
}

/**
 * energize, then the team's beam-in: beamDown starts the away team and then runs beamEffect(team, false, false) before anything else happens
 * (awayteam.cpp:137-140), so the game waits for the effect. The state is the screen's by the time it plays; `energize`'s own work is not delayed.
 */
export async function energizeAndArrive(world: World, room: TransporterRoom): Promise<void> {
  const effect = energize(world, room);
  if (effect) await world.presenter.show({ kind: 'beam', objects: [...world.state.awayTeam], out: false, chodak: false });
}

/**
 * UnityEngine::beamDown (awayteam.cpp:109-140). The screen change is startAwayTeam(world, beamScreen, 0): the team
 * arrives at the screen's first entrance. Coming back (endAwayTeam, awayteam.cpp:144-170) is Task 9's.
 */
export function beamDown(world: World, team: string[], kit: string[], screen: string, beamWorld: number, effect: boolean): void {
  const ship = world.content.ship;
  if (!ship) throw new Error('this game has no ship');
  const state = world.state;
  // (startAwayTeam: the time the team left, awayteam.cpp:345)
  if (state.onShip !== null) state.ship.awaySince = world.clock.now;
  // (world 8 is world 5, later: awayteam.cpp:112-113. The lifter already gives world 8's beams world 5's screen.)
  const number = beamWorld === 8 ? 5 : beamWorld;

  // the leader is the first of the leader order who is on the team (awayteam.cpp:117-125)
  const leader = ship.data.crew.leaderOrder.find(id => team.includes(id)) ?? team[0];
  state.awayTeam = [...team];
  state.currentActor = leader;
  // (_mode = mode_Walk; _phaser_index = 0)
  state.phaserSetting = 0;

  // the kit is the inventory; whatever isn't in it stays on the ship (awayteam.cpp:131-138)
  const roles = world.content.rules.items;
  for (const id of [...(state.ship.equipment ?? []), ...ship.data.equipment, ...(roles.phaser ? [roles.phaser] : [])]) {
    const o = state.objects[id];
    if (o) o.inventory = false;
  }
  for (const id of kit) {
    const o = world.obj(id);
    o.screen = null;
    o.inventory = true;
    o.active = true;
  }
  state.ship.equipment = (state.ship.equipment ?? []).filter(id => !kit.includes(id));

  // (the ship's clock isn't stopped here: the original stops it only for a non-clock station and when it loads an away save,
  // restoreAwayTeam, save.cpp:476; a journey under way keeps its time, and arrives as soon as the team is back aboard)
  if (!world.content.screens[screen]?.markers.entrance_0) throw new Error(`beamDown: ${screen} has no entrance_0`);
  state.pendingScreen = { to: screen, entrance: 'entrance_0' };
  // (inside an action the outermost one applies it, as for any screen change)
  if (world.actionDepth === 0) world.applyScreenChange();
  world.bus.emit({ type: 'beamedDown', world: number, effect });
}
