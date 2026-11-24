// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The admin console's pictures (the "RGCD" PADD, adminmnu.cpp), published as they are, the way the tricorder's are (tricorder.ts): adminmnu.spr's
 * six animations (the console, 420 by 478, then the five screen pages, 332 by 256, speech pictures), adminmnu.mrg's buttons by name
 * (phase4_rest.md §6.2) and final.spr (the F1 Combat Options screen, 562 by 334). Every picture is decoded with standard.pal (the upper half),
 * index 13 clear (COLOUR_BLANK, which blit and drawMRG skip), scaled up 4x nearest-neighbour and written as lossless WebP to
 * games/unity/art/admin/<name>.webp, with presentation.yaml's art.admin.
 *
 * Two kinds of picture are the remake's, made only from the console's own pixels:
 * - SETTINGS (`settings`, `settingsLit`): the SOUND LEVELS button with its label cleared to its face and SETTINGS written in glyphs cut from the
 *   console's lit labels (SETTINGS_CUTS). Lit labels are cut because every letter needed has one; the plain button's colours are theirs mapped as
 *   the SOUND LEVELS pair maps them (NORMAL_INK).
 * - The settings page's tab words (`tabGame` …, each with its lit twin): glyphs cut from the screen's printed headings (TAB_CUTS), on clear, lit as
 *   the frame's LOAD pill lights (PILL_LIT).
 * Where each goes is the engine's. Local and git-ignored, like the rest of art/.
 *
 * With the art on, the console's body and final.spr are shown as their HD repaints (Plan 32 Task 12): art/recipes/plate.admin.yaml and plate.final.yaml
 * repaint the pictures adminOriginalFile decodes, and publish puts each last run beside its original (`<name>.hd.webp`, art.admin.hd). The screen's
 * five pages are shown in HD too (Plan 33 Task 7, plate.admin.<page>.yaml): each is run drawn where the console draws it, on the console, so the
 * upscale sees what the screen shows round it; publish cuts the page back out.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { spriteAnimation } from './enginespr';
import type { ArtCache } from './cache';
import { mrgIcon, parseMrg } from './icon';
import { decodePng, encodePng, meanAbsDiff, type Rgba } from './image';
import { readZipMember } from './shiporig';
import { nearestResize } from './pixel';
import { COLOUR_BLANK, colourFrame } from './shipsprite';
import { readWebp, toWebp } from './webp';

/** adminmnu.mrg's entries by name (phase4_rest.md §6.2): the slot rows' highlights, each button and its lit twin, the LEDs, the volume segment. */
export const ADMIN_BUTTONS: Record<number, string> = {
  0: 'row0', 1: 'row1', 2: 'row2', 3: 'row3', 4: 'row4', 5: 'row5',
  6: 'ensign', 7: 'ensignLit', 8: 'lieutenant', 9: 'lieutenantLit', 10: 'captain', 11: 'captainLit',
  12: 'textOff', 13: 'textOffLit', 14: 'textOn', 15: 'textOnLit', 16: 'resume', 17: 'resumeLit',
  18: 'led0', 19: 'led1', 20: 'led2',
  21: 'soundLevels', 22: 'soundLevelsLit', 23: 'segOff', 24: 'segOn',
  25: 'cancel', 26: 'no', 27: 'yes', 28: 'difficultyOff',
};
/** adminmnu.spr's animations, each one picture: the console, then the screen's five pages. Published as frame0 … frame5. */
export const ADMIN_FRAMES = 6;

/** A picture in palette indices. */
export interface IndexImage { width: number; height: number; indices: Uint8Array }
export type Rect = [x: number, y: number, w: number, h: number];
/** A letter cut from a picture: `from` is a button's or a frame's name, `rect` the letter's cell in it. */
export interface GlyphCut { char: string; from: string; rect: Rect }
/**
 * Where a button's label sits (the rectangle to clear) and the colours of its ink there. A lit label also has a halo: a ring of `halo` round its
 * letters on the face (`face`), cleared with them where it is within two pixels of the ink, and drawn round the new letters, a pixel wide.
 */
export interface LabelSpec { rect: Rect; ink: number[]; halo?: { colour: number; face: number } }

/** The ink of a lit label (SOUND LEVELS lit, TEXT, the DIFFICULTY words): its stroke (154) and the outline round it (156). */
export const BUTTON_INK = [154, 156];
/**
 * SETTINGS' letters, each a 16-row cell (the stroke's 14 rows and the outline round it), from lit labels: SOUND LEVELS lit's S, E and N, TEXT's T,
 * the DIFFICULTY word's I and G (the only G the console has).
 */
export const SETTINGS_CUTS: GlyphCut[] = [
  { char: 'S', from: 'soundLevelsLit', rect: [16, 12, 8, 16] },
  { char: 'E', from: 'soundLevelsLit', rect: [81, 12, 8, 16] },
  { char: 'N', from: 'soundLevelsLit', rect: [46, 12, 8, 16] },
  { char: 'T', from: 'textOff', rect: [34, 12, 9, 16] },
  { char: 'I', from: 'ensign', rect: [146, 12, 3, 16] },
  { char: 'G', from: 'ensign', rect: [151, 12, 8, 16] },
];
/**
 * SOUND LEVELS' label: the rectangle its letters (rows 12-27 with their outlines) and the lit one's halo fill, and its ink plain (the outline 159,
 * the stroke 157, their corners 133 and 158) and lit (with the halo, 158 on the face 159).
 */
export const SOUND_LEVELS_LABEL: Rect = [14, 10, 117, 20];
export const SOUND_LEVELS_INK = { normal: { ink: [133, 157, 158, 159] }, lit: { ink: BUTTON_INK, halo: { colour: 158, face: 159 } } };
/** A lit label's ink as the plain button draws it: SOUND LEVELS lit against plain, pixel for pixel (the stroke 154 is 157, the outline 156 is 159). */
export const NORMAL_INK: Record<number, number> = { 154: 157, 156: 159 };

/**
 * The tab words' letters, from the screen's printed text (one font, 12 rows, its stroke anti-aliased into black): the sound page's two headings
 * (frame5) and, for Y, the quit page's question (frame3).
 */
export const TAB_CUTS: GlyphCut[] = [
  { char: 'O', from: 'frame5', rect: [39, 17, 7, 12] },
  { char: 'C', from: 'frame5', rect: [52, 17, 7, 12] },
  { char: 'E', from: 'frame5', rect: [61, 17, 6, 12] },
  { char: 'S', from: 'frame5', rect: [69, 17, 7, 12] },
  { char: 'T', from: 'frame5', rect: [128, 17, 8, 12] },
  { char: 'M', from: 'frame5', rect: [177, 17, 10, 12] },
  { char: 'B', from: 'frame5', rect: [228, 17, 7, 12] },
  { char: 'A', from: 'frame5', rect: [236, 17, 9, 12] },
  { char: 'K', from: 'frame5', rect: [255, 17, 7, 12] },
  { char: 'G', from: 'frame5', rect: [263, 17, 7, 12] },
  { char: 'Y', from: 'frame3', rect: [109, 64, 8, 12] },
];
export const TAB_WORDS: Record<string, string> = { tabGame: 'GAME', tabCombat: 'COMBAT', tabKeys: 'KEYS' };
/** The screen's black (index 128): clear around a tab word. */
const SCREEN_BLACK = 128;
/** The screen's text lit, as the LOAD pill's word is (frame2's against frame1's): the blue 173 is 144, its edges one shade up. */
export const PILL_LIT: Record<number, number> = { 173: 144, 172: 174, 171: 172, 170: 171 };
/** Blank columns between letters, as the console's labels space them. */
const LETTER_GAP = 2;

/** The letters of `text` (but spaces) that no cut has. */
export function missingGlyphs(text: string, cuts: GlyphCut[]): string[] {
  return [...new Set([...text].filter(c => c !== ' ' && !cuts.some(g => g.char === c)))];
}

/** The pixels of `rect` in `src` that `ink` keeps; every other one blank (COLOUR_BLANK). */
function cutGlyph(src: IndexImage, [x, y, w, h]: Rect, ink: (c: number) => boolean, from: string): IndexImage {
  if (x < 0 || y < 0 || x + w > src.width || y + h > src.height) throw new Error(`the glyph cut [${x}, ${y}, ${w}, ${h}] is outside ${from} (${src.width} by ${src.height})`);
  const out: IndexImage = { width: w, height: h, indices: new Uint8Array(w * h).fill(COLOUR_BLANK) };
  for (let r = 0; r < h; r++)
    for (let c = 0; c < w; c++) {
      const v = src.indices[(y + r) * src.width + x + c]!;
      if (ink(v)) out.indices[r * w + c] = v;
    }
  return out;
}

/** `text` in the cuts' letters, `LETTER_GAP` apart, on blank; a colour in `map` is drawn as its value. */
function word(text: string, cuts: GlyphCut[], sources: Record<string, IndexImage>, ink: (c: number) => boolean, map: Record<number, number>): IndexImage {
  const glyphs = [...text].map(ch => {
    const cut = cuts.find(g => g.char === ch);
    if (!cut) throw new Error(`no glyph for '${ch}' in the console's labels`);
    const src = sources[cut.from];
    if (!src) throw new Error(`no picture ${cut.from} to cut '${ch}' from`);
    const g = cutGlyph(src, cut.rect, ink, cut.from);
    if (!g.indices.some(v => v !== COLOUR_BLANK)) throw new Error(`the cut for '${ch}' in ${cut.from} has no ink`);
    return g;
  });
  const width = glyphs.reduce((n, g) => n + g.width, 0) + LETTER_GAP * (glyphs.length - 1);
  const height = Math.max(...glyphs.map(g => g.height));
  const out: IndexImage = { width, height, indices: new Uint8Array(width * height).fill(COLOUR_BLANK) };
  let x = 0;
  for (const g of glyphs) {
    for (let r = 0; r < g.height; r++)
      for (let c = 0; c < g.width; c++) {
        const v = g.indices[r * g.width + c]!;
        if (v !== COLOUR_BLANK) out.indices[r * width + x + c] = map[v] ?? v;
      }
    x += g.width + LETTER_GAP;
  }
  return out;
}

/**
 * `base` with its label replaced by `text`. The old label's ink (and a lit one's halo near it) is cleared to the face: each pixel takes one of the
 * face's own pixels in its column, picked by a fixed hash, so the face's dither and the glare's band carry on through. The new word, cut from lit
 * labels and drawn in `map`'s colours, is centred where the old one was, with its halo if the label has one.
 */
export function composeLabel(base: IndexImage, label: LabelSpec, text: string, cuts: GlyphCut[], sources: Record<string, IndexImage>, map: Record<number, number> = {}): IndexImage {
  const glyphs = word(text, cuts, sources, c => BUTTON_INK.includes(c), map);
  const [lx, ly, lw, lh] = label.rect;
  const { width } = base;
  const at = (x: number, y: number): number => y * width + x;
  const inRect = (x: number, y: number): boolean => x >= lx && x < lx + lw && y >= ly && y < ly + lh;
  const isInk = (x: number, y: number): boolean => inRect(x, y) && label.ink.includes(base.indices[at(x, y)]!);
  const nearInk = (x: number, y: number): boolean => {
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (isInk(x + dx, y + dy)) return true;
    return false;
  };
  const cleared = (x: number, y: number): boolean => isInk(x, y) || (!!label.halo && base.indices[at(x, y)] === label.halo.colour && nearInk(x, y));
  const out: IndexImage = { width, height: base.height, indices: base.indices.slice() };
  let minX = Infinity, maxX = -Infinity;
  // (each column's face pixels; a column the label fills top to bottom borrows the nearest column's)
  const faces = Array.from({ length: lw }, (_, i) => {
    const ys: number[] = [];
    for (let y = ly; y < ly + lh; y++) if (!cleared(lx + i, y)) ys.push(y);
    return ys;
  });
  for (let x = lx; x < lx + lw; x++) {
    let fx = x;
    for (let d = 1; faces[fx - lx]!.length === 0 && d < lw; d++) {
      if (x - d >= lx && faces[x - d - lx]!.length > 0) fx = x - d;
      else if (x + d < lx + lw && faces[x + d - lx]!.length > 0) fx = x + d;
    }
    const face = faces[fx - lx]!;
    for (let y = ly; y < ly + lh; y++) {
      if (isInk(x, y)) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
      if (face.length > 0 && cleared(x, y)) out.indices[at(x, y)] = base.indices[at(fx, face[((Math.imul(x, 73856093) ^ Math.imul(y, 19349663)) >>> 0) % face.length]!)]!;
    }
  }
  const centre = Number.isFinite(minX) ? (minX + maxX + 1) / 2 : lx + lw / 2;
  const x0 = Math.round(centre - glyphs.width / 2);
  const y0 = ly + Math.floor((lh - glyphs.height) / 2);
  const glyphAt = (c: number, r: number): number => (c < 0 || r < 0 || c >= glyphs.width || r >= glyphs.height ? COLOUR_BLANK : glyphs.indices[r * glyphs.width + c]!);
  for (let r = -1; r <= glyphs.height; r++)
    for (let c = -1; c <= glyphs.width; c++) {
      const x = x0 + c, y = y0 + r;
      if (x < 0 || y < 0 || x >= width || y >= base.height) continue;
      const v = glyphAt(c, r);
      if (v !== COLOUR_BLANK) out.indices[at(x, y)] = v;
      else if (label.halo && out.indices[at(x, y)] === label.halo.face && [-1, 0, 1].some(dr => [-1, 0, 1].some(dc => glyphAt(c + dc, r + dr) !== COLOUR_BLANK))) out.indices[at(x, y)] = label.halo.colour;
    }
  return out;
}

/** A tab word in the screen's letters, on clear, plain or lit. */
export function tabWord(text: string, frames: Record<string, IndexImage>, lit: boolean): IndexImage {
  return word(text, TAB_CUTS, frames, c => c !== SCREEN_BLACK && c !== COLOUR_BLANK, lit ? PILL_LIT : {});
}

export interface AdminSprite { name: string; image: Rgba; width: number; height: number }
export interface AdminPictures { frames: AdminSprite[]; buttons: AdminSprite[]; final: AdminSprite; settings: AdminSprite[]; tabs: AdminSprite[] }

/**
 * The console's palette and final.spr's: 256 entries with standard.pal (6-bit) as the upper half; the lower half (the room's) black for the console.
 * final.spr (the F1 Combat Options) is shown over tactical, whose palette's lower half is the space palette's (TacticalScreen::start sets
 * enterprs.mtl's first texture's colours for the whole battle: tactical.cpp:271-276, published as space/space.rgb). About 80 of its pixels,
 * the emblem's and the buttons' edges, use that half (indices 26, 81, 85 and 124: greys there); under the room's black they were black
 * (Plan 32 Task 6's gap). Without the space palette, its lower half stays black too.
 */
function adminPalettes(standardPal: Uint8Array, spacePalette?: Uint8Array): { pal: Uint8Array; finalPal: Uint8Array } {
  const pal = new Uint8Array(256 * 3);
  for (let i = 0; i < 128 * 3; i++) pal[128 * 3 + i] = Math.min(255, standardPal[i]! << 2);
  const finalPal = new Uint8Array(pal);
  if (spacePalette && spacePalette.length >= 128 * 3) finalPal.set(spacePalette.subarray(0, 128 * 3), 0);
  return { pal, finalPal };
}

/** Every picture the console publishes, in colour (index 13 clear) at `scale` times its size. */
export function adminPictures(spr: Uint8Array, mrg: Uint8Array, finalSpr: Uint8Array, standardPal: Uint8Array, scale = 4, spacePalette?: Uint8Array): AdminPictures {
  const { pal, finalPal } = adminPalettes(standardPal, spacePalette);
  const sprite = (name: string, img: IndexImage, colours = pal): AdminSprite => ({ name, image: nearestResize(colourFrame(img, colours), img.width * scale, img.height * scale), width: img.width, height: img.height });
  const frameImages: Record<string, IndexImage> = {};
  for (let a = 0; a < ADMIN_FRAMES; a++) {
    const [f] = spriteAnimation(spr, a, true);
    if (!f) throw new Error(`adminmnu.spr has no picture in animation ${a}`);
    frameImages[`frame${a}`] = f;
  }
  const [fin] = spriteAnimation(finalSpr, 0, true);
  if (!fin) throw new Error('final.spr has no picture in its first animation');
  const entries = parseMrg(mrg);
  const buttonImages: Record<string, IndexImage> = {};
  const buttons: AdminSprite[] = [];
  for (const [i, name] of Object.entries(ADMIN_BUTTONS)) {
    const e = entries[Number(i)];
    if (!e) throw new Error(`adminmnu.mrg has no entry ${i} (${name})`);
    buttonImages[name] = { width: e.width, height: e.height, indices: e.pixels };
    const img = mrgIcon(mrg, standardPal, Number(i), [0, 0, e.width, e.height], COLOUR_BLANK);
    buttons.push({ name, image: nearestResize(img, e.width * scale, e.height * scale), width: e.width, height: e.height });
  }
  const settings = [
    sprite('settings', composeLabel(buttonImages.soundLevels!, { rect: SOUND_LEVELS_LABEL, ...SOUND_LEVELS_INK.normal }, 'SETTINGS', SETTINGS_CUTS, buttonImages, NORMAL_INK)),
    sprite('settingsLit', composeLabel(buttonImages.soundLevelsLit!, { rect: SOUND_LEVELS_LABEL, ...SOUND_LEVELS_INK.lit }, 'SETTINGS', SETTINGS_CUTS, buttonImages)),
  ];
  const tabs = Object.entries(TAB_WORDS).flatMap(([name, text]) => [sprite(name, tabWord(text, frameImages, false)), sprite(`${name}Lit`, tabWord(text, frameImages, true))]);
  return {
    frames: Object.entries(frameImages).map(([name, img]) => sprite(name, img)),
    buttons,
    final: sprite('final', fin, finalPal),
    settings,
    tabs,
  };
}

export interface AdminDeps {
  /**
   * The HD repaints (Plan 32 Task 12), each a run's plate (`scale` times the picture's size, opaque) and the sha256 of the original it was made
   * from (adminPlates reads both from the last runs). Published beside the originals as `<name>.hd.webp`, the original's clear pixels clear, under
   * art.admin.hd; the art on shows them, the art off the originals.
   */
  plates?: Partial<Record<AdminPlate, { plate: Rgba; source: string }>>;
  encode?: (png: string, out: string) => Promise<void>;
  decode?: (webp: string) => Promise<Rgba>;
  /** Where a warning goes (console.warn). */
  warn?: (message: string) => void;
}

/** Publishes the console's pictures; every WebP is read back and must be the scaled picture exactly, or nothing is renamed or recorded. */
export async function publishAdmin(gameDir: string, spr: Uint8Array, mrg: Uint8Array, finalSpr: Uint8Array, standardPal: Uint8Array, deps: AdminDeps = {}, scale = 4): Promise<string[]> {
  const encode = deps.encode ?? ((png, out) => toWebp(png, out, { quality: 100, lossless: true, alpha: true }));
  const decode = deps.decode ?? readWebp;
  // (the space palette, as the space build published it, for final.spr's lower indices: adminPictures)
  const spacePath = join(gameDir, 'space', 'space.rgb');
  const spacePalette = existsSync(spacePath) ? new Uint8Array(await readFile(spacePath)) : undefined;
  if (!spacePalette) (deps.warn ?? console.warn)(`admin: no ${spacePath} (the space build's palette): final.spr's lower indices stay black; build the space set first (npm run unity:build)`);
  const pics = adminPictures(spr, mrg, finalSpr, standardPal, scale, spacePalette);
  const hd: AdminSprite[] = [];
  for (const [which, given] of Object.entries(deps.plates ?? {}) as [AdminPlate, { plate: Rgba; source: string }][]) {
    const { recipe, published } = ADMIN_PLATES[which];
    const original = adminOriginalPicture(spr, finalSpr, standardPal, which, spacePalette);
    if (given.source !== sha(encodePng(original))) throw new Error(`${recipe}'s last run was made from an older ${which} picture: run npm run art -- run art/recipes/${recipe}.yaml again; nothing was published`);
    const plate = hdPlate(given.plate, plateIndices(spr, finalSpr, which), scale);
    if (isPage(which)) {
      const page = pageIndices(spr, which);
      const [x, y] = ADMIN_PAGE_AT;
      hd.push({ name: `${published}.hd`, image: cropImage(plate, [x * scale, y * scale, page.width * scale, page.height * scale]), width: page.width, height: page.height });
    } else hd.push({ name: `${published}.hd`, image: which === 'console' ? paintOut(plate, ADMIN_GROOVE, scale, GROOVE_MARGIN) : plate, width: original.width, height: original.height });
  }
  const all = [...pics.frames, ...pics.buttons, pics.final, ...pics.settings, ...pics.tabs, ...hd];
  const work = await mkdtemp(join(tmpdir(), 'admin-'));
  const staged: { tmp: string; dest: string; name: string; rel: string }[] = [];
  try {
    await mkdir(join(gameDir, 'art', 'admin'), { recursive: true });
    for (const s of all) {
      const rel = `art/admin/${s.name}.webp`;
      const dest = join(gameDir, rel);
      const png = join(work, `${s.name}.png`);
      await writeFile(png, encodePng(s.image));
      const tmp = `${dest}.tmp`;
      await encode(png, tmp);
      staged.push({ tmp, dest, name: s.name, rel });
      const drift = meanAbsDiff(s.image, await decode(tmp));
      if (drift !== 0) throw new Error(`${rel}: the WebP differs from the picture's pixels (mean ${drift.toFixed(2)}/255); nothing was published`);
    }
  } catch (e) {
    for (const s of staged) await rm(s.tmp, { force: true });
    throw e;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  for (const s of staged) await rename(s.tmp, s.dest);
  const rel = (name: string): string => `art/admin/${name}.webp`;
  const path = join(gameDir, 'presentation.yaml');
  const doc = parseDocument(existsSync(path) ? await readFile(path, 'utf8') : '');
  doc.setIn(['art', 'admin'], {
    scale,
    frames: pics.frames.map(f => rel(f.name)),
    buttons: Object.fromEntries(pics.buttons.map(b => [b.name, rel(b.name)])),
    final: rel('final'),
    settings: rel('settings'),
    settingsLit: rel('settingsLit'),
    tabs: Object.fromEntries(pics.tabs.map(t => [t.name, rel(t.name)])),
    ...(hd.length > 0 ? { hd: Object.fromEntries(hd.map(h => [h.name.replace(/\.hd$/, ''), rel(h.name)])) } : {}),
  });
  await writeFile(path, String(doc));
  return staged.map(s => s.rel);
}

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** The screen's pages (adminmnu.spr's animations 1-5), by the name their HD run goes by (Plan 33 Task 7). */
export const ADMIN_PAGES = { load: 1, save: 2, new: 3, quit: 4, sound: 5 } as const;
export type AdminPage = keyof typeof ADMIN_PAGES;
/**
 * Where the console draws a page, its top-left in the console's pixels (adminConsole.tsx's PIC.page): the sound page's emblem and pills fall on the
 * console's own there, pixel for pixel.
 */
export const ADMIN_PAGE_AT = [44, 47] as const;
const isPage = (which: AdminPlate): which is AdminPage => Object.hasOwn(ADMIN_PAGES, which);

/**
 * The pictures the art pipeline makes HD, the recipe (and run) each is, and the picture each stands in for: the console's body and final.spr (Plan 32
 * Task 12), and the screen's pages (Plan 33 Task 7).
 */
export type AdminPlate = 'console' | 'final' | AdminPage;
export const ADMIN_PLATES: Record<AdminPlate, { recipe: string; published: `frame${0 | 1 | 2 | 3 | 4 | 5}` | 'final' }> = {
  console: { recipe: 'plate.admin', published: 'frame0' },
  final: { recipe: 'plate.final', published: 'final' },
  load: { recipe: 'plate.admin.load', published: 'frame1' },
  save: { recipe: 'plate.admin.save', published: 'frame2' },
  new: { recipe: 'plate.admin.new', published: 'frame3' },
  quit: { recipe: 'plate.admin.quit', published: 'frame4' },
  sound: { recipe: 'plate.admin.sound', published: 'frame5' },
};
/** Where a repaint's input is decoded to, in the art cache. */
export const adminOriginal = (cache: Pick<ArtCache, 'root'>, which: AdminPlate): string => join(cache.root, 'originals', 'admin', `${which}.png`);

/** A page (adminmnu.spr's animation 1-5), in indices. */
function pageIndices(spr: Uint8Array, which: AdminPage): IndexImage {
  const [p] = spriteAnimation(spr, ADMIN_PAGES[which], true);
  if (!p) throw new Error(`adminmnu.spr has no picture in animation ${ADMIN_PAGES[which]} (the ${which} page)`);
  return p;
}

/**
 * The console's body (adminmnu.spr's first picture) or final.spr's, in indices; for a page, the console with the page drawn on it at ADMIN_PAGE_AT
 * (its clear pixels, if any, showing the console), as the screen shows it.
 */
function plateIndices(spr: Uint8Array, finalSpr: Uint8Array, which: AdminPlate): IndexImage {
  const [f] = which === 'final' ? spriteAnimation(finalSpr, 0, true) : spriteAnimation(spr, 0, true);
  if (!f) throw new Error(`${which === 'final' ? 'final.spr' : 'adminmnu.spr'} has no picture in its first animation`);
  if (!isPage(which)) return f;
  const page = pageIndices(spr, which);
  const [px, py] = ADMIN_PAGE_AT;
  if (px + page.width > f.width || py + page.height > f.height) throw new Error(`the ${which} page (${page.width} by ${page.height}) at (${px}, ${py}) is outside the console (${f.width} by ${f.height})`);
  const out: IndexImage = { width: f.width, height: f.height, indices: f.indices.slice() };
  for (let y = 0; y < page.height; y++)
    for (let x = 0; x < page.width; x++) {
      const v = page.indices[y * page.width + x]!;
      if (v !== COLOUR_BLANK) out.indices[(py + y) * f.width + px + x] = v;
    }
  return out;
}

/** `rect` ([x, y, w, h]) of `img`. */
function cropImage(img: Rgba, [x, y, w, h]: Rect): Rgba {
  if (x < 0 || y < 0 || x + w > img.width || y + h > img.height) throw new Error(`the crop [${x}, ${y}, ${w}, ${h}] is outside the ${img.width}x${img.height} plate`);
  const data = new Uint8Array(w * h * 4);
  for (let r = 0; r < h; r++) data.set(img.data.subarray(((y + r) * img.width + x) * 4, ((y + r) * img.width + x + w) * 4), r * w * 4);
  return { width: w, height: h, data };
}

/**
 * A repaint's input: the picture at its own size, coloured as publish colours it (final.spr with the space palette's lower half when given), its
 * clear pixels opaque black, since the repaint has no alpha (publish puts the clear pixels back: hdPlate).
 */
export function adminOriginalPicture(spr: Uint8Array, finalSpr: Uint8Array, standardPal: Uint8Array, which: AdminPlate, spacePalette?: Uint8Array): Rgba {
  const { pal, finalPal } = adminPalettes(standardPal, spacePalette);
  const img = colourFrame(plateIndices(spr, finalSpr, which), which === 'final' ? finalPal : pal);
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
  return img;
}

/**
 * A repaint's original as the run reads it (PNG bytes): decoded from the game zip into the cache when `zip` is given (with games/unity's
 * space/space.rgb for final.spr's lower indices, as publish has them), else the one decoded before.
 */
export async function adminOriginalFile(cache: Pick<ArtCache, 'root'>, which: AdminPlate, gameDir: string, zip?: string, read: (zip: string, member: string) => Promise<Uint8Array> = readZipMember): Promise<Uint8Array> {
  const file = adminOriginal(cache, which);
  if (zip) {
    const spacePath = join(gameDir, 'space', 'space.rgb');
    const spacePalette = existsSync(spacePath) ? new Uint8Array(await readFile(spacePath)) : undefined;
    if (which === 'final' && !spacePalette) throw new Error(`plate.final needs ${spacePath} (the space build's palette) for final.spr's lower indices: npm run unity:build first`);
    const png = encodePng(adminOriginalPicture(await read(zip, 'adminmnu.spr'), await read(zip, 'final.spr'), await read(zip, 'standard.pal'), which, spacePalette));
    await mkdir(join(cache.root, 'originals', 'admin'), { recursive: true });
    await writeFile(file, png);
    return png;
  }
  if (!existsSync(file)) throw new Error(`no decoded ${which} picture at ${file}: run with GAMEDATA_DIR set (the game's folder with STTNG.ZIP) to decode it`);
  return new Uint8Array(await readFile(file));
}

/**
 * The console's lower LED row's groove, in the console's pixels: where the console covers it, from the face above it (adminConsole.tsx's
 * GROOVE_COVER.to, [186, 385, 198, 24]), and 3 rows above and 1 below, where the upscale of the original rings round the groove's dark edge
 * (the HD body's row 384 was 3 levels darker than the face). The HD body's face shades down the panel, so the copied patch would show; publish
 * paints the groove out of it instead.
 */
export const ADMIN_GROOVE: Rect = [186, 382, 198, 28];
/** How far clear of the groove its fill is sampled, in the console's pixels: the repaint darkens the row just above it. */
const GROOVE_MARGIN = 3;

/**
 * `img` with `rect` (in original pixels, `scale` times in the image) painted out: each column blended from the image's own pixel above the rect to
 * the one below it, so the fill follows the local shading. Those are taken `margin` original pixels clear of the rect, past any shadow the repaint
 * left at its edge. The rect is clipped to the image; with no row above or below, the other side's stands in.
 */
export function paintOut(img: Rgba, [rx, ry, rw, rh]: Rect, scale: number, margin = 0): Rgba {
  const x0 = Math.max(0, rx * scale), x1 = Math.min(img.width, (rx + rw) * scale);
  const y0 = Math.max(0, ry * scale), y1 = Math.min(img.height, (ry + rh) * scale);
  const data = new Uint8Array(img.data);
  if (x0 >= x1 || y0 >= y1) return { width: img.width, height: img.height, data };
  const up = y0 - 1 - margin * scale, down = y1 + margin * scale;
  const above = up >= 0 ? up : down < img.height ? down : y0;
  const below = down < img.height ? down : above;
  for (let x = x0; x < x1; x++) {
    const a = (above * img.width + x) * 4, b = (below * img.width + x) * 4;
    for (let y = y0; y < y1; y++) {
      const t = (y - above) / (below - above || 1);
      const i = (y * img.width + x) * 4;
      for (let c = 0; c < 4; c++) data[i + c] = Math.round(img.data[a + c]! * (1 - t) + img.data[b + c]! * t);
    }
  }
  return { width: img.width, height: img.height, data };
}

/** The repaint as published: the plate's colours, opaque, with the original's clear pixels (index 13, scaled up nearest) clear. */
export function hdPlate(plate: Rgba, original: IndexImage, scale: number): Rgba {
  if (plate.width !== original.width * scale || plate.height !== original.height * scale) throw new Error(`the plate is ${plate.width}x${plate.height}, not ${scale} times the ${original.width}x${original.height} picture`);
  const data = new Uint8Array(plate.data);
  for (let y = 0; y < plate.height; y++)
    for (let x = 0; x < plate.width; x++) {
      const clear = original.indices[Math.floor(y / scale) * original.width + Math.floor(x / scale)] === COLOUR_BLANK;
      const i = (y * plate.width + x) * 4;
      if (clear) data.fill(0, i, i + 4);
      else data[i + 3] = 255;
    }
  return { width: plate.width, height: plate.height, data };
}

/** The last passing run of each repaint (`<work>/<recipe>/last.json`): its plate and the sha256 of its original. A repaint with no run is left out. */
export async function adminPlates(cache: Pick<ArtCache, 'work'>): Promise<NonNullable<AdminDeps['plates']>> {
  const out: NonNullable<AdminDeps['plates']> = {};
  for (const [which, { recipe }] of Object.entries(ADMIN_PLATES) as [AdminPlate, (typeof ADMIN_PLATES)[AdminPlate]][]) {
    const last = join(cache.work, recipe, 'last.json');
    if (!existsSync(last)) continue;
    const { dir, meta } = JSON.parse(await readFile(last, 'utf8')) as { dir: string; meta: { source?: string } };
    if (!meta.source) throw new Error(`${last} records no source: run npm run art -- run art/recipes/${recipe}.yaml again`);
    out[which] = { plate: decodePng(new Uint8Array(await readFile(join(dir, 'plate.png')))), source: meta.source };
  }
  return out;
}
