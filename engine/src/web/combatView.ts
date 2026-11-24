// SPDX-License-Identifier: GPL-3.0-or-later
import type { Camera, Scene, WebGLRenderer } from 'three';
import type { CombatData } from '../content/types';
import type { BattleState } from '../sim/combat/types';
import type { BattleAssets } from '../view/combat/assets';
import type { DrawnEffect, DrawnShip, SpaceScene, SpaceSceneOptions } from '../view/combat/spaceScene';
import type { WarpOverlay } from '../view/combat/warpOverlay';
import type { Box } from '../view/combat/targetMarks';
import type { ScaledView } from '../view/combat/scaledView';
import type { Viewport } from '../view/shipSet';
import { REDUCED_FLASH } from '../view/combat/files';
import { PREVIEW_RECT, previewBattle, turnPreview } from '../view/combat/optionsPreview';
import { FULL_RECT, SPLIT_RECT } from '../view/combat/projection';
import { DEFAULT_SETTINGS, type CombatOptions } from './settings';

/** The longest a scene's warm-up holds its first frame back (CombatViewHost.warm). */
export const WARM_LIMIT_MS = 5000;

/** The combat chunk's module (M8 spec §8): the space view, loaded the first time a battle is drawn. */
export type SpaceSceneModule = typeof import('../view/combat/spaceScene');

/** What the view draws: a battle, its lifted data and its loaded set. */
export interface CombatViewSource {
  b: BattleState; combat: CombatData; assets: BattleAssets;
  /** The last frame flashed the bridge red (WorldBattle.redFlash: tactical.cpp:484-487). */
  redFlash?: boolean;
  /** The battle isn't stepping (paused, resolved, the world busy): no flash shows, and a held one ends, review #4. */
  still?: boolean;
  /** The warp overlay is up, this many battle ms into it (WorldBattle.warpHold). */
  warp?: number;
  /** The wide view's HUD's boxes on the window (hudKeepOut), which the target's arrow keeps clear of. */
  keepOut?: readonly Box[];
}

/** A rectangle as getBoundingClientRect gives it (CSS pixels). */
type ClientRect = Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom' | 'width' | 'height'>;

/**
 * The wide view's HUD panels (`panels`, CSS pixels, as tactical.tsx reads them: the strip, the target, the log, the fire
 * buttons and whatever is under the HUD) as boxes of a window `width` units across `frame` (viewWindow's: the frame's scale
 * either way). An empty panel keeps nothing out.
 */
export function hudKeepOut(frame: ClientRect, panels: readonly ClientRect[], width: number): Box[] {
  if (frame.width <= 0) return [];
  const k = width / frame.width;
  return panels.filter(p => p.width > 0 && p.height > 0)
    .map((p): Box => [(p.left - frame.left) * k, (p.top - frame.top) * k, (p.right - frame.left) * k, (p.bottom - frame.top) * k]);
}

/** The view's state for `?dev` and the tests. */
export interface CombatViewState {
  /** The combat chunk: not asked for yet, loading, loaded, or failed. */
  module: 'none' | 'loading' | 'ready' | 'failed';
  /** A scene is up for this battle. */
  drawing: boolean;
  /** What is drawn instead of the view: the warp overlay (showWarp), or nothing. */
  overlay: 'warp' | null;
  scenario: number | null;
  /** Where the Combat Options' preview was last drawn (device pixels, y up), while the screen is up; else null (Plan 32 Task 11). */
  preview: Viewport | null;
  /** The drawn battle's steps (BattleState.steps), for the tests. */
  steps: number | null;
  wide: boolean;
  parity: boolean;
  /** The window, in the original's units. */
  window: { width: number; height: number } | null;
  /** Where the view is drawn on the canvas (device pixels, y up), as the renderer's viewport. */
  viewport: Viewport | null;
  ships: readonly DrawnShip[];
  /** The effects drawn (SpaceScene.effectsDrawn). */
  effects: readonly DrawnEffect[];
}

/** What the session draws this frame through the renderer's `over` viewport: a scene and camera in the box, and what follows (the bloom). */
export interface CombatViewFrame {
  scene: Scene; camera: Camera; viewport: Viewport;
  /** Drawn first, before the box is cleared and `scene` drawn in it: Resolution 2's view at half its scale (scaledView.ts). */
  before?: (r: WebGLRenderer) => void;
  after: (r: WebGLRenderer) => void;
}

/**
 * Where the view goes in a 640 x 480 box (a viewport, device pixels, y up): Split's 320 x 220 rectangle of the console
 * (tactical.cpp:38-41), or, wide, the whole box (Plan 27 fills the frame and adds the HUD). The window is in the
 * original's units: Split's 320 x 220; wide 640 across.
 */
export function viewWindow(box: Viewport, wide: boolean): { viewport: Viewport; width: number; height: number } {
  if (wide) return { viewport: box, width: FULL_RECT.width, height: Math.max(1, Math.round((FULL_RECT.width * box.height) / Math.max(1, box.width))) };
  const sx = box.width / 640, sy = box.height / 480;
  const left = Math.round(SPLIT_RECT.x * sx), right = Math.round((SPLIT_RECT.x + SPLIT_RECT.width) * sx);
  const top = Math.round(SPLIT_RECT.y * sy), bottom = Math.round((SPLIT_RECT.y + SPLIT_RECT.height) * sy);
  return { viewport: { x: box.x + left, y: box.y + box.height - bottom, width: right - left, height: bottom - top }, width: SPLIT_RECT.width, height: SPLIT_RECT.height };
}

/**
 * The space view in the game (M8 spec §3; behind `?dev` until the switch-on): the combat chunk, loaded the first time a
 * battle is drawn, and one scene for the battle being drawn, made when its set is ready and freed when the set goes.
 */
export class CombatViewHost {
  private module: SpaceSceneModule | null = null;
  private moduleState: CombatViewState['module'] = 'none';
  /** `ready`: the scene's warm-up is done (or there is none), and it may be drawn. */
  private current: { assets: BattleAssets; scene: SpaceScene; scenario: number; warp: WarpOverlay | null; scaled: ScaledView | null; ready: boolean; warmLimit?: ReturnType<typeof setTimeout> } | null = null;
  /** The set whose battle last asked for the chunk. */
  private failedFor: BattleAssets | null = null;
  private last: Omit<CombatViewState, 'module' | 'preview'> = { drawing: false, overlay: null, scenario: null, steps: null, wide: false, parity: false, window: null, viewport: null, ships: [], effects: [] };
  /**
   * The Combat Options' preview (Plan 32 Task 11): a scene of its own for the battle's set, drawing the preview's battle (the Enterprise alone,
   * optionsPreview.ts) kept for the battle it came from, and where it was last drawn. Freed as the screen closes and with the battle's scene.
   */
  private previewOf: { assets: BattleAssets; from: BattleState; b: BattleState; scene: SpaceScene; scaled: ScaledView | null; viewport: Viewport | null } | null = null;
  /** The drawn scene's effects on the window, asked for only by state() (the dev hooks and the tests), not each frame. */
  private effectsNow: () => readonly DrawnEffect[] = () => [];
  /** The parity mode (M8 spec §9.3): set by `?dev`. */
  parity = false;
  /** The battle and step a red flash was taken at, or null (a preview at the same step is another battle). */
  private flashAt: { b: BattleState; step: number } | null = null;
  /** The red flash the last frame drew (0, REDUCED_FLASH or 1), which the console's palette shows too (Plan 27 R11). */
  private flashNow = 0;

  constructor(
    private readonly load: () => Promise<SpaceSceneModule>,
    private readonly warn: (message: string) => void,
    private readonly changed: () => void,
    /** prefers-reduced-motion, asked each frame (M8 spec §3.2: the shimmer steady, the red flash at 40%). */
    private readonly reducedMotion: () => boolean = () => false,
    /** The Combat Options (Plan 32: the settings' `combat`), asked each frame. */
    private readonly combatOptions: () => CombatOptions = () => DEFAULT_SETTINGS.combat,
    /**
     * Runs a job on the renderer between frames (SessionParts.prepare): a new scene's warm-up (SpaceScene.warm, Plan 34 Task
     * 8), which the scene waits for before its first frame. Without it (the tests) a scene draws at once.
     */
    private readonly prepare?: (job: (r: WebGLRenderer) => Promise<void>) => Promise<void>,
  ) {}

  /**
   * The scene to draw this frame for `source` in `box`, placed for the battle as it is now; null while the chunk or the set
   * is loading, or with no source (and then the last scene is freed).
   */
  frame(source: CombatViewSource | null, box: Viewport | null): CombatViewFrame | null {
    if (!source || !box) {
      this.release();
      return null;
    }
    // (a chunk that failed is asked for again by the next battle, not every frame of this one)
    if (this.moduleState === 'failed' && this.failedFor !== source.assets) this.moduleState = 'none';
    if (this.moduleState === 'none') this.failedFor = source.assets;
    const module = this.module ?? this.start();
    if (!module) return null;
    if (this.current?.assets !== source.assets) {
      this.release();
      const { width, height, viewport } = viewWindow(box, source.b.view.wide);
      const scene = new module.SpaceScene(source.assets, source.combat, source.b.view.seed, { width, height, parity: this.parity, detail: this.combatOptions().detail });
      this.current = { assets: source.assets, scenario: source.b.scenario, scene, warp: null, scaled: null, ready: !this.prepare };
      if (this.prepare) this.warm(this.current, viewport);
    }
    // (the battle's first frame waits for its programs and bloom: the frame is drawn without the view meanwhile, as while the set loads)
    if (!this.current.ready) return null;
    // (the Enterprise warping away: the overlay over the whole box, as showWarp draws it over the whole screen, and no view)
    if (source.warp !== undefined) {
      let warp = this.current.warp;
      if (!warp) {
        warp = this.current.warp = new module.WarpOverlay(source.assets);
        for (const p of warp.problems) this.warn(p);
      }
      warp.update(source.warp);
      this.last = { ...this.last, drawing: true, overlay: 'warp', steps: source.b.steps, viewport: box, ships: [], effects: [] };
      this.effectsNow = () => [];
      return { scene: warp.scene, camera: warp.camera, viewport: box, after: () => {} };
    }
    const { viewport, width, height } = viewWindow(box, source.b.view.wide);
    // (ScummVM's red flash lasts one main-loop pass, about 16 ms: TacticalScreen::update sets palette entry 0 red and the
    // next pass, with or without a step, sets it back (tactical.cpp:484-493; Combat::update steps every 66 ms,
    // combat.cpp:411-417). The view holds it from the frame that took it until the next step, about 66 ms, as its own
    // choice, so it is seen (Plan 26 R8), and at 40% under prefers-reduced-motion. The parity mode shows the original's:
    // the frame's flag alone (WorldBattle.redFlash is the battle's for one world frame), at full strength.)
    const calm = this.reducedMotion();
    let flash: number;
    if (source.still) {
      this.flashAt = null;
      flash = 0;
    } else if (this.parity) flash = source.redFlash ? 1 : 0;
    else {
      if (source.redFlash) this.flashAt = { b: source.b, step: source.b.steps };
      flash = this.flashAt?.b === source.b && this.flashAt.step === source.b.steps ? (calm ? REDUCED_FLASH : 1) : 0;
    }
    this.flashNow = flash;
    // (the Combat Options, which the parity mode ignores: the original's look, for the screenshot check)
    const combat = this.combatOptions();
    const options: SpaceSceneOptions = { width, height, parity: this.parity, reducedMotion: calm, flash, stars: combat.stars, detail: combat.detail, radar: combat.radar, ...(source.keepOut ? { keepOut: source.keepOut } : {}) };
    const scale = !this.parity && combat.resolution === 2 ? 0.5 : 1;
    const scene = this.current.scene;
    scene.setOptions(options);
    scene.setPixelScale((viewport.width / width) * scale);
    scene.update(source.b);
    this.last = { drawing: true, overlay: null, scenario: source.b.scenario, steps: source.b.steps, wide: source.b.view.wide, parity: this.parity, window: { width, height }, viewport, ships: scene.drawn(), effects: [] };
    this.effectsNow = () => scene.effectsDrawn();
    if (scale < 1) {
      // (Resolution 2: the view and its bloom drawn at half scale first, then that picture over the box, its pixels doubled)
      const scaled = this.current.scaled ??= new module.ScaledView();
      return { scene: scaled.scene, camera: scaled.camera, viewport, before: r => scaled.draw(r, scene.scene, scene.camera, viewport, scale, r2 => scene.postRender(r2)), after: () => {} };
    }
    // (the bloom over the view, once the renderer has drawn it: bloom.ts)
    return { scene: scene.scene, camera: scene.camera, viewport, after: r => scene.postRender(r) };
  }

  /**
   * The Combat Options' preview for `source` in `viewport` (device pixels, y up: the screen's window over (399,128)-(547,269)), at `wall` ms of
   * the wall clock: the Enterprise alone, turning, drawn by a second SpaceScene through the same renderer (M8 Decision 4) with the options as
   * they are now (its stars, its detail, its resolution). The battle's own scene is kept, undrawn meanwhile. Null until the chunk is in.
   */
  optionsPreview(source: CombatViewSource, viewport: Viewport, wall: number): CombatViewFrame | null {
    const module = this.module;
    if (!module) return null;
    let p = this.previewOf;
    if (p?.assets !== source.assets || p.from !== source.b) {
      this.releasePreview();
      const b = previewBattle(source.b, source.combat);
      if (!b) return null;
      const scene = new module.SpaceScene(source.assets, source.combat, source.b.view.seed, { width: PREVIEW_RECT.width, height: PREVIEW_RECT.height, parity: false });
      p = this.previewOf = { assets: source.assets, from: source.b, b, scene, scaled: null, viewport: null };
    }
    const calm = this.reducedMotion();
    const combat = this.combatOptions();
    const { width, height } = PREVIEW_RECT;
    const scale = combat.resolution === 2 ? 0.5 : 1;
    // (the battle's own now and camera, so the stars sit as the battle's; the preview's ship turned)
    p.b.now = source.b.now;
    p.b.lastStep = source.b.now - 1e9;
    turnPreview(p.b, wall, calm);
    p.scene.setOptions({ width, height, parity: false, reducedMotion: calm, flash: 0, stars: combat.stars, detail: combat.detail, radar: combat.radar });
    p.scene.setPixelScale((viewport.width / width) * scale);
    p.scene.update(p.b);
    p.viewport = viewport;
    const scene = p.scene;
    if (scale < 1) {
      const scaled = p.scaled ??= new module.ScaledView();
      return { scene: scaled.scene, camera: scaled.camera, viewport, before: r => scaled.draw(r, scene.scene, scene.camera, viewport, scale, r2 => scene.postRender(r2)), after: () => {} };
    }
    return { scene: scene.scene, camera: scene.camera, viewport, after: r => scene.postRender(r) };
  }

  /**
   * Starts `current`'s warm-up, and marks it ready when it is done, has failed (said, and the view drawn anyway) or has taken
   * WARM_LIMIT_MS (a lost context's compile, which never says it is done). A scene freed meanwhile is left as it is.
   */
  private warm(current: NonNullable<CombatViewHost['current']>, viewport: Viewport): void {
    const limit = new Promise<void>(resolve => { current.warmLimit = setTimeout(resolve, WARM_LIMIT_MS); });
    const done = () => {
      clearTimeout(current.warmLimit);
      if (this.current !== current) return;
      current.ready = true;
      this.changed();
    };
    Promise.race([this.prepare!(r => current.scene.warm(r, viewport)), limit]).then(done, (err: unknown) => {
      this.warn(`The space view's warm-up failed (${err instanceof Error ? err.message : String(err)}): it is drawn without.`);
      done();
    });
  }

  /** Frees the Combat Options' preview (the screen closed): its scene and its half-scale picture. */
  releasePreview(): void {
    this.previewOf?.scene.dispose();
    this.previewOf?.scaled?.dispose();
    this.previewOf = null;
  }

  /** Whether the last frame drew the view or the overlay: state()'s `drawing`, without the effects' list it works out. */
  get drawing(): boolean {
    return this.last.drawing;
  }

  /**
   * The ship drawn at (fx, fy) of the view's box, each a fraction of its width and height from the top left (a click on the
   * view: SpaceScene.pick), or null: none there, nothing drawn, or the warp overlay up (Plan 29 R6).
   */
  pick(fx: number, fy: number): number | null {
    const window = this.last.window;
    if (!this.current || this.last.overlay !== null || !this.last.drawing || !window) return null;
    return this.current.scene.pick(fx * window.width, fy * window.height);
  }

  /** The red flash the last frame drew, held as the view holds it (0 while nothing draws, and under the warp overlay). */
  get flash(): number {
    return this.last.drawing && this.last.overlay === null ? this.flashNow : 0;
  }

  /** The combat chunk, once loaded (the console's code is in it: Plan 27 R2). */
  get chunk(): SpaceSceneModule | null {
    return this.module;
  }

  state(): CombatViewState {
    return { module: this.moduleState, ...this.last, preview: this.previewOf?.viewport ?? null, effects: this.effectsNow() };
  }

  /** Frees the scene (not the set: its holder frees that). */
  release(): void {
    this.releasePreview();
    this.flashAt = null;
    clearTimeout(this.current?.warmLimit);
    this.current?.scene.dispose();
    this.current?.warp?.dispose();
    this.current?.scaled?.dispose();
    this.current = null;
    this.last = { ...this.last, drawing: false, overlay: null, viewport: null, ships: [], effects: [] };
    this.effectsNow = () => [];
  }

  /** Starts loading the chunk, once; null until it is in. */
  private start(): SpaceSceneModule | null {
    if (this.moduleState !== 'none') return null;
    this.moduleState = 'loading';
    this.load().then(m => {
      this.module = m;
      this.moduleState = 'ready';
      this.changed();
    }, (err: unknown) => {
      // (offline before the chunk was ever fetched: the battle goes on, undrawn, and the next frame doesn't ask again)
      this.moduleState = 'failed';
      this.warn(`combat: the space view could not be loaded: ${err instanceof Error ? err.message : String(err)}`);
      this.changed();
    });
    return null;
  }
}
