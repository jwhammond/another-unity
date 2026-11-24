// SPDX-License-Identifier: GPL-3.0-or-later
import type { VerbMode } from './store';

/** What the pointer looks like: the arrow everywhere, the hand over a control, and one for each verb on the room. */
export type CursorKind = 'default' | 'pointer' | VerbMode;

const INK = '#5aa8ff';
const HI = '#c4e4ff';
const DARK = '#0a0f24';
const ORANGE = '#ff9966';

const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">${body}</svg>`;
// the verbs are a reticle ring with a glyph in it: a ring and four ticks, in LCARS blue over a dark edge, with an orange tab
const reticle = (glyph: string, lit = false) =>
  `<circle cx="16" cy="16" r="12" fill="${lit ? INK : DARK}" fill-opacity="${lit ? '.45' : '.55'}" stroke="${DARK}" stroke-width="4"/>`
  + `<circle cx="16" cy="16" r="12" fill="none" stroke="${lit ? HI : INK}" stroke-width="${lit ? 3 : 2}"/>`
  + `<path d="M16 1v5M16 26v5M1 16h5M26 16h5" stroke="${ORANGE}" stroke-width="2.5" stroke-linecap="square"/>`
  + glyph;

const ARROW = 'M3 2v22l6-5 4 9 4-2-4-9h8z';
// (the glyph in each verb's ring)
const GLYPHS: Record<VerbMode, string> = {
  // (walk: a footprint, toes up)
  walk: `<path d="M13 15c0-3 1.4-4.4 3-4.4s3 1.4 3 4.4c0 2.4-.8 3.4-.8 5.2h-4.4c0-1.8-.8-2.8-.8-5.2z" fill="${HI}"/><rect x="13.6" y="21.6" width="4.8" height="2.6" rx="1.3" fill="${HI}"/><g fill="${HI}"><circle cx="12.2" cy="9.8" r="1.2"/><circle cx="14.8" cy="8.6" r="1.1"/><circle cx="17.4" cy="8.6" r="1.1"/><circle cx="19.8" cy="9.8" r="1.2"/></g>`,
  // (look: an eye)
  look: `<path d="M8 16q8-8 16 0q-8 8-16 0z" fill="none" stroke="${HI}" stroke-width="2"/><circle cx="16" cy="16" r="2.5" fill="${HI}"/>`,
  // (use: an open hand, fingers up and a thumb out)
  use: `<g stroke="${HI}" stroke-width="2.3" stroke-linecap="round" fill="none"><path d="M12.4 15V9.6M15.1 14.4V8.2M17.8 14.4V8.6M20.5 15V10.4"/><path d="M11.6 18.6L9 15.6"/></g><path d="M11.4 15.2h10.2v3.8c0 2.6-2 4.4-5.1 4.4s-5.1-1.6-5.1-4.4z" fill="${HI}"/>`,
  // (talk: a speech balloon)
  talk: `<path d="M9 10h14v9h-8l-4 4v-4H9z" fill="none" stroke="${HI}" stroke-width="2" stroke-linejoin="round"/>`,
};
const FALLBACKS: Record<VerbMode, string> = { walk: 'crosshair', look: 'help', use: 'grab', talk: 'help' };
const SVGS: Record<'default' | 'pointer', { svg: string; x: number; y: number; fallback: string }> = {
  default: {
    svg: svg(`<path d="${ARROW}" fill="${INK}" stroke="${DARK}" stroke-width="2" stroke-linejoin="round"/><rect x="3" y="28" width="10" height="3" fill="${ORANGE}"/>`),
    x: 3, y: 2, fallback: 'default',
  },
  pointer: {
    svg: svg(`<path d="${ARROW}" fill="${HI}" stroke="${DARK}" stroke-width="2" stroke-linejoin="round"/><path d="M3 2v22l6-5 4 9 4-2-4-9h8z" fill="none" stroke="${ORANGE}" stroke-width="1"/><circle cx="25" cy="7" r="4" fill="none" stroke="${ORANGE}" stroke-width="2"/>`),
    x: 3, y: 2, fallback: 'pointer',
  },
};

/** The drawn pointer of a kind; a verb's is lit (a brighter, thicker ring) over something to act on, as the original's lit frame is. */
function drawn(kind: CursorKind, lit: boolean): { svg: string; x: number; y: number; fallback: string } {
  if (kind === 'default' || kind === 'pointer') return SVGS[kind];
  return { svg: svg(reticle(GLYPHS[kind], lit)), x: 16, y: 16, fallback: FALLBACKS[kind] };
}

/** The picture itself, as an image source (the cursor sheet shows these). */
export function cursorImage(kind: CursorKind, lit = false): string {
  return `data:image/svg+xml,${encodeURIComponent(drawn(kind, lit).svg)}`;
}

/** A verb's cursor made from a published picture: the picture (a data URL) and its hotspot in its pixels. */
export interface SpriteCursor { url: string; x: number; y: number }
/** A verb's pointer, and `_lit` its lit twin: the original draws that over something to act on (updateAwayTeamCursor). */
export type CursorKey = VerbMode | `${VerbMode}_lit`;
export type SpriteCursors = Partial<Record<CursorKey, SpriteCursor>>;

/** The sprites are the panel's buttons at four times their size (160 by 108): the pointer is one at this width. */
export const SPRITE_CURSOR_W = 48;
/** Where a click lands on each sprite, as fractions of it: the eye's pupil, the hand's fingertips, the speech balloon's middle, the boot's toe. */
export const SPRITE_HOTSPOTS: Record<VerbMode, readonly [number, number]> = { look: [0.5, 0.5], use: [0.8, 0.3], talk: [0.5, 0.5], walk: [0.85, 0.65] };

/** Where a sprite's cursor of this size has its hotspot, in pixels. */
export function spriteHotspot(mode: VerbMode, width: number, height: number): { x: number; y: number } {
  const [fx, fy] = SPRITE_HOTSPOTS[mode];
  return { x: Math.round(width * fx), y: Math.round(height * fy) };
}

/** The CSS `cursor` value for a kind: the published sprite when it is made (the lit one when `lit`, the plain one if there is no lit), else the picture, with its hotspot, and a system cursor if it can't load. */
export function cursorCss(kind: CursorKind, sprites?: SpriteCursors, lit = false): string {
  const c = drawn(kind, lit);
  const sprite = kind === 'default' || kind === 'pointer' ? undefined : (lit ? sprites?.[`${kind}_lit`] : undefined) ?? sprites?.[kind];
  if (sprite) return `url("${sprite.url}") ${sprite.x} ${sprite.y}, ${c.fallback}`;
  return `url("${cursorImage(kind, lit)}") ${c.x} ${c.y}, ${c.fallback}`;
}

/** A picture to scale to cursor size: where it is, the size it is drawn at from its own, and its click point at that size. */
export interface CursorSource {
  url: string;
  size(naturalWidth: number, naturalHeight: number): { width: number; height: number };
  hotspot(width: number, height: number): { x: number; y: number };
}

/** The panel's button sprites (160 by 108 and the like) as pointers: SPRITE_CURSOR_W wide, clicking at SPRITE_HOTSPOTS. */
export function panelCursorSource(mode: VerbMode, url: string): CursorSource {
  return {
    url,
    size: (w, h) => ({ width: SPRITE_CURSOR_W, height: Math.round((h / w) * SPRITE_CURSOR_W) }),
    hotspot: (w, h) => spriteHotspot(mode, w, h),
  };
}

/** The original's pointers (cursor.dat, published at `scale` times their size) drawn at twice their own, clicking at the original's point (setCursor's table). */
export function originalCursorSource(url: string, scale: number, at: readonly [number, number]): CursorSource {
  return {
    url,
    size: (w, h) => ({ width: Math.round((w / scale) * 2), height: Math.round((h / scale) * 2) }),
    hotspot: () => ({ x: at[0] * 2, y: at[1] * 2 }),
  };
}

const made = new Map<string, Promise<SpriteCursors>>();

/**
 * Scales published pointer pictures to cursor size on a canvas (nearest-neighbour when they are drawn at a whole fraction of their size, so the
 * original's hard pixels stay hard). A picture that doesn't load (or a page with no canvas) is left out, and cursorCss keeps the drawn one for it.
 */
export function loadSpriteCursors(sources: Partial<Record<CursorKey, CursorSource>>, doc: Document = document): Promise<SpriteCursors> {
  const key = Object.entries(sources).map(([k, v]) => `${k}=${v.url}`).join('|');
  let pending = made.get(key);
  if (!pending) {
    pending = Promise.all((Object.entries(sources) as [CursorKey, CursorSource][]).map(async ([name, source]): Promise<[CursorKey, SpriteCursor] | undefined> => {
      try {
        const img = doc.createElement('img');
        img.src = source.url;
        await img.decode();
        const { width, height } = source.size(img.naturalWidth, img.naturalHeight);
        const canvas = doc.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const g = canvas.getContext('2d');
        if (!g) return undefined;
        const whole = img.naturalWidth % width === 0;
        g.imageSmoothingEnabled = !whole;
        g.imageSmoothingQuality = 'high';
        g.drawImage(img, 0, 0, width, height);
        return [name, { url: canvas.toDataURL('image/png'), ...source.hotspot(width, height) }];
      } catch {
        return undefined;
      }
    })).then(done => Object.fromEntries(done.filter((d): d is [CursorKey, SpriteCursor] => d !== undefined)));
    made.set(key, pending);
  }
  return pending;
}
