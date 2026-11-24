// SPDX-License-Identifier: GPL-3.0-or-later
import type { TransporterRoom } from '../sim/transporter';
import type { Rect } from '../view/art';
import { advanceLock, lockRects, type MapLock, startLock } from '../view/transporterMap';
import { DOOR_NEAR, MAX_STEP_MS, newWalker, type PadSpot, started, stepWalker, walkerAt, walkPath, type Waypoint, type Walker, WALK_DELAY_MS } from '../view/transporterWalk';

/** What the session lends the transporter room's screen. */
export interface DirectorHost {
  /** `_transporterTargets`: where each world's target is on the map. */
  targets(): { x: number; y: number }[];
  /** A ship sound by name (presentation.yaml's `shipSounds`). */
  sound(name: string): void;
  /** Tells the panels something changed. */
  bump(): void;
  /** How long each frame of the lock's blip shows. */
  blipMs(): number;
  /** The crew's walk in and out (`_transporterWalkOn`, `_transporterWalkOff`) and where each pad is; null where the lifted game has none (an older ship.yaml). */
  walk(): { on: Waypoint[]; off: Waypoint[]; pads: PadSpot[] } | null;
  /** Whether this crew member is seen walking: the room is drawn from a plate and they have a card. Without, they are on their pad at once. */
  walks(crew: string): boolean;
  /** A crew member who has walked off is back in the crew list (`removeFromPad`). */
  removePad(pad: number): void;
}

/** What the room draws of a crew member who is walking: where their feet are, how big, the animation, and whether they have set off yet. */
export interface WalkPose { at: [number, number]; scale: number; anim: number; visible: boolean }

/** What the panel draws of the map: its picture's world, and the scan's lines and blip, in the original's 640x480 pixels. */
export interface TransporterMapView {
  /** `_showMap`: the map is up (the lists are not). */
  showing: boolean;
  /** `_hasTarget`: there is a place to beam to. */
  hasTarget: boolean;
  /** The picture to show: the target's world, or 0 (the one that says there are no locations) with none. */
  world: number;
  /** The scan has found the target (`_lockStage == 2`). */
  locked: boolean;
  /** The two scan lines and the blip. */
  across: Rect;
  down: Rect | null;
  blip: Rect | null;
  /** The blip's frame (it loops, a frame every `blipMs`). */
  blipTime: number;
}

/** One visit to the room: what its map is doing. */
interface RoomState {
  showing: boolean;
  lock: MapLock;
  /** The map was shown at the start and has not yet played its sound (showMap plays them as it starts). */
  fresh: boolean;
  blipTime: number;
  /** The room's own milliseconds: what the walkers' times are on. */
  time: number;
  walkers: Walker[];
  /** Who was on each pad when it was last looked at: a new face is someone walking on. */
  known: (string | null)[];
  /** How long after the last walker sets off the next does: the recommended team walk one at a time, a crew member chosen by hand at once. */
  delay: number;
  doorOpen: boolean;
}

/**
 * The transporter room's own going-on, which the sim leaves out because it is only what the screen does over time (transporter.cpp `update`): the map,
 * with its scan and the lock-on. It holds a room's `hold` while the original would not energize.
 */
export class TransporterDirector {
  private readonly rooms = new WeakMap<TransporterRoom, RoomState>();

  constructor(private readonly host: DirectorHost) {}

  /** TransporterScreen::start's showMap(true): each visit opens on the map, scanning. */
  private state(room: TransporterRoom): RoomState {
    let s = this.rooms.get(room);
    if (!s) {
      // (the team the easier levels choose at the start walks in one at a time)
      s = { showing: true, lock: startLock(), fresh: true, blipTime: 0, time: 0, walkers: [], known: room.pads.map(() => null), delay: WALK_DELAY_MS, doorOpen: false };
      this.rooms.set(room, s);
    }
    return s;
  }

  /** The target the scan heads for: the world's, or the first entry's when there is none (`_target`, transporter.cpp:168). */
  private scan(room: TransporterRoom): { x: number; y: number } {
    const targets = this.host.targets();
    return targets[room.target !== null ? room.world : 0] ?? { x: 418, y: 415 };
  }

  private begin(room: TransporterRoom): void {
    // (the scan sound; with no target, the computer says so)
    this.host.sound('transporterScan');
    if (room.target === null) this.host.sound('transporterNoTarget');
  }

  /** The Map and Lists buttons: Map restarts the scan (only from the lists), Lists puts it away. */
  showMap(room: TransporterRoom, show: boolean): void {
    const s = this.state(room);
    if (show === s.showing) return;
    s.showing = show;
    s.fresh = false;
    if (show) {
      s.lock = startLock();
      s.blipTime = 0;
      this.begin(room);
    }
    room.hold = this.holds(room, s);
    this.host.bump();
  }

  private holds(room: TransporterRoom, s: RoomState): boolean {
    return (s.showing && s.lock.stage !== 2 && room.target !== null) || s.walkers.length > 0;
  }

  /** Recommended: the team's set off one after another (chooseRecommended walks them on with kWalkDelay). */
  recommended(room: TransporterRoom): void {
    this.state(room).delay = WALK_DELAY_MS;
  }

  private openDoor(s: RoomState): void {
    if (s.doorOpen) return;
    s.doorOpen = true;
    this.host.sound('doorOpen');
  }

  /** `walk`: from the door to the pad, or back, one at a time when `delay` says (the others' start times plus it). */
  private startWalk(s: RoomState, pad: number, leaving: boolean, delay: number): boolean {
    const data = this.host.walk();
    const spot = data?.pads[pad];
    if (!data || !spot || data.on.length < 6 || data.off.length < 4) return false;
    let start = s.time;
    for (const w of s.walkers) start = Math.max(start, w.start + delay);
    s.walkers.push(newWalker(pad, leaving, walkPath(data.on, data.off, pad, spot, leaving), start));
    this.openDoor(s);
    return true;
  }

  /** A crew member who is on a pad now and was not: they walk in (`addToPad`). */
  private sync(room: TransporterRoom, s: RoomState): void {
    for (let pad = 0; pad < room.pads.length; pad++) {
      const crew = room.pads[pad] ?? null;
      if (crew !== null && s.known[pad] !== crew && this.host.walks(crew)) this.startWalk(s, pad, false, s.delay);
      if (crew === null) s.walkers = s.walkers.filter(w => w.pad !== pad);
    }
    s.known = room.pads.map(p => p ?? null);
    s.delay = 0;
  }

  /** Whether someone is walking onto or off this pad (`isWalking`: it cannot be clicked then). */
  walking(room: TransporterRoom, pad: number): boolean {
    return this.state(room).walkers.some(w => w.pad === pad);
  }

  /** Whether the one walking on this pad is walking off it. */
  leaving(room: TransporterRoom, pad: number): boolean {
    return this.state(room).walkers.some(w => w.pad === pad && w.leaving);
  }

  /**
   * A double click on a pad sends them back out (transporter.cpp:735-741): they walk off, and are back in the crew list when they have gone. Returns whether
   * they walk (else the caller takes them off at once); a pad someone is walking on is left alone.
   */
  dismiss(room: TransporterRoom, pad: number): boolean {
    const s = this.state(room);
    if (s.walkers.some(w => w.pad === pad)) return true;
    const crew = room.pads[pad];
    if (!crew || !this.host.walks(crew)) return false;
    if (!this.startWalk(s, pad, true, 0)) return false;
    room.hold = this.holds(room, s);
    this.host.bump();
    return true;
  }

  /** The walkers' poses by pad, for drawing their cards: the position, size and animation, hidden until they set off. */
  poses(room: TransporterRoom): Map<number, WalkPose> {
    const s = this.state(room);
    return new Map(s.walkers.map(w => [w.pad, { at: walkerAt(w), scale: w.scale, anim: w.anim, visible: started(w, s.time) }]));
  }

  /** `updateWalkers`: everyone on their way a step further, the door closing when nobody is near it, and arrivals standing on their pads. */
  private walkers(room: TransporterRoom, s: RoomState, ms: number): void {
    let left = ms;
    // (a long frame is several of the original's: none counts more than a tenth of a second)
    while (left > 0) {
      const step = Math.min(left, MAX_STEP_MS);
      left -= step;
      s.time += step;
      let near = false;
      for (const w of [...s.walkers]) {
        if (!stepWalker(w, s.time)) {
          if (started(w, s.time) && walkerAt(w)[0] < DOOR_NEAR) near = true;
          continue;
        }
        s.walkers.splice(s.walkers.indexOf(w), 1);
        if (w.leaving) {
          this.host.removePad(w.pad);
          s.known[w.pad] = null;
        }
        // (an arrival is on the pad at its own size, standing: the room draws a card that is not walking so)
      }
      if (!near && s.doorOpen) {
        s.doorOpen = false;
        this.host.sound('doorClose');
      }
    }
  }

  /** `ms` of the room's time pass: the scan steps, the blip turns. */
  update(room: TransporterRoom | null, ms: number): void {
    if (room === null) return;
    const s = this.state(room);
    if (s.fresh) {
      s.fresh = false;
      if (s.showing) this.begin(room);
      room.hold = this.holds(room, s);
      this.host.bump();
    }
    const walkersBefore = s.walkers.length;
    this.sync(room, s);
    if (s.walkers.length > 0 || s.doorOpen) this.walkers(room, s, ms);
    room.hold = this.holds(room, s);
    if (s.walkers.length !== walkersBefore) this.host.bump();
    if (!s.showing || ms <= 0) return;
    const before = `${s.lock.stage} ${s.lock.x} ${s.lock.y}`;
    const locked = advanceLock(s.lock, ms, this.scan(room), room.target !== null);
    if (locked) {
      this.host.sound('transporterLocked');
      s.blipTime = 0;
    } else if (s.lock.stage === 2) {
      const frame = Math.floor(s.blipTime / this.host.blipMs());
      s.blipTime += ms;
      if (Math.floor(s.blipTime / this.host.blipMs()) !== frame) this.host.bump();
    }
    room.hold = this.holds(room, s);
    if (locked || before !== `${s.lock.stage} ${s.lock.x} ${s.lock.y}`) this.host.bump();
  }

  view(room: TransporterRoom): TransporterMapView {
    const s = this.state(room);
    const scan = this.scan(room);
    const rects = lockRects(s.lock, scan);
    return {
      showing: s.showing,
      hasTarget: room.target !== null,
      world: room.target !== null ? room.world : 0,
      locked: s.lock.stage === 2,
      ...rects,
      blipTime: s.blipTime,
    };
  }
}
