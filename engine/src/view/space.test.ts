// SPDX-License-Identifier: GPL-3.0-or-later
import { BufferGeometry, Mesh, Texture, type Object3D } from 'three';
import { describe, expect, it } from 'vitest';
import type { ArtLoaders } from './art';
import { createSpaceView } from './space';

const frame = (): Texture => {
  const t = new Texture();
  t.image = { width: 530, height: 254 };
  return t;
};
const loaders = (log: string[] = []): ArtLoaders => ({
  texture: async url => {
    log.push(url);
    if (url.includes('missing')) throw new Error('404');
    return frame();
  },
  model: async () => { throw new Error('no model'); },
});
const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0));
const geometries = (o: Object3D): string[] => {
  const out: string[] = [];
  o.traverse(c => { if ((c as Mesh).geometry) out.push(((c as Mesh).geometry as BufferGeometry).uuid); });
  return out.sort();
};
const visible = (o: Object3D, name: string): boolean => {
  let v = false;
  o.traverse(c => { if (c.name === name) v = c.visible; });
  return v;
};

describe('createSpaceView', () => {
  it('set() switches between starfield, streaks, sphere and sprite quad without reallocating', async () => {
    const space = createSpaceView(7, loaders());
    const before = geometries(space.scene);
    const children = space.scene.children.length;
    expect(space.shown()).toBe('space');
    space.set({ kind: 'warp' });
    expect(space.shown()).toBe('warp');
    space.set({ kind: 'planet', colours: ['#c08040', '#203060'] });
    expect(space.shown()).toBe('planet');
    space.set({ kind: 'sprite', sprite: 'viewfere' }, 'art/ship/view/viewfere.webp');
    // (the frame loads: space until it is in)
    expect(space.shown()).toBe('space');
    await tick();
    expect(space.shown()).toBe('sprite');
    space.set({ kind: 'space' });
    space.set({ kind: 'planet', colours: ['#ffffff', '#000000'] });
    expect(geometries(space.scene)).toEqual(before);
    expect(space.scene.children.length).toBe(children);
    space.dispose();
  });

  it('the sphere takes the two colours: its vertex colours range between them, and a new pair repaints the same geometry', () => {
    const space = createSpaceView(7, loaders());
    space.set({ kind: 'planet', colours: ['#ff0000', '#0000ff'] });
    let sphere: Mesh | undefined;
    space.scene.traverse(c => { if ((c as Mesh).isMesh && ((c as Mesh).geometry as BufferGeometry).getAttribute('color')) sphere = c as Mesh; });
    const col = sphere!.geometry.getAttribute('color');
    let reds = 0;
    let blues = 0;
    for (let i = 0; i < col.count; i++) {
      if (col.getX(i) > 0.9) reds++;
      if (col.getZ(i) > 0.9) blues++;
    }
    // (both tones are on the sphere, and none of the third colour's green)
    expect(reds).toBeGreaterThan(50);
    expect(blues).toBeGreaterThan(50);
    expect(col.getY(0)).toBe(0);
    space.dispose();
  });

  it('the same seed gives the same sky, and the streaks move only at warp', () => {
    const pos = (seed: number): number[] => {
      const s = createSpaceView(seed, loaders());
      let p: number[] = [];
      s.scene.traverse(c => { if ((c as unknown as { isPoints?: boolean }).isPoints) p = [...((c as Mesh).geometry as BufferGeometry).getAttribute('position').array.slice(0, 9)]; });
      s.dispose();
      return p;
    };
    expect(pos(5)).toEqual(pos(5));
    expect(pos(5)).not.toEqual(pos(6));
    const space = createSpaceView(1, loaders());
    const streak = (): number => {
      let z = 0;
      space.scene.traverse(c => { if ((c as unknown as { isLineSegments?: boolean }).isLineSegments) z = ((c as Mesh).geometry as BufferGeometry).getAttribute('position').getZ(0); });
      return z;
    };
    const z0 = streak();
    space.update(0.1);
    expect(streak()).toBe(z0);
    space.set({ kind: 'warp' });
    space.update(0.1);
    expect(streak()).not.toBe(z0);
    expect(visible(space.scene, 'nothing')).toBe(false);
  });

  it('a frame that fails to load, or has no url, warns once and leaves space', async () => {
    const warnings: string[] = [];
    const space = createSpaceView(1, loaders(), m => warnings.push(m));
    space.set({ kind: 'sprite', sprite: 'viewx' }, 'art/ship/view/missing.webp');
    await tick();
    expect(space.shown()).toBe('space');
    expect(warnings).toHaveLength(1);
    space.set({ kind: 'sprite', sprite: 'viewy' });
    expect(warnings).toHaveLength(2);
    expect(space.shown()).toBe('space');
  });

  it('the sprite quad is inside the camera\'s far plane, and 1 sprite pixel is 1 original pixel on the window', async () => {
    const space = createSpaceView(1, loaders());
    space.setBox(521, 240);
    space.set({ kind: 'sprite', sprite: 'viewfere' }, 'art/ship/view/viewfere.webp');
    await tick();
    let quad: Mesh | undefined;
    space.scene.traverse(c => { if ((c as Mesh).isMesh && c.scale.x === 530) quad = c as Mesh; });
    expect(quad).toBeDefined();
    expect(-quad!.position.z).toBeLessThan(space.camera.far);
    expect(-quad!.position.z).toBeGreaterThan(space.camera.near);
    // at that distance the view is the box's height (240) high, so the 254-high frame is 254 of 240 box units tall
    const visibleHeight = 2 * -quad!.position.z * Math.tan((space.camera.fov * Math.PI) / 360);
    expect(visibleHeight).toBeCloseTo(240, 3);
    expect(quad!.scale.y).toBe(254);
  });

  it('a repainted still is drawn at 1/scale of its pixels with its bottom centre where the original puts the sprite', async () => {
    const space = createSpaceView(1, loaders());
    space.setBox(521, 240);
    // (the test loader's frame is 530x254: a still of it at 2x is a 265x127 quad)
    space.set({ kind: 'sprite', sprite: 'viewfere' }, 'art/ship/view/viewfere.still.webp', { scale: 2, at: [319, 311], boxCentre: [319.5, 189] });
    await tick();
    let quad: Mesh | undefined;
    space.scene.traverse(c => { if ((c as Mesh).isMesh && c.scale.x === 265) quad = c as Mesh; });
    expect(quad).toBeDefined();
    expect(quad!.scale.y).toBe(127);
    expect(quad!.position.x).toBeCloseTo(-0.5, 6);
    // (y goes down on the screen: the centre is 311 - 63.5 = 247.5, 58.5 below the window's centre)
    expect(quad!.position.y).toBeCloseTo(-58.5, 6);
    // and the next sprite without a still is centred 1:1 again
    space.set({ kind: 'sprite', sprite: 'viewfere' }, 'art/ship/view/viewfere.webp');
    await tick();
    expect([quad!.scale.x, quad!.position.x, quad!.position.y]).toEqual([530, 0, -0]);
  });

  it('a late frame is dropped when another picture was chosen meanwhile, and setBox sets the aspect', async () => {
    const space = createSpaceView(1, loaders());
    space.setBox(500, 250);
    expect(space.camera.aspect).toBe(2);
    space.set({ kind: 'sprite', sprite: 'viewfere' }, 'art/ship/view/viewfere.webp');
    space.set({ kind: 'warp' });
    await tick();
    expect(space.shown()).toBe('warp');
  });

  it('a frame still loading when the view is disposed is freed when it arrives, and not installed', async () => {
    let late: Texture | undefined;
    let freed = 0;
    const view = createSpaceView(1, {
      texture: async () => {
        late = frame();
        late.addEventListener('dispose', () => freed++);
        return late;
      },
      model: async () => { throw new Error('no model'); },
    });
    view.set({ kind: 'sprite', sprite: 'viewfere' }, 'art/ship/view/viewfere.webp');
    view.dispose();
    await tick();
    expect(late).toBeDefined();
    expect(freed).toBe(1);
    expect(view.shown()).toBe('space');
  });
});
