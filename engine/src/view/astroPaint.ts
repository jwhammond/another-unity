// SPDX-License-Identifier: GPL-3.0-or-later
import { GLOBE_RAMPS, globeColours, globeTexture, renderGlobe, GLOBE_SIZE } from './astroGlobe';
import { GLOBE, MAP_WINDOW, type MapCommand, type MapFont, type MapLayout } from './astroLayout';

// Painting the astrogation map's commands (astroLayout.ts) onto a 2D canvas that covers the map's window. Lines and pixels are the original's, one
// of its pixels wide; the pictures are the original's sprites when they are published (art astro publish) and plain shapes otherwise.

/** The part of a canvas 2D context this paints with (so a test can record it). */
export interface Paint2D {
  fillStyle: unknown; strokeStyle: unknown; lineWidth: number; font: string; textBaseline: string; textAlign: string; imageSmoothingEnabled: boolean;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void; moveTo(x: number, y: number): void; lineTo(x: number, y: number): void; stroke(): void;
  arc(x: number, y: number, r: number, a: number, b: number): void; fill(): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
  drawImage(image: never, ...args: number[]): void;
}

/** A picture of the original's, with its own size in the original's pixels. */
/** (`image` is null while it is still loading: nothing is drawn then.) */
export interface PaintSprite { image: unknown; width: number; height: number }

export interface PaintOptions {
  /** Device pixels to an original pixel. */
  scale: number;
  sprite?: (name: string) => PaintSprite | undefined;
  /** The clock's ticks, which turn the globe. */
  ticks: number;
  /**
   * The string as a picture in the game's own bitmap font, at its own size in the original's pixels (a picture of the text, the kind of `sprite`): used for
   * every text when it is given, so the map's letters are the original's; without it the text is drawn in the browser's font.
   */
  text?: (font: MapFont, text: string, colour: string) => PaintSprite | undefined;
  /** Makes the canvas the globe is drawn on (once per size); the browser's. */
  makeCanvas?: (width: number, height: number) => { getContext(kind: '2d'): { putImageData(data: unknown, x: number, y: number): void } | null };
  makeImageData?: (data: Uint8ClampedArray, width: number, height: number) => unknown;
}

const FAMILY = "'Arial Narrow', 'Roboto Condensed', 'Helvetica Neue', sans-serif";
/** The fonts in the original's pixels: kFontMap, kFontInfo and kFontLabel (the info text's lines are 18 apart). */
const FONT: Record<MapFont, string> = { map: `700 8px ${FAMILY}`, info: `700 14px ${FAMILY}`, label: `700 17px ${FAMILY}` };
export const fontFor = (font: MapFont): string => FONT[font];

/** A measure of a string's width in a font, in the original's pixels, for the layout (drawMapText and the destination labels place text by it). */
export function measurer(ctx: Pick<Paint2D, 'font' | 'measureText'>): (font: MapFont, text: string) => number {
  return (font, text) => {
    ctx.font = FONT[font];
    return Math.ceil(ctx.measureText(text).width);
  };
}

/** The sizes of the shapes drawn for a picture that is not published, by name: the picture's own size in the original's pixels. */
function fallbackSize(name: string): [number, number] {
  if (name.startsWith('star_class')) return [[22, 18, 8, 16, 14, 24, 28][Number(name.slice(10))] ?? 16, 0];
  if (name === 'star' || name === 'companion') return [40, 0];
  if (name.startsWith('planet')) return [[36, 30, 16, 20, 18, 20, 26, 16, 12, 14, 22, 24, 24, 24, 40, 32][Number(name.slice(6))] ?? 20, 0];
  if (name === 'moon') return [6, 0];
  if (name === 'ship') return [12, 0];
  if (name === 'ship_marker' || name === 'destination_marker') return [9, 0];
  if (name === 'selected') return [8, 0];
  if (name === 'belt') return [4, 100];
  if (name.startsWith('hazard') || name.startsWith('station')) return [18, 0];
  if (name === 'starbase_icon' || name === 'outpost_icon') return [13, 18];
  return [60, 60];
}

const STAR_COLOURS = ['#9cc0ff', '#bcd4ff', '#ffffff', '#fff4d0', '#ffe070', '#ffb060', '#ff7048'];
const rgb = (c: readonly number[]): string => `rgb(${c[0]},${c[1]},${c[2]})`;

/** A shape in place of a picture (art off or not published): a disc in the colour a star or planet class suggests, a box for what is made, a ring for a marker. */
function paintShape(ctx: Paint2D, name: string, cx: number, cy: number, w: number, h: number, scale: number): void {
  const disc = (colour: string, r: number): void => { ctx.fillStyle = colour; ctx.beginPath(); ctx.arc(cx, cy, Math.max(r, 0.5), 0, Math.PI * 2); ctx.fill(); };
  if (name.startsWith('star_class')) disc(STAR_COLOURS[Number(name.slice(10))] ?? '#fff', (w * scale) / 512 * 1);
  else if (name === 'star' || name === 'companion') disc('#ffb347', w / 2);
  else if (name.startsWith('planet')) disc(rgb(GLOBE_RAMPS[Math.min(Number(name.slice(6)), 15)]![1]!), w / 2);
  else if (name === 'moon') disc('#c8c8c8', w / 2);
  else if (name === 'ship') disc('#68e0fc', 3);
  else if (name === 'ship_marker') disc('#68e0fc', 3);
  else if (name === 'destination_marker') disc('#fcfc00', 3);
  else if (name === 'belt') { ctx.fillStyle = '#806040'; ctx.fillRect(cx - 1, cy - h / 2, 3, h); } else {
    ctx.strokeStyle = name === 'selected' ? '#fcfc00' : '#a4a4a4';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx - w / 2, cy - w / 2); ctx.lineTo(cx + w / 2, cy - w / 2); ctx.lineTo(cx + w / 2, cy + w / 2); ctx.lineTo(cx - w / 2, cy + w / 2); ctx.lineTo(cx - w / 2, cy - w / 2); ctx.stroke();
  }
}

interface Globe { type: number; seed: number; texture: Uint8Array; colours: Uint8Array }
let globe: Globe | null = null;
let globeCanvas: { getContext(kind: '2d'): { putImageData(data: unknown, x: number, y: number): void } | null } | null = null;

/** Paints the layout's commands onto a canvas whose pixels are `scale` times the original's, covering the map's window. */
export function paintMap(ctx: Paint2D, layout: Pick<MapLayout, 'commands'>, options: PaintOptions): void {
  const s = options.scale;
  ctx.setTransform(s, 0, 0, s, -MAP_WINDOW.x * s, -MAP_WINDOW.y * s);
  ctx.imageSmoothingEnabled = true;
  ctx.textBaseline = 'top';
  ctx.lineWidth = 1;
  for (const c of layout.commands as readonly MapCommand[]) {
    switch (c.kind) {
      case 'fill':
        ctx.fillStyle = c.colour;
        ctx.fillRect(c.x1, c.y1, c.x2 - c.x1 + 1, c.y2 - c.y1 + 1);
        break;
      case 'pixel':
        ctx.fillStyle = c.colour;
        ctx.fillRect(c.x, c.y, 1, 1);
        break;
      case 'line':
        ctx.strokeStyle = c.colour;
        ctx.beginPath();
        ctx.moveTo(c.x1 + 0.5, c.y1 + 0.5);
        ctx.lineTo(c.x2 + 0.5, c.y2 + 0.5);
        ctx.stroke();
        break;
      case 'text': {
        const picture = options.text?.(c.font, c.text, c.colour);
        if (picture && picture.image !== null) {
          // (drawString: from the corner, or with `centre` about x; the hard pixels stay hard at three to one)
          const left = c.align === 'centre' ? c.x - (picture.width >> 1) : c.x;
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(picture.image as never, left, c.y, picture.width, picture.height);
          ctx.imageSmoothingEnabled = true;
          break;
        }
        ctx.font = FONT[c.font];
        ctx.fillStyle = c.colour;
        ctx.textAlign = c.align === 'centre' ? 'center' : 'left';
        ctx.fillText(c.text, c.x, c.y);
        break;
      }
      case 'sprite': {
        const art = options.sprite?.(c.name);
        const factor = (c.scale ?? 256) / 256;
        if (art && art.image === null) break;
        if (art) {
          const w = Math.max(Math.trunc(art.width * factor), 1), h = Math.max(Math.trunc(art.height * factor), 1);
          const left = c.anchor === 'corner' ? c.x : c.x - (w >> 1);
          const top = c.anchor === 'centre' ? c.y - (h >> 1) : c.anchor === 'bottom' ? c.y - h : c.y;
          ctx.drawImage(art.image as never, left, top, w, h);
        } else {
          const [w, h] = fallbackSize(c.name);
          const cx = c.anchor === 'corner' ? c.x + w / 2 : c.x;
          const cy = c.anchor === 'centre' ? c.y : c.anchor === 'bottom' ? c.y - w / 2 : c.y + w / 2;
          paintShape(ctx, c.name, cx, cy, w, h || w, c.scale ?? 256);
        }
        break;
      }
      case 'globe': {
        if (!options.makeCanvas || !options.makeImageData) break;
        if (!globe || globe.type !== c.type || globe.seed !== c.seed) globe = { type: c.type, seed: c.seed, texture: globeTexture(c.type, c.seed), colours: globeColours(c.type) };
        globeCanvas ??= options.makeCanvas(GLOBE_SIZE, GLOBE_SIZE);
        globeCanvas.getContext('2d')?.putImageData(options.makeImageData(renderGlobe(globe.texture, globe.colours, options.ticks), GLOBE_SIZE, GLOBE_SIZE), 0, 0);
        ctx.drawImage(globeCanvas as never, GLOBE.x, GLOBE.y, GLOBE.size, GLOBE.size);
        break;
      }
    }
  }
}
