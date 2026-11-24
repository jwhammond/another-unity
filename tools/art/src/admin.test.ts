// SPDX-License-Identifier: GPL-3.0-or-later
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { ADMIN_BUTTONS, ADMIN_GROOVE, adminOriginal, adminOriginalFile, adminOriginalPicture, adminPlates, composeLabel, hdPlate, missingGlyphs, paintOut, publishAdmin, SETTINGS_CUTS, TAB_CUTS, TAB_WORDS, type GlyphCut, type IndexImage } from './admin';
import { parseMrg } from './icon';
import { createHash } from 'node:crypto';
import { decodePng, encodePng, type Rgba } from './image';
import { block, picture, sprite } from './spritefixture';

let tmp = '';
afterEach(() => rm(tmp, { recursive: true, force: true }));

/** An MRG of the given entries (each a width, height and its indices). */
function mrgOf(entries: IndexImage[]): Uint8Array {
  const header = 2 + entries.length * 4;
  const bytes = new Uint8Array(header + entries.reduce((n, e) => n + 4 + e.width * e.height, 0));
  const dv = new DataView(bytes.buffer);
  dv.setUint16(0, entries.length, true);
  let off = header;
  entries.forEach((e, i) => {
    dv.setUint32(2 + i * 4, off, true);
    dv.setUint16(off, e.width, true);
    dv.setUint16(off + 2, e.height, true);
    bytes.set(e.indices, off + 4);
    off += 4 + e.width * e.height;
  });
  return bytes;
}
const filled = (width: number, height: number, colour: number): IndexImage => ({ width, height, indices: new Uint8Array(width * height).fill(colour) });
const at = (img: IndexImage, x: number, y: number): number => img.indices[y * img.width + x]!;
function paint(img: IndexImage, [x, y, w, h]: [number, number, number, number], colour: number): void {
  for (let r = y; r < y + h; r++) img.indices.fill(colour, r * img.width + x, r * img.width + x + w);
}
/** A glyph cell as the console's lit labels draw one: a ring of outline (156) around a stroke (154). */
function glyphCell(img: IndexImage, [x, y, w, h]: [number, number, number, number]): void {
  paint(img, [x, y, w, h], 156);
  paint(img, [x + 1, y + 1, w - 2, h - 2], 154);
}

const pal = new Uint8Array(128 * 3).map((_, i) => i % 64);
const copyCodec = { encode: (png: string, out: string) => copyFile(png, out), decode: async (f: string) => decodePng(new Uint8Array(await readFile(f))) };

describe('composeLabel', () => {
  it('composes SETTINGS from glyph cuts, the same size as SOUND LEVELS', () => {
    // (a 2-entry MRG: the button, a face of 131 with its old label's ink (157 and 159) in it, and a lit label to cut the glyphs from)
    const button = filled(24, 10, 131);
    paint(button, [8, 2, 8, 6], 159);
    paint(button, [9, 3, 6, 4], 157);
    const source = filled(20, 10, 159);
    glyphCell(source, [2, 2, 3, 6]);
    glyphCell(source, [10, 2, 5, 6]);
    const [b, s] = parseMrg(mrgOf([button, source])).map(e => ({ width: e.width, height: e.height, indices: e.pixels }));
    const cuts: GlyphCut[] = [{ char: 'I', from: 'source', rect: [2, 2, 3, 6] }, { char: 'O', from: 'source', rect: [10, 2, 5, 6] }];
    const out = composeLabel(b!, { rect: [2, 2, 20, 6], ink: [157, 159] }, 'OI', cuts, { source: s! }, { 154: 157, 156: 159 });
    expect([out.width, out.height]).toEqual([24, 10]);
    // (the old label's ink is gone where the new label doesn't draw; the word, 5 + 2 + 3 wide, is centred on the old label's centre, 12)
    const row = (y: number) => [...out.indices.subarray(y * 24, y * 24 + 24)];
    expect(row(4)).toEqual([131, 131, 131, 131, 131, 131, 131, 159, 157, 157, 157, 159, 131, 131, 159, 157, 159, 131, 131, 131, 131, 131, 131, 131]);
    expect(row(7)).toEqual([131, 131, 131, 131, 131, 131, 131, 159, 159, 159, 159, 159, 131, 131, 159, 159, 159, 131, 131, 131, 131, 131, 131, 131]);
    expect(at(out, 7, 2)).toBe(159);
    expect(at(out, 0, 0)).toBe(131);
  });
  it('clears a lit label\'s halo near its ink and rings the new letters with one', () => {
    // (a lit face, 159, with an old letter (154 in 156) haloed in 158 and, far from it, a 158 of the face's own)
    const lit = filled(20, 9, 159);
    paint(lit, [1, 0, 7, 9], 158);
    glyphCell(lit, [3, 2, 3, 5]);
    lit.indices[17] = 158;
    const source = filled(5, 7, 159);
    glyphCell(source, [1, 1, 3, 5]);
    const out = composeLabel(lit, { rect: [1, 0, 18, 9], ink: [154, 156], halo: { colour: 158, face: 159 } }, 'I', [{ char: 'I', from: 'source', rect: [1, 1, 3, 5] }], { source });
    // (the old letter and its halo are face; the new one, centred where the old one was, has its ring; the far 158 stays)
    expect([at(out, 1, 0), at(out, 7, 8)]).toEqual([159, 159]);
    expect([at(out, 2, 4), at(out, 3, 4), at(out, 4, 4), at(out, 5, 4), at(out, 6, 4)]).toEqual([158, 156, 154, 156, 158]);
    expect(at(out, 17, 0)).toBe(158);
  });
  it('refuses a word with a letter no label has', () => {
    const cuts: GlyphCut[] = [{ char: 'O', from: 'source', rect: [0, 0, 1, 1] }];
    expect(missingGlyphs('OK', cuts)).toEqual(['K']);
    expect(() => composeLabel(filled(4, 4, 131), { rect: [0, 0, 4, 4], ink: [] }, 'OK', cuts, { source: filled(1, 1, 154) })).toThrow(/no glyph for 'K'/);
  });
  it('has every letter SETTINGS and the tabs need', () => {
    expect(missingGlyphs('SETTINGS', SETTINGS_CUTS)).toEqual([]);
    for (const w of Object.values(TAB_WORDS)) expect(missingGlyphs(w, TAB_CUTS)).toEqual([]);
  });
});

describe('publishAdmin', () => {
  /** The console (anim 0, a picture), then five pages (speech pictures) with ink (173) where each tab glyph is cut. */
  function consoleSprite(): Uint8Array {
    const pages = [1, 2, 3, 4, 5].map(() => filled(332, 80, 128));
    for (const c of TAB_CUTS) paint(pages[Number(c.from.replace('frame', '')) - 1]!, c.rect, 173);
    const entries = [picture(4, 2, [140, 141, 13, 142, 143, 144, 145, 146]), block('PAUS', [])];
    for (const p of pages) entries.push(picture(p.width, p.height, p.indices, 'SCOM'), block('PAUS', []));
    return sprite(entries, [0, 2, 4, 6, 8, 10]);
  }
  /** Every button the console has, 201 by 46, with a glyph cell where each SETTINGS glyph is cut. */
  function consoleMrg(): Uint8Array {
    const entries = Object.keys(ADMIN_BUTTONS).map(() => filled(201, 46, 131));
    const byName = Object.fromEntries(Object.entries(ADMIN_BUTTONS).map(([i, n]) => [n, entries[Number(i)]!]));
    for (const c of SETTINGS_CUTS) glyphCell(byName[c.from]!, c.rect);
    return mrgOf(entries);
  }
  const finalSpr = sprite([picture(3, 2, [150, 151, 152, 153, 13, 155]), block('EXIT', [])], [0]);

  it('publishes every frame and named button at 4x', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'admin-test-'));
    const written = await publishAdmin(tmp, consoleSprite(), consoleMrg(), finalSpr, pal, copyCodec);
    const names = written.map(w => w.replace(/^art\/admin\/(.*)\.webp$/, '$1'));
    expect(names).toEqual(expect.arrayContaining(['frame0', 'frame5', 'final', 'settings', 'settingsLit', 'tabGame', 'tabCombatLit', 'tabKeys', ...Object.values(ADMIN_BUTTONS)]));
    expect(Object.values(ADMIN_BUTTONS)).toEqual(expect.arrayContaining(['row0', 'row5', 'ensignLit', 'textOn', 'resumeLit', 'led2', 'segOn', 'cancel', 'no', 'yes', 'difficultyOff']));
    expect(Object.keys(ADMIN_BUTTONS)).toHaveLength(29);
    const size = async (name: string) => { const i = decodePng(new Uint8Array(await readFile(join(tmp, 'art/admin', `${name}.webp`)))); return [i.width, i.height]; };
    expect(await size('frame0')).toEqual([16, 8]);
    expect(await size('frame3')).toEqual([332 * 4, 80 * 4]);
    expect(await size('final')).toEqual([12, 8]);
    expect(await size('row0')).toEqual([201 * 4, 46 * 4]);
    expect(await size('settings')).toEqual(await size('soundLevels'));
    expect(await size('settingsLit')).toEqual(await size('soundLevelsLit'));
    // (index 13 is clear; the console's colours come from standard.pal, the upper half)
    const frame0 = decodePng(new Uint8Array(await readFile(join(tmp, 'art/admin/frame0.webp'))));
    expect(frame0.data[(0 * 16 + 8) * 4 + 3]).toBe(0);
    expect([...frame0.data.subarray(0, 4)]).toEqual([...[12 * 3, 12 * 3 + 1, 12 * 3 + 2].map(v => (v % 64) << 2), 255]);
    const y = parse(await readFile(join(tmp, 'presentation.yaml'), 'utf8')) as { art: { admin: { scale: number; frames: string[]; buttons: Record<string, string>; final: string; settings: string; settingsLit: string; tabs: Record<string, string> } } };
    expect(y.art.admin.scale).toBe(4);
    expect(y.art.admin.frames).toEqual([0, 1, 2, 3, 4, 5].map(i => `art/admin/frame${i}.webp`));
    expect(y.art.admin.buttons.soundLevelsLit).toBe('art/admin/soundLevelsLit.webp');
    expect(Object.keys(y.art.admin.buttons)).toHaveLength(29);
    expect(y.art.admin.final).toBe('art/admin/final.webp');
    expect([y.art.admin.settings, y.art.admin.settingsLit]).toEqual(['art/admin/settings.webp', 'art/admin/settingsLit.webp']);
    expect(y.art.admin.tabs).toEqual({ tabGame: 'art/admin/tabGame.webp', tabGameLit: 'art/admin/tabGameLit.webp', tabCombat: 'art/admin/tabCombat.webp', tabCombatLit: 'art/admin/tabCombatLit.webp', tabKeys: 'art/admin/tabKeys.webp', tabKeysLit: 'art/admin/tabKeysLit.webp' });
  });
  it('colours final.spr\'s lower indices as tactical shows it, with the space palette (space/space.rgb), and black without one (Plan 32 Task 11)', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'admin-test-'));
    const low = sprite([picture(2, 1, [26, 150]), block('EXIT', [])], [0]);
    const pixel = async (x: number) => { const i = decodePng(new Uint8Array(await readFile(join(tmp, 'art/admin/final.webp')))); return [...i.data.subarray(x * 4 * 4, x * 4 * 4 + 4)]; };
    const warned: string[] = [];
    await publishAdmin(tmp, consoleSprite(), consoleMrg(), low, pal, { ...copyCodec, warn: m => warned.push(m) });
    expect(await pixel(0)).toEqual([0, 0, 0, 255]);
    expect(warned).toEqual([expect.stringMatching(/space\.rgb.*lower indices stay black/)]);
    const space = new Uint8Array(768).fill(7);
    space.set([41, 49, 49], 26 * 3);
    await mkdir(join(tmp, 'space'), { recursive: true });
    await writeFile(join(tmp, 'space', 'space.rgb'), space);
    await publishAdmin(tmp, consoleSprite(), consoleMrg(), low, pal, { ...copyCodec, warn: m => warned.push(m) });
    expect(await pixel(0)).toEqual([41, 49, 49, 255]);
    expect(warned.length).toBe(1);
    // (the upper half stays standard.pal's)
    expect(await pixel(1)).toEqual([...[22 * 3, 22 * 3 + 1, 22 * 3 + 2].map(v => (v % 64) << 2), 255]);
    // (the console's own pictures keep the black lower half: they never use it)
    const frame0 = decodePng(new Uint8Array(await readFile(join(tmp, 'art/admin/frame0.webp'))));
    expect([...frame0.data.subarray(0, 4)]).toEqual([...[12 * 3, 12 * 3 + 1, 12 * 3 + 2].map(v => (v % 64) << 2), 255]);
  });

  it('publishes nothing when a WebP does not read back exactly', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'admin-test-'));
    const bad = { ...copyCodec, decode: async () => ({ width: 16, height: 8, data: new Uint8Array(512).fill(7) }) };
    await expect(publishAdmin(tmp, consoleSprite(), consoleMrg(), finalSpr, pal, bad)).rejects.toThrow(/nothing was published/);
    expect(existsSync(join(tmp, 'presentation.yaml'))).toBe(false);
    expect(existsSync(join(tmp, 'art/admin/frame0.webp'))).toBe(false);
  });
  it('refuses an MRG without every button', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'admin-test-'));
    await expect(publishAdmin(tmp, consoleSprite(), mrgOf([filled(2, 1, 131)]), finalSpr, pal, copyCodec)).rejects.toThrow(/entry 1 \(row1\)/);
  });

  describe('the HD repaints (Plan 32 Task 12)', () => {
    const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
    /** A plate as a run leaves it: opaque, every pixel `rgb`, at 4x. */
    const plateOf = (w: number, h: number, rgb: [number, number, number]): Rgba => {
      const data = new Uint8Array(w * h * 4);
      for (let i = 0; i < w * h; i++) data.set([...rgb, 255], i * 4);
      return { width: w, height: h, data };
    };

    it('gives the repaint the picture in colour, its clear pixels opaque black', () => {
      const c = adminOriginalPicture(consoleSprite(), finalSpr, pal, 'console');
      expect([c.width, c.height]).toEqual([4, 2]);
      expect([...c.data.subarray(8, 12)]).toEqual([0, 0, 0, 255]);
      expect([...c.data.subarray(0, 4)]).toEqual([...[12 * 3, 12 * 3 + 1, 12 * 3 + 2].map(v => (v % 64) << 2), 255]);
      const f = adminOriginalPicture(consoleSprite(), finalSpr, pal, 'final');
      expect([f.width, f.height, f.data[4 * 4 + 3]]).toEqual([3, 2, 255]);
    });
    it('puts the original\'s clear pixels back into the plate, and refuses a plate of another size', () => {
      const out = hdPlate(plateOf(16, 8, [9, 8, 7]), { width: 4, height: 2, indices: new Uint8Array([140, 141, 13, 142, 143, 144, 145, 146]) }, 4);
      const px = (x: number, y: number) => [...out.data.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 4)];
      expect([px(7, 3), px(8, 0), px(11, 3), px(12, 0), px(8, 4)]).toEqual([[9, 8, 7, 255], [0, 0, 0, 0], [0, 0, 0, 0], [9, 8, 7, 255], [9, 8, 7, 255]]);
      expect(() => hdPlate(plateOf(15, 8, [0, 0, 0]), { width: 4, height: 2, indices: new Uint8Array(8) }, 4)).toThrow(/not 4 times/);
    });
    it('publishes the plates beside the originals as <name>.hd.webp under art.admin.hd', async () => {
      tmp = await mkdtemp(join(tmpdir(), 'admin-test-'));
      const source = (which: 'console' | 'final') => sha(encodePng(adminOriginalPicture(consoleSprite(), finalSpr, pal, which)));
      const plates = { console: { plate: plateOf(16, 8, [9, 8, 7]), source: source('console') }, final: { plate: plateOf(12, 8, [1, 2, 3]), source: source('final') } };
      const written = await publishAdmin(tmp, consoleSprite(), consoleMrg(), finalSpr, pal, { ...copyCodec, warn: () => {}, plates });
      expect(written).toEqual(expect.arrayContaining(['art/admin/frame0.webp', 'art/admin/frame0.hd.webp', 'art/admin/final.webp', 'art/admin/final.hd.webp']));
      const hd = decodePng(new Uint8Array(await readFile(join(tmp, 'art/admin/frame0.hd.webp'))));
      expect([[...hd.data.subarray(0, 4)], hd.data[8 * 4 + 3]]).toEqual([[9, 8, 7, 255], 0]);
      // (the original stays the original's pixels, for the art off)
      const orig = decodePng(new Uint8Array(await readFile(join(tmp, 'art/admin/frame0.webp'))));
      expect([...orig.data.subarray(0, 4)]).toEqual([...[12 * 3, 12 * 3 + 1, 12 * 3 + 2].map(v => (v % 64) << 2), 255]);
      const y = parse(await readFile(join(tmp, 'presentation.yaml'), 'utf8')) as { art: { admin: { hd?: Record<string, string>; final: string } } };
      expect(y.art.admin.hd).toEqual({ frame0: 'art/admin/frame0.hd.webp', final: 'art/admin/final.hd.webp' });
      expect(y.art.admin.final).toBe('art/admin/final.webp');
      // (without plates, no hd)
      await publishAdmin(tmp, consoleSprite(), consoleMrg(), finalSpr, pal, { ...copyCodec, warn: () => {} });
      expect((parse(await readFile(join(tmp, 'presentation.yaml'), 'utf8')) as { art: { admin: { hd?: unknown } } }).art.admin.hd).toBeUndefined();
    });
    it('paints a rect out with each column blended from the pixel above it to the one below', () => {
      // (a 2x4 picture at scale 2: a column of rows 10, groove 200, 200, 40 per channel; the groove is rows 2-5 of the image)
      const rows = [10, 10, 200, 200, 200, 200, 40, 40];
      const img: Rgba = { width: 4, height: 8, data: new Uint8Array(rows.flatMap(v => [v, v, v, 255, v, v, v, 255, v, v, v, 255, v, v, v, 255])) };
      const out = paintOut(img, [1, 1, 1, 2], 2);
      const col = (x: number) => Array.from({ length: 8 }, (_, y) => out.data[(y * 4 + x) * 4]!);
      // (from row 1's 10 to row 6's 40 over rows 2-5: t = 1/5 … 4/5)
      expect(col(2)).toEqual([10, 10, 16, 22, 28, 34, 40, 40]);
      expect(col(3)).toEqual([10, 10, 16, 22, 28, 34, 40, 40]);
      expect(col(0)).toEqual(rows);
      expect(img.data[2 * 16]).toBe(200);
      // (sampled a margin clear of the rect: rows 0 and 7 here, 10 and 40)
      const far: Rgba = { ...img, data: new Uint8Array(img.data) };
      for (const y of [1, 6]) for (let x = 0; x < 4; x++) far.data.fill(99, (y * 4 + x) * 4, (y * 4 + x) * 4 + 3);
      expect(Array.from({ length: 8 }, (_, y) => paintOut(far, [1, 1, 1, 2], 2, 0.5).data[(y * 4 + 2) * 4]!)).toEqual([10, 99, 19, 23, 27, 31, 99, 40]);
      // (clipped to the image; wholly outside, unchanged)
      expect([...paintOut(img, [10, 10, 2, 2], 2).data]).toEqual([...img.data]);
    });
    it('paints the LED groove out of the HD console (Plan 32 Task 12 fix 1)', async () => {
      tmp = await mkdtemp(join(tmpdir(), 'admin-test-'));
      // (a console big enough for the groove: face 140, the groove 141)
      const [gx, gy, gw, gh] = ADMIN_GROOVE;
      const W = gx + gw + 2, H = gy + gh + 6;
      const body = filled(W, H, 140);
      paint(body, [gx, gy, gw, gh], 141);
      const spr = sprite([picture(W, H, body.indices), block('PAUS', []), ...[1, 2, 3, 4, 5].flatMap(() => [picture(332, 80, (() => { const p = filled(332, 80, 128); for (const c of TAB_CUTS) paint(p, c.rect, 173); return p.indices; })(), 'SCOM'), block('PAUS', [])])], [0, 2, 4, 6, 8, 10]);
      const source = sha(encodePng(adminOriginalPicture(spr, finalSpr, pal, 'console')));
      // (the plate: rows shading from 0 at the top to 255 at the foot, the groove 7)
      const plate: Rgba = { width: W * 4, height: H * 4, data: new Uint8Array(W * 4 * H * 4 * 4) };
      for (let y = 0; y < H * 4; y++) for (let x = 0; x < W * 4; x++) {
        const v = y >= gy * 4 && y < (gy + gh) * 4 && x >= gx * 4 && x < (gx + gw) * 4 ? 7 : Math.round((y / (H * 4 - 1)) * 255);
        plate.data.set([v, v, v, 255], (y * W * 4 + x) * 4);
      }
      await publishAdmin(tmp, spr, consoleMrg(), finalSpr, pal, { ...copyCodec, warn: () => {}, plates: { console: { plate, source } } });
      const hd = decodePng(new Uint8Array(await readFile(join(tmp, 'art/admin/frame0.hd.webp'))));
      const v = (x: number, y: number) => hd.data[(y * hd.width + x) * 4]!;
      const mid = (gy + gh / 2) * 4;
      // (no 7 is left; the fill shades between the rows above and below, as the face round it)
      expect(v((gx + 10) * 4, mid)).toBeGreaterThan(v((gx + 10) * 4, gy * 4));
      expect(Math.abs(v((gx + 10) * 4, mid) - Math.round((mid / (H * 4 - 1)) * 255))).toBeLessThanOrEqual(2);
      expect(v((gx - 1) * 4, mid)).toBe(Math.round((mid / (H * 4 - 1)) * 255));
      // (the original's frame0 keeps its groove)
      const orig = decodePng(new Uint8Array(await readFile(join(tmp, 'art/admin/frame0.webp'))));
      const o = (x: number, y: number) => [...orig.data.subarray((y * orig.width + x) * 4, (y * orig.width + x) * 4 + 3)];
      expect(o((gx + 10) * 4, mid)).not.toEqual(o((gx - 1) * 4, mid));
    });
    describe('the screen\'s pages (Plan 33 Task 7)', () => {
      // (a console big enough for a page at (44, 47): face 140; each page 332 by 80 of black 128, with its own colour 160 + n at its top-left)
      const W = 380, H = 130;
      const pageOf = (n: number): IndexImage => {
        const p = filled(332, 80, 128);
        for (const c of TAB_CUTS) paint(p, c.rect, 173);
        p.indices[0] = 160 + n;
        return p;
      };
      const bigSprite = (): Uint8Array => sprite([picture(W, H, filled(W, H, 140).indices), block('PAUS', []), ...[1, 2, 3, 4, 5].flatMap(n => [picture(332, 80, pageOf(n).indices, 'SCOM'), block('PAUS', [])])], [0, 2, 4, 6, 8, 10]);
      const colour = (i: number) => [...[i * 3 - 384, i * 3 - 383, i * 3 - 382].map(v => (v % 64) << 2)];

      it('gives the run the page drawn on the console where the console draws it', () => {
        const o = adminOriginalPicture(bigSprite(), finalSpr, pal, 'sound');
        const px = (x: number, y: number) => [...o.data.subarray((y * W + x) * 4, (y * W + x) * 4 + 3)];
        expect([o.width, o.height]).toEqual([W, H]);
        expect([px(44, 47), px(45, 47), px(43, 47), px(44, 46), px(44 + 332, 47)]).toEqual([colour(165), colour(128), colour(140), colour(140), colour(140)]);
        // (a page that doesn't fit the console is refused)
        expect(() => adminOriginalPicture(consoleSprite(), finalSpr, pal, 'load')).toThrow(/load page.*outside the console/);
      });
      it('publishes a page\'s plate cut back out of the console, as frame<n>.hd.webp, the original frame<n> unchanged', async () => {
        tmp = await mkdtemp(join(tmpdir(), 'admin-test-'));
        const spr = bigSprite();
        const source = sha(encodePng(adminOriginalPicture(spr, finalSpr, pal, 'quit')));
        // (the plate: each pixel's red its x / 4 mod 256, green its y / 4)
        const plate: Rgba = { width: W * 4, height: H * 4, data: new Uint8Array(W * 4 * H * 4 * 4) };
        for (let y = 0; y < H * 4; y++) for (let x = 0; x < W * 4; x++) plate.data.set([(x >> 2) & 255, y >> 2, 0, 255], (y * W * 4 + x) * 4);
        const written = await publishAdmin(tmp, spr, consoleMrg(), finalSpr, pal, { ...copyCodec, warn: () => {}, plates: { quit: { plate, source } } });
        expect(written).toEqual(expect.arrayContaining(['art/admin/frame4.webp', 'art/admin/frame4.hd.webp']));
        const hd = decodePng(new Uint8Array(await readFile(join(tmp, 'art/admin/frame4.hd.webp'))));
        const px = (x: number, y: number) => [...hd.data.subarray((y * hd.width + x) * 4, (y * hd.width + x) * 4 + 4)];
        expect([hd.width, hd.height]).toEqual([332 * 4, 80 * 4]);
        expect([px(0, 0), px(331 * 4 + 3, 79 * 4 + 3)]).toEqual([[44, 47, 0, 255], [(44 + 331) & 255, 47 + 79, 0, 255]]);
        const orig = decodePng(new Uint8Array(await readFile(join(tmp, 'art/admin/frame4.webp'))));
        expect([...orig.data.subarray(0, 3)]).toEqual(colour(164));
        const y = parse(await readFile(join(tmp, 'presentation.yaml'), 'utf8')) as { art: { admin: { hd?: Record<string, string>; frames: string[] } } };
        expect(y.art.admin.hd).toEqual({ frame4: 'art/admin/frame4.hd.webp' });
        expect(y.art.admin.frames[4]).toBe('art/admin/frame4.webp');
        // (a run made from another page is refused)
        await expect(publishAdmin(tmp, spr, consoleMrg(), finalSpr, pal, { ...copyCodec, warn: () => {}, plates: { new: { plate, source } } })).rejects.toThrow(/plate\.admin\.new.*older new.*nothing was published/);
      });
      it('reads each page\'s last run by its recipe', async () => {
        tmp = await mkdtemp(join(tmpdir(), 'admin-test-'));
        const dir = join(tmp, 'work', 'plate.admin.sound', 'run1');
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'plate.png'), encodePng(plateOf(8, 8, [4, 5, 6])));
        await writeFile(join(tmp, 'work', 'plate.admin.sound', 'last.json'), JSON.stringify({ dir, meta: { source: 'def' } }));
        const got = await adminPlates({ work: join(tmp, 'work') });
        expect([Object.keys(got), got.sound!.source]).toEqual([['sound'], 'def']);
      });
    });
    it('refuses a plate made from another original, publishing nothing', async () => {
      tmp = await mkdtemp(join(tmpdir(), 'admin-test-'));
      const plates = { console: { plate: plateOf(16, 8, [9, 8, 7]), source: 'old' } };
      await expect(publishAdmin(tmp, consoleSprite(), consoleMrg(), finalSpr, pal, { ...copyCodec, warn: () => {}, plates })).rejects.toThrow(/plate\.admin.*older console.*nothing was published/);
      expect(existsSync(join(tmp, 'presentation.yaml'))).toBe(false);
    });
    it('reads the last runs\' plates and sources, leaving out a repaint with no run', async () => {
      tmp = await mkdtemp(join(tmpdir(), 'admin-test-'));
      const dir = join(tmp, 'work', 'plate.final', 'run1');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'plate.png'), encodePng(plateOf(12, 8, [1, 2, 3])));
      await writeFile(join(tmp, 'work', 'plate.final', 'last.json'), JSON.stringify({ dir, meta: { source: 'abc' } }));
      const got = await adminPlates({ work: join(tmp, 'work') });
      expect(Object.keys(got)).toEqual(['final']);
      expect([got.final!.source, got.final!.plate.width, got.final!.plate.data[0]]).toEqual(['abc', 12, 1]);
    });
    it('decodes the original into the cache from the game zip, or reads the one decoded before', async () => {
      tmp = await mkdtemp(join(tmpdir(), 'admin-test-'));
      const cache = { root: join(tmp, 'cache') };
      await expect(adminOriginalFile(cache, 'console', tmp)).rejects.toThrow(/GAMEDATA_DIR/);
      const members: Record<string, Uint8Array> = { 'adminmnu.spr': consoleSprite(), 'final.spr': finalSpr, 'standard.pal': pal };
      const read = async (_zip: string, m: string) => members[m]!;
      // (final.spr's lower indices need the space palette)
      await expect(adminOriginalFile(cache, 'final', tmp, '/zip', read)).rejects.toThrow(/space\.rgb/);
      const png = await adminOriginalFile(cache, 'console', tmp, '/zip', read);
      expect(decodePng(png).width).toBe(4);
      expect(new Uint8Array(await readFile(adminOriginal(cache, 'console')))).toEqual(png);
      expect(await adminOriginalFile(cache, 'console', tmp)).toEqual(png);
    });
  });
});
