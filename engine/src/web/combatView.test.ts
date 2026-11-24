// SPDX-License-Identifier: GPL-3.0-or-later
import { PerspectiveCamera, Scene, type WebGLRenderer } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { miniBattle, miniCombat } from '../testing/combat';
import type { BattleAssets } from '../view/combat/assets';
import { ScaledView } from '../view/combat/scaledView';
import { DEFAULT_SETTINGS, type CombatOptions } from './settings';
import { CombatViewHost, hudKeepOut, viewWindow, WARM_LIMIT_MS, type SpaceSceneModule } from './combatView';

describe('viewWindow (tactical.cpp:38-46)', () => {
  it('puts Split in its 320 x 220 rectangle at (319, 23) of the 640 x 480 box, at the box\'s scale, y up', () => {
    expect(viewWindow({ x: 0, y: 0, width: 640, height: 480 }, false)).toEqual({ viewport: { x: 319, y: 237, width: 320, height: 220 }, width: 320, height: 220 });
    // (twice the size, offset: (638, 46) to (1278, 486) of a 1280 x 960 box at (100, 50))
    expect(viewWindow({ x: 100, y: 50, width: 1280, height: 960 }, false).viewport).toEqual({ x: 738, y: 524, width: 640, height: 440 });
  });

  it('fills the box when wide, 640 units across and as tall as the box\'s aspect makes it', () => {
    expect(viewWindow({ x: 0, y: 0, width: 1280, height: 960 }, true)).toEqual({ viewport: { x: 0, y: 0, width: 1280, height: 960 }, width: 640, height: 480 });
  });
});

describe('hudKeepOut (Task 9 review)', () => {
  it('puts the HUD\'s boxes on the wide window, 640 units across the frame', () => {
    // (a 1280 x 720 CSS-pixel frame at (100, 50): two CSS pixels a unit, the window 640 x 360)
    const frame = { left: 100, top: 50, right: 1380, bottom: 770, width: 1280, height: 720 };
    const target = { left: 1000, top: 62, right: 1364, bottom: 150, width: 364, height: 88 };
    expect(hudKeepOut(frame, [target], 640)).toEqual([[450, 6, 632, 50]]);
    // (an empty box, a panel with nothing in it, keeps nothing out)
    expect(hudKeepOut(frame, [{ left: 200, top: 60, right: 200, bottom: 60, width: 0, height: 0 }], 640)).toEqual([]);
    expect(hudKeepOut({ ...frame, width: 0 }, [target], 640)).toEqual([]);
  });
});

describe('CombatViewHost', () => {
  const set = (): BattleAssets => ({ list: { models: [], sprites: [] }, models: new Map(), sprites: new Map(), stills: null, missing: [], textures: [], dispose: () => {} });
  const BOX = { x: 0, y: 0, width: 640, height: 480 };
  class FakeScene {
    static made = 0;
    static freed = 0;
    scene = new Scene();
    camera = new PerspectiveCamera();
    constructor() { FakeScene.made++; }
    setOptions() {}
    setPixelScale() {}
    update() {}
    drawn() { return []; }
    effectsDrawn() { return []; }
    dispose() { FakeScene.freed++; }
  }
  const module = { SpaceScene: FakeScene } as unknown as SpaceSceneModule;

  it('says whether it draws without listing the effects (the tactical panel asks every render; only the hooks ask for the list)', async () => {
    let listed = 0;
    // (a scene of its own, not FakeScene, whose counts the next tests read)
    class Counting {
      scene = new Scene();
      camera = new PerspectiveCamera();
      setOptions() {}
      setPixelScale() {}
      update() {}
      drawn() { return []; }
      effectsDrawn() { listed++; return []; }
      dispose() {}
    }
    const host = new CombatViewHost(async () => ({ SpaceScene: Counting }) as unknown as SpaceSceneModule, () => {}, () => {});
    const { b } = miniBattle();
    const a = set();
    expect(host.drawing).toBe(false);
    host.frame({ b, combat: miniCombat(), assets: a }, BOX);
    await Promise.resolve();
    host.frame({ b, combat: miniCombat(), assets: a }, BOX);
    expect([host.drawing, listed]).toEqual([true, 0]);
    expect([host.state().drawing, listed]).toEqual([true, 1]);
    host.frame(null, BOX);
    expect(host.drawing).toBe(false);
  });

  it('loads the chunk once, as the first battle is drawn; makes a scene per set and frees it when the set or the battle goes', async () => {
    let loads = 0;
    const host = new CombatViewHost(async () => { loads++; return module; }, () => {}, () => {});
    const { b } = miniBattle();
    const a = set();
    expect(host.frame({ b, combat: miniCombat(), assets: a }, BOX)).toBeNull();
    await Promise.resolve();
    expect(host.frame({ b, combat: miniCombat(), assets: a }, BOX)?.viewport).toEqual({ x: 319, y: 237, width: 320, height: 220 });
    host.frame({ b, combat: miniCombat(), assets: a }, BOX);
    expect([loads, FakeScene.made, FakeScene.freed]).toEqual([1, 1, 0]);
    host.frame({ b, combat: miniCombat(), assets: set() }, BOX);
    expect([FakeScene.made, FakeScene.freed]).toEqual([2, 1]);
    expect(host.frame(null, BOX)).toBeNull();
    expect([FakeScene.freed, host.state().drawing]).toEqual([2, false]);
  });

  it('says once that a chunk which fails to load (offline, never fetched) is missing, draws nothing, and asks again for the next battle', async () => {
    const warned: string[] = [];
    let loads = 0;
    let changed = 0;
    const host = new CombatViewHost(async () => { loads++; throw new Error('offline'); }, m => warned.push(m), () => changed++);
    const { b } = miniBattle();
    const a = set();
    for (let i = 0; i < 3; i++) {
      expect(host.frame({ b, combat: miniCombat(), assets: a }, BOX)).toBeNull();
      await Promise.resolve();
      await Promise.resolve();
    }
    expect([loads, warned, host.state().module]).toEqual([1, ['combat: the space view could not be loaded: offline'], 'failed']);
    // (the failure is told to the store, as the arrival is: Plan 25 review #5)
    expect(changed).toBe(1);
    host.frame({ b, combat: miniCombat(), assets: set() }, BOX);
    expect(loads).toBe(2);
  });

  it('tells the scene of prefers-reduced-motion each frame, and hands the renderer the scene\'s bloom to draw after it', async () => {
    const options: unknown[] = [];
    const after: unknown[] = [];
    class Scene2 extends FakeScene {
      override setOptions(o?: unknown) { options.push(o); }
      postRender(r: unknown) { after.push(r); }
    }
    let calm = false;
    const host = new CombatViewHost(async () => ({ SpaceScene: Scene2 }) as unknown as SpaceSceneModule, () => {}, () => {}, () => calm);
    const { b } = miniBattle();
    const a = set();
    host.frame({ b, combat: miniCombat(), assets: a }, BOX);
    await Promise.resolve();
    host.frame({ b, combat: miniCombat(), assets: a }, BOX);
    calm = true;
    const drawn = host.frame({ b, combat: miniCombat(), assets: a }, BOX)!;
    const opts = { stars: true, detail: 'high', radar: true };
    expect(options).toEqual([{ width: 320, height: 220, parity: false, reducedMotion: false, flash: 0, ...opts }, { width: 320, height: 220, parity: false, reducedMotion: true, flash: 0, ...opts }]);
    drawn.after('renderer' as never);
    expect(after).toEqual(['renderer']);
  });

  it('shows a red flash from the frame that took it until the next step, at 40% under prefers-reduced-motion; the parity mode, the original\'s: its frame alone, at full strength', async () => {
    const flashes: number[] = [];
    class Scene3 extends FakeScene {
      override setOptions(o?: { flash: number }) { flashes.push(o!.flash); }
    }
    let calm = false;
    const host = new CombatViewHost(async () => ({ SpaceScene: Scene3 }) as unknown as SpaceSceneModule, () => {}, () => {}, () => calm);
    const { b } = miniBattle();
    const a = set();
    const frameOf = (battle: typeof b, redFlash: boolean) => host.frame({ b: battle, combat: miniCombat(), assets: a, redFlash }, BOX);
    const frame = (redFlash: boolean) => frameOf(b, redFlash);
    // (the first frame asks for the chunk and draws nothing)
    frame(false);
    await Promise.resolve();
    frame(false);
    // (the flag is the battle's for one frame (tacticalScreen.ts afterUpdate); the flash holds until the next step)
    frame(true);
    frame(false);
    b.steps++;
    frame(false);
    calm = true;
    frame(true);
    frame(false);
    // (a ?dev preview on the same set at the same step is another battle: it has no flash of this one's, review #5)
    frameOf({ ...b }, false);
    // (the parity mode: the frame that took it alone, as ScummVM's one main-loop pass, and at full strength)
    host.parity = true;
    b.steps++;
    frame(true);
    frame(false);
    // (a still battle (paused, the world busy) shows none, and the held one ends)
    host.parity = false;
    calm = false;
    b.steps++;
    frame(true);
    host.frame({ b, combat: miniCombat(), assets: a, redFlash: false, still: true }, BOX);
    frame(false);
    expect(flashes).toEqual([0, 1, 1, 0, 0.4, 0.4, 0, 1, 0, 1, 0, 0]);
  });

  it('gives the console the flash it drew, none while the warp overlay shows or nothing draws (Plan 27 R11)', async () => {
    const host = new CombatViewHost(async () => ({ SpaceScene: FakeScene, WarpOverlay: class { scene = new Scene(); camera = new PerspectiveCamera(); problems = []; update() {} dispose() {} } }) as unknown as SpaceSceneModule, () => {}, () => {}, () => true);
    const { b } = miniBattle();
    const a = set();
    host.frame({ b, combat: miniCombat(), assets: a }, BOX);
    await Promise.resolve();
    expect(host.chunk).not.toBeNull();
    host.frame({ b, combat: miniCombat(), assets: a, redFlash: true }, BOX);
    const calm = host.flash;
    host.frame({ b, combat: miniCombat(), assets: a, redFlash: true, warp: 10 }, BOX);
    const warp = host.flash;
    host.frame(null, null);
    expect([calm, warp, host.flash]).toEqual([0.4, 0, 0]);
  });

  it('draws the warp overlay over the whole box while it lasts, instead of the view, telling once what is wrong with its sprites', async () => {
    const warned: string[] = [];
    const shown: number[] = [];
    class Overlay {
      scene = new Scene();
      camera = new PerspectiveCamera();
      problems = ['a problem'];
      update(ms: number) { shown.push(ms); }
      dispose() {}
    }
    const host = new CombatViewHost(async () => ({ SpaceScene: FakeScene, WarpOverlay: Overlay }) as unknown as SpaceSceneModule, m => warned.push(m), () => {});
    const { b } = miniBattle();
    const a = set();
    host.frame({ b, combat: miniCombat(), assets: a }, BOX);
    await Promise.resolve();
    const one = host.frame({ b, combat: miniCombat(), assets: a, warp: 0 }, BOX)!;
    host.frame({ b, combat: miniCombat(), assets: a, warp: 500 }, BOX);
    expect([one.viewport, host.state().overlay, shown, warned]).toEqual([BOX, 'warp', [0, 500], ['a problem']]);
    expect(host.frame({ b, combat: miniCombat(), assets: a }, BOX)!.viewport).toEqual({ x: 319, y: 237, width: 320, height: 220 });
    expect(host.state().overlay).toBeNull();
  });

  it('picks a ship at a point of the view\'s box by the scene, in the window\'s units; none before a frame, under the warp overlay or with nothing drawn (Plan 29 R6)', async () => {
    const asked: number[][] = [];
    class Picking extends FakeScene {
      pick(x: number, y: number) { asked.push([x, y]); return 1; }
    }
    const host = new CombatViewHost(async () => ({ SpaceScene: Picking, WarpOverlay: class { scene = new Scene(); camera = new PerspectiveCamera(); problems = []; update() {} dispose() {} } }) as unknown as SpaceSceneModule, () => {}, () => {});
    const { b } = miniBattle();
    const a = set();
    expect(host.pick(0.5, 0.5)).toBeNull();
    host.frame({ b, combat: miniCombat(), assets: a }, BOX);
    await Promise.resolve();
    host.frame({ b, combat: miniCombat(), assets: a }, BOX);
    // (Split's window is 320 x 220; wide, 640 across and as tall as the box makes it: 1280 x 720 is 640 x 360)
    const split = host.pick(0.25, 0.5);
    b.view.wide = true;
    host.frame({ b, combat: miniCombat(), assets: a }, { x: 0, y: 0, width: 1280, height: 720 });
    const wide = host.pick(0.5, 0.25);
    host.frame({ b, combat: miniCombat(), assets: a, warp: 10 }, BOX);
    const warp = host.pick(0.5, 0.5);
    host.frame(null, null);
    expect([split, wide, warp, host.pick(0.5, 0.5), asked]).toEqual([1, 1, null, null, [[80, 110], [320, 90]]]);
  });

  it('hands the scene the boxes the wide view\'s HUD covers, for the target\'s arrow (Task 9 review)', async () => {
    const options: { keepOut?: unknown }[] = [];
    class Scene6 extends FakeScene {
      override setOptions(o?: { keepOut?: unknown }) { options.push(o!); }
    }
    const host = new CombatViewHost(async () => ({ SpaceScene: Scene6 }) as unknown as SpaceSceneModule, () => {}, () => {});
    const { b } = miniBattle();
    const a = set();
    host.frame({ b, combat: miniCombat(), assets: a }, BOX);
    await Promise.resolve();
    host.frame({ b, combat: miniCombat(), assets: a, keepOut: [[0, 0, 10, 10]] }, BOX);
    host.frame({ b, combat: miniCombat(), assets: a }, BOX);
    expect(options.map(o => o.keepOut)).toEqual([[[0, 0, 10, 10]], undefined]);
  });

  it('a space scene is compiled and its bloom built before its first frame (Plan 34 Task 8)', async () => {
    const warmed: { r: unknown; viewport: unknown }[] = [];
    let finish: (() => void) | null = null;
    class Warming extends FakeScene {
      warm(r: unknown, viewport: unknown) {
        warmed.push({ r, viewport });
        return new Promise<void>(resolve => { finish = resolve; });
      }
    }
    const renderer = { spy: true } as unknown as WebGLRenderer;
    let changed = 0;
    const host = new CombatViewHost(async () => ({ SpaceScene: Warming }) as unknown as SpaceSceneModule, () => {}, () => changed++, () => false, () => DEFAULT_SETTINGS.combat, job => job(renderer));
    const { b } = miniBattle();
    const source = { b, combat: miniCombat(), assets: set() };
    host.frame(source, BOX);
    await Promise.resolve();
    // (the scene is made, and warmed on the renderer for Split's viewport, before any frame of it is drawn)
    expect(host.frame(source, BOX)).toBeNull();
    expect(warmed).toEqual([{ r: renderer, viewport: { x: 319, y: 237, width: 320, height: 220 } }]);
    expect([host.drawing, host.frame(source, BOX), warmed.length]).toEqual([false, null, 1]);
    const before = changed;
    finish!();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(changed).toBeGreaterThan(before);
    expect(host.frame(source, BOX)).not.toBeNull();
    expect([host.drawing, warmed.length]).toEqual([true, 1]);
  });

  it('draws the view anyway when its warm-up fails, saying so, or outlasts its limit (Plan 34 Task 8)', async () => {
    const warned: string[] = [];
    class Failing extends FakeScene { warm() { return Promise.reject(new Error('context lost')); } }
    const failing = new CombatViewHost(async () => ({ SpaceScene: Failing }) as unknown as SpaceSceneModule, m => warned.push(m), () => {}, () => false, () => DEFAULT_SETTINGS.combat, job => job({} as WebGLRenderer));
    const { b } = miniBattle();
    const source = { b, combat: miniCombat(), assets: set() };
    failing.frame(source, BOX);
    await Promise.resolve();
    expect(failing.frame(source, BOX)).toBeNull();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(failing.frame(source, BOX)).not.toBeNull();
    expect(warned).toEqual([expect.stringContaining('context lost')]);
    vi.useFakeTimers();
    try {
      class Stuck extends FakeScene { warm() { return new Promise<void>(() => {}); } }
      const stuck = new CombatViewHost(async () => ({ SpaceScene: Stuck }) as unknown as SpaceSceneModule, () => {}, () => {}, () => false, () => DEFAULT_SETTINGS.combat, job => job({} as WebGLRenderer));
      stuck.frame(source, BOX);
      await Promise.resolve();
      expect(stuck.frame(source, BOX)).toBeNull();
      await vi.advanceTimersByTimeAsync(WARM_LIMIT_MS);
      expect(stuck.frame(source, BOX)).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('hands the scene the Combat Options each frame, as the settings have them now (Plan 32 Task 9)', async () => {
    const options: unknown[] = [];
    class Scene4 extends FakeScene {
      override setOptions(o?: unknown) { options.push(o); }
    }
    let combat: CombatOptions = { stars: true, resolution: 1, radar: true, detail: 'high' };
    const host = new CombatViewHost(async () => ({ SpaceScene: Scene4 }) as unknown as SpaceSceneModule, () => {}, () => {}, () => false, () => combat);
    const { b } = miniBattle();
    const a = set();
    host.frame({ b, combat: miniCombat(), assets: a }, BOX);
    await Promise.resolve();
    combat = { stars: false, resolution: 1, radar: false, detail: 'low' };
    host.frame({ b, combat: miniCombat(), assets: a }, BOX);
    expect(options.at(-1)).toMatchObject({ stars: false, radar: false, detail: 'low' });
  });

  it('resolution 2 renders the view at half its pixel scale: drawn into a quarter of its box, then that picture over the box, nearest; never in the parity mode', async () => {
    const scales: number[] = [];
    const rendered: unknown[] = [];
    class Scene5 extends FakeScene {
      override setPixelScale(s?: number) { scales.push(s!); }
      postRender(r: unknown) { rendered.push(['bloom', r]); }
    }
    let combat: CombatOptions = { stars: true, resolution: 2, radar: true, detail: 'high' };
    const host = new CombatViewHost(async () => ({ SpaceScene: Scene5, ScaledView }) as unknown as SpaceSceneModule, () => {}, () => {}, () => false, () => combat);
    const { b } = miniBattle();
    const a = set();
    host.frame({ b, combat: miniCombat(), assets: a }, BOX);
    await Promise.resolve();
    const half = host.frame({ b, combat: miniCombat(), assets: a }, BOX)!;
    // (Split's 320 x 220 window in a 320 x 220 device-pixel viewport: half a device pixel a unit)
    expect(scales.at(-1)).toBe(0.5);
    expect(half.viewport).toEqual({ x: 319, y: 237, width: 320, height: 220 });
    expect(half.before).toBeDefined();
    const calls: unknown[][] = [];
    const renderer = {
      autoClear: true,
      getPixelRatio: () => 1,
      getScissorTest: () => false,
      // (what the app's render left: a viewport and scissor of its own, which the draw puts back)
      getViewport: (v: { set: (...n: number[]) => unknown }) => v.set(10, 20, 300, 200),
      getScissor: (v: { set: (...n: number[]) => unknown }) => v.set(11, 21, 301, 201),
      setViewport: (...v: number[]) => calls.push(['viewport', ...v]),
      setScissor: (...v: number[]) => calls.push(['scissor', ...v]),
      setScissorTest: (on: boolean) => calls.push(['scissorTest', on]),
      clear: () => calls.push(['clear']),
      render: (scene: unknown) => { rendered.push(scene); },
      copyFramebufferToTexture: (t: { image: { width: number; height: number } }, at: { x: number; y: number }) => calls.push(['copy', at.x, at.y, t.image.width, t.image.height]),
      getSize: (v: { set: (x: number, y: number) => unknown }) => v.set(640, 480),
    };
    half.before!(renderer as never);
    expect(calls).toContainEqual(['viewport', 319, 237, 160, 110]);
    expect(calls).toContainEqual(['copy', 319, 237, 160, 110]);
    expect(calls.slice(-3)).toEqual([['scissorTest', false], ['viewport', 10, 20, 300, 200], ['scissor', 11, 21, 301, 201]]);
    // (the view, its bloom, both into the quarter; the frame then draws the picture of it, not the view)
    expect(rendered.length).toBe(2);
    expect(rendered[1]).toEqual(['bloom', renderer]);
    expect(half.scene).not.toBe(rendered[0]);
    // (resolution 1: today's)
    combat = { ...combat, resolution: 1 };
    const full = host.frame({ b, combat: miniCombat(), assets: a }, BOX)!;
    expect([scales.at(-1), full.before, full.scene]).toEqual([1, undefined, rendered[0]]);
    // (the parity mode: the original's look whatever the options)
    combat = { ...combat, resolution: 2 };
    host.parity = true;
    const parity = host.frame({ b, combat: miniCombat(), assets: a }, BOX)!;
    expect([scales.at(-1), parity.before]).toEqual([1, undefined]);
  });

  it('draws the Combat Options\' preview with a scene of its own: the Enterprise alone, turning, with the options; freed on close and with the battle (Plan 32 Task 11)', async () => {
    const updates: { b: unknown; ships: number; angles: number[] }[] = [];
    const options: unknown[] = [];
    const scales: number[] = [];
    class Scene6 extends FakeScene {
      override update(b?: unknown) { const bb = b as { ships: { angles: number[] }[] }; updates.push({ b, ships: bb.ships.length, angles: [...bb.ships[0]!.angles] }); }
      override setOptions(o?: unknown) { options.push(o); }
      override setPixelScale(s?: number) { scales.push(s!); }
      postRender() {}
    }
    let combat: CombatOptions = { stars: false, resolution: 1, radar: true, detail: 'medium' };
    const host = new CombatViewHost(async () => ({ SpaceScene: Scene6, ScaledView }) as unknown as SpaceSceneModule, () => {}, () => {}, () => false, () => combat);
    const { b } = miniBattle();
    const a = set();
    const source = { b, combat: miniCombat(), assets: a };
    // (nothing before the chunk is in)
    expect(host.optionsPreview(source, { x: 10, y: 20, width: 298, height: 284 }, 0)).toBeNull();
    host.frame(source, BOX);
    await Promise.resolve();
    host.frame(source, BOX);
    const made = FakeScene.made, freed = FakeScene.freed;
    const p = host.optionsPreview(source, { x: 10, y: 20, width: 298, height: 284 }, 0)!;
    expect(p.viewport).toEqual({ x: 10, y: 20, width: 298, height: 284 });
    // (a second scene, the battle's kept)
    expect([FakeScene.made - made, FakeScene.freed - freed]).toEqual([1, 0]);
    expect(options.at(-1)).toMatchObject({ width: 149, height: 142, stars: false, detail: 'medium', parity: false });
    expect(scales.at(-1)).toBe(2);
    expect(updates.at(-1)!.ships).toBe(1);
    expect(host.state().preview).toEqual({ x: 10, y: 20, width: 298, height: 284 });
    // (the same battle each frame, turned: the scene keeps its instances)
    host.optionsPreview(source, { x: 10, y: 20, width: 298, height: 284 }, 3000);
    expect(updates.at(-1)!.b).toBe(updates.at(-2)!.b);
    expect(updates.at(-1)!.angles[0]).not.toBe(updates.at(-2)!.angles[0]);
    // (resolution 2: through the half-scale picture, as the view)
    combat = { ...combat, resolution: 2 };
    expect(host.optionsPreview(source, { x: 10, y: 20, width: 298, height: 284 }, 3000)!.before).toBeDefined();
    // (closed: freed, the battle's scene kept)
    host.releasePreview();
    expect([FakeScene.freed - freed, host.state().preview, host.drawing]).toEqual([1, null, true]);
    // (and with the battle)
    host.optionsPreview(source, { x: 10, y: 20, width: 298, height: 284 }, 0);
    host.frame(null, null);
    expect(FakeScene.freed - freed).toBe(3);
  });
});
