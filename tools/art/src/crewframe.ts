// SPDX-License-Identifier: GPL-3.0-or-later
import type { Rgba } from './image';

const DARK = 40;
/**
 * The original's outline at the silhouette: near-black (all channels <= DARK) and, on the last passes, the dark neutral and steel-blue
 * greys the sprites' edges are antialiased to (Picard's head has a 2-3 pixel ring of (80, 80, 104) and (80, 96, 132), the backdrop the
 * figure was cut from). Drawn at 4x, that ring reads as a steel-blue halo. Skin, hair, gold and red are warmer (red above blue) and a
 * blue uniform is far bluer (Troi's), so neither is taken.
 */
const isFringe = (r: number, g: number, b: number, grey: boolean): boolean =>
  grey ? Math.max(r, g, b) > DARK && r <= 112 && b >= r && b - r <= 60 && g <= b + 4 && Math.max(r, g, b) <= 140 : r <= DARK && g <= DARK && b <= DARK;

/** The original picture the frames were painted over, and where the frame's top-left corner sits in it. */
export interface FrameBackground { pixels: Rgba; left: number; top: number }

/** A frame of a crew sprite and where its top-left corner sits in the original picture. */
export interface PlacedFrame { img: Rgba; left: number; top: number }

/**
 * A still pixel (the same in every frame) is the picture's own when no channel differs from the picture's by more than this (most of
 * the picture left in the frames is within 8; the rest is the dither of a shadow on the carpet). A dark one has to be nearer: a dark
 * still part of a figure (trousers, a tunic's shadow) is often within 24 to 48 of a dark picture.
 */
const STILL_SAME = 24;
const STILL_SAME_DARK = 12;
/** A pixel that changes from frame to frame is the picture showing in this frame only when it is this near the picture (the figure's own colours rarely are)... */
const MOVING_SAME = 8;
/** ... or, a light one, this near and within NEAR_CUT pixels of the frame's own cut-out (the rim the original left round a walking figure). */
const RIM_SAME = 40;
const NEAR_CUT = 3;
/** A light patch of moving pixels the figure encloses, within RIM_SAME of the picture, is a gap (the carpet between the legs) when it has this many pixels. */
const HOLE_PATCH = 16;
/** ... and its pixels are this near the picture on average (the carpet's dither is mostly within 8, some within 48; a red sleeve over a red-brown wall is 40 throughout). */
const GAP_MEAN = 20;
/** Light: a channel over this. */
const HOLE_DARK = 90;
/** Opaque islands smaller than this are dropped. */
const SPECK = 30;

/**
 * Picture the frames carry that the frames themselves can't tell from the figure, traced by hand in the original bridge picture's pixels
 * (640x480; a polygon's corners are pixel boundaries, so it takes the pixels whose centres fall inside): furniture drawn in front of the
 * figure, and picture beside it that bridge.png doesn't match (so it isn't taken as picture). Only still pixels inside a polygon are cut, so
 * a moving arm that crosses one stays. Traced (Plan 33 B2) over each sprite's first frame drawn on the original picture at 6x with a
 * 10-pixel grid, beside the frame's difference from the sprite's other frames and from the picture, and the bug report's raw-against-matte
 * comparisons of the tactical rail's and the ops console's crew. The rail and the console themselves match the picture and go without a trace.
 */
export const CREW_CUTS: readonly { sprite: string; what: string; poly: readonly (readonly [number, number])[] }[] = [
  { sprite: 'brdgworf.spr', what: 'the tactical rail\'s top edge right of the arm', poly: [[372, 150], [387, 153], [387, 162], [372, 158]] },
  { sprite: 'brdgtroi.spr', what: 'the chair\'s edge and the carpet\'s shadow left of the legs', poly: [[355, 228], [358, 228], [366, 238], [370, 246], [370, 272], [355, 272]] },
  { sprite: 'brdgdata.spr', what: 'the chair\'s pedestal and the carpet between the legs', poly: [[491, 258], [494, 258], [494, 288], [491, 288]] },
];

/** The traced cuts for a sprite (its file name, as ship.yaml spells it). */
export const cutsFor = (sprite: string): (readonly (readonly [number, number])[])[] => CREW_CUTS.filter(c => c.sprite === sprite.toLowerCase()).map(c => c.poly);

const inPoly = (poly: readonly (readonly [number, number])[], x: number, y: number): boolean => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

/** The components of `on` (4-connected, or 8 with `eight`), each as a list of pixel indices. */
function components(w: number, h: number, on: (k: number) => boolean, eight = false): number[][] {
  const seen = new Uint8Array(w * h);
  const out: number[][] = [];
  const steps = eight ? [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] : [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let k0 = 0; k0 < w * h; k0++) {
    if (seen[k0] || !on(k0)) continue;
    const comp = [k0];
    seen[k0] = 1;
    for (let n = 0; n < comp.length; n++) {
      const k = comp[n]!;
      const x = k % w;
      const y = (k - x) / w;
      for (const [dx, dy] of steps) {
        const nx = x + dx!;
        const ny = y + dy!;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const m = ny * w + nx;
        if (!seen[m] && on(m)) (seen[m] = 1, comp.push(m));
      }
    }
    out.push(comp);
  }
  return out;
}

/** `mask` grown (dilate) or shrunk (erode) by one pixel, 3x3. */
function morph(mask: Uint8Array, w: number, h: number, grow: boolean): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let hit = !grow;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          const v = nx < 0 || ny < 0 || nx >= w || ny >= h ? (grow ? 0 : 1) : mask[ny * w + nx]!;
          if (grow && v) hit = true;
          if (!grow && !v) hit = false;
        }
      out[y * w + x] = hit ? 1 : 0;
    }
  return out;
}

/**
 * Which pixels of each frame of one crew sprite are the figure (1) and which the picture behind it (0). The original painted some frames
 * over its own picture (the display bank, the console, the chair), so the picture has to come out, but not by colour alone: a black belt
 * over a black display or a pale face over a cream pillar matches the picture as well as the picture does. The frames say more than one does:
 * - **The figure moves; the picture doesn't.** A pixel that is the same in every frame (still) and the picture's colour there is the
 *   picture, when it reaches the frame's border through such pixels (or the frame's own cut-out, its transparent index). A pixel that
 *   changes is the figure, but where it is the picture's colour in this frame (light, in a frame the original cut round the figure by hand),
 *   and for a walking figure's rim: a light one near the picture's colour within a few pixels of the frame's cut-out.
 * - **What the figure encloses is its own:** a still part (dark trousers over a dark display, a face over the pillar) stays. Only the
 *   picture traced in CREW_CUTS is cut from inside it, and a light gap the moving figure opens (the picture between its legs).
 * - The mask is closed (a notch or channel up to two pixels wide is filled: 3x3), what it then encloses is filled, and specks are dropped.
 * - **A lamp on the head is the picture's.** A still part the figure keeps that touches it only on the top edge of its moving part (the
 *   topmost moving pixel of a column), from above or beside it and no lower, is picture bridge.png doesn't match (the lamp behind Data's
 *   head, and its specks): the figure under it moves, and it doesn't. The frame is traced again with it as cut-out, so the picture it walled
 *   in goes, and the rim and dark housing beside it that are the picture's colour.
 * - **The limit, accepted:** a still part of the figure within STILL_SAME (light) or STILL_SAME_DARK (dark) of the picture behind it that
 *   reaches the frame's border or cut-out through such pixels is taken as picture: nothing in the frames tells it apart. Only enclosure
 *   (the figure's outline round it) or moving keeps it. The bridge's still crew are well clear of it (their figure is mostly 24 to 48 or
 *   more from the picture; the picture left in their frames is mostly within 8).
 */
export function crewMattes(frames: readonly PlacedFrame[], bg: Rgba, cuts: readonly (readonly (readonly [number, number])[])[] = []): Uint8Array[] {
  if (frames.length === 0) return [];
  const left = Math.min(...frames.map(f => f.left));
  const top = Math.min(...frames.map(f => f.top));
  const uw = Math.max(...frames.map(f => f.left + f.img.width)) - left;
  const uh = Math.max(...frames.map(f => f.top + f.img.height)) - top;
  // (a pixel of the picture is still when every frame over it has the same colour there, or none)
  const first = new Int32Array(uw * uh).fill(-2);
  const moving = new Uint8Array(uw * uh);
  for (const f of frames)
    for (let y = 0; y < f.img.height; y++)
      for (let x = 0; x < f.img.width; x++) {
        const i = (y * f.img.width + x) * 4;
        const v = f.img.data[i + 3] === 0 ? -1 : (f.img.data[i]! << 16) | (f.img.data[i + 1]! << 8) | f.img.data[i + 2]!;
        const k = (f.top - top + y) * uw + f.left - left + x;
        if (first[k] === -2) first[k] = v;
        else if (first[k] !== v) moving[k] = 1;
      }
  return frames.map(f => {
    const { width: w, height: h, data } = f.img;
    const opaque = (k: number): boolean => data[k * 4 + 3] !== 0;
    const still = (k: number): boolean => moving[(f.top - top + Math.floor(k / w)) * uw + f.left - left + (k % w)] === 0;
    const diff = (k: number): number => {
      const bx = f.left + (k % w);
      const by = f.top + Math.floor(k / w);
      if (bx < 0 || by < 0 || bx >= bg.width || by >= bg.height) return 255;
      const j = (by * bg.width + bx) * 4;
      return Math.max(Math.abs(data[k * 4]! - bg.data[j]!), Math.abs(data[k * 4 + 1]! - bg.data[j + 1]!), Math.abs(data[k * 4 + 2]! - bg.data[j + 2]!));
    };
    const light = (k: number): boolean => Math.max(data[k * 4]!, data[k * 4 + 1]!, data[k * 4 + 2]!) > HOLE_DARK;
    // (chessboard distance to the frame's own cut-out, up to NEAR_CUT + 1)
    const toCut = new Uint8Array(w * h).fill(NEAR_CUT + 1);
    for (let k = 0; k < w * h; k++) if (!opaque(k)) toCut[k] = 0;
    for (let d = 1; d <= NEAR_CUT; d++)
      for (let k = 0; k < w * h; k++) {
        if (toCut[k] !== NEAR_CUT + 1) continue;
        const x = k % w;
        const y = (k - x) / w;
        for (let dy = -1; dy <= 1 && toCut[k] !== d; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < w && ny < h && toCut[ny * w + nx] === d - 1) { toCut[k] = d; break; }
        }
      }
    // (a frame with its own cut-out, a fifth or more of it empty, was cut round the figure by hand: what it left is the figure but for a light
    // rim, so a dark moving pixel in it is the figure's (black shoulders over a black doorway match it exactly))
    let clear = 0;
    for (let k = 0; k < w * h; k++) if (!opaque(k)) clear++;
    const cutOut = clear * 5 >= w * h;
    const picture = (k: number): boolean =>
      still(k) ? diff(k) <= (light(k) ? STILL_SAME : STILL_SAME_DARK) : (light(k) || !cutOut) && (diff(k) <= MOVING_SAME || (light(k) && toCut[k]! <= NEAR_CUT && diff(k) <= RIM_SAME));
    // (the figure, with `lamp` taken as picture: what reaches the frame's border through cut-out or picture pixels is the picture. The lamp is
    // cut out as the frame's own cut-out is, with the same light rim round it, and its dark housing beside it, the picture's own colour, goes too
    // (a dark moving pixel is kept elsewhere in a frame cut round the figure by hand, as black shoulders over a black doorway))
    const trace = (lamp: Uint8Array): Uint8Array => {
      let nearLamp = lamp;
      for (let d = 0; d < NEAR_CUT; d++) nearLamp = morph(nearLamp, w, h, true);
      const open = (k: number): boolean => !opaque(k) || picture(k) || lamp[k] === 1 || (nearLamp[k] === 1 && !still(k) && (diff(k) <= MOVING_SAME || (light(k) && diff(k) <= RIM_SAME)));
      const outside = new Uint8Array(w * h);
      const stack: number[] = [];
      const push = (x: number, y: number): void => {
        const k = y * w + x;
        if (x >= 0 && y >= 0 && x < w && y < h && !outside[k] && open(k)) (outside[k] = 1, stack.push(k));
      };
      for (let x = 0; x < w; x++) (push(x, 0), push(x, h - 1));
      for (let y = 0; y < h; y++) (push(0, y), push(w - 1, y));
      for (let k = 0; k < w * h; k++) if (!opaque(k)) push(k % w, Math.floor(k / w));
      while (stack.length) {
        const k = stack.pop()!;
        const x = k % w;
        const y = (k - x) / w;
        (push(x + 1, y), push(x - 1, y), push(x, y + 1), push(x, y - 1));
      }
      const fig = new Uint8Array(w * h);
      for (let k = 0; k < w * h; k++) fig[k] = opaque(k) && !outside[k] ? 1 : 0;
      // (cut from inside: the still pixels inside a traced cut, and the light gaps a moving figure opens)
      const cut = new Uint8Array(lamp);
      for (let k = 0; k < w * h; k++)
        if (opaque(k) && still(k) && cuts.some(p => inPoly(p, f.left + (k % w) + 0.5, f.top + Math.floor(k / w) + 0.5))) cut[k] = 1;
      for (const comp of components(w, h, k => fig[k] === 1 && !still(k) && light(k) && diff(k) <= RIM_SAME)) if (comp.length >= HOLE_PATCH && comp.reduce((t, k) => t + diff(k), 0) <= GAP_MEAN * comp.length) for (const k of comp) cut[k] = 1;
      for (let k = 0; k < w * h; k++) if (cut[k]) fig[k] = 0;
      // (closed: a notch or channel up to two pixels wide is the figure's; then what the figure encloses is filled)
      const closed = morph(morph(fig, w, h, true), w, h, false);
      for (let k = 0; k < w * h; k++) if (closed[k] && opaque(k) && !cut[k]) fig[k] = 1;
      for (const comp of components(w, h, k => fig[k] === 0)) {
        if (comp.some(k => { const x = k % w; const y = (k - x) / w; return x === 0 || y === 0 || x === w - 1 || y === h - 1 || !opaque(k) || cut[k] === 1; })) continue;
        for (const k of comp) fig[k] = 1;
      }
      return fig;
    };
    // (a lamp: still pixels the figure keeps (picture bridge.png doesn't match) that touch it only on the moving part's top edge, from above or
    // beside, are the picture behind the head. Traced again with it taken as picture, the picture it walled in (behind the head's edge) goes too)
    let fig = trace(new Uint8Array(w * h));
    const lamp = new Uint8Array(w * h);
    const crown = new Int32Array(w).fill(h);
    for (let k = 0; k < w * h; k++) if (fig[k] && !still(k)) crown[k % w] = Math.min(crown[k % w]!, Math.floor(k / w));
    // (the blob is 8-connected, so a speck joined to the lamp at a corner goes with it; what it touches is 4-connected, as the trace's flood is,
    // so a corner doesn't count as touching. Both 4-connected took two pixels at the edge of Troi's figure, a corner apart, as lamps; both
    // 8-connected kept a speck beside the head's top corner)
    for (const comp of components(w, h, k => fig[k] === 1 && still(k), true)) {
      const mine = new Set(comp);
      let touches = -1;
      let lowest = -1;
      let other = false;
      for (const k of comp) {
        const x = k % w;
        const y = (k - x) / w;
        lowest = Math.max(lowest, y);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = x + dx;
          const ny = y + dy;
          const m = ny * w + nx;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h || !fig[m] || mine.has(m)) continue;
          if (still(m) || crown[nx] !== ny || ny < y) other = true;
          else touches = Math.max(touches, ny);
        }
      }
      if (!other && touches >= 0 && lowest <= touches) for (const k of comp) lamp[k] = 1;
    }
    if (lamp.includes(1)) fig = trace(lamp);
    for (const comp of components(w, h, k => fig[k] === 1, true)) if (comp.length < SPECK) for (const k of comp) fig[k] = 0;
    return fig;
  });
}

/** An edge pixel (an empty neighbour) this much darker than the figure inside it is the outline. */
const OUTLINE_RATIO = 0.55;
const OUTLINE_DARK = 64;
const luma = (d: Uint8Array, i: number): number => 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!;

/**
 * The outline the erosion left (where the figure is two pixels of it deep, or the rim is a grey the erosion doesn't take) is given the colour
 * of the figure just inside it rather than cut: the silhouette stays, and the dark ring that the 4x card drew round the figure goes. Inside
 * is the mean of the opaque pixels within two pixels that are not on the edge themselves.
 */
function relightOutline(img: Rgba): void {
  const { width: w, height: h, data } = img;
  const edge = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] === 0) continue;
      for (let dy = -1; dy <= 1 && !edge[y * w + x]; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && alpha(img, x + dx, y + dy) === 0) { edge[y * w + x] = 1; break; }
    }
  const set: [number, number[]][] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (!edge[y * w + x] || luma(data, i) > OUTLINE_DARK) continue;
      const sum = [0, 0, 0];
      let n = 0;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h || edge[ny * w + nx] || data[(ny * w + nx) * 4 + 3] === 0) continue;
          for (let c = 0; c < 3; c++) sum[c]! += data[(ny * w + nx) * 4 + c]!;
          n++;
        }
      if (n === 0) continue;
      const inner = sum.map(v => v / n);
      if (luma(data, i) < OUTLINE_RATIO * (0.299 * inner[0]! + 0.587 * inner[1]! + 0.114 * inner[2]!)) set.push([i, inner.map(Math.round)]);
    }
  for (const [i, rgb] of set) data.set(rgb, i);
}

// ---- The stills' clean-up as it was before Plan 33 (writeCrew, publish.ts): a frame with no matte from crewMattes keeps it, byte for byte,
// so a station's crew stills don't change with the bridge strips' masks. ----

/** Pixels of a frame that are the background's own (the original painted these frames over its picture) differ by at most this. */
const LEGACY_SAME = 36;
/** A matched pixel enclosed by the figure is put back when no channel is over this (a dark part of the figure); a lighter one is the picture behind it. */
const LEGACY_HOLE_DARK = 90;
/** ... and goes with the rest of its patch only when the patch is at least this many pixels (a dither dot of the figure's own is not). */
const LEGACY_HOLE_PATCH = 16;

/**
 * Some frames carry the picture behind the figure (Worf's, Troi's and Data's hold the display bank, the console and the chair
 * as drawn into the original bridge), which would show as a box in a set that draws its own. A pixel that equals the original's
 * pixel at the place the frame is drawn is that picture, not the figure: it goes transparent. A dark part of the figure that
 * matches by chance is put back when it is enclosed by the figure (it is a hole the border can't reach), and specks of fewer
 * than 30 pixels that survive are dropped.
 */
function legacyColourMatte(img: Rgba, bg: FrameBackground, lightOnly = false): void {
  const { width: w, height: h } = img;
  const same = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (img.data[i + 3] === 0) continue;
      // (a frame with its own cut-out has only a light picture left in it: its dark pixels are the figure's, black shoulders and hair that match a black display by chance)
      if (lightOnly && Math.max(img.data[i]!, img.data[i + 1]!, img.data[i + 2]!) <= LEGACY_HOLE_DARK) continue;
      const bx = bg.left + x;
      const by = bg.top + y;
      if (bx < 0 || by < 0 || bx >= bg.pixels.width || by >= bg.pixels.height) continue;
      const j = (by * bg.pixels.width + bx) * 4;
      if (Math.abs(img.data[i]! - bg.pixels.data[j]!) <= LEGACY_SAME && Math.abs(img.data[i + 1]! - bg.pixels.data[j + 1]!) <= LEGACY_SAME && Math.abs(img.data[i + 2]! - bg.pixels.data[j + 2]!) <= LEGACY_SAME) same[y * w + x] = 1;
    }
  // (what is empty once the picture is gone, and reaches the frame's border, is outside; the rest of the matched pixels are holes)
  const empty = (k: number): boolean => same[k] === 1 || img.data[k * 4 + 3] === 0;
  const outside = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (x: number, y: number): void => {
    const k = y * w + x;
    if (x >= 0 && y >= 0 && x < w && y < h && !outside[k] && empty(k)) {
      outside[k] = 1;
      stack.push(k);
    }
  };
  for (let x = 0; x < w; x++) (push(x, 0), push(x, h - 1));
  for (let y = 0; y < h; y++) (push(0, y), push(w - 1, y));
  while (stack.length) {
    const k = stack.pop()!;
    const x = k % w;
    const y = (k - x) / w;
    push(x + 1, y);
    push(x - 1, y);
    push(x, y + 1);
    push(x, y - 1);
  }
  for (let k = 0; k < w * h; k++) if (same[k] === 1 && outside[k] === 1) img.data[k * 4 + 3] = 0;
  // (a matched pixel the border can't reach is a hole, and stays: black trousers over a black display match by chance, and so does a blue uniform's dither over
  // the carpet. A light patch of 16 pixels or more is the picture showing between the legs or an arm and the body, the carpet's blue or the wall's cream, and goes)
  const light = (k: number): boolean => same[k] === 1 && outside[k] === 0 && Math.max(img.data[k * 4]!, img.data[k * 4 + 1]!, img.data[k * 4 + 2]!) > LEGACY_HOLE_DARK;
  const done = new Uint8Array(w * h);
  for (let k0 = 0; k0 < w * h; k0++) {
    if (done[k0] || !light(k0)) continue;
    const comp: number[] = [k0];
    done[k0] = 1;
    for (let n = 0; n < comp.length; n++) {
      const k = comp[n]!;
      const x = k % w;
      const y = (k - x) / w;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const m = ny * w + nx;
        if (!done[m] && light(m)) (done[m] = 1, comp.push(m));
      }
    }
    if (comp.length >= LEGACY_HOLE_PATCH) for (const k of comp) img.data[k * 4 + 3] = 0;
  }
  // (opaque islands under 30 pixels)
  const seen = new Uint8Array(w * h);
  for (let k0 = 0; k0 < w * h; k0++) {
    if (seen[k0] || img.data[k0 * 4 + 3] === 0) continue;
    const comp: number[] = [k0];
    seen[k0] = 1;
    for (let n = 0; n < comp.length; n++) {
      const k = comp[n]!;
      const x = k % w;
      const y = (k - x) / w;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const m = ny * w + nx;
          if (!seen[m] && img.data[m * 4 + 3] !== 0) (seen[m] = 1, comp.push(m));
        }
    }
    if (comp.length < 30) for (const k of comp) img.data[k * 4 + 3] = 0;
  }
}
/**
 * The light outline round a figure: edge pixels the matte missed because the sprite was cut from a slightly different picture (the cream of the
 * wall in a strip along an arm, the carpet's blue at a hand), which the plate's own wall and carpet then show up against. An opaque pixel on the
 * edge (a neighbour empty) goes when it is nearer the picture behind it than the figure beside it: `inner` is the mean of the opaque pixels at
 * least three pixels inside, within a 9x9 window. Two passes take a two-pixel rim. Skin, hair and the uniforms are nearer themselves than the wall, so stay.
 */
function legacyDefringe(img: Rgba, bg: FrameBackground): void {
  const { width: w, height: h } = img;
  const dist = (a: number[], b: number[]): number => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
  for (let pass = 0; pass < FRINGE_PASSES; pass++) {
    // chessboard depth into the figure, up to 3
    const depth = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (img.data[(y * w + x) * 4 + 3] !== 0) depth[y * w + x] = 255;
    for (let d = 1; d <= 3; d++) {
      const next: number[] = [];
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          if (depth[y * w + x] !== 255) continue;
          let edge = false;
          for (let dy = -1; dy <= 1 && !edge; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && (x + dx < 0 || y + dy < 0 || x + dx >= w || y + dy >= h || depth[(y + dy) * w + x + dx] === 0 || (depth[(y + dy) * w + x + dx]! < 255 && depth[(y + dy) * w + x + dx]! < d))) { edge = true; break; }
          if (edge) next.push(y * w + x);
        }
      for (const k of next) depth[k] = d;
    }
    const drop: number[] = [];
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        if (depth[y * w + x] !== 1) continue;
        const bx = bg.left + x;
        const by = bg.top + y;
        if (bx < 0 || by < 0 || bx >= bg.pixels.width || by >= bg.pixels.height) continue;
        const i = (y * w + x) * 4;
        const me = [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!];
        const j = (by * bg.pixels.width + bx) * 4;
        const there = [bg.pixels.data[j]!, bg.pixels.data[j + 1]!, bg.pixels.data[j + 2]!];
        const sum = [0, 0, 0];
        let n = 0;
        for (let dy = -4; dy <= 4; dy++)
          for (let dx = -4; dx <= 4; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h || depth[ny * w + nx]! < 3) continue;
            const q = (ny * w + nx) * 4;
            n++;
            for (let k = 0; k < 3; k++) sum[k]! += img.data[q + k]!;
          }
        if (n === 0) continue;
        const inner = sum.map(v => v / n);
        const toPicture = dist(me, there);
        if (toPicture <= FRINGE_NEAR && toPicture < dist(me, inner) * FRINGE_MARGIN) drop.push(i);
      }
    for (const i of drop) img.data[i + 3] = 0;
    if (drop.length === 0) break;
  }
}
/** A fringe pixel is within this of the picture behind it (looser than the matte's own SAME), and nearer it than the figure by this factor. */
const FRINGE_NEAR = 110;
const FRINGE_MARGIN = 0.8;
const FRINGE_PASSES = 2;

const alpha = (img: Rgba, x: number, y: number): number => (x < 0 || y < 0 || x >= img.width || y >= img.height ? 0 : img.data[(y * img.width + x) * 4 + 3]!);

/**
 * A bridge sprite's frame made ready to be a texture. The original draws these frames pixel for pixel through a palette, where an
 * index is either drawn or not. Here they are scaled by the GPU, so three things look wrong that the original's 1:1 blit hides:
 * - **Picture.** The frames carry the picture they were painted over: `matte` (crewMattes, from all the sprite's frames) says what is
 *   the figure. A frame with only `bg` (a station's still, writeCrew) keeps the clean-up it had before Plan 33, byte for byte: the
 *   colour matte and defringe (legacyColourMatte, legacyDefringe), and none of the strip's changes below.
 * - **Fringe.** The frames carry a rim of near-black pixels (the outline, dither at the silhouette, the shoes). At 1.8x they read as
 *   dirt around the figure, so the rim is eroded one pixel: a dark pixel with three or more of its eight neighbours empty goes,
 *   then one with five or more (so what is left of a dither speck goes too). In a strip frame what goes takes its colour with it, and what
 *   is left of the outline takes the colour inside it (relightOutline).
 * - **Halo.** Empty pixels are black, and linear filtering mixes that black into the edge, ringing the figure in dark. Each empty
 *   pixel next to the figure takes the colour of the figure pixels beside it (alpha stays 0), three pixels out.
 */
export function prepareCrewFrame(src: Rgba, bg?: FrameBackground, matte?: Uint8Array): Rgba {
  const img: Rgba = { width: src.width, height: src.height, data: new Uint8Array(src.data) };
  const at = (x: number, y: number): number => (y * img.width + x) * 4;
  // (a strip frame comes with its mask from all its frames, crewMattes, and what goes takes its colour with it: the colour bleed below would
  // spread the picture's or the outline's colour into the edge. A still, with none, is cleaned up as it always was)
  const strip = matte !== undefined;
  if (matte) {
    for (let k = 0; k < matte.length; k++) if (!matte[k]) img.data.fill(0, k * 4, k * 4 + 4);
  } else if (bg) {
    let clear = 0;
    for (let i = 3; i < img.data.length; i += 4) if (img.data[i] === 0) clear++;
    legacyColourMatte(img, bg, clear * 5 >= img.width * img.height);
    legacyDefringe(img, bg);
  }
  // (the rim of near-black pixels is one pixel thinner: three empty neighbours on the first pass, which takes the edge, then five, and a last pass for the greys)
  for (const { need, grey } of [{ need: 3, grey: false }, { need: 5, grey: false }, { need: 3, grey: true }, { need: 3, grey: true }, { need: 3, grey: true }]) {
    const drop: number[] = [];
    for (let y = 0; y < img.height; y++)
      for (let x = 0; x < img.width; x++) {
        const i = at(x, y);
        if (img.data[i + 3] === 0 || !isFringe(img.data[i]!, img.data[i + 1]!, img.data[i + 2]!, grey)) continue;
        let empty = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && alpha(img, x + dx, y + dy) === 0) empty++;
        if (empty >= need) drop.push(i);
      }
    for (const i of drop) {
      if (strip) img.data.fill(0, i, i + 4);
      else img.data[i + 3] = 0;
    }
  }
  if (strip) relightOutline(img);
  for (let pass = 0; pass < 3; pass++) {
    const set: [number, number[]][] = [];
    for (let y = 0; y < img.height; y++)
      for (let x = 0; x < img.width; x++) {
        const i = at(x, y);
        if (img.data[i + 3] !== 0) continue;
        let n = 0;
        const sum = [0, 0, 0];
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= img.width || ny >= img.height) continue;
            const j = at(nx, ny);
            if (img.data[j + 3] === 0 && !(pass > 0 && img.data[j]! + img.data[j + 1]! + img.data[j + 2]! > 0)) continue;
            n++;
            for (let k = 0; k < 3; k++) sum[k]! += img.data[j + k]!;
          }
        if (n > 0) set.push([i, sum.map(v => Math.round(v / n))]);
      }
    for (const [i, rgb] of set) img.data.set(rgb, i);
  }
  return img;
}
