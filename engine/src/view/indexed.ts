// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The original's own way of drawing a 640x480 screen: one byte a pixel, a 256-colour palette, sprites that skip colour 13, rectangles filled with
 * a colour index, and strings in the game's bitmap fonts (graphics.cpp). The engineering screen and the holodeck are painted like this from the
 * game's own pictures (published into the git-ignored art/ by `art engineering publish`); the astrogation screen's text uses the same fonts.
 * Pure: no DOM. `toRgba` turns a screen into pixels for a canvas.
 */

/** COLOUR_BLANK (unity.h): the colour a blit skips. It is 13, not 0. */
export const COLOUR_BLANK = 13;
export const SCREEN_W = 640;
export const SCREEN_H = 480;

/** A picture of palette indices. */
export interface IndexedImage { width: number; height: number; pixels: Uint8Array }

const PACK_MAGIC = 0x4b434150; // "PACK"

/**
 * An indexed pack: the magic, a u32 count, then each picture's u16 width, u16 height and width x height indices, all little endian. The publisher
 * (tools/art/src/engineering.ts) writes them; the entries are numbered in the order it lists them in presentation.yaml.
 */
export function parsePack(bytes: Uint8Array): IndexedImage[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 8 || dv.getUint32(0, true) !== PACK_MAGIC) throw new Error('not an indexed pack');
  const count = dv.getUint32(4, true);
  const out: IndexedImage[] = [];
  let at = 8;
  for (let i = 0; i < count; i++) {
    if (at + 4 > bytes.length) throw new Error(`the pack ends inside entry ${i}`);
    const width = dv.getUint16(at, true), height = dv.getUint16(at + 2, true);
    at += 4;
    if (at + width * height > bytes.length) throw new Error(`the pack ends inside entry ${i}'s pixels`);
    out.push({ width, height, pixels: bytes.subarray(at, at + width * height) });
    at += width * height;
  }
  return out;
}

/** Writes a pack (for the publisher and the tests). */
export function writePack(images: readonly IndexedImage[]): Uint8Array {
  const size = 8 + images.reduce((n, im) => n + 4 + im.width * im.height, 0);
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, PACK_MAGIC, true);
  dv.setUint32(4, images.length, true);
  let at = 8;
  for (const im of images) {
    dv.setUint16(at, im.width, true);
    dv.setUint16(at + 2, im.height, true);
    out.set(im.pixels, at + 4);
    at += 4 + im.width * im.height;
  }
  return out;
}

/** A 256-colour palette in 8-bit RGB (the originals' 6-bit entries shifted left by two), with the original's rotations and single-entry edits. */
export class Palette {
  readonly rgb: Uint8Array;
  constructor(rgb?: Uint8Array) {
    this.rgb = new Uint8Array(256 * 3);
    if (rgb) this.rgb.set(rgb.subarray(0, 256 * 3));
  }
  clone(): Palette { return new Palette(this.rgb); }

  /** Graphics::rotatePalette: the entries from `from` to `to` move one step towards `from`, and the first goes round to the end. */
  rotate(from: number, to: number): void {
    const saved = this.rgb.slice(from * 3, from * 3 + 3);
    if (from < to) this.rgb.copyWithin(from * 3, (from + 1) * 3, (to + 1) * 3);
    else this.rgb.copyWithin((to + 1) * 3, to * 3, from * 3);
    this.rgb.set(saved, to * 3);
  }
  /** Graphics::copyPaletteEntry. */
  copyEntry(dest: number, src: number): void {
    this.rgb.copyWithin(dest * 3, src * 3, src * 3 + 3);
  }
  /** Graphics::setPaletteEntry. */
  setEntry(index: number, colour: readonly [number, number, number]): void {
    this.rgb.set(colour, index * 3);
  }
}

/** One of the game's fonts (font0.fon ... font9.fon; graphics.cpp UnityFont): a glyph is a bit a pixel in the colour given, or the glyph's own colours. */
export class BitmapFont {
  readonly height: number;
  private readonly start: number;
  private readonly end: number;
  private readonly size: number;
  private readonly pitch: number;
  private readonly colour: boolean;
  private readonly data: Uint8Array;
  private readonly widths: Uint8Array;

  constructor(file: Uint8Array) {
    const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
    if (file.length < 9) throw new Error('a font file is at least 9 bytes');
    if (file[0] !== 1) throw new Error(`unknown font file kind ${file[0]}`);
    this.height = file[1]!;
    this.start = file[2]!;
    this.end = file[3]!;
    let size = dv.getUint16(4, true);
    if (file[6] !== 0) throw new Error(`unknown font file byte ${file[6]}`);
    const type = file[7]!;
    if (type > 1) throw new Error(`unknown font type ${type}`);
    this.colour = type === 1;
    let pitch = file[8]!;
    if (this.colour) {
      // (the size includes the width)
      size--;
      if (size !== pitch * this.height) throw new Error('a colour font glyph is not pitch x height');
    } else {
      // a byte for each row
      size = this.height;
      pitch = 8;
    }
    this.size = size;
    this.pitch = pitch;
    const glyphs = this.end - this.start + 1;
    this.data = new Uint8Array(glyphs * size);
    this.widths = new Uint8Array(glyphs);
    let at = 9;
    // (some files end early)
    for (let i = 0; i < glyphs && at + 1 + size <= file.length; i++) {
      this.widths[i] = file[at]!;
      this.data.set(file.subarray(at + 1, at + 1 + size), i * size);
      at += 1 + size;
    }
  }

  charWidth(code: number): number {
    return code < this.start || code > this.end ? 0 : this.widths[code - this.start]!;
  }

  stringWidth(text: string): number {
    let w = 0;
    for (let i = 0; i < text.length; i++) w += this.charWidth(text.charCodeAt(i));
    return w;
  }

  /** Font::drawChar: clipped to the surface. A character the font lacks is a space. */
  drawChar(screen: IndexedScreen, code: number, x: number, y: number, colour: number): void {
    if (code < this.start || code > this.end) code = 0x20;
    const glyph = code - this.start;
    const base = glyph * this.size;
    const left = Math.max(0, -x), right = Math.min(this.widths[glyph]!, screen.width - x);
    if (left >= right) return;
    for (let line = 0; line < this.height; line++) {
      if (y + line < 0 || y + line >= screen.height) continue;
      const row = (y + line) * screen.width + x;
      if (this.colour) {
        for (let col = left; col < right; col++) screen.pixels[row + col] = this.data[base + line * this.pitch + col]!;
        continue;
      }
      const bits = this.data[base + line]!;
      for (let col = left; col < right && col < 8; col++) if (bits & (0x80 >> col)) screen.pixels[row + col] = colour;
    }
  }
}

/** The screen: indices, drawn on in place. It persists between frames as the original's does, so what a frame leaves alone stays. */
export class IndexedScreen {
  readonly pixels: Uint8Array;
  constructor(readonly width = SCREEN_W, readonly height = SCREEN_H) {
    this.pixels = new Uint8Array(width * height);
  }

  /** Graphics::fillRect: [x1, x2) by [y1, y2), clipped. */
  fillRect(colour: number, x1: number, y1: number, x2: number, y2: number): void {
    const l = Math.max(0, x1), r = Math.min(this.width, x2), t = Math.max(0, y1), b = Math.min(this.height, y2);
    if (l >= r) return;
    for (let y = t; y < b; y++) this.pixels.fill(colour, y * this.width + l, y * this.width + r);
  }

  /** The original's `fill`: its corners are inclusive. */
  fill(x1: number, y1: number, x2: number, y2: number, colour: number): void {
    this.fillRect(colour, x1, y1, x2 + 1, y2 + 1);
  }

  /** Graphics::drawLine (Surface::drawLine, graphics/primitives.cpp:28-61): Bresenham's line from (x0, y0) to (x1, y1), both ends in, each point clipped. */
  line(x0: number, y0: number, x1: number, y1: number, colour: number): void {
    const steep = Math.abs(y1 - y0) > Math.abs(x1 - x0);
    if (steep) [x0, y0, x1, y1] = [y0, x0, y1, x1];
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const xStep = x0 < x1 ? 1 : -1, yStep = y0 < y1 ? 1 : -1;
    const point = (x: number, y: number) => {
      const [px, py] = steep ? [y, x] : [x, y];
      if (px >= 0 && px < this.width && py >= 0 && py < this.height) this.pixels[py * this.width + px] = colour;
    };
    let x = x0, y = y0, err = 0;
    point(x, y);
    while (x !== x1) {
      x += xStep;
      err += dy;
      if (2 * err > dx) {
        y += yStep;
        err -= dx;
      }
      point(x, y);
    }
  }

  /** Graphics::blit: a picture at (x, y), skipping `transparent`, clipped. */
  blit(image: IndexedImage, x: number, y: number, transparent = COLOUR_BLANK): void {
    const l = Math.max(0, x), r = Math.min(this.width, x + image.width), t = Math.max(0, y), b = Math.min(this.height, y + image.height);
    for (let py = t; py < b; py++) {
      for (let px = l; px < r; px++) {
        const v = image.pixels[(py - y) * image.width + (px - x)]!;
        if (v !== transparent) this.pixels[py * this.width + px] = v;
      }
    }
  }

  /** The whole picture, replacing everything (the background). */
  set(image: IndexedImage): void {
    this.pixels.set(image.pixels.subarray(0, this.pixels.length));
  }

  /** Graphics::drawString. */
  drawString(font: BitmapFont, x: number, y: number, text: string, colour = 0xff): void {
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      font.drawChar(this, code, x, y, colour);
      x += font.charWidth(code);
    }
  }

  /** The screen in the palette's colours, as RGBA bytes (opaque), into `out` (width x height x 4). */
  toRgba(palette: Palette, out: Uint8ClampedArray | Uint8Array): void {
    const rgb = palette.rgb;
    for (let i = 0, n = this.pixels.length; i < n; i++) {
      const c = this.pixels[i]! * 3;
      out[i * 4] = rgb[c]!;
      out[i * 4 + 1] = rgb[c + 1]!;
      out[i * 4 + 2] = rgb[c + 2]!;
      out[i * 4 + 3] = 255;
    }
  }
}
