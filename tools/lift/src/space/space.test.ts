// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { makeGif, makePbm, makeSpaceMaterials, makeSpaceModel } from '../testing/space-files';
import { decodeGif, decodePbm, decodeTexture, hasTexture, materialType, parseSpaceMaterials, parseSpaceModel, spacePalette } from './index';

const ramp = (base: number) => Uint8Array.from({ length: 768 }, (_, i) => (base + i) & 0xff);

describe('parseSpaceModel (SpaceModel::load, space3d.cpp:117-195)', () => {
  const part = {
    vertices: [[0, 0, 0], [1.5, 0, 0], [0, -2, 0.25]] as [number, number, number][],
    uv: [[0, 0], [65536, 0], [0, 32768]] as [number, number][],
    faces: [{ material: 3, v: [0, 1, 2] as [number, number, number] }, { material: 1, twoSided: true, v: [2, 1, 0] as [number, number, number] }],
    faceNormals: [[0, 0, 1], [0, 0, -1]] as [number, number, number][],
    faceD: [0.5, -0.5],
  };

  it('reads the name, size, centre, hidden flags and every part, vertex, face and normal', () => {
    const m = parseSpaceModel(makeSpaceModel({ name: 'ZAP.TXT', size: [10, 20, 30], centre: [1, 2, 3], hidden: [0, 1], parts: [part, { ...part, billboard: true }] }))!;
    expect(m).toMatchObject({ name: 'ZAP.TXT', size: [10, 20, 30], centre: [1, 2, 3], hidden: [0, 1] });
    expect(m.parts).toHaveLength(2);
    expect(m.parts[0]).toMatchObject({ billboard: false, faceType: 2, vertices: part.vertices, u: [0, 65536, 0], v: [0, 0, 32768], faceNormals: part.faceNormals, faceD: [0.5, -0.5] });
    expect(m.parts[0]!.faces).toEqual([{ material: 3, twoSided: false, vertices: [0, 1, 2] }, { material: 1, twoSided: true, vertices: [2, 1, 0] }]);
    expect(m.parts[1]!.billboard).toBe(true);
    expect(m.parts[1]!.vertices).toHaveLength(3);
  });

  it('keeps a part that isn\'t triangles as an empty part, and has no uv without its offset', () => {
    const m = parseSpaceModel(makeSpaceModel({ parts: [{ ...part, faceType: 3 }, { ...part, uv: undefined }] }))!;
    expect(m.parts[0]).toMatchObject({ faceType: 3, vertices: [], faces: [] });
    expect(m.parts[1]!.u).toEqual([]);
  });

  it('refuses another version, no parts, or a file cut short, as load returns false', () => {
    expect(parseSpaceModel(makeSpaceModel({ parts: [part], version: 0x6f }))).toBeNull();
    expect(parseSpaceModel(makeSpaceModel({ parts: [] }))).toBeNull();
    const whole = makeSpaceModel({ parts: [part] });
    expect(parseSpaceModel(whole.subarray(0, whole.length - 4))).toBeNull();
  });
});

describe('parseSpaceMaterials (SpaceResources::materials, space3d.cpp:537-567)', () => {
  it('reads each material\'s colour (15 bits), alpha, flags and texture name', () => {
    const mats = parseSpaceMaterials(makeSpaceMaterials([
      { colour: 0x8000 | 0x2950, flags: 1, texture: 'PURPLE.IMG' }, { alpha: 0x1000, flags: 2, texture: 'SHIELD.LBM' }, { flags: 3, texture: 'leftover' },
    ]));
    expect(mats).toEqual([
      { colour: 0x2950, alpha: 0, flags: 1, texture: 'PURPLE.IMG' }, { colour: 0, alpha: 0x1000, flags: 2, texture: 'SHIELD.LBM' }, { colour: 0, alpha: 0, flags: 3, texture: 'leftover' },
    ]);
    // (only textured and keyed materials load their texture; gouraud's name is left over from the tool)
    expect(mats.map(hasTexture)).toEqual([true, true, false]);
    expect(materialType({ colour: 0, alpha: 0, flags: 0x102, texture: '' })).toBe(2);
  });

  it('gives no materials for a file cut short', () => {
    expect(parseSpaceMaterials(makeSpaceMaterials([{ flags: 1, texture: 'A.IMG' }]).subarray(0, 40))).toEqual([]);
  });
});

describe('the textures (loadGIF, loadPBM: space3d.cpp:588-750)', () => {
  const pixels = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

  it('decodes a GIF\'s LZW and palette, and puts an interlaced GIF\'s rows back in order', () => {
    expect(decodeGif(makeGif(4, 3, pixels, ramp(7)))).toEqual({ width: 4, height: 3, pixels: Uint8Array.from(pixels), palette: ramp(7) });
    // rows 0, 2, 1 in the file's order (pass 0 has row 0, pass 2 row 2, pass 3 row 1)
    const fileOrder = [0, 1, 2, 3, 8, 9, 10, 11, 4, 5, 6, 7];
    expect(decodeGif(makeGif(4, 3, fileOrder, ramp(0), true))!.pixels).toEqual(Uint8Array.from(pixels));
  });

  it('follows a real LZW stream: codes widen past 9 bits, a repeat run needs KwKwK, and entries are looked up', () => {
    const long: number[] = [];
    for (let i = 0; i < 1500; i++) long.push(i % 2, (i * 7 + (i >> 3)) % 251);
    long.push(...new Array<number>(300).fill(5), ...new Array<number>(40).fill(0));
    const decoded = decodeGif(makeGif(long.length, 1, long, ramp(3), false, true))!;
    expect(decoded.pixels).toEqual(Uint8Array.from(long));
    const runOnly = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    expect(decodeGif(makeGif(10, 1, runOnly, ramp(3), false, true))!.pixels).toEqual(Uint8Array.from(runOnly));
  });

  it('decodes a PBM, plain or ByteRun1, with its colour map; odd widths are padded per row', () => {
    const odd = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    expect(decodePbm(makePbm(3, 3, odd, ramp(1)))).toEqual({ width: 3, height: 3, pixels: Uint8Array.from(odd), palette: ramp(1) });
    // (a one-colour row is a repeat run, the other a literal run)
    const runs = [5, 5, 5, 5, 1, 2, 3, 4];
    expect(decodePbm(makePbm(4, 2, runs, ramp(1), true))!.pixels).toEqual(Uint8Array.from(runs));
  });

  it('picks PBM for .lbm and GIF for everything else, and gives null for neither', () => {
    expect(decodeTexture('BOOM.LBM', makePbm(1, 1, [9], ramp(0)))!.pixels).toEqual(Uint8Array.of(9));
    expect(decodeTexture('purple.img', makeGif(1, 1, [9], ramp(0)))!.pixels).toEqual(Uint8Array.of(9));
    expect(decodeTexture('purple.img', makePbm(1, 1, [9], ramp(0)))).toBeNull();
  });
});

describe('spacePalette (TacticalScreen::start, tactical.cpp:271-276; Review Focus 2)', () => {
  it('is the palette of enterprs.mtl\'s first texture, not another file\'s', () => {
    const files = new Map<string, Uint8Array>([
      ['enterprs.mtl', makeSpaceMaterials([{ flags: 1, texture: 'HULL.IMG' }, { flags: 1, texture: 'OTHER.IMG' }])],
      ['hull.img', makeGif(1, 1, [0], ramp(40))],
      ['other.img', makeGif(1, 1, [0], ramp(90))],
      ['chodak.mtl', makeSpaceMaterials([{ flags: 1, texture: 'OTHER.IMG' }])],
    ]);
    expect(spacePalette(files)).toEqual(ramp(40));
    expect(spacePalette(new Map([['hull.img', makeGif(1, 1, [0], ramp(40))]]))).toBeNull();
  });
});
