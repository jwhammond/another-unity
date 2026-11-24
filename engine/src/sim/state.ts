// SPDX-License-Identifier: GPL-3.0-or-later
import type { AdviceSetting, ConversationDef, GameContent, ResponseState, StartupActionDef, Vec2 } from '../content/types';
import { normalizeSeed } from './rng';
import { newComputerState } from './computer';
import { newShipState, type ShipState, type Vec3i } from './ship';

export const STATE_VERSION = 4;

export interface ObjectState {
  screen: string | null;
  pos: Vec2;
  state: number;
  active: boolean;
  inventory: boolean;
  /** The original's OBJFLAG_STUNNED, which alter sets. Being down is phaser health: see World.isIncapacitated. */
  stunned: boolean;
  name: string;
  /** Seconds between timer actions; 0 means none. */
  timer: number;
  /** The tick the next timer action is due; 0 means not running. */
  timerDue: number;
  /** What talking to it does; alter can change it. */
  talk: string;
  talkVoice: string | null;
  /** Where it is in space (the ship world's objects); the Enterprise's follows the ship. */
  universe?: Vec3i;
  /**
   * The sprite animation an alter last set (the original's anim_index): a play sets it, a stop makes it -1. Absent until one has, when the picture
   * of the object shows the animation it starts on. The picture follows it, and the Enterprise's is the sprite the viewscreen shows (unity.cpp:604-610;
   * a journey's start clears it, astrogation.cpp:525-532); nothing in the rules reads it.
   */
  anim?: number;
}

export interface TriggerState {
  enabled: boolean;
  due: number;
}

export interface PhaserState {
  health: number;
  /** Set once the stun list has run, until the object gets up again. */
  stunned: boolean;
  /** The tick it last went down or regained a point of health. */
  regenAt: number;
  /** phaser_data->destroyed: a ship's kill list has run (damage.cpp:718-732). */
  destroyed: boolean;
}

export interface StartupState {
  advice: AdviceSetting;
  closeup: boolean;
  /** null leaves the flag as it is. */
  combadge: boolean | null;
  inputBlocked: boolean | null;
  action: StartupActionDef | null;
}

/** A hail for the starship modes (CommunicateBlock); `type` is the original's hail type. */
export interface PendingHail {
  from: string | null;
  /** Null on a battle hail, which has a scenario instead. */
  conversation: string | null;
  situation: number;
  type: number;
  /** A battle hail's scenario (types 0xa, 0xb, 0x10, 0x11: unity.cpp:676-690). */
  scenario?: number;
}

export interface PendingScreen {
  /** A screen, or $ship. */
  to: string;
  /** A marker on `to`; '' for the ship. */
  entrance: string;
  stepIn?: boolean;
  stay?: boolean;
  gameOver?: number;
}

export interface WorldState {
  version: number;
  tick: number;
  rngSeed: number;
  screen: string;
  awayTeam: string[];
  currentActor: string;
  objects: Record<string, ObjectState>;
  regions: Record<string, Record<string, boolean>>;
  triggers: Record<string, TriggerState>;
  /** Condition counters by rule path, holding the original's uint16 values. */
  counters: Record<string, number>;
  pendingScreen: PendingScreen | null;
  /** For the objects with phaser data. */
  phaser: Record<string, PhaserState>;
  /** 0 off, 1 low, 2 medium, 3 high. */
  phaserSetting: number;
  /** Each conversation's response states, in file order. */
  conversations: Record<string, ResponseState[]>;
  /** Each conversation's "situation.key" list, so a save from other conversation files is refused. */
  conversationShapes: Record<string, string>;
  /** `every` is in seconds; `due` is a tick. */
  advice: { id: string | null; every: number; due: number };
  awayFlags: { inputBlocked: boolean; combadge: boolean };
  /** Each screen's startup, as scripts have changed it. */
  startups: Record<string, StartupState>;
  onCloseup: boolean;
  pendingHail: PendingHail | null;
  /** Where the transporter sends the next away team (BeamBlock). */
  beamTarget: string | null;
  /** Tricorder readings, by world and group, in the order recorded. */
  readings: { world: string; group: number }[];
  /** The ship's computer: the entries hidden (ascending) and the readings recorded (newest first). */
  computer: { hidden: number[]; readings: number[] };
  /** transporter.cpp:572-582: written, never read (R5). */
  adviceMode: number;
  /** Up to 10 outermost conversations, newest first (R7). */
  conversationLog: { speaker: string | null; text: string }[][];
  /** BeamBlock's world when it isn't the target screen's (world 8). */
  beamWorld: number | null;
  /**
   * The objects whose sprite the original has loaded: the crew, whatever is listed on a screen entered, and whatever
   * a reaction brought. A reaction on one that isn't loaded brings it to the screen (ReactionBlock::execute).
   */
  spritesLoaded: string[];
  /** Set once the team has gone back to the ship. */
  onShip: { gameOver: number | null } | null;
  /** The starship: where it is, its station, and its journey. */
  ship: ShipState;
}

/** The (situation, key) pairs of a conversation's responses, in file order. */
export function conversationShape(conv: ConversationDef): string {
  return conv.responses.map(r => `${r.situation}.${r.key}`).join(' ');
}

/**
 * The marker for entrance slot `i % 4`: the entrance itself, then `<entrance>.1` to `.3` where the screen has
 * them (placeAwayTeam, awayteam.cpp:375-378; the lifter names them so).
 */
export function entranceSlotName(markers: Record<string, Vec2>, entrance: string, i: number): string {
  const slot = i % 4;
  const name = `${entrance}.${slot}`;
  return slot !== 0 && Object.hasOwn(markers, name) ? name : entrance;
}

/**
 * A new game. `onShip` starts on the bridge with no away team, as the original's new game does; without it the
 * away start is kept (dev walks, `?start=`, mission select).
 */
export function createInitialState(c: GameContent, seed?: number, opts: { onShip?: boolean } = {}): WorldState {
  const onShip = opts.onShip === true;
  const ship = newShipState(c);
  const marker = (screen: string, name: string): Vec2 => ({ ...c.screens[screen].markers[name] });

  const objects: Record<string, ObjectState> = {};
  const phaser: Record<string, PhaserState> = {};
  for (const d of Object.values(c.objects)) {
    const inventory = d.inventory ?? false;
    const screen = inventory ? null : d.screen;
    objects[d.id] = {
      screen,
      pos: d.at && screen ? marker(screen, d.at) : { ...(d.pos ?? { x: 0, z: 0 }) },
      state: d.state ?? 0,
      active: d.active ?? true,
      inventory,
      stunned: false,
      name: d.name,
      timer: d.timer ?? 0,
      timerDue: 0,
      talk: d.talk ?? '',
      talkVoice: d.talkVoice ?? null,
      ...(d.universe ? { universe: { ...d.universe } } : {}),
    };
    if (d.phaser) phaser[d.id] = { health: d.phaser.health, stunned: false, regenAt: 0, destroyed: false };
  }

  // the team arrives in crew content order, each on their entrance slot (startAwayTeam, awayteam.cpp:285-310)
  const markers = c.screens[c.start.screen].markers;
  const arriving = Object.keys(c.objects).filter(id => c.start.awayTeam.includes(id));
  if (!onShip) arriving.forEach((id, i) => {
    objects[id].screen = c.start.screen;
    objects[id].pos = marker(c.start.screen, entranceSlotName(markers, c.start.entrance, i));
  });

  const startups: Record<string, StartupState> = {};
  for (const s of Object.values(c.screens)) {
    const st = s.startup ?? {};
    startups[s.id] = {
      advice: { ...(st.advice ?? {}) },
      closeup: st.closeup ?? false,
      combadge: st.combadge ?? null,
      inputBlocked: st.inputBlocked ?? null,
      action: st.action ? { ...st.action } : null,
    };
  }

  // (the Enterprise sits where the ship is: updateEnterprise)
  const ent = c.ship ? objects[c.ship.data.astro.enterprise] : undefined;
  if (ent) ent.universe = { ...ship.pos };

  return {
    version: STATE_VERSION,
    tick: 0,
    rngSeed: normalizeSeed(seed ?? c.start.seed ?? 1),
    screen: c.start.screen,
    awayTeam: onShip ? [] : [...c.start.awayTeam],
    currentActor: c.start.awayTeam[0],
    objects,
    regions: Object.fromEntries(Object.values(c.screens).map(s => [s.id, { ...(s.regions ?? {}) }])),
    triggers: Object.fromEntries(c.triggers.map(t => [t.id, { enabled: t.enabled, due: 0 }])),
    counters: {},
    pendingScreen: null,
    phaser,
    phaserSetting: 0,
    conversations: Object.fromEntries(Object.values(c.conversations).map(conv => [conv.id, conv.responses.map(r => r.state)])),
    conversationShapes: Object.fromEntries(Object.values(c.conversations).map(conv => [conv.id, conversationShape(conv)])),
    advice: { id: null, every: 0, due: 0 },
    // a new engine's flags (unity.cpp:104-105): the combadge is on until a startup or script turns it off
    awayFlags: { inputBlocked: false, combadge: true },
    startups,
    onCloseup: false,
    pendingHail: null,
    beamTarget: null,
    readings: [],
    computer: newComputerState(c),
    adviceMode: 0,
    conversationLog: [],
    beamWorld: null,
    spritesLoaded: Object.values(c.objects).filter(d => d.crew || (!onShip && d.screen === c.start.screen)).map(d => d.id),
    onShip: onShip ? { gameOver: null } : null,
    ship,
  };
}
