// SPDX-License-Identifier: GPL-3.0-or-later
import {
  AmbientLight,
  BoxGeometry,
  BufferGeometry,
  Color,
  DirectionalLight,
  Float32BufferAttribute,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  Plane,
  Raycaster,
  Scene,
  SphereGeometry,
  Texture,
  Vector2,
  Vector3,
  PerspectiveCamera,
  OrthographicCamera,
  type Camera,
  type Material,
  type WebGLRenderer,
} from 'three';
import type { AnimFx, Vec2 } from '../content/types';
import type { SimEvent } from '../sim/events';
import type { Visual } from '../sim/presenter';
import type { StopSignal } from '../sim/stop';
import { FLAT_DEPTH } from '../content/projection';
import { pixelAt, projectionOf, screenFloor, screenPixels } from '../sim/pixels';
import type { World } from '../sim/world';
import { ACTOR_HEIGHT, ActorView, CardPlayer, FIRE_PHASER, clockDirection } from './actors';
import { animationMillis, layerFrame, upcomingFrames, type LayerStrip } from './layerAnim';
import { FrameRing } from './frameStream';
import { fitQuad, fullyOccluded, maskQuad, moveQuad, rectOutlines, type Occluder } from './masks';
import { textureBytes } from './textureMemory';
import { canvasSurface, defaultLoaders, disposeRoomArt, loadRoomArt, type ArtLoaders, type ArtSource, type CellBitmap, type LayerSurface, type PageData, type RoomArt, type RoomMask } from './art';
import { BeamRun, dissolveTick, setDissolve, type BeamTarget, type SparkleArt } from './beam';
import { PropBeam } from './propBeam';
import { BEAM_MS, BeamView, beamLines, beamStep, muzzleDirection, muzzleStart, MUZZLE_CREW, MUZZLE_DIRECTIONS, type Px } from './phaserFx';
import { phaserBeam } from './fx';
import { NavMesh } from './navmesh';
import { fallbackRoom, fitFlat, loadRoom, SCREEN_H, SCREEN_W, type RoomRegion, type RoomView, type Triangle } from './room';
import type { PresentationClock } from './timeline';
import { HURRY, Walker } from './walker';

/** What a click landed on. */
export type Hit = { kind: 'object'; id: string } | { kind: 'floor'; at: Vec2 };

export interface DebugView {
  hotspots: boolean;
  markers: boolean;
  navmesh: boolean;
  /** Show the room's art in place of the greybox (R10). */
  art: boolean;
}

export interface StageOptions {
  /** Where a screen's room model is (AssetIndex.room), if it has one. */
  roomUrl: (screen: string) => string | undefined;
  /** Loads a room model (loadRoom; tests pass their own). */
  load?: (url: string) => Promise<RoomView>;
  clock: PresentationClock;
  /** Where the name tags go (an element laid over the canvas). */
  labels?: HTMLElement | null;
  /** Whether the player asked for the names and outlines over the clickable areas (H, or the HUD's Hotspots button). */
  hotspotLabels?: () => boolean;
  warn?: (message: string) => void;
  /** The art the package publishes (presentation.art), if any. */
  art?: ArtSource;
  artLoaders?: ArtLoaders;
  /** ?art=0: start with art off (R10). */
  artOff?: boolean;
  /** Told how many of a room's art files have loaded, of how many (a loading screen's view into the art load). */
  artProgress?: (done: number, total: number) => void;
  /**
   * For a device short of memory: the bytes the crew's animation strips may take, which is a lot (a card has twenty, each megabytes,
   * and a room's crew can come to a gigabyte). With it, a strip is loaded when the player first needs it, not all at once, and the
   * least recently used ones are freed to stay under it. Without it, every strip is asked for as the card is made.
   */
  stripBudget?: number;
  /** The longest a screen change holds the frame left, in milliseconds (B5): then the next room shows with whatever of its art has come, and the rest pops in. 1500 by default. */
  holdMs?: number;
}

/** Frees the GPU side of everything under root: geometries, materials and their textures (each once). */
/** An animated layer (Batch 8): a prop whose picture follows its object's animation. */
interface LayerView {
  /** The strips that loaded, by animation. */
  strips: Record<number, LayerStrip>;
  /** A quad over each strip's cell. */
  quads: Map<number, Mesh>;
  /** Each strip's textures (an atlas's pages). */
  textures: Map<number, Texture[]>;
  /** The animation the object starts on when the state has none. */
  initial: number;
  /** The animation being drawn (a stop keeps it). */
  anim: number;
  /** The state's `anim` as last looked at: a change is a script. */
  seen: number;
  /** When it started, in presentation milliseconds. */
  since: number;
  /** Where a stop held it (milliseconds into the animation), or null while it plays. */
  frozen: number | null;
  /** What it plays while its object replies, and the animation it goes back to when the line ends (-1: it stays on the talk one). */
  talk?: { anim: number; idle: number };
  /** Until when a play a script has just made is kept on the screen (presentation milliseconds), whatever the state has become by then. */
  hold: number;
  /** What it draws now; null draws the still. */
  frame: { anim: number; index: number } | null;
  /** The atlas strips, streamed (Batch 8c): absent for a layer with only grid strips. */
  stream?: LayerStream;
}

/**
 * How an atlas layer is drawn without holding its pages on the GPU: one texture (`surface`) as big as the layer's largest cell, the pages as encoded bytes, and
 * a ring of the next decoded cells. A cell is drawn into the surface when its frame comes up and is decoded; until then the layer holds what it last drew.
 */
interface LayerStream {
  surface: LayerSurface;
  /** The surface's size in pixels: the layer's largest cell. */
  size: [number, number];
  ring: FrameRing<number, CellBitmap>;
  /** The pages of each animation that is an atlas. */
  data: Map<number, PageData[]>;
  /** What the surface holds and how it is placed; null until the first cell is there (the still is drawn till then). */
  drawn: { key: number; anim: number; uv: [number, number, number, number]; sub: [number, number, number, number]; empty: boolean } | null;
}

/** A cell of an atlas strip, as one number: its animation and its index. */
const CELL_KEY = 100000;

function freeGpu(root: Object3D): void {
  const freed = new Set<{ dispose(): void }>();
  const free = (thing: { dispose(): void }) => {
    if (freed.has(thing)) return;
    freed.add(thing);
    thing.dispose();
  };
  root.traverse(node => {
    const { geometry, material } = node as Partial<Mesh>;
    if (geometry instanceof BufferGeometry) free(geometry);
    for (const m of material === undefined ? [] : Array.isArray(material) ? material : [material]) {
      for (const value of Object.values(m)) if (value instanceof Texture) free(value);
      free(m);
    }
  });
}

const BACKGROUND = new Color(0x101418);
const WALKABLE = 0x8c99a6;
const CLOSED = 0x664040;
const BASE_OPACITY = 0.35;
const DEBUG_OPACITY = 0.55;
const HOVER_OPACITY = 0.7;
const ANIM_SECONDS = 0.6;
/** How long a layer keeps a play that a script has just made on the screen, in milliseconds. */
const LAYER_HOLD_MS = 160;
const CREW_COLORS = [0xc0392b, 0xd4ac0d, 0x2e86c1, 0x8e44ad, 0x17a589, 0xca6f1e];
/** How far across the screen, in the original's pixels, someone must be to be turned toward rather than faced. */
const SIDE_PX = 40;
const MARKER_GEOMETRY = new SphereGeometry(0.08, 8, 6);
const MARKER_MATERIAL = new MeshStandardMaterial({ color: 0x00e0ff });
const PROP_GEOMETRY = new BoxGeometry(0.5, 1, 0.5);
const GROUND = new Plane(new Vector3(0, 1, 0), 0);

/** The stage's lights: the greybox and the capsules are lit. */
function addLights(scene: Scene): void {
  scene.add(new AmbientLight(0xffffff, 0.7));
  const sun = new DirectionalLight(0xffffff, 1.4);
  sun.position.set(3, 8, 6);
  scene.add(sun);
}
const round3 = (v: number) => Math.round(v * 1000) / 1000 + 0;

/**
 * The three.js side of the game: the current screen's room, the crew as capsules, picking, walking and
 * visual effects. It reads the world's state and follows its events; it never changes the state.
 */
export class Stage {
  readonly scene = new Scene();
  room: RoomView | null = null;
  nav: NavMesh = NavMesh.build([]);
  /** Settles once the current screen's room is in place. */
  ready: Promise<void> = Promise.resolve();
  /**
   * Settles once the current screen is on show with its art: its room, its art (or the art failed or is off) and its actors' cards, swapped in
   * at once for the frame held while they loaded (B5), or swapped at the hold's limit and the art in since. `ready` does not wait for it.
   */
  artDone: Promise<void> = Promise.resolve();
  private world: World | null = null;
  private screen: string | null = null;
  private off: (() => void) | null = null;
  private readonly actors = new Map<string, ActorView>();
  private readonly props = new Map<string, Mesh>();
  private readonly debugLayer = new Object3D();
  private readonly raycaster = new Raycaster();
  private debug: DebugView = { hotspots: false, markers: false, navmesh: false, art: true };
  private hovered: string | null = null;
  /** Ends each live walk where its actor stands now, for when the actor goes before the walk does. */
  private readonly walks = new Map<ActorView, () => void>();
  private art: RoomArt | null = null;
  /** The room's mask quads by object id (R9): in the scene, not the room, whose meshes art hides. */
  private readonly maskQuads = new Map<string, Mesh>();
  /** The layers whose picture follows the object's animation (Batch 8), by object id: a quad a strip, and which frame is drawn. The still is the mask quad. */
  private readonly layers = new Map<string, LayerView>();
  /** The masks and layers drawn now: their object is here and active, and the art is on (whichever picture of it, a strip's frame or the still). */
  private readonly shownMasks = new Set<string>();
  /** The load whose art was last asked for (so a toggle doesn't ask twice). */
  private artAsked = -1;
  private loadToken = 0;
  private loading = false;
  /** A crew member's card texture by object id, loaded once and shared by every room; freed on detach. */
  private readonly cardTextures = new Map<string, Texture>();
  private readonly cardAsked = new Set<string>();
  /** A crew member's animation strips, by `object/anim`: loaded the first time the player asks. */
  private readonly stripTextures = new Map<string, Texture>();
  private readonly stripAsked = new Set<string>();
  private cardEpoch = 0;
  /** Presentation time in milliseconds, what the card players run on. */
  private time = 0;
  /** The phaser shots being drawn (phaserFx.ts). */
  private readonly shots: { from: string; to: string; start: number; at: { start: Px; target: Px }; view: BeamView }[] = [];
  /** The transporter's beams under way (beam.ts), the sparkle art loaded for them, and the textures to free. */
  private readonly beams: BeamRun[] = [];
  private readonly beamArts = new Map<string, Promise<SparkleArt | undefined>>();
  private readonly beamTextures: Texture[] = [];
  /**
   * The frame on show while the next screen loads (B5): the room left, its art and its actors, moved to a scene of their own and drawn
   * instead of the stage's until the next room, its art and its cards are all in place, then freed. Only the picture is held: picking, walks
   * and everything else go on in the new room as soon as its model has loaded.
   */
  private held: { scene: Scene; camera: Camera; free: () => void } | null = null;
  /** The load whose art is still on its way: the swap waits for it. */
  private artPending = -1;
  /** Whether the held frame has been held its time (holdMs, from the change that took it): the swap goes as soon as the room is in, art or no art. */
  private holdSpent = false;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  /** Settles `artDone` for the current load. */
  private settleSwap: (() => void) | null = null;
  /** Crew who have just left the screen: taken off at the end of the task, unless a screen change in it holds them in the frame left. */
  private readonly leaving: ActorView[] = [];
  /** The cards that could not be loaded (the capsule stands in): a swap does not wait for them. */
  private readonly cardFailed = new Set<string>();
  /** The away team just beamed down: hidden until the beam-in plays (an actor is made as the room loads, after the sim has said it arrived). */
  private readonly arriving = new Set<string>();

  constructor(private readonly opts: StageOptions) {
    this.scene.background = BACKGROUND;
    this.debug.art = !opts.artOff;
    addLights(this.scene);
    this.debugLayer.name = 'debug';
    this.scene.add(this.debugLayer);
  }

  get debugView(): DebugView {
    return { ...this.debug };
  }

  /** Shows `world` (its screen, and every change it announces from now on) in place of any other; what was on show stays until it is ready. */
  attach(world: World): Promise<void> {
    this.detach(true);
    this.world = world;
    this.off = world.bus.on(e => this.onEvent(e));
    return this.enter(world.state.screen);
  }

  /** Lets go of the world. With `keepFrame` (a load, before the next world's attach) what is on show stays drawn until the next screen is ready. */
  detach(keepFrame = false): void {
    this.off?.();
    this.off = null;
    this.loadToken++;
    this.loading = false;
    const textures = [...this.cardTextures.values(), ...this.stripTextures.values()];
    if (keepFrame) this.hold();
    else {
      this.clearRoom();
      this.dropHeld();
    }
    // (the held actors may draw the cards: they go with the held frame)
    const held = this.held;
    if (held) {
      const free = held.free;
      held.free = () => {
        free();
        for (const t of textures) t.dispose();
      };
    } else for (const t of textures) t.dispose();
    this.settleSwap?.();
    this.settleSwap = null;
    // (a frame kept keeps its limit, counted from the change that took it, and so goes even if no world comes, as when a load's build throws)
    if (!this.held && this.holdTimer !== null) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
    this.cardTextures.clear();
    this.cardAsked.clear();
    this.cardFailed.clear();
    this.stripTextures.clear();
    this.stripUsed.clear();
    this.stripAsked.clear();
    this.cardEpoch++;
    for (const b of this.beams.splice(0)) b.finish();
    for (const sh of this.shots.splice(0)) sh.view.dispose();
    for (const t of this.beamTextures.splice(0)) t.dispose();
    this.beamArts.clear();
    this.arriving.clear();
    this.world = null;
    this.screen = null;
  }

  actorIds(): string[] {
    return [...this.actors.keys()];
  }

  actorAt(id: string): Vec2 | undefined {
    return this.actors.get(id)?.position;
  }

  /** What is under a point given in normalised device coordinates (-1..1, y up). */
  pick(ndc: { x: number; y: number }): Hit | null {
    const room = this.room;
    // (while a room loads, or the frame left is held on show, nothing is picked: a click never acts on a room the player can't see, B5)
    if (!room || !this.world || this.loading || this.held) return null;
    this.scene.updateMatrixWorld();
    this.raycaster.setFromCamera(new Vector2(ndc.x, ndc.y), room.camera);
    const hit = this.frontmost(this.raycaster.intersectObjects(this.pickables(), false).map(h => h.object), room, this.rectHits(ndc));
    if (hit) return { kind: 'object', id: hit };
    const floors = [...room.regions.values()].filter(r => this.isOpen(r)).map(r => r.mesh);
    const ground = this.raycaster.intersectObjects(floors, false)[0];
    if (ground) return { kind: 'floor', at: { x: round3(ground.point.x), z: round3(ground.point.z) } };
    // (off the open floor: where the ray meets the ground, pulled to the nearest open floor, as walkTo
    // goes to the nearest walkable point; above the horizon there is nothing)
    const plane = this.raycaster.ray.intersectPlane(GROUND, new Vector3());
    const near = plane ? this.nav.nearest({ x: plane.x, z: plane.z }) : null;
    return near ? { kind: 'floor', at: { x: round3(near.point.x), z: round3(near.point.z) } } : null;
  }

  private floorUnder(ndc: { x: number; y: number }): boolean {
    const room = this.room;
    if (!room || !this.world || this.loading || this.held) return false;
    this.scene.updateMatrixWorld();
    this.raycaster.setFromCamera(new Vector2(ndc.x, ndc.y), room.camera);
    const floors = [...room.regions.values()].filter(r => this.isOpen(r)).map(r => r.mesh);
    return this.raycaster.intersectObjects(floors, false).length > 0;
  }

  /**
   * The hotspots under a point by the original's own test (objectAt, unity.cpp:225-258): the point is a pixel of its 640 by 480 screen, and an object
   * with no sprite, or a sprite with a verb, is under it when the pixel is inside the rectangle lift measured, whatever its box in the room's 3D is.
   * (The boxes stand on the object's ground point, which a row above the horizon has none of: the shelf's pickups and the conduit on the far wall
   * could not be picked by them.) Each comes with the row it is checked by, as the original sorts: the object's y_adjust, or its y. The rectangle
   * follows the object when a script moves it, by the pixels its position moved.
   */
  private rectHits(ndc: { x: number; y: number }): { id: string; row: number }[] {
    const world = this.world;
    const room = this.room;
    if (!world || !room) return [];
    // (the original's pointer is a whole pixel)
    const px = Math.floor(((ndc.x + 1) / 2) * SCREEN_W + 1e-6);
    const py = Math.floor(((1 - ndc.y) / 2) * SCREEN_H + 1e-6);
    const out: { id: string; row: number }[] = [];
    for (const [id, h] of room.hotspots) {
      const o = world.state.objects[id];
      if (!h.rect || !h.pickable || !h.mesh.visible || !o?.active || o.inventory || o.screen !== this.screen) continue;
      const { rect: [x0, y0, x1, y1], dy } = this.rectNow(id, h.rect, room);
      // (inclusive: the original's tests are `<` and `>` on the rectangle's edges)
      if (px < x0 || px > x1 || py < y0 || py > y1) continue;
      out.push({ id, row: (h.order ?? h.rect[3]) + dy });
    }
    return out;
  }

  /** A hotspot's rectangle where its object is now: moved by the pixels the object's position has moved from where it was lifted. */
  private rectNow(id: string, rect: [number, number, number, number], room: RoomView): { rect: [number, number, number, number]; dy: number } {
    const world = this.world;
    const o = world?.state.objects[id];
    const fit = world ? screenPixels(world) : undefined;
    const marker = room.markers.get(id);
    if (!fit || !o || !marker || (Math.abs(o.pos.x - marker.x) <= 0.005 && Math.abs(o.pos.z - marker.z) <= 0.005)) return { rect, dy: 0 };
    const now = fit.toPixel(o.pos);
    const was = fit.toPixel(marker);
    const dx = Math.round(now.x - was.x);
    const dy = Math.round(now.y - was.y);
    return { rect: [rect[0] + dx, rect[1] + dy, rect[2] + dx, rect[3] + dy], dy };
  }

  /** Whether the frame left is held on show while the next screen loads (B5): input to the room waits for the swap. */
  get holding(): boolean {
    return this.held !== null;
  }

  /**
   * Whether input to the room waits on the held frame: only within the hold's limit. Past it the picture may stay held while the room's model
   * is still loading (no greybox shows), but presses go through again; `pick` finds nothing until the room is in, so none acts on a room unseen.
   */
  get inputHeld(): boolean {
    return this.held !== null && !this.holdSpent;
  }

  /** Whether the pointer's ray meets open floor itself (not a closed region or the ground off the floor, which a click is pulled in from): where Walk lights its pointer. */
  overFloor = false;

  /**
   * Lights up the object under the pointer; returns its id. A transition or action square is not a thing to point at (handleAwayTeamMouseMove
   * drops it), so it is not lit or named; a click on one still picks it. `overFloor` says whether the pointer is on open floor.
   */
  hover(ndc: { x: number; y: number } | null): string | null {
    const hit = ndc ? this.pick(ndc) : null;
    const spot = hit?.kind === 'object' ? this.room?.hotspots.get(hit.id) : undefined;
    const id = hit?.kind === 'object' && spot?.kind !== 'transition' && spot?.kind !== 'action' ? hit.id : null;
    this.overFloor = id === null && ndc !== null && this.room !== null && this.floorUnder(ndc);
    if (id !== this.hovered) {
      this.highlight(this.hovered, false);
      this.highlight(id, true);
      this.hovered = id;
    }
    return id;
  }

  /** Whether the player is hurrying (Shift held): walks go HURRY times as fast. */
  hurry = false;

  /** The browser presenter's walk: along the navmesh to where the sim said, or until stopped. */
  async walk(actor: string, from: Vec2, to: Vec2, stop: StopSignal): Promise<Vec2> {
    await this.ready;
    const view = this.actors.get(actor);
    if (stop.stopped) return { ...from };
    // (someone the view doesn't show, on another screen or a close-up, just gets there)
    if (!view) return { ...to };
    const route = this.nav.path(from, to);
    if (!route.reachable) this.opts.warn?.(`no way for ${actor} to ${to.x},${to.z} over the floor: walking straight there`);
    const walker = new Walker(from, route.points);
    this.placeActor(view, from);
    view.walker = walker;
    return new Promise<Vec2>(resolve => {
      let settled = false;
      const finish = (end: Vec2) => {
        if (settled) return;
        settled = true;
        if (view.walker === walker) view.walker = null;
        view.arrive = null;
        this.walks.delete(view);
        this.placeActor(view, end);
        resolve(end);
      };
      // (a walk that got there ends exactly where the sim said; a stopped one is rounded, so the sim's
      // state and saves stay tidy, and the view shows exactly that)
      const stopped = () => {
        const at = walker.position;
        finish({ x: round3(at.x), z: round3(at.z) });
      };
      view.arrive = () => finish({ ...to });
      this.walks.set(view, stopped);
      stop.onStop(stopped);
    });
  }

  async anim(object: string, anim: AnimFx): Promise<void> {
    // (a play of the animation a layer is already on starts it again, as SpritePlayer::startAnim does; any other change is the state's `anim`, which the layer follows)
    const layer = this.layers.get(object);
    if (layer && 'play' in anim && anim.play === layer.anim) {
      layer.since = this.time;
      layer.frozen = null;
    } else if (layer && 'play' in anim && anim.play in layer.strips && this.time >= layer.hold) {
      // (a button's script plays its lit animation and the plain one straight after, between two frames: the lit one is drawn for a moment all the same, as the original's sound would hold it)
      layer.seen = anim.play;
      layer.anim = anim.play;
      layer.since = this.time;
      layer.frozen = null;
      layer.hold = this.time + LAYER_HOLD_MS;
    }
    const mesh = this.meshOf(object);
    if (mesh && 'play' in anim) {
      // (no clips yet: a short pulse stands in for the animation)
      mesh.scale.multiplyScalar(1.1);
      void this.opts.clock.after(ANIM_SECONDS).then(() => mesh.scale.divideScalar(1.1));
    }
    if ('play' in anim && anim.wait) {
      // (a layer that is drawn plays the animation as long as the sprite does, and the rules wait for it to stop: UnityEngine::waitForAnim, with its 30 s limit for a loop)
      const strips = layer && this.shownMasks.has(object) ? Object.fromEntries(Object.entries(layer.strips).filter(([a]) => layer.quads.has(Number(a)))) : null;
      const ms = strips ? animationMillis(strips, anim.play) : null;
      await this.opts.clock.after(ms === null ? ANIM_SECONDS : Math.min(ms, 30_000) / 1000);
    }
  }

  async show(visual: Visual): Promise<void> {
    if (visual.kind === 'phaserShot') {
      await this.shoot(visual.from, visual.to);
      return;
    }
    await this.beam(visual.objects, visual.out, visual.chodak);
  }

  /** A world point as a pixel of the original's 640x480 picture, through the room's camera. */
  private pixelOfPoint(p: Vector3): Px | null {
    const room = this.room;
    if (!room) return null;
    room.camera.updateMatrixWorld(true);
    const v = p.clone().project(room.camera);
    return { x: Math.round(((v.x + 1) / 2) * SCREEN_W), y: Math.round(((1 - v.y) / 2) * SCREEN_H) };
  }

  /** Where an object stands, in the original's pixels: its place on the floor (a whole pixel, as the original keeps positions). */
  private footPixel(id: string): Px | null {
    const world = this.world;
    const o = world?.state.objects[id];
    if (!world || !o) return null;
    const fit = screenPixels(world);
    if (fit) return pixelAt(fit, o.pos);
    return this.pixelOfPoint(new Vector3(o.pos.x, 0, o.pos.z));
  }

  /**
   * Where a phaser aims at an object (UnityEngine::phaserTarget): its sprite's own aim point where it has one, else halfway up it. A layer has its
   * sprite's rectangle (and the aim point published with it, moved as the layer is); anything else is its middle on the screen.
   */
  private aimPixel(id: string): Px | null {
    const quad = this.maskQuads.get(id);
    const made = quad?.userData.made as { rect: [number, number, number, number] } | undefined;
    if (made && this.shownMasks.has(id)) {
      const [dx, dy] = this.maskMoved.get(id) ?? [0, 0];
      const aim = this.art?.masks.find(m => m.object === id)?.aim;
      if (aim) return { x: aim[0] + dx, y: aim[1] + dy };
      return { x: Math.round(made.rect[0] + dx + made.rect[2] / 2), y: Math.round(made.rect[1] + dy + made.rect[3] / 2) };
    }
    const c = this.centre(id);
    return c ? this.pixelOfPoint(c) : null;
  }

  /**
   * A phaser shot (UnityEngine::phaserShot): the beam from where it leaves the shooter to where it aims at the target, drawn over 16 steps. A crew member
   * fires from the muzzle of the direction the target is in; anyone else from the middle of their sprite. Without the package's phaser table, a plain line.
   */
  private async shoot(from: string, to: string): Promise<void> {
    const world = this.world;
    const room = this.room;
    const art = this.opts.art?.phaser?.();
    const feet = this.footPixel(from);
    const target = this.aimPixel(to);
    if (!world || !room || !art || !feet || !target) {
      const a = this.centre(from);
      const b = this.centre(to);
      if (a && b) await phaserBeam(this.scene, a, b, this.opts.clock);
      else await this.opts.clock.after(0);
      return;
    }
    const index = world.content.objects[from]?.crew ? art.crew.indexOf(from) : -1;
    let start: Px | null = null;
    // (the crew member fires: the firing animation for that direction plays until the frame the muzzle table names, and holds there while the beam is drawn, then goes on, as phaserShot does)
    let held: CardPlayer | null = null;
    if (index >= 0 && index < MUZZLE_CREW) {
      const direction = muzzleDirection(feet, target);
      const muzzle = art.muzzles[index * MUZZLE_DIRECTIONS + direction];
      const floor = screenFloor(world);
      if (muzzle) start = muzzleStart(feet, muzzle, floor && !floor.empty ? floor.scaleAt(feet) : 256);
      const actor = this.actors.get(from);
      const player = actor?.player;
      if (muzzle && actor && player?.has(FIRE_PHASER + direction)) {
        player.set({ kind: 'anim', index: FIRE_PHASER + direction });
        actor.updateCard();
        await this.opts.clock.after(player.startOf(FIRE_PHASER + direction, muzzle.frame) / 1000);
        player.hold(muzzle.frame);
        held = player;
      }
    }
    start ??= this.aimPixel(from) ?? feet;
    const shot = { from, to, start: this.time, at: { start, target }, view: new BeamView(room.camera, this.scene, art.colours) };
    this.shots.push(shot);
    shot.view.show(beamLines(0, start, target));
    await this.opts.clock.after(BEAM_MS / 1000);
    shot.view.dispose();
    this.shots.splice(this.shots.indexOf(shot), 1);
    held?.release();
  }

  /**
   * The transporter's effect on these objects (UnityEngine::beamEffect): the sparkle, then the dissolve, on presentation time. An object beamed in is
   * hidden from the moment the sim has put it here, so it never shows whole before its beam begins.
   */
  private async beam(objects: string[], out: boolean, chodak: boolean): Promise<void> {
    if (!out) {
      for (const id of objects) {
        this.actors.get(id)?.dissolve(0);
        for (const q of this.propQuads(id)) setDissolve(q, 0);
      }
    }
    await this.ready;
    await this.artDone;
    const art = await this.beamArt(chodak);
    // (a card loads after its actor is made: wait a moment for it, so the beam dissolves the card and not the capsule)
    const cardPending = (id: string): boolean => {
      const a = this.actors.get(id);
      return a !== undefined && this.debug.art && this.opts.art?.card(id) !== undefined && a.card === null;
    };
    for (let i = 0; i < 40 && objects.some(cardPending); i++) await this.opts.clock.after(0.05);
    const targets: BeamTarget[] = [];
    for (const id of objects) {
      this.arriving.delete(id);
      const actor = this.actors.get(id);
      const prop = actor ? null : this.propBeam(id);
      if (actor) targets.push(actor);
      else if (prop) targets.push(prop);
    }
    if (targets.length === 0) {
      await this.opts.clock.after(0);
      return;
    }
    const run = new BeamRun(out, targets, art, this.time, objects);
    this.beams.push(run);
    run.update(this.time);
    await this.opts.clock.after(run.totalMs / 1000);
    run.finish();
    const at = this.beams.indexOf(run);
    if (at >= 0) this.beams.splice(at, 1);
  }

  /** The sparkle's strips, loaded the first time a beam wants them; undefined where the package has none (a beam then has only the dissolve). */
  private beamArt(chodak: boolean): Promise<SparkleArt | undefined> {
    const id = chodak ? 'beam_chodak' : 'beam_effect';
    const have = this.beamArts.get(id);
    if (have) return have;
    const def = this.debug.art ? this.opts.art?.card(id) : undefined;
    if (!def?.anims?.[0]) return Promise.resolve(undefined);
    const anims = def.anims;
    const epoch = this.cardEpoch;
    const made = (async (): Promise<SparkleArt | undefined> => {
      const textures = new Map<number, Texture>();
      try {
        for (const [anim, a] of Object.entries(anims)) {
          const t = await (this.opts.artLoaders ?? defaultLoaders).texture(a.url, true);
          if (epoch !== this.cardEpoch) {
            t.dispose();
            return undefined;
          }
          textures.set(Number(anim), t);
          this.beamTextures.push(t);
        }
      } catch (err) {
        this.opts.warn?.(`could not load the transporter's sparkle (${err instanceof Error ? err.message : String(err)}): the beam only dissolves`);
        return undefined;
      }
      return { anims, texture: a => textures.get(a) };
    })();
    this.beamArts.set(id, made);
    return made;
  }

  /** The quads that draw a prop: its still and its layers' strips. */
  private propQuads(id: string): Mesh[] {
    const still = this.maskQuads.get(id);
    return still ? [still, ...(this.layers.get(id)?.quads.values() ?? [])] : [];
  }

  /** A prop in a beam: null where it has no layer in this room (no art, or an object without a sprite). */
  private propBeam(id: string): PropBeam | null {
    const world = this.world;
    const room = this.room;
    const o = world?.state.objects[id];
    if (!world || !room || !o || this.maskQuads.get(id) === undefined || !this.debug.art) return null;
    const fit = screenPixels(world);
    let foot: { x: number; y: number };
    if (fit) foot = pixelAt(fit, o.pos);
    else {
      room.camera.updateMatrixWorld(true);
      const v = new Vector3(o.pos.x, 0, o.pos.z).project(room.camera);
      foot = { x: ((v.x + 1) / 2) * SCREEN_W, y: ((1 - v.y) / 2) * SCREEN_H };
    }
    return new PropBeam(room.camera, this.scene, () => this.propQuads(id), foot, id);
  }

  /** The time the stage's animations play on, in ms: the sum of the frames' dt, which the loop caps, so it falls behind the wall clock when frames take over 167 ms. */
  get animationTime(): number {
    return this.time;
  }

  /** One drawn frame: walkers move on, name tags follow. */
  frame(dt: number): void {
    this.time += Math.max(0, dt) * 1000;
    dissolveTick();
    for (const b of this.beams) b.update(this.time);
    for (const sh of this.shots) {
      const step = beamStep(this.time - sh.start);
      if (step !== null) sh.view.show(beamLines(step, sh.at.start, sh.at.target));
    }
    for (const id of this.layers.keys()) this.updateLayer(id);
    for (const a of this.actors.values()) {
      const walker = a.walker;
      if (walker) {
        // (only the pace changes: the walk ends where the sim said, so hurrying leaves the game's state alone)
        walker.advance(this.hurry ? dt * HURRY : dt);
        this.placeActor(a, walker.position);
        a.face(walker.heading);
        if (walker.done) a.arrive?.();
      }
      this.driveCard(a);
    }
    this.placeLabels();
  }

  /** Plays a card's animation for what the actor is doing: a walk in the screen direction of its step, a stand when it stops. */
  private driveCard(a: ActorView): void {
    const player = a.player;
    if (!player) return;
    const walker = a.walker;
    if (walker && !walker.done) {
      const dir = this.screenDirection(a, walker.heading);
      if (dir !== null) a.lastDir = dir;
      player.set({ kind: 'walk', dir: a.lastDir });
      a.walkingCard = true;
    } else if (a.walkingCard) {
      a.walkingCard = false;
      a.side = 'front';
      player.set({ kind: 'stand', dir: a.lastDir });
    }
    a.updateCard();
  }

  /** The clock direction an actor walking along `heading` moves in on the screen, or null for a step with no length there. */
  private screenDirection(a: ActorView, heading: number): number | null {
    const room = this.room;
    if (!room) return null;
    this.scene.updateMatrixWorld();
    const at = a.group.position;
    const from = new Vector3(at.x, 0, at.z).project(room.camera);
    const to = new Vector3(at.x + Math.sin(heading) * 0.25, 0, at.z + Math.cos(heading) * 0.25).project(room.camera);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    return Math.hypot(dx, dy) < 1e-9 ? null : clockDirection(dx, dy);
  }

  /** A line is being said (on) or has been (off): the speaker's talk animation, then its end. Called by the presenter. */
  speak(who: string, on: boolean): void {
    // (a character drawn as an animated layer plays its talk animation while it replies, and goes back to its idle one: UnityEngine::replyAnims, sayLine)
    const layer = this.layers.get(who);
    if (layer?.talk && layer.quads.has(layer.talk.anim) && this.shownMasks.has(who)) {
      // (an idle animation with no strip that loaded: the one it started on)
      const to = on ? layer.talk.anim : layer.quads.has(layer.talk.idle) ? layer.talk.idle : layer.initial;
      if (layer.quads.has(to)) {
        layer.anim = to;
        layer.since = this.time;
        layer.frozen = null;
      }
      return;
    }
    const a = this.actors.get(who);
    const player = a?.player;
    if (!a || !player || a.walkingCard) return;
    if (on) {
      player.set({ kind: 'talk', side: a.side });
    } else {
      player.set({ kind: 'end', side: a.side });
      a.side = 'front';
    }
    a.updateCard();
  }

  /** An actor turns to a side (or back to the camera): the turn animation, and it speaks that way after. */
  private turnCard(a: ActorView, side: 'front' | 'left' | 'right'): void {
    if (side === a.side || !a.player || a.walkingCard) {
      a.side = side;
      return;
    }
    a.side = side;
    a.player.set(side === 'front' ? { kind: 'idle', side } : { kind: 'turn', side });
    a.updateCard();
  }

  render(renderer: WebGLRenderer): void {
    if (this.held) renderer.render(this.held.scene, this.held.camera);
    else if (this.room) renderer.render(this.scene, this.room.camera);
  }

  /** Where an object is drawn, in CSS pixels within a canvas of this size (tests and the dev tools). */
  screenPoint(id: string, width: number, height: number): { x: number; y: number } | null {
    // (a hotspot with its rectangle is where that is: the middle of it, the pixels a click there picks it at)
    const spot = this.room?.hotspots.get(id);
    if (spot?.rect && this.room) {
      const [x0, y0, x1, y1] = this.rectNow(id, spot.rect, this.room).rect;
      return { x: (((x0 + x1) / 2) / SCREEN_W) * width, y: (((y0 + y1) / 2) / SCREEN_H) * height };
    }
    const p = this.centre(id);
    if (!p || !this.room) return null;
    const v = p.project(this.room.camera);
    return { x: ((v.x + 1) / 2) * width, y: ((1 - v.y) / 2) * height };
  }

  setDebug(d: Partial<DebugView>): void {
    this.debug = { ...this.debug, ...d };
    this.applyDebug();
    this.applyArt();
    // (art turned on in a room whose art hasn't been asked for yet)
    if (this.debug.art && this.art === null && this.artAsked !== this.loadToken && this.screen !== null && this.world) this.askArt(this.screen, this.loadToken);
    // (art turned off: a swap waiting for it waits no longer)
    this.tryRelease();
    this.settleIfDone();
  }

  /** What the current room shows: for the dev handle and tests. `masks` are the room's mask and prop layers, `shown` the ones drawn now (their object is here and active). */
  artState(): { screen: string | null; plate: boolean; model: boolean; masks: string[]; shown: string[]; cards: string[]; cardAnims: Record<string, number>; layers: { object: string; anim: number; frame: number | null; still: boolean }[]; beams: { objects: string[]; out: boolean; sparkle: 0 | 1; level: number }[]; shots: { from: string; to: string; step: number; start: [number, number]; target: [number, number] }[]; moved: Record<string, [number, number]>; on: boolean; held: boolean } {
    const art = this.art;
    const on = this.debug.art && art !== null && (art.plate !== null || art.model !== null);
    // (`layers` are the animated ones shown: the animation they draw and its frame, or `still` where they draw the fallback because the animation has no strip)
    const layers = on ? [...this.layers].filter(([id]) => this.shownMasks.has(id)).map(([object, l]) => ({ object, anim: l.frame?.anim ?? l.anim, frame: l.frame?.index ?? null, still: l.frame === null })) : [];
    return { screen: this.screen, plate: on && art?.plate != null, model: on && art?.model != null, masks: on ? [...this.maskQuads.keys()] : [], shown: on ? [...this.maskQuads.keys()].filter(id => this.shownMasks.has(id)) : [], cards: [...this.actors].filter(([, a]) => a.card !== null).map(([id]) => id), cardAnims: Object.fromEntries([...this.actors].flatMap(([id, a]) => { const f = a.card !== null ? a.player?.frame() : null; return f ? [[id, f.anim] as const] : []; })), layers, beams: this.beams.map(b => ({ objects: [...b.objects], out: b.out, sparkle: b.phase(this.time).sparkle, level: b.level })), shots: this.shots.map(sh => ({ from: sh.from, to: sh.to, step: beamStep(this.time - sh.start) ?? 15, start: [sh.at.start.x, sh.at.start.y], target: [sh.at.target.x, sh.at.target.y] })), moved: Object.fromEntries(this.maskMoved), on, held: this.held !== null };
  }

  private onEvent(e: SimEvent): void {
    switch (e.type) {
      case 'screenChanged':
        void this.enter(e.screen);
        break;
      case 'regionsChanged':
        if (e.screen === this.screen) this.rebuildNav();
        break;
      case 'objectChanged':
        this.syncObject(e.id);
        break;
      case 'beamedDown':
        // (the team is hidden until its beam-in plays; one that never plays, a test's or a failed one, is let go after a while)
        if (e.effect && this.world) {
          const team = [...this.world.state.awayTeam];
          for (const id of team) this.arriving.add(id);
          void this.opts.clock.after(30).then(() => {
            for (const id of team) if (this.arriving.delete(id)) this.actors.get(id)?.dissolve(-1);
          });
        }
        break;
      case 'collapsed':
        this.actors.get(e.id)?.setDown(true);
        break;
      case 'recovered':
        this.actors.get(e.id)?.setDown(false);
        break;
      case 'turned': {
        const actor = this.actors.get(e.who);
        actor?.face(e.side === 'right' ? Math.PI / 2 : -Math.PI / 2);
        if (actor) this.turnCard(actor, e.side === 'right' ? 'right' : 'left');
        break;
      }
      case 'faced': {
        const actor = this.actors.get(e.who);
        const target = this.centre(e.toward);
        if (actor && target) {
          actor.face(Math.atan2(target.x - actor.position.x, target.z - actor.position.z));
          this.turnCard(actor, this.sideToward(actor, target));
        }
        break;
      }
      default:
        break;
    }
  }

  /** Which side of the screen a target is on from an actor: the way the original's speakers turn (right, left, or toward the camera when it is straight above or below). */
  private sideToward(actor: ActorView, target: Vector3): 'front' | 'left' | 'right' {
    const room = this.room;
    if (!room) return 'front';
    this.scene.updateMatrixWorld();
    const a = new Vector3(actor.position.x, 0, actor.position.z).project(room.camera);
    const t = target.clone().project(room.camera);
    const dx = ((t.x - a.x) / 2) * 640;
    return dx > SIDE_PX ? 'right' : dx < -SIDE_PX ? 'left' : 'front';
  }

  /**
   * Goes to a screen (B5). What is on show (the room, its art and its actors) is held in the frame while the next room's model and its art load,
   * side by side; the swap is one frame, once the room, the art (unless it failed or is off) and the cards are in place. The new room is the one
   * picked and walked as soon as its model is in, so input never waits on the art. A later screen change frees what this one loaded.
   */
  private enter(screen: string): Promise<void> {
    const world = this.world;
    this.screen = screen;
    if (!world) return Promise.resolve();
    const token = ++this.loadToken;
    this.hold();
    this.loading = true;
    this.settleSwap?.();
    this.artDone = new Promise<void>(resolve => {
      this.settleSwap = resolve;
    });
    if (this.debug.art) this.askArt(screen, token);
    this.ready = this.loadRoom(world, screen)
      .then(room => {
        // (a later screen change, or another world, may have overtaken this load)
        if (token !== this.loadToken) {
          freeGpu(room.root);
          return;
        }
        this.loading = false;
        this.setRoom(room);
        for (const id of Object.keys(world.state.objects)) this.syncObject(id);
        this.tryRelease();
      })
      .catch((err: unknown) => {
        if (token === this.loadToken) {
          this.loading = false;
          this.tryRelease();
        }
        this.opts.warn?.(`could not show ${screen}: ${err instanceof Error ? err.message : String(err)}`);
      });
    return this.ready;
  }

  /**
   * Puts what is on show in the held frame (B5), and leaves the stage empty for the next screen. A frame already held stays: what a load that a
   * newer screen change overtook brought in is freed instead. With nothing on show, the held frame is the empty background.
   */
  private hold(): void {
    if (this.held) {
      this.clearRoom();
      return;
    }
    const camera: Camera = this.room?.camera ?? new PerspectiveCamera();
    const taken = this.takeRoom();
    const scene = new Scene();
    scene.background = taken.background;
    addLights(scene);
    for (const part of taken.parts) scene.add(part);
    for (const a of taken.actors) if (a.label) a.label.style.visibility = 'hidden';
    this.held = {
      scene, camera,
      free: () => {
        for (const part of taken.parts) if (part.parent === scene) scene.remove(part);
        taken.free();
      },
    };
    this.limitHold();
  }

  /**
   * A hold has a limit, counted from the change that took the held frame (a later screen change, load or attach does not restart it): past it
   * the latest room shows with what of its art has come, or, with no world to show, the held frame goes, so input never waits on it for longer.
   */
  private limitHold(): void {
    if (this.holdTimer !== null) clearTimeout(this.holdTimer);
    this.holdSpent = false;
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      if (!this.held) return;
      this.holdSpent = true;
      if (this.world) this.tryRelease();
      else this.dropHeld();
    }, this.opts.holdMs ?? 1500);
  }

  private dropHeld(): void {
    this.held?.free();
    this.held = null;
  }

  /** Swaps the held frame for the stage once the current screen's room, art and cards are in place. */
  private tryRelease(): void {
    if (!this.held || !this.world || this.loading) return;
    const over = this.holdSpent;
    if (!over && this.debug.art && this.artPending === this.loadToken) return;
    if (!over && this.cardsPending()) return;
    if (this.holdTimer !== null) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
    this.dropHeld();
    this.freeUnusedCards();
    this.settleIfDone();
  }

  /** Settles `artDone` once the frame is swapped and the art is in (or failed, or is off): a swap the hold's limit forced leaves it waiting for the art. */
  private settleIfDone(): void {
    if (this.held || (this.debug.art && this.artPending === this.loadToken)) return;
    this.settleSwap?.();
    this.settleSwap = null;
  }

  /** Whether a crew member here is waiting for a card that is still loading (one that failed has the capsule, and is not waited for). */
  private cardsPending(): boolean {
    if (!this.debug.art) return false;
    for (const id of this.actors.keys()) if (this.opts.art?.card(id) !== undefined && !this.cardTextures.has(id) && !this.cardFailed.has(id)) return true;
    return false;
  }

  private async loadRoom(world: World, screen: string): Promise<RoomView> {
    const def = world.content.screens[screen];
    if (!def) {
      this.opts.warn?.(`${screen} has no screen definition: using an empty floor`);
      return fallbackRoom({ id: screen, markers: {} });
    }
    const url = this.opts.roomUrl(screen);
    if (url === undefined) return fallbackRoom(def);
    try {
      const room = await (this.opts.load ?? loadRoom)(url);
      // (a flat screen's camera and hotspots are the original's pixels, not the floor's size)
      const metric = projectionOf(world, screen);
      if (metric?.params.kind === 'flat') fitFlat(room, metric.unitsPerPixel(0), metric.unitsPerPixel(0) * FLAT_DEPTH);
      return room;
    } catch (err) {
      this.opts.warn?.(`could not load the room for ${screen} (${err instanceof Error ? err.message : String(err)}): using a flat floor`);
      return fallbackRoom(def);
    }
  }

  /** Starts loading a screen's art, alongside its room (B5); it is put in once the room is, and the swap waits for it. */
  private askArt(screen: string, token: number): void {
    const urls = this.opts.art?.room(screen);
    if (!urls || this.artAsked === token) return;
    this.artAsked = token;
    this.artPending = token;
    const loading = loadRoomArt(urls, this.opts.artLoaders ?? defaultLoaders, m => this.opts.warn?.(`${screen}: ${m}`), this.opts.artProgress);
    void (async () => {
      try {
        const art = await loading;
        // (a load already overtaken frees its art now, not after the next room's)
        if (token === this.loadToken) await this.ready;
        // (a later screen change may have overtaken this load, or the room failed: free what it brought)
        if (token !== this.loadToken || !this.room || this.art !== null) {
          disposeRoomArt(art);
          return;
        }
        this.placeArt(screen, art);
      } catch (err) {
        if (token === this.loadToken) this.opts.warn?.(`could not show the art of ${screen}: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        if (this.artPending === token) {
          this.artPending = -1;
          this.tryRelease();
          this.settleIfDone();
        }
      }
    })();
  }

  private placeArt(screen: string, art: RoomArt): void {
    if (!this.room) return;
    this.art = art;
    if (art.model) this.room.root.add(art.model);
    // (an object listed twice keeps its later entry, a prop's card coming after the masks cut from the plate: the earlier quad is taken off, as one
    // the stage no longer tracks is never hidden nor removed, and stays drawn in every room after)
    const listed = new Set<string>();
    for (const mask of art.masks) {
      if (listed.has(mask.object)) {
        this.opts.warn?.(`${screen}: ${mask.object} is listed twice in the room's masks: drawing the later one`);
        this.dropMask(mask.object);
      }
      listed.add(mask.object);
      const quad = maskQuad(this.room.camera, mask);
      // (a mask sorted above the horizon is drawn before every actor, and being cut from the plate it then looks like the plate: nothing to draw)
      if (!quad) continue;
      this.maskQuads.set(mask.object, quad);
      this.scene.add(quad);
      this.addLayer(mask);
    }
    this.applyArt();
  }

  /** Plate as the background; the greybox's look hidden but still picked and walked (Review Focus 1). */
  private applyArt(): void {
    const room = this.room;
    const art = this.art;
    if (!room) return;
    const on = this.debug.art && art !== null && (art.plate !== null || art.model !== null);
    this.scene.background = on && art?.plate ? art.plate : BACKGROUND;
    if (art?.model) art.model.visible = on;
    const regions = new Set([...room.regions.values()].map(r => r.mesh));
    const hotspots = new Set([...room.hotspots.values()].map(h => h.mesh));
    room.root.traverse(node => {
      if (!(node instanceof Mesh)) return;
      // (the art model's own meshes stay as they are)
      for (let up: Object3D | null = node; up; up = up.parent) if (up === art?.model) return;
      const material = node.material as Material;
      // (regions show when the navmesh view is on; hotspots when the hotspot view is; walls and the reference quad never, with art)
      if (regions.has(node)) material.visible = !on || this.debug.navmesh;
      else if (hotspots.has(node)) material.visible = !on || this.debug.hotspots;
      else material.visible = !on;
    });
    this.applyMasks();
    this.applyCards();
  }

  /** A mask shows while art is on and its object is here and active (some start inactive and are switched on by the rules). */
  private applyMasks(): void {
    for (const id of this.maskQuads.keys()) this.syncMask(id);
  }

  private syncMask(id: string): void {
    const quad = this.maskQuads.get(id);
    if (!quad) return;
    this.moveMask(id);
    const o = this.world?.state.objects[id];
    const here = o === undefined || (o.screen === this.screen && o.active && !o.inventory);
    const shown = here && this.artState().on;
    if (shown) this.shownMasks.add(id);
    else this.shownMasks.delete(id);
    quad.visible = shown;
    // (a prop beamed out stays dissolved until the sim has moved it; once it is not here it is whole again for when it comes back)
    if (!shown && !this.beams.some(b => b.objects.includes(id))) for (const q of this.propQuads(id)) setDissolve(q, -1);
    this.updateLayer(id);
  }

  /** How far each mask or layer has been moved from where its sprite was published, in the original's pixels (see moveMask). */
  private readonly maskMoved = new Map<string, [number, number]>();

  /**
   * A prop is published where the original draws its sprite at the start (the object's home place). The rules move some of them: a cable beamed
   * in lands on a marker of the room, and its sprite is drawn there. The layer follows the object by the pixels it has moved from its home.
   */
  private moveMask(id: string): void {
    const world = this.world;
    const room = this.room;
    const quad = this.maskQuads.get(id);
    if (!world || !room || !quad) return;
    const o = world.state.objects[id];
    const def = world.content.objects[id];
    const fit = screenPixels(world);
    let d: [number, number] = [0, 0];
    const homeScreen = def?.screen;
    const published = this.art?.masks.find(m => m.object === id)?.home;
    if (o && def && fit && typeof homeScreen === 'string' && o.screen === homeScreen) {
      const a = pixelAt(fit, o.pos);
      const home = def.at !== undefined ? world.content.screens[homeScreen]?.markers[def.at] : def.pos;
      if (home && published) {
        // (an object a rule has moved is measured from where it stood in the original's own pixels: the lifted marker of one that stood off the floor, above the horizon, is not that place)
        const moved = o.pos.x !== home.x || o.pos.z !== home.z;
        if (moved) d = [published[0] === null ? 0 : a.x - published[0], published[1] === null ? 0 : a.y - published[1]];
      } else if (home) {
        const b = pixelAt(fit, home);
        d = [a.x - b.x, a.y - b.y];
      }
    }
    const was = this.maskMoved.get(id) ?? [0, 0];
    if (d[0] === was[0] && d[1] === was[1]) return;
    const quads = [quad, ...(this.layers.get(id)?.quads.values() ?? [])];
    if (quads.every(q => moveQuad(room.camera, q, d[0], d[1]))) this.maskMoved.set(id, d);
  }

  /** A layer for a mask that has animation strips: a quad over each strip's cell (the union of the animation's frames), drawn instead of the still while its frame is there. */
  private addLayer(mask: RoomMask): void {
    if (!mask.strips || !this.room) return;
    const quads = new Map<number, Mesh>();
    const textures = new Map<number, Texture[]>();
    // (an atlas is not uploaded: one texture the size of the largest of its cells takes each frame as it comes up)
    let stream: LayerStream | undefined;
    const atlas = Object.entries(mask.strips).filter(([, s]) => s.data !== undefined && s.cells !== undefined);
    if (atlas.length > 0) {
      let w = 0;
      let h = 0;
      for (const [, s] of atlas) for (const c of s.cells!) {
        w = Math.max(w, c[3]!);
        h = Math.max(h, c[4]!);
      }
      const data = new Map(atlas.map(([anim, s]) => [Number(anim), s.data!] as const));
      const strips = mask.strips;
      if (w > 0 && h > 0) {
        const loaders = this.opts.artLoaders ?? defaultLoaders;
        const surface = (loaders.surface ?? canvasSurface)(w, h, `layer ${mask.object}`);
        const ring = new FrameRing<number, CellBitmap>(key => {
          const anim = Math.floor(key / CELL_KEY);
          const c = strips[anim]!.cells![key % CELL_KEY]!;
          return data.get(anim)![c[0]!]!.crop(c[1]!, c[2]!, c[3]!, c[4]!);
          // (two at a time: a cell's crop makes the browser decode its whole page, ~85 ms for the hologram's 4000x4000 against 65 ms a frame; the wanted set is still three, so memory is as before)
        }, { concurrency: 2 });
        stream = { surface, size: [w, h], ring, data, drawn: null };
      }
    }
    for (const [anim, strip] of Object.entries(mask.strips)) {
      const streamed = stream !== undefined && stream.data.has(Number(anim));
      const texture = streamed ? stream!.surface.texture : strip.texture;
      if (!texture) continue;
      const quad = maskQuad(this.room.camera, { ...mask, rect: strip.rect, texture });
      if (!quad) continue;
      quad.name = `layer:${mask.object}:${anim}`;
      quad.visible = false;
      quads.set(Number(anim), quad);
      if (!streamed) textures.set(Number(anim), strip.textures ?? [texture]);
      this.scene.add(quad);
    }
    if (quads.size === 0) {
      stream?.ring.dispose();
      stream?.surface.dispose();
      return;
    }
    const initial = mask.anim ?? Math.min(...Object.keys(mask.strips).map(Number));
    // (an object a save left on another animation starts there, as the original starts its sprite on its anim_index)
    const own = this.world?.state.objects[mask.object]?.anim;
    // (an index the sprite has no animation for is ignored, as SpritePlayer::startAnim does: the layer stays on the one it started on)
    const want = own !== undefined && own >= 0 && !(own in mask.strips) ? initial : own ?? initial;
    this.layers.set(mask.object, { strips: mask.strips, quads, textures, initial, anim: want < 0 ? initial : want, seen: want, since: this.time, frozen: want < 0 ? 0 : null, hold: 0, frame: null, ...(mask.talk ? { talk: mask.talk } : {}), ...(stream ? { stream } : {}) });
  }

  /** What a layer draws now: the frame its object's animation is on (the state's `anim`, which scripts set), timed on the presentation clock. */
  private updateLayer(id: string): void {
    const layer = this.layers.get(id);
    if (!layer) return;
    const set = this.world?.state.objects[id]?.anim;
    // (an animation the sprite does not have is ignored, as SpritePlayer::startAnim warns and returns: the layer keeps the one it is on)
    const want = set !== undefined && set >= 0 && !(set in layer.strips) ? layer.seen : set ?? layer.initial;
    if (want !== layer.seen && this.time >= layer.hold) {
      layer.seen = want;
      if (want < 0) layer.frozen = this.time - layer.since;
      else {
        layer.anim = want;
        layer.since = this.time;
        layer.frozen = null;
      }
    }
    const shown = this.shownMasks.has(id);
    const strips: Record<number, LayerStrip> = layer.strips;
    // (an animation with no strip that loaded draws the still: never nothing)
    const live = Object.fromEntries(Object.entries(strips).filter(([a]) => layer.quads.has(Number(a))));
    const elapsed = layer.frozen ?? this.time - layer.since;
    const f = shown ? layerFrame(live, layer.anim, elapsed) : null;
    const stream = layer.stream;
    // (what is drawn: for a streamed cell, the frame that is up if it is decoded, else the one last drawn; a layer that has drawn none yet has the still up)
    let drawn: { anim: number; uv: [number, number, number, number]; sub: [number, number, number, number]; empty: boolean; page: number } | null = null;
    if (f && stream && stream.data.has(f.anim)) {
      const key = f.anim * CELL_KEY + f.cell;
      const ahead = layer.frozen === null ? upcomingFrames(live, layer.anim, elapsed, 2).filter(n => stream.data.has(n.anim) && !n.empty).map(n => n.anim * CELL_KEY + n.cell) : [];
      if (f.empty) {
        // (nothing visible in this cell: nothing to decode for it, the surface is not touched; the cells after it are still got ready)
        stream.drawn = { key, anim: f.anim, uv: f.uv, sub: f.sub, empty: true };
        if (ahead.length > 0) stream.ring.want(ahead[0]!, ahead.slice(1));
        else stream.ring.idle();
      } else {
        const bitmap = stream.ring.want(key, ahead);
        if (bitmap && stream.drawn?.key !== key) {
          const c = strips[f.anim]!.cells![f.cell]!;
          const [W, H] = stream.size;
          stream.surface.draw(bitmap);
          // (the cell is at the surface's top left: its uv window is that part of it, v up)
          stream.drawn = { key, anim: f.anim, uv: [0, 1 - c[4]! / H, c[3]! / W, 1], sub: f.sub, empty: false };
        }
      }
      if (stream.drawn) drawn = { ...stream.drawn, page: 0 };
    } else if (f) {
      drawn = { anim: f.anim, uv: f.uv, sub: f.sub, empty: f.empty, page: f.page };
    }
    // (hidden, or on a grid strip: nothing is being played, so the ring lets go of its frames; what the surface holds stays for when it is shown again)
    if (stream && !(f && stream.data.has(f.anim))) stream.ring.idle();
    layer.frame = f && drawn && { anim: f.anim, index: f.index };
    for (const [anim, quad] of layer.quads) {
      quad.visible = drawn !== null && drawn.anim === anim && !drawn.empty;
      if (drawn !== null && drawn.anim === anim) {
        // (a grid strip's atlas cell is drawn on its own part of the union rectangle, from whichever page it is on)
        const material = quad.material as MeshBasicMaterial;
        const page = layer.textures.get(anim)?.[drawn.page];
        if (page && material.map !== page) material.map = page;
        fitQuad(quad, drawn.sub);
      }
      if (quad.visible) {
        const uv = quad.geometry.getAttribute('uv');
        uv.setXY(0, drawn!.uv[0], drawn!.uv[3]);
        uv.setXY(1, drawn!.uv[2], drawn!.uv[3]);
        uv.setXY(2, drawn!.uv[2], drawn!.uv[1]);
        uv.setXY(3, drawn!.uv[0], drawn!.uv[1]);
        uv.needsUpdate = true;
      }
    }
    const still = this.maskQuads.get(id);
    if (still) still.visible = shown && drawn === null;
  }

  /** Each crew member with a card shows it while art is on (the capsule stays the hit volume); loads a card the first time it's needed. */
  private applyCards(): void {
    for (const [id, actor] of this.actors) {
      const def = this.debug.art ? this.opts.art?.card(id) : undefined;
      const texture = def ? this.cardTextures.get(id) : undefined;
      if (def && texture) {
        if (actor.cardStill !== texture) {
          const anims = def.anims;
          const player = anims ? new CardPlayer({ anims }, () => this.time) : undefined;
          player?.set({ kind: 'stand', dir: actor.lastDir });
          actor.setCard({
            texture, frames: def.frames, anchor: def.anchor,
            ...(def.pixelHeight !== undefined ? { pixelHeight: def.pixelHeight } : {}),
            ...(player ? { player, strip: (anim: number) => this.strip(id, anim) } : {}),
          });
          this.placeActor(actor, actor.position);
          // (every strip is asked for now, so the first walk or line doesn't show the last pose while its strip loads; with a memory
          // budget they come as they are needed instead)
          if (this.opts.stripBudget === undefined) for (const anim of Object.keys(anims ?? {})) this.strip(id, Number(anim));
        }
      } else {
        if (actor.card) actor.setCard(null);
        if (def && !this.cardAsked.has(id)) void this.loadCard(id, def.url);
      }
    }
  }

  /**
   * Frees the card textures of the crew who are not in this room: the away team's stay (their actors come along), and the
   * rest were only for the rooms the player has left. One that is needed again is loaded again.
   */
  private freeUnusedCards(): void {
    for (const [id, texture] of this.cardTextures) {
      if (this.actors.has(id)) continue;
      texture.dispose();
      this.cardTextures.delete(id);
      this.cardAsked.delete(id);
    }
    for (const [key, texture] of this.stripTextures) {
      if (this.actors.has(key.slice(0, key.lastIndexOf('/')))) continue;
      texture.dispose();
      this.stripTextures.delete(key);
      this.stripUsed.delete(key);
      this.stripAsked.delete(key);
    }
  }

  /** When each strip was last asked for, in presentation milliseconds: what the budget frees first. */
  private readonly stripUsed = new Map<string, number>();

  /** Frees the least recently used strips until the rest fit the budget; one asked for in the last two seconds stays (it is being played). */
  private trimStrips(): void {
    const budget = this.opts.stripBudget;
    if (budget === undefined) return;
    const size = (t: Texture): number => {
      const image = t.image as { width?: number; height?: number } | undefined;
      return textureBytes(image?.width ?? 0, image?.height ?? 0, t.generateMipmaps);
    };
    let total = 0;
    for (const t of this.stripTextures.values()) total += size(t);
    const oldest = [...this.stripTextures.keys()].sort((a, b) => (this.stripUsed.get(a) ?? 0) - (this.stripUsed.get(b) ?? 0));
    for (const key of oldest) {
      if (total <= budget) break;
      if (this.time - (this.stripUsed.get(key) ?? 0) < 2000) continue;
      const texture = this.stripTextures.get(key)!;
      total -= size(texture);
      texture.dispose();
      this.stripTextures.delete(key);
      this.stripUsed.delete(key);
      this.stripAsked.delete(key);
    }
  }

  /** An animation's strip, or undefined while it loads (the first ask starts the load). */
  private strip(id: string, anim: number): Texture | undefined {
    const key = `${id}/${anim}`;
    const have = this.stripTextures.get(key);
    if (have) {
      this.stripUsed.set(key, this.time);
      return have;
    }
    const def = this.opts.art?.card(id)?.anims?.[anim];
    if (def && !this.stripAsked.has(key)) void this.loadStrip(key, def.url);
    return undefined;
  }

  private async loadStrip(key: string, url: string): Promise<void> {
    this.stripAsked.add(key);
    const epoch = this.cardEpoch;
    try {
      const texture = await (this.opts.artLoaders ?? defaultLoaders).texture(url, true);
      if (epoch !== this.cardEpoch || !this.actors.has(key.slice(0, key.lastIndexOf('/')))) {
        texture.dispose();
        if (epoch === this.cardEpoch) this.stripAsked.delete(key);
        return;
      }
      this.stripTextures.set(key, texture);
      this.stripUsed.set(key, this.time);
      this.trimStrips();
    } catch (err) {
      this.opts.warn?.(`could not load the strip ${key} (${err instanceof Error ? err.message : String(err)}): the card keeps its still`);
    }
  }

  private async loadCard(id: string, url: string): Promise<void> {
    this.cardAsked.add(id);
    const epoch = this.cardEpoch;
    try {
      const texture = await (this.opts.artLoaders ?? defaultLoaders).texture(url, true);
      // (detached while it loaded: nobody will free it later; nor will anyone who left the room meanwhile)
      if (epoch !== this.cardEpoch || !this.actors.has(id)) {
        texture.dispose();
        if (epoch === this.cardEpoch) this.cardAsked.delete(id);
        return;
      }
      this.cardTextures.set(id, texture);
      this.applyCards();
      this.tryRelease();
    } catch (err) {
      this.opts.warn?.(`could not load ${id}'s card (${err instanceof Error ? err.message : String(err)}): using the capsule`);
      if (epoch === this.cardEpoch) {
        this.cardFailed.add(id);
        this.tryRelease();
      }
    }
  }

  /** Takes one object's mask quad and layer off the stage and frees them. */
  private dropMask(id: string): void {
    const quad = this.maskQuads.get(id);
    const layer = this.layers.get(id);
    for (const q of [...(quad ? [quad] : []), ...(layer?.quads.values() ?? [])]) {
      this.scene.remove(q);
      q.geometry.dispose();
      (q.material as Material).dispose();
    }
    layer?.stream?.ring.dispose();
    layer?.stream?.surface.dispose();
    this.maskQuads.delete(id);
    this.layers.delete(id);
    this.shownMasks.delete(id);
    this.maskMoved.delete(id);
  }

  private clearRoom(): void {
    this.takeRoom().free();
  }

  /**
   * Takes what is on show off the stage, leaving it empty: the room, its art, masks and layers, the actors (a walk one was on ends where it
   * stands) and the props. Returns them, with the background they were drawn on and what frees them.
   */
  private takeRoom(): { background: Scene['background']; parts: Object3D[]; actors: ActorView[]; free: () => void } {
    const quads = [...this.maskQuads.values()];
    const layers = [...this.layers.values()];
    const layerQuads = layers.flatMap(l => [...l.quads.values()]);
    const art = this.art;
    const room = this.room;
    const actors = [...this.actors.values(), ...this.leaving.splice(0)];
    const props = [...this.props.values()];
    const background = this.scene.background;
    for (const a of actors) this.walks.get(a)?.();
    const parts: Object3D[] = [...quads, ...layerQuads, ...(room ? [room.root] : []), ...actors.map(a => a.group), ...props];
    for (const part of parts) this.scene.remove(part);
    this.maskQuads.clear();
    this.maskMoved.clear();
    this.layers.clear();
    this.shownMasks.clear();
    this.art = null;
    this.scene.background = BACKGROUND;
    this.room = null;
    for (const el of this.spotLabels.values()) el.remove();
    this.spotLabels.clear();
    this.actors.clear();
    this.props.clear();
    this.hovered = null;
    return {
      background, parts, actors,
      free: () => {
        // (a layer's decoded cells, its one texture and the canvas behind it: the pages' bytes go with the room's art)
        for (const layer of layers) {
          layer.stream?.ring.dispose();
          layer.stream?.surface.dispose();
        }
        for (const quad of [...quads, ...layerQuads]) {
          quad.geometry.dispose();
          (quad.material as Material).dispose();
        }
        if (art) disposeRoomArt(art);
        if (room) freeGpu(room.root);
        for (const a of actors) a.dispose();
        for (const m of props) (m.material as Material).dispose();
      },
    };
  }

  /** A crew member who left the screen: taken off at the end of the task, so that a screen change in the same task can hold them in its frame. */
  private retire(actor: ActorView): void {
    this.walks.get(actor)?.();
    this.leaving.push(actor);
    if (this.leaving.length === 1) queueMicrotask(() => {
      for (const a of this.leaving.splice(0)) this.removeActor(a);
    });
  }

  /** Takes an actor off the stage; a walk it was on ends where it stands. */
  private removeActor(actor: ActorView): void {
    this.walks.get(actor)?.();
    this.scene.remove(actor.group);
    actor.dispose();
  }

  private setRoom(room: RoomView): void {
    this.clearRoom();
    // (each region and hotspot gets its own material, so opening one region or lighting one hotspot changes only it)
    // (the originals are freed: nothing else draws with them)
    for (const r of room.regions.values()) {
      const original = r.mesh.material as Material;
      r.mesh.material = original.clone();
      original.dispose();
    }
    for (const h of room.hotspots.values()) {
      const original = h.mesh.material as MeshStandardMaterial;
      const material = original.clone();
      original.dispose();
      material.transparent = true;
      material.depthWrite = false;
      h.mesh.userData.baseOpacity = material.opacity < 1 ? material.opacity : BASE_OPACITY;
      material.opacity = Number(h.mesh.userData.baseOpacity);
      h.mesh.material = material;
    }
    this.room = room;
    this.scene.add(room.root);
    this.rebuildNav();
  }

  /** The sim's region state wins over the polygon's own type (PathBlocks). */
  private isOpen(r: RoomRegion): boolean {
    return this.world?.state.regions[this.screen ?? '']?.[r.name] ?? r.walkable;
  }

  private rebuildNav(): void {
    const room = this.room;
    if (!room) return;
    const triangles: Triangle[] = [];
    for (const r of room.regions.values()) {
      const open = this.isOpen(r);
      (r.mesh.material as MeshStandardMaterial).color?.setHex(open ? WALKABLE : CLOSED);
      if (open) triangles.push(...r.triangles);
    }
    this.nav = NavMesh.build(triangles);
    // (built now, as the room loads, so the first walk round a corner doesn't stall)
    this.nav.prepare();
    this.applyDebug();
  }

  /**
   * Stands an actor at p, drawn at the size the original draws it there: on a screen with a pixel metric, the
   * floor's scale at its pixel (Screen::scaleAt, from the polygons' corners) over the fitted scale the room camera
   * already draws that row at; without one, full size.
   */
  private placeActor(actor: ActorView, p: Vec2): void {
    actor.place(p);
    let k = 1;
    const world = this.world;
    const fit = world ? screenPixels(world) : undefined;
    const floor = world ? screenFloor(world) : undefined;
    if (fit && floor && !floor.empty) {
      const px = pixelAt(fit, p);
      k = floor.scaleAt(px) / fit.scaleAt(px.y);
    }
    actor.group.scale.setScalar(k);
    const row = fit ? pixelAt(fit, p).y : undefined;
    // (cards and masks are drawn in the order of the row each stands on, as the original draws them)
    if (row !== undefined) actor.setFootRow(row);
    // (a card is drawn at the original's pixel size: R9)
    const metres = fit && row !== undefined ? this.pixelMetres(actor, fit.scaleAt(row)) : undefined;
    // (down the picture a flat screen's pixel is FLAT_DEPTH times as deep)
    actor.setPixelMetres(metres, metres !== undefined && this.room?.camera instanceof OrthographicCamera ? metres * FLAT_DEPTH : metres);
  }

  /**
   * The metres one of the original's pixels is across for an actor's card, before the floor's scale (which the actor's
   * group applies): what one pixel of the picture is at the actor's depth, times the fitted scale there over 256. The
   * room camera is fitted to the metric, so this is the metric's metres per pixel; reading it off the camera keeps a
   * card on its pixel rectangle wherever the two differ.
   */
  private pixelMetres(actor: ActorView, fitted: number): number | undefined {
    const camera = this.room?.camera;
    // (a flat screen's top-down camera draws every depth alike: its 640 columns span its frustum's width)
    if (camera instanceof OrthographicCamera) return (((camera.right - camera.left) / camera.zoom / 640) * fitted) / 256;
    if (!(camera instanceof PerspectiveCamera)) return undefined;
    camera.updateMatrixWorld(true);
    const at = new Vector3(actor.group.position.x, 0, actor.group.position.z).sub(camera.getWorldPosition(new Vector3()));
    const depth = at.dot(camera.getWorldDirection(new Vector3()));
    if (!(depth > 0)) return undefined;
    // (the picture is 480 rows for the camera's whole vertical field)
    const pixel = (2 * depth * Math.tan((camera.fov * Math.PI) / 360)) / 480;
    return (pixel * fitted) / 256;
  }

  private syncObject(id: string): void {
    const world = this.world;
    const room = this.room;
    if (!world || !room) return;
    const o = world.state.objects[id];
    const def = world.content.objects[id];
    if (!o || !def) return;
    const here = o.screen === this.screen && o.active && !o.inventory && !(def.crew && world.state.onCloseup);
    if (def.crew) {
      let actor = this.actors.get(id);
      if (!here) {
        if (actor) {
          this.actors.delete(id);
          this.retire(actor);
        }
        return;
      }
      if (!actor) {
        const crew = Object.values(world.content.objects).filter(d => d.crew).map(d => d.id);
        actor = new ActorView(id, CREW_COLORS[Math.max(0, crew.indexOf(id)) % CREW_COLORS.length], this.opts.labels ?? null);
        this.actors.set(id, actor);
        this.scene.add(actor.group);
      }
      if (this.arriving.has(id)) actor.dissolve(0);
      actor.setName(o.name);
      if (!actor.walker) this.placeActor(actor, o.pos);
      actor.setDown(world.isIncapacitated(id));
      this.applyCards();
      return;
    }
    this.syncMask(id);
    const mesh = room.hotspots.get(id)?.mesh ?? this.prop(id, room);
    if (!mesh) return;
    mesh.visible = here;
    // (a hotspot's box stands where the lifter put it, which for a sprite with its own position is not the object's marker: the
    // original draws and picks the sprite there. It keeps that offset from the object, so it still follows an object that moves.)
    let offset = mesh.userData.offset as { x: number; z: number } | undefined;
    if (!offset) {
      const marker = room.hotspots.has(id) ? room.markers.get(id) : undefined;
      offset = marker ? { x: mesh.position.x - marker.x, z: mesh.position.z - marker.z } : { x: 0, z: 0 };
      mesh.userData.offset = offset;
    }
    mesh.position.x = o.pos.x + offset.x;
    mesh.position.z = o.pos.z + offset.z;
  }

  /** In a made-up room, every object gets a box to click; in a modelled one, only hotspots can be clicked. */
  private prop(id: string, room: RoomView): Mesh | undefined {
    if (room.modelled) return undefined;
    let mesh = this.props.get(id);
    if (!mesh) {
      mesh = new Mesh(PROP_GEOMETRY, new MeshStandardMaterial({ color: 0xd4a017, transparent: true, opacity: 0.6 }));
      mesh.position.y = 0.5;
      mesh.userData.object = id;
      this.props.set(id, mesh);
      this.scene.add(mesh);
    }
    return mesh;
  }

  private pickables(): Object3D[] {
    const world = this.world;
    const room = this.room;
    if (!world || !room) return [];
    const out: Object3D[] = [];
    for (const a of this.actors.values()) out.push(a.body);
    for (const [id, h] of room.hotspots) {
      const o = world.state.objects[id];
      // (a hotspot with its rectangle is picked by that, in rectHits)
      if (h.pickable && !h.rect && h.mesh.visible && o?.active && o.screen === this.screen) out.push(h.mesh);
    }
    for (const m of this.props.values()) if (m.visible) out.push(m);
    return out;
  }

  /**
   * Of the objects under the pointer (nearest first), the one the original draws in front: objectAt checks objects in
   * draw order, front first (unity.cpp:239-241), and draws by the row each one stands on (DrawOrderComparison, the
   * object's y: unity.cpp:209-220). A hotspot's box reaches toward the camera from where its object stands, so the
   * nearest box isn't always the object drawn in front; the lowest ground point on the screen is. Ties go to the nearest.
   */
  private frontmost(hits: Object3D[], room: RoomView, rects: { id: string; row: number }[] = []): string | undefined {
    let best: string | undefined;
    let bestRow = -Infinity;
    let bestActor = false;
    for (const object of hits) {
      const id = String(object.userData.object);
      const actor = this.actors.get(id);
      const ground = (actor ? actor.group : object).getWorldPosition(new Vector3());
      ground.y = 0;
      // (lower on the screen is a larger row: the original's y, in its pixels as the rectangles' rows are. A character stands at a whole pixel of the
      // screen, which is that y; the camera's projection of the same point can be a pixel or two off, enough to put one behind a rectangle at the
      // row next to its own)
      const row = (actor ? this.footPixel(id)?.y : undefined) ?? ((1 - ground.project(room.camera).y) / 2) * SCREEN_H;
      if (row > bestRow) {
        best = id;
        bestRow = row;
        bestActor = actor !== undefined;
      }
    }
    // (the rectangles' own rows: the one checked first, which is the one drawn in front, wins; a later object wins a tie, as the original's last-first walk of its list does.
    // The team is added to the screen's list after its own objects (awayteam.cpp:303), so a character standing on the very row of a rectangle's object is the later one)
    for (const r of rects) {
      if (r.row > bestRow || (r.row === bestRow && !bestActor)) {
        best = r.id;
        bestRow = r.row;
        bestActor = false;
      }
    }
    return best;
  }

  private meshOf(id: string): Mesh | undefined {
    return this.actors.get(id)?.body ?? this.room?.hotspots.get(id)?.mesh ?? this.props.get(id);
  }

  private centre(id: string): Vector3 | null {
    const mesh = this.meshOf(id);
    if (!mesh) return null;
    this.scene.updateMatrixWorld();
    return mesh.getWorldPosition(new Vector3());
  }

  private highlight(id: string | null, on: boolean): void {
    if (id === null) return;
    this.actors.get(id)?.setHighlight(on);
    const mesh = this.room?.hotspots.get(id)?.mesh ?? this.props.get(id);
    if (!mesh) return;
    const base = this.debug.hotspots ? DEBUG_OPACITY : Number(mesh.userData.baseOpacity ?? 0.6);
    (mesh.material as MeshStandardMaterial).opacity = on ? HOVER_OPACITY : base;
  }

  /** The player's names and outlines over the clickable areas, by object: a box over each pickable object's rectangle in the original's 640x480. */
  private readonly spotLabels = new Map<string, HTMLElement>();

  private placeSpotLabels(layer: HTMLElement, room: RoomView, w: number, h: number): void {
    const world = this.world;
    const wanted = new Set<string>();
    if (world && this.opts.hotspotLabels?.() === true) {
      for (const [id, spot] of room.hotspots) {
        const o = world.state.objects[id];
        if (!spot.rect || !spot.pickable || !o?.active || o.inventory || o.screen !== this.screen || o.name === '') continue;
        wanted.add(id);
        let el = this.spotLabels.get(id);
        if (!el) {
          el = layer.appendChild(document.createElement('div'));
          el.className = 'au-hotspot';
          this.spotLabels.set(id, el);
        }
        if (el.textContent !== o.name) el.textContent = o.name;
        const [x0, y0, x1, y1] = spot.rect;
        el.style.cssText = `left:${(x0 / SCREEN_W) * w}px;top:${(y0 / SCREEN_H) * h}px;width:${((x1 - x0) / SCREEN_W) * w}px;height:${((y1 - y0) / SCREEN_H) * h}px`;
      }
    }
    for (const [id, el] of this.spotLabels) {
      if (wanted.has(id)) continue;
      el.remove();
      this.spotLabels.delete(id);
    }
  }

  private placeLabels(): void {
    const layer = this.opts.labels;
    const room = this.room;
    if (!layer) return;
    // (no room on show, as aboard the ship: no room's names either)
    if (!room) {
      for (const el of this.spotLabels.values()) el.remove();
      this.spotLabels.clear();
      return;
    }
    // (while a frame is held, what is on show is the room left: the next room's names wait for it)
    if (this.held) {
      for (const el of this.spotLabels.values()) el.remove();
      this.spotLabels.clear();
      for (const a of this.actors.values()) if (a.label) a.label.style.visibility = 'hidden';
      return;
    }
    const w = layer.clientWidth;
    const h = layer.clientHeight;
    this.placeSpotLabels(layer, room, w, h);
    this.scene.updateMatrixWorld();
    for (const a of this.actors.values()) {
      if (!a.label) continue;
      // (over the head of an actor drawn at the floor's scale)
      const p = new Vector3(a.group.position.x, (a.headHeight() + 0.25) * a.group.scale.y, a.group.position.z).project(room.camera);
      // (a card hidden entirely behind a painted object leaves its name tag behind with it)
      a.label.style.visibility = this.cardHidden(a, room.camera) ? 'hidden' : '';
      a.label.style.transform = `translate(${((p.x + 1) / 2) * w}px, ${((1 - p.y) / 2) * h}px) translate(-50%, -100%)`;
    }
  }

  /** Whether a card is fully behind masks that are showing (their depth rows are below it: the original draws them after it). */
  private cardHidden(a: ActorView, camera: PerspectiveCamera | OrthographicCamera): boolean {
    const masks = this.art?.masks;
    if (!a.card || !masks || masks.length === 0 || !this.artState().on) return false;
    const toPixel = (v: Vector3) => ({ x: ((v.x + 1) / 2) * 640, y: ((1 - v.y) / 2) * 480 });
    const feet = toPixel(new Vector3(a.group.position.x, 0, a.group.position.z).project(camera));
    const head = toPixel(new Vector3(a.group.position.x, a.headHeight() * a.group.scale.y, a.group.position.z).project(camera));
    const height = feet.y - head.y;
    const width = height * a.cardAspect();
    const [ax] = a.cardFeet();
    const left = feet.x - ax * width;
    const showing: Occluder[] = masks.filter(m => this.shownMasks.has(m.object));
    return fullyOccluded([left, head.y, left + width, feet.y], feet.y, showing);
  }

  private applyDebug(): void {
    for (const child of [...this.debugLayer.children]) {
      this.debugLayer.remove(child);
      if (child instanceof LineSegments) {
        child.geometry.dispose();
        (child.material as Material).dispose();
      }
    }
    const room = this.room;
    if (!room) return;
    for (const h of room.hotspots.values()) {
      const m = h.mesh.material as MeshStandardMaterial;
      m.opacity = this.debug.hotspots ? DEBUG_OPACITY : Number(h.mesh.userData.baseOpacity ?? BASE_OPACITY);
      // (hotspots a click can't pick show as wireframes)
      m.wireframe = this.debug.hotspots && !h.pickable;
    }
    if (this.debug.hotspots) {
      // (each hotspot's original rectangle, in screen space over the plate: the greybox's boxes are only where they stand)
      const outlines = rectOutlines(room.camera, [...room.hotspots.values()]);
      if (outlines) this.debugLayer.add(outlines);
    }
    if (this.debug.markers) {
      for (const p of room.markers.values()) {
        const dot = new Mesh(MARKER_GEOMETRY, MARKER_MATERIAL);
        dot.position.set(p.x, 0.05, p.z);
        this.debugLayer.add(dot);
      }
    }
    if (this.debug.navmesh) {
      const points: number[] = [];
      for (const [a, b, c] of this.nav.triangles) {
        for (const [p, q] of [[a, b], [b, c], [c, a]] as const) points.push(p.x, 0.02, p.z, q.x, 0.02, q.z);
      }
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new Float32BufferAttribute(points, 3));
      this.debugLayer.add(new LineSegments(geometry, new LineBasicMaterial({ color: 0x00ff88 })));
    }
  }
}
