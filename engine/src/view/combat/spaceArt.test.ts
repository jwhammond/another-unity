// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { Group, Mesh, MeshStandardMaterial, BoxGeometry, NearestFilter, RepeatWrapping, ClampToEdgeWrapping, SRGBColorSpace, Texture } from 'three';
import { blitKey, drawArtLayer, drawConsoleShot, LIVE_ENTRIES, RecordingScreen, seeThrough, sheetEntry, spaceArtPacks, swapMaps, texEntry, type SpaceArt } from './spaceArt';
import type { IndexedImage } from '../indexed';

const space = (o: Partial<SpaceArt> = {}): SpaceArt => ({ kinds: {}, backdrops: [], ...o });
const pic = (width: number, height: number, fill: number[]): IndexedImage => ({ width, height, pixels: Uint8Array.from({ length: width * height }, (_, i) => fill[i % fill.length]!) });

describe('the packs a battle loads (Plan 30 R14)', () => {
  it('takes each kind\'s pack once, in kind order, then the effects\'; a kind without one has none', () => {
    const s = space({ kinds: { 0: 'art/space/kind0.pack', 3: 'art/space/kind3.pack' }, effects: 'art/space/effects.pack' });
    expect(spaceArtPacks(s, [3, 0, 3, 5])).toEqual(['art/space/kind0.pack', 'art/space/kind3.pack', 'art/space/effects.pack']);
    expect(spaceArtPacks(space(), [0])).toEqual([]);
  });

  it('names a texture and a sheet by their lower-case originals', () => {
    expect([texEntry('Hull.GIF'), sheetEntry('Boom.SPR')]).toEqual(['tex:hull.gif', 'sheet:boom.spr']);
  });
});

describe('swapMaps (Plan 30 R15)', () => {
  const model = () => {
    const own = (name: string) => Object.assign(new Texture(), { name, wrapS: RepeatWrapping, wrapT: ClampToEdgeWrapping, flipY: false, colorSpace: SRGBColorSpace });
    const textured = new MeshStandardMaterial({ map: own('a') });
    textured.userData = { texture: 'A.GIF' };
    const keyed = new MeshStandardMaterial({ map: own('b'), alphaTest: 0.5 });
    keyed.userData = { texture: 'b.gif' };
    const flat = new MeshStandardMaterial();
    flat.userData = { colour: 1 };
    const unpainted = new MeshStandardMaterial({ map: own('c') });
    unpainted.userData = { texture: 'c.gif' };
    const root = new Group();
    root.add(new Mesh(new BoxGeometry(), [textured, keyed, flat]), new Mesh(new BoxGeometry(), unpainted));
    return { root, textured, keyed, flat, unpainted };
  };

  it('gives each material with a repaint its texture, with the sampler of the map it replaces, and returns the maps replaced', () => {
    const m = model();
    const [ownA, ownB] = [m.textured.map!, m.keyed.map!];
    const art = new Map([['a.gif', new Texture()], ['b.gif', new Texture()]]);
    art.get('a.gif')!.magFilter = NearestFilter;
    const r = swapMaps(m.root, art);
    expect(r.swapped).toBe(2);
    expect(r.replaced).toEqual([ownA, ownB]);
    expect([m.textured.map, m.keyed.map, m.flat.map, m.unpainted.map!.name]).toEqual([art.get('a.gif'), art.get('b.gif'), null, 'c']);
    expect([m.textured.map!.wrapS, m.textured.map!.wrapT, m.textured.map!.flipY, m.textured.map!.colorSpace]).toEqual([RepeatWrapping, ClampToEdgeWrapping, false, SRGBColorSpace]);
    // (a keyed material keeps its alpha test: the repaint's alpha is the original's, Plan 30 R8)
    expect(m.keyed.alphaTest).toBe(0.5);
  });

  it('swaps nothing twice, and nothing without a repaint', () => {
    const m = model();
    const art = new Map([['a.gif', new Texture()]]);
    swapMaps(m.root, art);
    expect(swapMaps(m.root, art)).toEqual({ swapped: 0, replaced: [] });
    expect(swapMaps(model().root, new Map())).toEqual({ swapped: 0, replaced: [] });
  });
});

describe('the console\'s indexed frame over the repaint (Plan 30 R6, R7)', () => {
  // (a 6 x 2 screen: the plate is 128s with a live 0 and a live 245; a picture of 130s, entry 1, drawn at (2, 0), its one 13 skipped)
  const plate = pic(6, 2, [128, 128, 128, 128, 0, 245]);
  const images = [pic(1, 1, [140]), pic(2, 2, [130, 13, 130, 130])];

  it('records the console\'s pictures each frame draws, and starts again with the frame\'s background', () => {
    const s = new RecordingScreen(6, 2);
    s.pictures(images);
    s.set(plate);
    s.blit(images[1]!, 2, 0);
    s.blit(pic(1, 1, [9]), 0, 0);
    expect(s.blits).toEqual([{ image: 1, x: 2, y: 0 }]);
    s.set(plate);
    expect(s.blits).toEqual([]);
  });

  it('clears the plate\'s own pixels and a repainted picture\'s, never a live entry\'s, an opaque area\'s or what the frame drew over them', () => {
    const s = new RecordingScreen(6, 2);
    s.pictures(images);
    s.set(plate);
    s.blit(images[1]!, 2, 0);
    s.pixels[1] = 150; // (a word drawn over the plate)
    const rgba = new Uint8Array(6 * 2 * 4).fill(255);
    const cleared = seeThrough(s, plate, s.blits, images, new Set([1]), [[0, 1, 1, 1]], rgba);
    const alpha = Array.from({ length: 12 }, (_, i) => rgba[i * 4 + 3]);
    // row 0: plate 128 | the word | the picture's 130 | the plate under its 13 | live 0 | live 245
    // row 1: an opaque area | plate | picture | picture | live 0 | live 245
    expect(alpha).toEqual([0, 255, 0, 0, 255, 255, 255, 0, 0, 0, 255, 255]);
    expect(cleared).toBe(6);
  });

  it('keeps an upscale-only picture\'s pixels unless they are the plate\'s, and keys the art layer by the repainted pictures drawn', () => {
    const s = new RecordingScreen(6, 2);
    s.pictures(images);
    s.set(plate);
    s.blit(images[1]!, 2, 0);
    const rgba = new Uint8Array(6 * 2 * 4).fill(255);
    seeThrough(s, plate, s.blits, images, new Set(), [], rgba);
    expect([rgba[2 * 4 + 3], rgba[3 * 4 + 3]]).toEqual([255, 0]);
    expect([blitKey(s.blits, new Set([1])), blitKey(s.blits, new Set())]).toEqual(['1@2,0', '']);
    expect([...LIVE_ENTRIES].length).toBe(13);
  });
});

describe('the art layer (Plan 30 R7)', () => {
  it('clears its canvas, then draws the frame\'s repainted pictures at their scale, in order, and nothing for the rest', () => {
    const calls: unknown[] = [];
    const a = { width: 40, height: 8 }, b = { width: 8, height: 8 };
    drawArtLayer({ clearRect: (...r) => calls.push(['clear', ...r]), drawImage: (im, x, y) => calls.push([im === a ? 'a' : 'b', x, y]) },
      { plate: 'p.webp', images: new Map([[3, a], [5, b]]), scale: 4, opaque: [] }, [{ image: 5, x: 1, y: 2 }, { image: 9, x: 0, y: 0 }, { image: 3, x: 10, y: 0 }]);
    expect(calls).toEqual([['clear', 0, 0, 2560, 1920], ['b', 4, 8], ['a', 40, 0]]);
  });
});

describe('the screenshot check\'s console with the art on (Plan 30 R17)', () => {
  it('draws the plate, then the art layer, smoothed, then the frame over them texel for texel, each at the shot\'s size', () => {
    const calls: string[] = [];
    const g = { imageSmoothingEnabled: true, drawImage: (im: { width: number; height: number; id?: string }, x: number, y: number, w: number, h: number) => { calls.push(`${im.id} ${x},${y} ${w}x${h} ${g.imageSmoothingEnabled ? 'smooth' : 'nearest'}`); } };
    const frame = { width: 640, height: 480, id: 'frame' }, plate = { width: 2560, height: 1920, id: 'plate' }, layer = { width: 2560, height: 1920, id: 'layer' };
    drawConsoleShot(g, 1280, 960, frame, { plate, layer });
    expect(calls).toEqual(['plate 0,0 1280x960 smooth', 'layer 0,0 1280x960 smooth', 'frame 0,0 1280x960 nearest']);
    calls.length = 0;
    drawConsoleShot(g, 640, 480, frame, null);
    expect(calls).toEqual(['frame 0,0 640x480 nearest']);
  });
});
