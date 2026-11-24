// SPDX-License-Identifier: GPL-3.0-or-later
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Mesh, MeshBasicMaterial, type PlaneGeometry, Texture, Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { ArtLoaders, CardArt } from './art';
import { animsToLoad, areaViewport, loadShipPlate, plateCamera, pointerInViewport } from './shipPlate';
import { screenViewport } from './shipSet';
import { dissolveLevel, DISSOLVE_STEP_MS } from './beam';
import { PresentationClock } from './timeline';

const sized = (w: number, h: number): Texture => {
  const t = new Texture();
  t.image = { width: w, height: h };
  return t;
};
const loaders = (made: Texture[] = []): ArtLoaders => ({
  texture: async url => {
    const t = url.startsWith('card') ? sized(98, 282) : url.startsWith('pad') ? sized(98 * 4, 282) : sized(2560, 1920);
    made.push(t);
    return t;
  },
  model: async () => { throw new Error('no model'); },
});
const plate = { kind: 'plate' as const, plate: 'plate.webp', areas: {}, crew: [] };
const card = (over: Partial<CardArt> = {}): CardArt => ({ url: 'card.webp', frames: 1, anchor: [0.5, 1], pixelHeight: 282, ...over });
const spans = (m: Mesh) => ({ left: m.position.x - m.scale.x / 2, right: m.position.x + m.scale.x / 2, top: -(m.position.y + m.scale.y / 2), bottom: -(m.position.y - m.scale.y / 2) });

describe('plateCamera', () => {
  it('puts (0,0) at NDC (-1,1) and (640,480) at (1,-1)', () => {
    const camera = plateCamera();
    const a = new Vector3(0, -0, 0).project(camera);
    const b = new Vector3(640, -480, 0).project(camera);
    expect([a.x, a.y]).toEqual([-1, 1]);
    expect([b.x, b.y]).toEqual([1, -1]);
  });
});

describe('loadShipPlate', () => {
  it('a card with pixelHeight 282 and anchor [0.5,1] at (240,365) spans y 83..365 and is centred on x 240, within 0.5 px', async () => {
    const set = await loadShipPlate(plate, loaders());
    await set.placeCards([{ key: 'picard', art: card(), at: [240, 365], depth: 0 }]);
    const s = spans(set.card('picard') as Mesh);
    expect(s.top).toBeCloseTo(83, 0);
    expect(s.bottom).toBeCloseTo(365, 0);
    expect((s.left + s.right) / 2).toBeCloseTo(240, 0);
    // (its aspect is the frame's: 98 x 282)
    expect(s.right - s.left).toBeCloseTo((282 * 98) / 282, 5);
    // (the camera maps it to the pixels: the feet at 365 are 365/480 down the box)
    const feet = new Vector3(240, -365, 0).project(set.camera);
    expect(feet.y).toBeCloseTo(1 - (2 * 365) / 480, 5);
  });

  it('a pad card at scale 192 of 256 is three quarters as high; renderOrder is 1000 - depth; depthTest is off', async () => {
    const set = await loadShipPlate(plate, loaders());
    await set.placeCards([
      { key: 'full', art: card(), at: [100, 300], depth: 40 },
      { key: 'pad', art: card(), at: [300, 300], scale: 192 / 256, depth: 90 },
    ]);
    const full = set.card('full') as Mesh;
    const pad = set.card('pad') as Mesh;
    expect(pad.scale.y).toBeCloseTo(full.scale.y * 0.75, 5);
    expect(full.renderOrder).toBe(960);
    expect(pad.renderOrder).toBe(910);
    expect((pad.material as MeshBasicMaterial).depthTest).toBe(false);
    const planeMat = (set.scene.getObjectByName('plate') as Mesh).material as MeshBasicMaterial;
    expect([planeMat.depthTest, planeMat.depthWrite]).toEqual([false, false]);
    expect(planeMat.map?.colorSpace).toBe('srgb');
    expect(planeMat.map?.generateMipmaps).toBe(true);
  });

  it('replaces a card with the same key and leaves the others', async () => {
    const set = await loadShipPlate(plate, loaders());
    await set.placeCards([{ key: 'a', art: card(), at: [10, 100], depth: 0 }, { key: 'b', art: card(), at: [20, 100], depth: 0 }]);
    const b = set.card('b');
    await set.placeCards([{ key: 'a', art: card(), at: [50, 100], depth: 0 }]);
    expect(set.cards().sort()).toEqual(['a', 'b']);
    expect(set.card('b')).toBe(b);
    expect(set.card('a')!.position.x).toBeCloseTo(50);
    set.removeCards(['a']);
    expect(set.cards()).toEqual(['b']);
  });

  it('plays a strip through the card player: the cell sets the size and the uv window', async () => {
    const art = card({ anims: { 24: { url: 'pad.strip', frames: 4, cell: [392, 1128], anchor: [0.5, 1], delays: [100, 100, 100, 100], loop: true } } });
    const set = await loadShipPlate(plate, loaders());
    await set.placeCards([{ key: 'p', art, at: [100, 200], depth: 0, anim: 24 }]);
    const m = set.card('p') as Mesh;
    expect(m.scale.y).toBeCloseTo(282);
    const map = (m.material as MeshBasicMaterial).map!;
    expect(map.repeat.x).toBeCloseTo(0.25);
    set.update(0.15);
    expect(map.offset.x).toBeCloseTo(0.25);
  });

  it('moves a walking card: its feet, its size, its order and whether it is drawn, and a sparkle would follow it', async () => {
    const strip = { url: 'pad.strip', frames: 4, cell: [392, 1128] as [number, number], anchor: [0.5, 1] as [number, number], delays: [100, 100, 100, 100], loop: true };
    const art = card({ anims: { 24: strip } });
    const set = await loadShipPlate(plate, loaders());
    await set.placeCards([{ key: 'p', art, at: [100, 200], depth: 200, scale: 1, anim: 24, all: true }, { key: 'q', art, at: [10, 20], depth: 20, anim: 24 }]);
    const m = set.card('p') as Mesh;
    set.moveCards({ p: { at: [150, 260], scale: 0.5, visible: true }, nobody: { at: [0, 0], scale: 1, visible: true } });
    const s = spans(m);
    expect(s.bottom).toBeCloseTo(260);
    expect((s.left + s.right) / 2).toBeCloseTo(150);
    expect(s.bottom - s.top).toBeCloseTo(141);
    expect(m.renderOrder).toBe(1000 - 260);
    expect(m.visible).toBe(true);
    set.moveCards({ p: { at: [150, 260], scale: 0.5, visible: false } });
    expect(m.visible).toBe(false);
    // (a card not named is where it was)
    expect(spans(set.card('q') as Mesh).bottom).toBeCloseTo(20);
  });

  it('draws a rectangle of the plate over the cards, with the plate\'s own pixels, and takes it away', async () => {
    const set = await loadShipPlate(plate, loaders());
    set.setOccluder([0, 112, 70, 176]);
    const m = set.node('occluder') as Mesh;
    const { width, height } = (m.geometry as PlaneGeometry).parameters;
    expect([m.position.x - width / 2, m.position.x + width / 2, -m.position.y - height / 2, -m.position.y + height / 2]).toEqual([0, 70, 112, 288]);
    expect(m.renderOrder).toBeGreaterThan(1000);
    const map = (m.material as MeshBasicMaterial).map!;
    expect(map.repeat.x).toBeCloseTo(70 / 640);
    expect(map.repeat.y).toBeCloseTo(176 / 480);
    expect(map.offset.x).toBe(0);
    expect(map.offset.y).toBeCloseTo(1 - 288 / 480);
    set.setOccluder([0, 0, 10, 10]);
    expect(set.scene.children.filter(c => c.name === 'occluder')).toHaveLength(1);
    set.setOccluder(null);
    expect(set.node('occluder')).toBeUndefined();
  });

  it("a bridge card with several frames plays its idle loop at the sprite's own pixels, falls into the next animation, and speaks with the talk one", async () => {
    // (scale 1: the cells are the sprite's pixels, not the away team's 4x; the idle animation 0 has 3 frames and falls into 3)
    const idle = { url: 'pad.idle', frames: 3, scale: 1, cell: [100, 280] as [number, number], anchor: [0.5, 1] as [number, number], delays: [100, 100, 100], loop: false, next: 3 };
    const next = { url: 'pad.next', frames: 2, scale: 1, cell: [100, 280] as [number, number], anchor: [0.5, 1] as [number, number], delays: [200, 200], loop: true };
    const talk = { url: 'pad.talk', frames: 2, scale: 1, cell: [110, 280] as [number, number], anchor: [0.5, 1] as [number, number], delays: [100, 100], loop: true };
    const art = card({ anims: { 0: idle, 3: next, 2: talk } });
    const set = await loadShipPlate(plate, loaders());
    await set.placeCards([{ key: 'picard', art, at: [266, 365], depth: -1, anim: 0, all: true }]);
    const m = set.card('picard') as Mesh;
    const map = () => (m.material as MeshBasicMaterial).map!;
    // (one frame is a third of the strip, at its own size: 100 x 280 pixels with the feet on the place)
    expect(m.scale.x).toBeCloseTo(100);
    expect(m.scale.y).toBeCloseTo(280);
    expect(spans(m).bottom).toBeCloseTo(365);
    expect(map().repeat.x).toBeCloseTo(1 / 3);
    const first = map();
    set.update(0.15);
    expect(map().offset.x).toBeCloseTo(1 / 3);
    // (after the idle animation's 300 ms it falls into animation 3, its own strip)
    set.update(0.2);
    expect(map()).not.toBe(first);
    expect(map().repeat.x).toBeCloseTo(1 / 2);
    // (speaking: the talk strip, then back to idle, from its start)
    set.playCards(() => 2);
    set.update(0.01);
    expect(m.scale.x).toBeCloseTo(110);
    set.playCards(() => 2);
    set.playCards(() => 0);
    set.update(0.01);
    expect(m.scale.x).toBeCloseTo(100);
    expect(map()).toBe(first);
    // (an animation the card doesn't have is left alone)
    set.playCards(() => 9);
    set.update(0.01);
    expect(map()).toBe(first);
  });

  it('a bridge strip upscaled 4x (scale 4, a cell 4x the sprite) is drawn the size of the sprite, so only its sharpness changes', async () => {
    const strip = { url: 'pad.up', frames: 2, scale: 4, cell: [400, 1120] as [number, number], anchor: [0.5, 1] as [number, number], delays: [100, 100], loop: true };
    const set = await loadShipPlate(plate, loaders());
    await set.placeCards([{ key: 'picard', art: card({ anims: { 0: strip } }), at: [266, 365], depth: 0, anim: 0, all: true }]);
    const m = set.card('picard') as Mesh;
    expect(m.scale.x).toBeCloseTo(100);
    expect(m.scale.y).toBeCloseTo(280);
    expect(spans(m).bottom).toBeCloseTo(365);
  });

  it("the bridge's crew draw in ScummVM's order: by -depth ascending, so Data (-99) is in front of Troi, Worf and Riker (-10) and Picard (0) is behind them all", async () => {
    // (bridge.cpp: y_adjust = -depth, and DrawOrderComparison sorts the bridge by y_adjust, a larger one drawing later)
    const set = await loadShipPlate(plate, loaders());
    const crew = { worf: -10, riker: -10, picard: 0, troi: -90, data: -99 };
    await set.placeCards(Object.entries(crew).map(([key, depth]) => ({ key, art: card(), at: [100, 300] as [number, number], depth })));
    const order = (k: string) => (set.card(k) as Mesh).renderOrder;
    const drawn = Object.keys(crew).sort((a, b) => order(a) - order(b));
    expect(drawn[0]).toBe('picard');
    expect(drawn[drawn.length - 1]).toBe('data');
    expect(order('troi')).toBeGreaterThan(order('worf'));
    expect(order('troi')).toBeLessThan(order('data'));
  });

  it("a pad's card at scale 240/256 is pixelHeight x scale / 256 high with its feet on the stand point, and is drawn by depth", async () => {
    const art = card({ pixelHeight: 150, anims: { 24: { url: 'pad.strip', frames: 2, cell: [400, 600], anchor: [0.5, 1], delays: [100, 100], loop: true } } });
    const set = await loadShipPlate(plate, loaders());
    await set.placeCards([{ key: 'pad.0', art, at: [250, 231], scale: 240 / 256, depth: 231, anim: 0x18 }, { key: 'pad.2', art, at: [300, 229], scale: 236 / 256, depth: 229, anim: 0x18 }]);
    const m = set.card('pad.0') as Mesh;
    expect(m.scale.y).toBeCloseTo((150 * 240) / 256);
    expect(spans(m).bottom).toBeCloseTo(231);
    expect(m.position.x).toBeCloseTo(250);
    expect((set.card('pad.2') as Mesh).scale.y).toBeCloseTo((150 * 236) / 256);
    // (the nearer pad, with the larger y, draws over the farther one)
    expect(m.renderOrder).toBeLessThan((set.card('pad.2') as Mesh).renderOrder);
  });

  it("beams the pads' cards: the sparkle stands on each card's feet at the pad's scale, the card dissolves with it, and an out beam leaves the cards hidden", async () => {
    const art = card({ pixelHeight: 150 });
    const set = await loadShipPlate(plate, loaders());
    await set.placeCards([{ key: 'pad.0', art, at: [250, 231], scale: 240 / 256, depth: 231 }, { key: 'pad.1', art, at: [300, 229], scale: 236 / 256, depth: 229 }]);
    const fx = { 0: { url: 'fx0.webp', frames: 13, cell: [232, 704] as [number, number], anchor: [0.5, 1] as [number, number], delays: Array(13).fill(86) as number[], loop: false }, 1: { url: 'fx1.webp', frames: 8, cell: [232, 704] as [number, number], anchor: [0.5, 1] as [number, number], delays: Array(8).fill(127) as number[], loop: false } };
    const clock = new PresentationClock();
    let done = false;
    void set.beam(['pad.0', 'pad.1', 'nobody'], true, fx, clock).then(() => { done = true; });
    await new Promise(resolve => setTimeout(resolve, 0));
    set.update(0.1);
    // (whole while the sparkle plays: 58 x 176 original pixels at the pad's scale, its bottom middle on the stand point)
    const spark = set.scene.getObjectByName('beam:pad.0') as Mesh;
    expect(spark.visible).toBe(true);
    expect(spark.scale.x).toBeCloseTo((58 * 240) / 256);
    expect(spark.scale.y).toBeCloseTo((176 * 240) / 256);
    expect(spans(spark).bottom).toBeCloseTo(231);
    expect(spark.position.x).toBeCloseTo(250);
    expect(spark.renderOrder).toBeGreaterThan((set.card('pad.0') as Mesh).renderOrder);
    expect(dissolveLevel(set.card('pad.0') as Mesh)).toBe(6);
    for (let t = 0; t < 1.3; t += 0.1) { clock.update(0.1); set.update(0.1); }
    expect(dissolveLevel(set.card('pad.0') as Mesh)).toBeLessThan(6);
    for (let t = 0; t < 2 + (7 * DISSOLVE_STEP_MS) / 1000; t += 0.1) { clock.update(0.1); set.update(0.1); await new Promise(resolve => setTimeout(resolve, 0)); }
    expect(done).toBe(true);
    expect(dissolveLevel(set.card('pad.0') as Mesh)).toBe(0);
    expect(set.scene.getObjectByName('beam:pad.0')).toBeUndefined();
  });

  it('a beam with no sparkle strips only dissolves, and one of cards that are not there ends at once', async () => {
    const set = await loadShipPlate(plate, loaders());
    await set.placeCards([{ key: 'pad.0', art: card(), at: [250, 231], depth: 231 }]);
    const clock = new PresentationClock();
    await set.beam(['gone'], false, undefined, clock);
    let done = false;
    void set.beam(['pad.0'], false, undefined, clock).then(() => { done = true; });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(set.scene.getObjectByName('beam:pad.0')).toBeUndefined();
    expect(dissolveLevel(set.card('pad.0') as Mesh)).toBe(0);
    for (let t = 0; t < 3; t += 0.1) { clock.update(0.1); set.update(0.1); }
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(done).toBe(true);
    expect(dissolveLevel(set.card('pad.0') as Mesh)).toBe(-1);
  });

  it('showCards hides and shows by key; dispose frees the plate, card and window textures', async () => {
    const made: Texture[] = [];
    const set = await loadShipPlate({ ...plate, window: 'frame.webp', areas: { window: [10, 10, 100, 80] } }, loaders(made));
    await set.placeCards([{ key: 'a', art: card(), at: [10, 100], depth: 0 }, { key: 'b', art: card(), at: [20, 100], depth: 0 }]);
    set.showCards(k => k === 'a');
    expect([set.card('a')!.visible, set.card('b')!.visible]).toEqual([true, false]);
    const target = new Texture();
    set.setWindow(target);
    expect(set.node('window')).toBeDefined();
    set.setWindow(null);
    expect(set.node('window')).toBeUndefined();
    const spies = made.map(t => vi.spyOn(t, 'dispose'));
    set.dispose();
    expect(made).toHaveLength(4);
    expect(spies.every(s => s.mock.calls.length > 0)).toBe(true);
  });

  it('the window layer maps the target onto the window bbox with window.webp as alpha', async () => {
    const made: Texture[] = [];
    const set = await loadShipPlate({ ...plate, window: 'window.webp', areas: { window: [59, 69, 521, 240] } }, loaders(made));
    const target = new Texture();
    set.setWindow(target);
    const w = set.node('window') as Mesh;
    const mat = w.material as MeshBasicMaterial;
    // the box, in the original's pixels: its corners land on the box's corners in the camera's NDC
    const tl = new Vector3(w.position.x - w.scale.x * 260.5, w.position.y + 120, 0);
    expect(w.position.x).toBeCloseTo(59 + 260.5, 5);
    expect(w.position.y).toBeCloseTo(-(69 + 120), 5);
    expect((w.geometry as PlaneGeometry).parameters.width).toBe(521);
    expect((w.geometry as PlaneGeometry).parameters.height).toBe(240);
    const corner = new Vector3(59, -69, 0).project(set.camera);
    expect(corner.x).toBeCloseTo((2 * 59) / 640 - 1, 5);
    expect(tl.z).toBe(0);
    // the colour is the target, the alpha is window.webp's own alpha (not an alphaMap's green)
    expect(mat.map).toBe(target);
    expect(mat.alphaMap).toBe(made[1]);
    expect(mat.transparent).toBe(true);
    expect(mat.depthTest).toBe(false);
    const shader = { fragmentShader: 'a\n#include <alphamap_fragment>\nb' };
    mat.onBeforeCompile(shader as never, undefined as never);
    expect(shader.fragmentShader).toContain('.a;');
    expect(shader.fragmentShader).not.toContain('#include <alphamap_fragment>');
    // it draws over the plate (0) and the frame (1)
    expect(w.renderOrder).toBe(2);
  });

  it('setFrame draws the viewscreen plate\'s rows 0-363 at y 0-363 over the bridge plate, with its window', async () => {
    const bridge = await loadShipPlate(plate, loaders());
    const vs = await loadShipPlate({ ...plate, window: 'window.webp', areas: { window: [59, 69, 521, 240] } }, loaders());
    bridge.setFrame(vs);
    const f = bridge.node('frame') as Mesh;
    expect(f).toBeDefined();
    const g = (f.geometry as PlaneGeometry).parameters;
    expect([0 - (f.position.y + g.height / 2) + 0, 0 - (f.position.y - g.height / 2), f.position.x - g.width / 2, f.position.x + g.width / 2]).toEqual([0, 364, 0, 640]);
    // the UV crop: the top 364 of 480 rows of the viewscreen plate's texture
    const map = (f.material as MeshBasicMaterial).map as Texture;
    expect(map.repeat.y).toBeCloseTo(364 / 480, 6);
    expect(map.offset.y).toBeCloseTo(1 - 364 / 480, 6);
    expect(map.source).toBe((vs.scene.getObjectByName('plate') as Mesh & { material: MeshBasicMaterial }).material.map!.source);
    // the frame is over the bridge plate and under the window and the cards
    expect(f.renderOrder).toBe(1);
    // the window layer takes the frame's box, and the target
    const target = new Texture();
    bridge.setWindow(target);
    const w = bridge.node('window') as Mesh;
    expect(w.position.x).toBeCloseTo(59 + 260.5, 5);
    expect((w.material as MeshBasicMaterial).map).toBe(target);
    // taking the frame away takes the window layer too: the bridge has no box of its own
    bridge.setFrame(null);
    expect(bridge.node('frame')).toBeUndefined();
    expect(bridge.node('window')).toBeUndefined();
  });
});

describe('the lifted transporter pads', () => {
  it('are read by no file under engine/src/sim (they are for drawing only)', () => {
    const root = fileURLToPath(new URL('../sim', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(path);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(10);
    // (the sim's own TransporterRoom has `pads`, the crew on each pad; the lifted pads' places are `transporter.pads` of ship data and `transporterPads`)
    const lifted = files.filter(f => /data\.transporter\.pads|transporter\??\.pads\?*\.(map|length)|transporterPads|_transporterPads/.test(readFileSync(f, 'utf8')));
    expect(lifted).toEqual([]);
  });
});

describe('areaViewport', () => {
  const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top }) as DOMRect;
  it('places an area inside the box viewport at dpr 1 and 2, rounding each edge as screenViewport does', () => {
    const canvas = rect(0, 0, 800, 700);
    // dpr 1: a 640x480 box at (180, 20): the area is its own pixels
    const box1 = screenViewport(rect(180, 20, 640, 480), canvas, 1);
    expect(areaViewport(box1, [10, 19, 379, 348])).toEqual({ x: 190, y: 700 - 20 - 367, width: 379, height: 348 });
    // dpr 2: the box is 1280x960, an area is twice its size
    const box2 = screenViewport(rect(180, 20, 640, 480), canvas, 2);
    expect(areaViewport(box2, [10, 19, 379, 348])).toEqual({ x: 2 * 190, y: 1400 - 2 * (20 + 367), width: 758, height: 696 });
    // the whole picture is the box
    expect(areaViewport(box2, [0, 0, 640, 480])).toEqual(box2);
  });

  it('rounds each edge of the area on its own, as the box\'s edges round: a fractional box and a scaled one', () => {
    const box = screenViewport(rect(100.4, 50.4, 481, 361), rect(0, 0, 800, 600), 1);
    const v = areaViewport(box, [10, 19, 379, 348]);
    const left = box.x + Math.round((10 / 640) * box.width);
    const right = box.x + Math.round((389 / 640) * box.width);
    expect(v.x).toBe(left);
    expect(v.width).toBe(right - left);
    const top = Math.round((19 / 480) * box.height);
    const bottom = Math.round((367 / 480) * box.height);
    expect(v.height).toBe(bottom - top);
    expect(v.y).toBe(box.y + box.height - bottom);
    // two areas that touch share an edge: no gap, no overlap
    const a = areaViewport(box, [0, 0, 100, 480]);
    const b = areaViewport(box, [100, 0, 540, 480]);
    expect(a.x + a.width).toBe(b.x);
    expect(b.x + b.width).toBe(box.x + box.width);
  });
});

describe('pointerInViewport', () => {
  it('maps a pointer through a viewport (y up) at dpr 2 and says when it is outside', () => {
    const vp = { x: 200, y: 400, width: 400, height: 200 };
    const canvas = { left: 10, top: 20, height: 500 };
    // the viewport's centre in css px: x (200 + 200)/2 + 10 = 210, y: (1000 - (400 + 100)) / 2 + 20 = 270
    const c = pointerInViewport(vp, canvas, 2, 210, 270);
    expect(c.x).toBeCloseTo(0);
    expect(c.y).toBeCloseTo(0);
    expect(c.inside).toBe(true);
    const corner = pointerInViewport(vp, canvas, 2, 10 + 100, 20 + (1000 - 600) / 2);
    expect([corner.x, corner.y]).toEqual([-1, 1]);
    expect(pointerInViewport(vp, canvas, 2, 10 + 99, 270).inside).toBe(false);
    expect(pointerInViewport(vp, canvas, 2, 210, 20 + (1000 - 600) / 2 - 1).inside).toBe(false);
  });
});

describe('animsToLoad', () => {
  const a = (next?: number) => ({ url: 'u', frames: 1, cell: [1, 1] as [number, number], anchor: [0.5, 1] as [number, number], delays: [1], loop: false, ...(next !== undefined ? { next } : {}) });
  const anims = { 0: a(3), 1: a(), 2: a(), 3: a(), 4: a(5), 5: a() };

  it('is every animation without a list, and else the listed ones and the chain each falls into', () => {
    expect(animsToLoad(anims)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(animsToLoad(anims, [0, 2])).toEqual([0, 2, 3]);
    // (one the art lacks is left out, and a loop in the chain ends)
    expect(animsToLoad({ 0: a(1), 1: a(0) }, [0, 9])).toEqual([0, 1]);
  });
});
