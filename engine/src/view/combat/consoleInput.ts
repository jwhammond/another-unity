// SPDX-License-Identifier: GPL-3.0-or-later
import { VIEW } from '../../sim/combat/battle';
import { CONSOLE_PAGES, type CombatCommand, type ConsolePage, type Held } from '../../sim/combat/commands';
import { FLIGHT } from '../../sim/combat/flight';
import type { BattleState } from '../../sim/combat/types';
import type { IndexedImage } from '../indexed';
import {
  BUTTON, BUTTONS, buttonShown, contains, DOWN_ARROW, ENGAGE_BUTTON, MANEUVER_ROWS, maneuverRow, NUM_BUTTONS, NUM_PAGES, PAGE, PHASER_SLIDER_X,
  phaserSliderY, powerCell, SALVO_X, SALVO_Y, SLIDER_WIDTH, tabRect, UP_ARROW, type ConsoleUi,
} from './console';
import { blipAt, type RadarBlip } from './radar';

/**
 * The console's input as TacticalScreen takes it (tactical.cpp:503-816): what a click, a drag and a key do, in the original's
 * pixels, and the button's delay. Pure: the console turns pointer and key events into these and gives the battle their commands
 * (battleCommand: every one an order, dropped while the warp overlay shows; Plan 27 R9).
 */

/** kButtonDelay (tactical.cpp:209): a pressed button stays down 0x91 ticks, 498 ms of the wall clock, before Bridge and Engineering act. */
export const BUTTON_DELAY = Math.trunc((0x91 * 1000) / 291);
/** kKeyRepeatDelay (tactical.cpp:210): a held fire, wide or zoom key acts again only a second on. */
export const KEY_REPEAT_DELAY = 1000;

/** buttonAt (tactical.cpp:585-601): the button shown at (x, y), by its up picture's size, or -1. */
export function buttonAt(x: number, y: number, page: number, wide: boolean, images: readonly IndexedImage[]): number {
  for (let i = 0; i < NUM_BUTTONS; i++) {
    if (!buttonShown(i, page, wide)) continue;
    const b = BUTTONS[i]!;
    const im = images[b.up];
    if (!im) continue;
    if (contains([b.x, b.y, b.x + im.width, b.y + im.height], x, y)) return i;
  }
  return -1;
}

/** sliderAt (tactical.cpp:603-616): a phaser bank's slider (0-5) on its page, a tube's salvo (6, 7) on the torpedoes', or -1. */
export function sliderAt(x: number, y: number, page: number): number {
  if (page === PAGE.phasers) {
    for (let i = 0; i < 6; i++) if (contains([PHASER_SLIDER_X, phaserSliderY(i), PHASER_SLIDER_X + 122, phaserSliderY(i) + 20], x, y)) return i;
  } else if (page === PAGE.torpedoes) {
    for (let i = 0; i < 2; i++) if (contains([SALVO_X, SALVO_Y[i]!, SALVO_X + 122, SALVO_Y[i]! + 24], x, y)) return 6 + i;
  }
  return -1;
}

/**
 * dragSlider (tactical.cpp:618-632): the slider's value at x, as its command. A bank's is 0 to 100 along 113 pixels; a salvo's
 * 1 within three pixels of its start, else tenths of the 113, at most 10. A bank the Enterprise lacks takes nothing (the
 * command's own check, as dragSlider's).
 */
export function dragCommand(slider: number, x: number): CombatCommand | null {
  if (slider < 0) return null;
  if (slider < 6) {
    const value = x <= PHASER_SLIDER_X ? 0 : x >= PHASER_SLIDER_X + SLIDER_WIDTH ? 100 : Math.trunc(((x - PHASER_SLIDER_X) * 100) / SLIDER_WIDTH);
    return { type: 'bank', bank: slider, setting: value };
  }
  const value = x <= SALVO_X ? 0 : x <= SALVO_X + 3 ? 1 : Math.trunc(((x - SALVO_X) * 10) / SLIDER_WIDTH);
  return { type: 'salvo', tube: slider === 6 ? 0 : 1, setting: Math.min(value, 10) };
}

/** What a click on the console is (mouseClick, tactical.cpp:646-700), in its order. */
export type ConsoleClick =
  | { kind: 'page'; page: ConsolePage }
  | { kind: 'command'; command: CombatCommand; arrow?: 0 | 1; beep: boolean }
  | { kind: 'button'; button: number }
  | null;

/**
 * mouseClick (tactical.cpp:646-700), after a drag's release (the console's own): nothing while a button is down; a tab; on
 * CONN a power cell; on TACTICS a maneuver row, an arrow (which shows pressed for the button delay, and beeps) or Engage (which
 * beeps); then a button; then a ship on the radar. The warp overlay's return is the console's: it takes no input while that shows.
 */
export function consoleClick(x: number, y: number, s: { page: number; wide: boolean; pressed: number; blips: readonly RadarBlip[]; images: readonly IndexedImage[] }): ConsoleClick {
  if (s.pressed !== -1) return null;
  for (let page = 0; page < NUM_PAGES; page++) if (contains(tabRect(page), x, y)) return { kind: 'page', page: CONSOLE_PAGES[page]! };
  if (s.page === PAGE.conn) {
    for (let level = 0; level < 5; level++) if (contains(powerCell(level), x, y)) return { kind: 'command', command: { type: 'powerLevel', level }, beep: false };
  } else if (s.page === PAGE.tactics) {
    for (let row = 0; row < MANEUVER_ROWS; row++) if (contains(maneuverRow(row), x, y)) return { kind: 'command', command: { type: 'maneuver', row }, beep: false };
    const up = contains(UP_ARROW, x, y);
    if (up || contains(DOWN_ARROW, x, y)) return { kind: 'command', command: { type: 'scrollManeuvers', direction: up ? -1 : 1 }, arrow: up ? 0 : 1, beep: true };
    if (contains(ENGAGE_BUTTON, x, y)) return { kind: 'command', command: { type: 'engage' }, beep: true };
  }
  const button = buttonAt(x, y, s.page, s.wide, s.images);
  if (button !== -1) return { kind: 'button', button };
  const ship = blipAt(s.blips, x, y);
  return ship === null ? null : { kind: 'command', command: { type: 'target', ship }, beep: false };
}

/** The console's four switches, each on or off: what pressButton and the wide key turn the other way. */
export interface Switches { shieldsRaised: boolean; weaponsLock: boolean; delegate: boolean; wide: boolean }

/**
 * The switches as the orders waiting for the next frame will leave them (Plan 29 R3): the battle's own, then each queued order
 * that sets one, the last last. ScummVM applies a click at once, so its second click reads the first's; the port's orders wait
 * for the next frame (a whole pause, Plan 23's), so a toggle reads through them, and two clicks while paused turn a switch on and
 * off again as two clicks in the original do. Only the orders that set a switch count: what another order does to it in the sim
 * (Delegate's weapons lock, ai.cpp's setDelegate) shows once that order is applied.
 */
export function pendingSwitches(b: Readonly<BattleState>, queued: readonly CombatCommand[] = []): Switches {
  const s: Switches = { shieldsRaised: b.console.shieldsRaised, weaponsLock: b.console.weaponsLock, delegate: b.console.delegate, wide: b.view.wide };
  for (const cmd of queued) {
    if (cmd.type === 'shields') s.shieldsRaised = cmd.on;
    else if (cmd.type === 'weaponsLock') s.weaponsLock = cmd.on;
    else if (cmd.type === 'delegate') s.delegate = cmd.on;
    else if (cmd.type === 'wide') s.wide = cmd.on;
  }
  return s;
}

/**
 * pressButton (tactical.cpp:523-574): the button goes down for the delay, beeps, and most act at once; Bridge and Engineering
 * act when the delay is up (buttonAction). Sets `ui`'s pressed button and its time; returns the commands it gives now. A
 * toggle turns its switch the other way from where the orders waiting will leave it (`queued`, pendingSwitches).
 */
export function pressButton(ui: ConsoleUi, button: number, b: Readonly<BattleState>, queued: readonly CombatCommand[] = []): CombatCommand[] {
  ui.pressed = button;
  ui.buttonTime = ui.wall + BUTTON_DELAY;
  const c = pendingSwitches(b, queued);
  switch (button) {
    case BUTTON.view: return [{ type: 'cycleView' }];
    case BUTTON.full: return [{ type: 'wide', on: !c.wide }];
    case BUTTON.zoomIn: return [{ type: 'zoom', direction: 'in' }];
    case BUTTON.zoomOut: return [{ type: 'zoom', direction: 'out' }];
    case BUTTON.delegate: return [{ type: 'delegate', on: !c.delegate }];
    case BUTTON.phasers: return [{ type: 'fire', weapon: 'phasers' }];
    case BUTTON.torpedoes: return [{ type: 'fire', weapon: 'torpedoes' }];
    case BUTTON.both: return [{ type: 'fire', weapon: 'both' }];
    case BUTTON.shields: return [{ type: 'shields', on: !c.shieldsRaised }];
    case BUTTON.weaponsLock: return [{ type: 'weaponsLock', on: !c.weaponsLock }];
    case BUTTON.selfDestruct: return [{ type: 'selfDestruct' }];
    case BUTTON.allPhasers: return [{ type: 'banks', all: true }];
    case BUTTON.noPhasers: return [{ type: 'banks', all: false }];
    default: return button >= BUTTON.spread && button < BUTTON.spread + 10 ? [{ type: 'spread', cell: button - BUTTON.spread }] : [];
  }
}

/** An arrow pressed (mouseClick, tactical.cpp:676-678): it shows down for the button delay; no button goes down. */
export function pressArrow(ui: ConsoleUi, arrow: 0 | 1): void {
  ui.arrow = arrow;
  ui.buttonTime = ui.wall + BUTTON_DELAY;
}

/**
 * update's button (tactical.cpp:495-499) and buttonAction (:503-521): once the delay is up the button comes up, and Bridge or
 * Engineering acts (Bridge is the hail at red alert, the seam's). Returns its command, or null.
 */
export function buttonDue(ui: ConsoleUi): CombatCommand | null {
  if (ui.pressed === -1 || ui.wall < ui.buttonTime) return null;
  const button = ui.pressed;
  ui.pressed = -1;
  if (button === BUTTON.bridge) return { type: 'bridge' };
  if (button === BUTTON.engineering) return { type: 'engineering' };
  return null;
}

/**
 * The tactical screen's key actions (metaengine.cpp:113-140, kCombatActions; actionStart and actionEnd, tactical.cpp:731-816,
 * 862-866), by name: Plan 29 binds keys and pads to them. The flight keys are held; the rest act on each press and on the
 * key's repeats (the keymap's allowKbdRepeats), fire, wide and zoom no more than once a second (KEY_REPEAT_DELAY).
 */
// (kActionOptions, metaengine.cpp:141, is left out: actionStart only opens ScummVM's own menu for it, tactical.cpp:743-747, as
// the original's options, the detail and the keys, are ScummVM's; the port's are its own settings)
export const TACTICAL_ACTIONS = [
  'pitchDown', 'pitchUp', 'rollLeft', 'rollRight', 'yawLeft', 'yawRight', 'accelerate', 'decelerate', 'orbitLeft', 'orbitRight',
  'stop', 'phasers', 'torpedoes', 'toggleView', 'cycleCamera', 'nextTarget', 'previousTarget', 'zoomIn', 'zoomOut',
  'view1', 'view2', 'view3', 'view4', 'view5', 'view6', 'view7', 'view8',
] as const;
export type TacticalAction = (typeof TACTICAL_ACTIONS)[number];

/** flightAction (tactical.cpp:704-729): the held bit of a flight key, or -1. */
const FLIGHT_BITS: Partial<Record<TacticalAction, number>> = {
  pitchDown: FLIGHT.pitchDown, pitchUp: FLIGHT.pitchUp, rollLeft: FLIGHT.rollLeft, rollRight: FLIGHT.rollRight, yawLeft: FLIGHT.yawLeft,
  yawRight: FLIGHT.yawRight, accelerate: FLIGHT.accelerate, decelerate: FLIGHT.decelerate, orbitLeft: FLIGHT.orbitLeft, orbitRight: FLIGHT.orbitRight,
};
/** kActionCameraView1-8 (tactical.cpp:789-813): the view, and whose (view 3 the target's). */
const CAMERA_VIEWS: readonly [number, 'enterprise' | 'target'][] = [
  [VIEW.target, 'enterprise'], [VIEW.chase, 'enterprise'], [VIEW.target, 'target'], [VIEW.forward, 'enterprise'],
  [VIEW.chaseClose, 'enterprise'], [VIEW.overview, 'enterprise'], [VIEW.drop, 'enterprise'], [VIEW.spinRoll, 'enterprise'],
];

/** What a drag or a pad holds (Plan 29 R7, R8): a direction for each of steer's axes, and the orbit's. */
export interface Axes { yaw: Held; pitch: Held; roll: Held; throttle: Held; orbit: Held }
/** Nothing held. */
export const NO_AXES: Readonly<Axes> = Object.freeze({ yaw: 0, pitch: 0, roll: 0, throttle: 0, orbit: 0 });

/** The steer and orbit commands with nothing held, as TacticalKeys remembers what it gave (releaseKeys' setHeld(0), tactical.cpp:858-859). */
const LET_GO = {
  steer: JSON.stringify({ type: 'steer', yaw: 0, pitch: 0, roll: 0, throttle: 0 }),
  orbit: JSON.stringify({ type: 'orbit', direction: 0 }),
} as const;

/** How an action is given: whether the warp overlay is up (actionStart's `_showingWarp` return), and the orders waiting (pendingSwitches). */
export interface ActionContext { warp?: boolean; queued?: readonly CombatCommand[] }

/**
 * TacticalScreen's _held and the four keys' last times (_lastPhaser, _lastTorpedo, _lastWideToggle, _lastZoom: 0 at first,
 * tactical.cpp:246-248), by the wall clock. `start` and `end` return the commands an action gives. The port's steer command
 * holds one direction an axis: a pair held both ways is the later pressed (ScummVM's ramps cancel, holding the value; Plan 27 R9).
 * Beside the keys, a drag on the view and a pad's sticks hold axes too (`hold`, the port's: Plan 29 R7, R8): on each axis a key
 * held wins, then the drag, then the pad.
 */
export class TacticalKeys {
  private held = 0;
  /** The flight keys pressed, the latest last: for a pair held both ways. */
  private order: number[] = [];
  private last = { phasers: 0, torpedoes: 0, wide: 0, zoom: 0 };
  private sources: Record<'drag' | 'pad', Axes> = { drag: { ...NO_AXES }, pad: { ...NO_AXES } };
  /** The steer and orbit commands last given (nothing held at first, and after a release), so a drag or a pad gives one only when what is held changes. */
  private sent = { ...LET_GO };

  /**
   * actionStart (tactical.cpp:731-816) at `wall` ms, for the battle `b` as it is (whether it is wide, read through the orders
   * waiting). Nothing while the warp overlay shows, not even the key's time: actionStart returns first (tactical.cpp:732-733).
   */
  start(action: TacticalAction, wall: number, b: Readonly<BattleState>, o: ActionContext = {}): CombatCommand[] {
    if (o.warp) return [];
    const flight = FLIGHT_BITS[action];
    if (flight !== undefined) {
      this.held |= 1 << flight;
      this.order = [...this.order.filter(f => f !== flight), flight];
      return [this.command(flight)];
    }
    // (uint32 now - _last: a repeat inside the delay does nothing)
    const due = (key: 'phasers' | 'torpedoes' | 'wide' | 'zoom') => {
      if (((wall - this.last[key]) >>> 0) < KEY_REPEAT_DELAY) return false;
      this.last[key] = wall;
      return true;
    };
    switch (action) {
      case 'stop': return [{ type: 'allStop' }];
      case 'phasers': return due('phasers') ? [{ type: 'fire', weapon: 'phasers' }] : [];
      case 'torpedoes': return due('torpedoes') ? [{ type: 'fire', weapon: 'torpedoes' }] : [];
      case 'toggleView': return due('wide') ? [{ type: 'wide', on: !pendingSwitches(b, o.queued).wide }] : [];
      case 'cycleCamera': return [{ type: 'cycleView' }];
      case 'nextTarget': return [{ type: 'target', which: 'next' }];
      case 'previousTarget': return [{ type: 'target', which: 'prev' }];
      case 'zoomIn': return due('zoom') ? [{ type: 'zoom', direction: 'in' }] : [];
      case 'zoomOut': return due('zoom') ? [{ type: 'zoom', direction: 'out' }] : [];
      default: {
        const view = CAMERA_VIEWS[Number(action.slice(4)) - 1];
        return view ? [{ type: 'view', view: view[0], ship: view[1] }] : [];
      }
    }
  }

  /**
   * Fire both (Space, M8 spec Decision 18; the port's): the phaser key and the torpedo key at once, each under its own repeat
   * delay, so `fire both` when both are due and the one that is otherwise. Nothing under the warp overlay.
   */
  fireBoth(wall: number, b: Readonly<BattleState>, o: ActionContext = {}): CombatCommand[] {
    const [p] = this.start('phasers', wall, b, o), [t] = this.start('torpedoes', wall, b, o);
    if (p && t) return [{ type: 'fire', weapon: 'both' }];
    return p ? [p] : t ? [t] : [];
  }

  /** actionEnd (tactical.cpp:862-866): a flight key let go. */
  end(action: TacticalAction): CombatCommand[] {
    const flight = FLIGHT_BITS[action];
    if (flight === undefined || !(this.held & (1 << flight))) return [];
    this.held &= ~(1 << flight);
    this.order = this.order.filter(f => f !== flight);
    return [this.command(flight)];
  }

  /**
   * What a drag on the view or a pad's sticks hold now (the port's: Plan 29 R7, R8), under any key held on the same axis. Gives
   * the steer or orbit command only when what is held, keys and all, has changed since the last one given.
   */
  hold(source: 'drag' | 'pad', axes: Readonly<Axes>): CombatCommand[] {
    this.sources[source] = { ...axes };
    const out: CombatCommand[] = [];
    for (const flight of [FLIGHT.yawLeft, FLIGHT.orbitLeft]) {
      const cmd = this.holding(flight);
      if (JSON.stringify(cmd) !== this.sent[cmd.type === 'orbit' ? 'orbit' : 'steer']) out.push(this.command(flight));
    }
    return out;
  }

  /**
   * Every key, the drag and the pad let go at once, with the orders that say so for whatever was held (the page lost the keyboard,
   * so no key will come up: the port's own, Plan 29 R4). `release` alone forgets them and leaves a held steer going in the sim.
   */
  letGo(): CombatCommand[] {
    const out: CombatCommand[] = [];
    if (this.sent.steer !== LET_GO.steer) out.push(JSON.parse(LET_GO.steer) as CombatCommand);
    if (this.sent.orbit !== LET_GO.orbit) out.push(JSON.parse(LET_GO.orbit) as CombatCommand);
    this.release();
    return out;
  }

  /** releaseKeys (tactical.cpp:856-860): every key let go, as showWarp and a return to tactical do; the drag's and the pad's too. */
  release(): void {
    this.held = 0;
    this.order = [];
    this.sources = { drag: { ...NO_AXES }, pad: { ...NO_AXES } };
    this.sent = { ...LET_GO };
  }

  /** The command for what is held now, given and so remembered: the orbit's for an orbit key, else the steer's. */
  private command(flight: number): CombatCommand {
    const cmd = this.holding(flight);
    this.sent[cmd.type === 'orbit' ? 'orbit' : 'steer'] = JSON.stringify(cmd);
    return cmd;
  }

  /** What is held now on the orbit's axis (an orbit key) or on steer's four: on each axis a key held, else the drag's, else the pad's. */
  private holding(flight: number): CombatCommand {
    const way = (less: number, more: number, axis: keyof Axes): Held => {
      const l = (this.held >> less) & 1, m = (this.held >> more) & 1;
      if (l && m) return this.order.lastIndexOf(more) > this.order.lastIndexOf(less) ? 1 : -1;
      if (m || l) return m ? 1 : -1;
      return this.sources.drag[axis] || this.sources.pad[axis];
    };
    if (flight === FLIGHT.orbitLeft || flight === FLIGHT.orbitRight) return { type: 'orbit', direction: way(FLIGHT.orbitLeft, FLIGHT.orbitRight, 'orbit') };
    return {
      type: 'steer', yaw: way(FLIGHT.yawLeft, FLIGHT.yawRight, 'yaw'), pitch: way(FLIGHT.pitchDown, FLIGHT.pitchUp, 'pitch'),
      roll: way(FLIGHT.rollLeft, FLIGHT.rollRight, 'roll'), throttle: way(FLIGHT.decelerate, FLIGHT.accelerate, 'throttle'),
    };
  }
}
