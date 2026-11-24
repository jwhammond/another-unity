// SPDX-License-Identifier: GPL-3.0-or-later
import { Object3D, PerspectiveCamera, Texture, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { loadShipSet, screenViewport } from './shipSet';
import type { ArtLoaders, CardArt } from './art';

const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top }) as DOMRect;

describe('screenViewport', () => {
  it('rounds fractional rects at dpr 1 and 2 to the CSS box, y from the bottom', () => {
    const canvas = rect(0, 0, 1000, 700);
    expect(screenViewport(rect(180.4, 20.6, 640, 480), canvas, 1)).toEqual({ x: 180, y: 700 - 501, width: 641 - 1, height: 480 });
    expect(screenViewport(rect(180.25, 20.25, 640, 480), canvas, 2)).toEqual({ x: 361, y: 1400 - 1001, width: 1280, height: 960 });
  });
  it('is relative to the canvas, which may not sit at the page origin', () => {
    expect(screenViewport(rect(110, 60, 640, 480), rect(10, 10, 800, 600), 1)).toEqual({ x: 100, y: 600 - 530, width: 640, height: 480 });
  });
});

describe('loadShipSet', () => {
  const loaders = (build: (root: Object3D) => void): ArtLoaders => ({
    texture: async () => { throw new Error('none'); },
    model: async () => { const root = new Object3D(); build(root); return root; },
  });

  it('takes the camera node\'s pose and fov, and applies the lens shift from its extras', async () => {
    const set = await loadShipSet('x.glb', 'camera:main', loaders(root => {
      const cam = new PerspectiveCamera(10, 1);
      cam.name = 'camera:main';
      cam.position.set(1, 2, 3);
      cam.userData = { shiftY: 120, fovY: 1, width: 640, height: 480 };
      root.add(cam);
      const node = new Object3D();
      node.name = 'viewscreen';
      root.add(node);
    }));
    expect(set.camera.position.toArray()).toEqual([1, 2, 3]);
    expect((set.camera as PerspectiveCamera).fov).toBeCloseTo((1 * 180) / Math.PI);
    expect((set.camera as PerspectiveCamera).aspect).toBeCloseTo(4 / 3);
    // (a point on the optical axis lands 120 px above the middle of the 480 px picture)
    const p = new Vector3(1, 2, 3 - 10).project(set.camera);
    expect(p.y).toBeCloseTo(120 / 240);
    expect(set.node('viewscreen')).toBeDefined();
    expect(set.node('nope')).toBeUndefined();
  });

  it('finds a node whose name the loader stripped of its colon (the glTF name stays in userData)', async () => {
    const set = await loadShipSet('x.glb', 'camera:main', loaders(root => {
      const cam = new PerspectiveCamera(10, 1);
      cam.name = 'cameramain';
      cam.userData = { name: 'camera:main', shiftY: 0, fovY: 1 };
      root.add(cam);
      const item = new Object3D();
      item.name = 'item3';
      item.userData = { name: 'item:3' };
      root.add(item);
    }));
    expect(set.node('item:3')?.name).toBe('item3');
    expect((set.camera as PerspectiveCamera).fov).toBeCloseTo((1 * 180) / Math.PI);
  });

  it('does not draw an item\'s proxy node (extras proxy: true), only the fixtures built on it', async () => {
    const set = await loadShipSet('x.glb', 'camera:main', loaders(root => {
      const cam = new PerspectiveCamera(10, 1);
      cam.name = 'camera:main';
      cam.userData = { fovY: 1 };
      root.add(cam);
      const proxy = new Object3D();
      proxy.name = 'item6';
      proxy.userData = { name: 'item:6', proxy: true };
      root.add(proxy);
      const fixture = new Object3D();
      fixture.name = 'fix6';
      root.add(fixture);
    }));
    expect(set.node('item:6')?.visible).toBe(false);
    expect(set.node('fix6')?.visible).toBe(true);
  });

  it('rejects a glb without the camera', async () => {
    await expect(loadShipSet('x.glb', 'camera:main', loaders(() => {}))).rejects.toThrow('no camera called camera:main');
  });

  describe('crew cards (Task 6)', () => {
    // a camera 10 m back from the origin looking down -z (a 480 px picture, fovY 1 rad), anchors at the feet
    const build = (root: Object3D, anchors: Record<string, [number, number, number]>) => {
      const cam = new PerspectiveCamera(10, 1);
      cam.name = 'camera:main';
      cam.position.set(0, 0, 10);
      cam.userData = { shiftY: 0, fovY: 1, width: 640, height: 480 };
      root.add(cam);
      for (const [object, at] of Object.entries(anchors)) {
        const a = new Object3D();
        a.name = `card${object}`;
        a.userData = { name: `card:${object}`, object, depth: -10 };
        a.position.set(...at);
        root.add(a);
      }
    };
    const frames: Record<string, { w: number; h: number }> = { 'bridge.riker': { w: 120, h: 258 }, 'bridge.worf': { w: 60, h: 124 } };
    const art = (object: string): CardArt | undefined => (frames[object] ? { url: object, frames: 1, anchor: [0.5, 1] } : undefined);
    const withCards = (anchors: Record<string, [number, number, number]>) =>
      loadShipSet('x.glb', 'camera:main', {
        texture: async url => {
          const t = new Texture();
          t.image = { width: frames[url]!.w, height: frames[url]!.h };
          return t;
        },
        model: async () => { const root = new Object3D(); build(root, anchors); return root; },
      }, art);

    it('places a bridge.<object> card on its card: anchor, sized to its sprite frame in original pixels at the anchor depth', async () => {
      const set = await withCards({ riker: [1, 0, 0], nobody: [0, 0, 5] });
      expect(set.cards()).toEqual(['riker']);
      const m = set.card('riker')!;
      set.scene.updateMatrixWorld(true);
      // (10 m from the camera: one original pixel is 10 * 2 tan(0.5) / 480 m, so the 258 px frame is 258 of them tall)
      const px = (10 * 2 * Math.tan(0.5)) / 480;
      const box = new Vector3();
      m.geometry.computeBoundingBox();
      m.geometry.boundingBox!.getSize(box);
      expect(box.x * m.scale.x).toBeCloseTo(120 * px, 6);
      expect(box.y * m.scale.y).toBeCloseTo(258 * px, 6);
      // (its feet stand on the anchor: the bottom edge's centre)
      const bottom = new Vector3(0, -0.5, 0).applyMatrix4(m.matrixWorld);
      expect(bottom.x).toBeCloseTo(1, 6);
      expect(bottom.y).toBeCloseTo(0, 6);
      expect(bottom.z).toBeCloseTo(0, 6);
      // (and on screen they land where the anchor projects, with the head 258 px higher)
      const feet = bottom.clone().project(set.camera);
      const head = new Vector3(0, 0.5, 0).applyMatrix4(m.matrixWorld).project(set.camera);
      expect(((head.y - feet.y) / 2) * 480).toBeCloseTo(258, 3);
    });

    it('draws over the set, not hidden by it, later the larger its y_adjust (-depth)', async () => {
      const set = await withCards({ riker: [0, 0, 0], worf: [2, 0, 0] });
      set.card('riker')!.userData.depth = -90;
      expect((set.card('riker')!.material as { depthTest: boolean }).depthTest).toBe(false);
      expect(set.card('riker')!.renderOrder).toBe(set.card('worf')!.renderOrder);   // both anchors carry depth -10 here
    });

    it('each card is its own frame height in pixels, whatever its distance from the camera', async () => {
      const set = await withCards({ riker: [0, 0, 0], worf: [0, 0, -10] });
      set.scene.updateMatrixWorld(true);
      const heightPx = (object: string): number => {
        const m = set.card(object)!;
        const f = new Vector3(0, -0.5, 0).applyMatrix4(m.matrixWorld).project(set.camera);
        const h = new Vector3(0, 0.5, 0).applyMatrix4(m.matrixWorld).project(set.camera);
        return ((h.y - f.y) / 2) * 480;
      };
      expect(heightPx('riker')).toBeCloseTo(258, 3);
      expect(heightPx('worf')).toBeCloseTo(124, 3);
    });

    it('hides the crew cards while the viewscreen is up (bridge.cpp setViewscreen), and shows them again after', async () => {
      const set = await withCards({ riker: [0, 0, 0], worf: [2, 0, 0] });
      let up = false;
      const present = () => set.showCards(() => !up);
      present();
      expect(set.card('riker')!.visible && set.card('worf')!.visible).toBe(true);
      up = true;
      present();
      expect(set.card('riker')!.visible || set.card('worf')!.visible).toBe(false);
      up = false;
      present();
      expect(set.card('riker')!.visible && set.card('worf')!.visible).toBe(true);
    });

    it('a crew member the port says is not on the bridge has no card', async () => {
      const set = await withCards({ riker: [0, 0, 0], worf: [2, 0, 0] });
      set.showCards(object => object !== 'worf');
      expect(set.card('riker')!.visible).toBe(true);
      expect(set.card('worf')!.visible).toBe(false);
    });

    it('a crew member with no card art leaves the anchor bare (the set still loads)', async () => {
      const set = await withCards({ nobody: [0, 0, 0] });
      expect(set.cards()).toEqual([]);
    });
  });
});
