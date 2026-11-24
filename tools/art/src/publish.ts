// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { parseDocument } from 'yaml';
import { alignCheck, ALIGN_DEFAULTS } from './align';
import type { Rect, RepaintRecipe, PlateStation } from './recipe';
import { decodePng, encodePng, meanAbsDiff, type Rgba } from './image';
import type { CheckPoint } from './points';
import type { RunMeta } from './run';
import { prepareCrewFrame } from './crewframe';
import type { BridgeStrip, ViewStrip } from './bridgeanim';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { readWebp, toWebp, webpSize } from './webp';
import { crop, windowAlpha, windowMask } from './window';

/** Data layers stay PNG (lossless); the plate, which is looked at, is WebP (R10). */
const DATA_LAYERS = ['depth', 'normal'] as const;
/** R10: a plate's WebP must be within this mean (levels of 255) of its PNG. */
export const WEBP_MAX_MEAN_DIFF = 2;
const QUALITY = 90;

/** A phone's plate: half the width and height, written beside the full one as plate.half.webp. */
export const HALF_PLATE = 'plate.half.webp';

/** Half of a plate's size, in pixels (never under 1). */
export const halfSize = (width: number, height: number): [number, number] => [Math.max(1, Math.floor(width / 2)), Math.max(1, Math.floor(height / 2))];

/** The encoder for a plate's half-resolution variant: the deps', else the full encoder when a test gave one, else cwebp with `-resize`. */
function halfEncoder(deps: PublishDeps, size: [number, number]): (png: string, out: string) => Promise<void> {
  return deps.encodeHalf ?? deps.encode ?? ((png, out) => toWebp(png, out, { quality: QUALITY, resize: size }));
}

/** How a plate's WebP is encoded: lossy first, then near-lossless, then lossless, each tried only when the one before fails a check. */
export type WebpMode = 'lossy' | 'near-lossless' | 'lossless';
export const WEBP_MODES: WebpMode[] = ['lossy', 'near-lossless', 'lossless'];
/** cwebp's -near_lossless level (0 is the most preprocessing, 100 none). */
export const NEAR_LOSSLESS = 60;

const encodeMode = (mode: WebpMode) => (png: string, out: string): Promise<void> =>
  toWebp(png, out, mode === 'lossy' ? { quality: QUALITY } : mode === 'lossless' ? { quality: QUALITY, lossless: true } : { quality: QUALITY, nearLossless: NEAR_LOSSLESS });

/**
 * Encodes `source` to `tmp` and decodes it again, trying each mode in turn until the WebP is within WEBP_MAX_MEAN_DIFF of its
 * PNG and (when `align` is given) still passes the alignment check. The thresholds are never loosened: when the lossless
 * one fails too, the result is `ok: false` with the last reason. Logs the mode used when it was not the first.
 */
export async function encodeChecked(
  label: string,
  source: string,
  tmp: string,
  png: Rgba,
  deps: PublishDeps,
  align: ((back: Rgba) => { ok: boolean; why?: string }) | null,
): Promise<{ ok: true; back: Rgba; drift: number; mode: WebpMode } | { ok: false; why: string }> {
  let why = '';
  for (const mode of WEBP_MODES) {
    await (deps.encode ? (a: string, b: string) => deps.encode!(a, b, mode) : encodeMode(mode))(source, tmp);
    const back = await (deps.decode ?? readWebp)(tmp);
    const drift = meanAbsDiff(png, back);
    if (drift > WEBP_MAX_MEAN_DIFF) {
      why = `the WebP differs from the PNG by a mean of ${drift.toFixed(2)}/255 (limit ${WEBP_MAX_MEAN_DIFF})`;
      continue;
    }
    const r = align?.(back);
    if (r && !r.ok) {
      why = `the WebP no longer passes the alignment check (${r.why})`;
      continue;
    }
    if (mode !== 'lossy') console.log(`${label}: the lossy WebP failed its check; published ${mode}`);
    return { ok: true, back, drift, mode };
  }
  return { ok: false, why };
}

export interface PublishDeps {
  /** Default: Homebrew's cwebp and dwebp. */
  encode?: (png: string, out: string, mode?: WebpMode) => Promise<void>;
  decode?: (webp: string) => Promise<Rgba>;
  /** The half-resolution plate (`plate.half.webp`, for phones). Default: `encode` when it is given (a test's), else cwebp resizing to half. */
  encodeHalf?: (png: string, out: string) => Promise<void>;
  /** The original, to see whether its interface strip is a key colour (blackenKeyBand). */
  original?: Rgba;
  /** The original and its check points: the WebP's own pixels are measured again, and a misalignment refuses the publish. */
  align?: { original: Rgba; points: CheckPoint[]; maxShift?: number };
}

/**
 * The bottom sixth of an original screen (rows 400-479 of 480) is where the game's interface sat. Close-ups leave a solid
 * key colour there (chroma green), which the engine would draw as a band. Returns the plate with that strip black (and the
 * rows just above it freed of the key colour's cast, where the repaint bleeds it) when the original's strip is one solid
 * non-black colour, else null. Scales to the plate's size.
 */
export function blackenKeyBand(plate: Rgba, original: Rgba): Rgba | null {
  const top = Math.round((original.height * 5) / 6);
  const at = (y: number, x: number): string => [0, 1, 2].map(c => original.data[(y * original.width + x) * 4 + c]).join(',');
  const key = at(top, 0);
  if (key === '0,0,0') return null;
  for (let y = top; y < original.height; y++) for (let x = 0; x < original.width; x++) if (at(y, x) !== key) return null;
  const out: Rgba = { width: plate.width, height: plate.height, data: new Uint8Array(plate.data) };
  const first = Math.round((plate.height * 5) / 6);
  for (let y = first; y < plate.height; y++) for (let x = 0; x < plate.width; x++) out.data.set([0, 0, 0, 255], (y * plate.width + x) * 4);
  // (the repaint bleeds the key colour into the rows beside the strip: in two original pixels of them, a pixel the key's
  // main channel dominates is made grey of the same luma, so the cast goes and the edge the alignment check measures stays)
  const channels = key.split(',').map(Number);
  const main = channels.indexOf(Math.max(...channels));
  const bleed = 2 * Math.ceil(plate.height / original.height);
  for (let y = Math.max(0, first - bleed); y < first; y++) {
    for (let x = 0; x < plate.width; x++) {
      const i = (y * plate.width + x) * 4;
      const [r, g, b] = [out.data[i]!, out.data[i + 1]!, out.data[i + 2]!];
      const others = [r, g, b].filter((_, c) => c !== main);
      if ([r, g, b][main]! - Math.max(...others) <= 8) continue;
      const luma = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
      out.data.set([luma, luma, luma], i);
    }
  }
  return out;
}

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/**
 * Writes games/unity/art/rooms/<world>/<sNN>/ (plate.webp, plus depth and normal PNGs) and sets presentation.yaml's
 * art.rooms[<screen>] (parseDocument, in place: the header and every other key stay). Both are local and git-ignored (R8).
 * Refuses a run without a passing alignment check, a WebP that drifts from its PNG, and a WebP that no longer aligns.
 * Both sha256s of the plate go to <run dir>/published.json.
 */
export async function publishRoom(gameDir: string, screen: string, run: { dir: string; meta: RunMeta }, deps: PublishDeps = {}): Promise<{ files: string[]; plate: { png: string; webp: string; meanAbsDiff: number } }> {
  // a repaint plate goes to the engine only once it has been measured against the original; only an upscale-only plate may skip that, with its reason
  const check = run.meta.checks.align as { ok?: boolean; skipped?: boolean; reason?: string } | undefined;
  const skipped = check?.skipped === true;
  if (skipped && run.meta.upscaleOnly !== true) {
    throw new Error(`${screen}: the run in ${run.dir} skipped the alignment check but is not an upscale-only plate; a repainted plate must pass it`);
  }
  if (!skipped && check?.ok !== true) {
    throw new Error(`${screen}: the run in ${run.dir} has no passing alignment check; give the recipe an align post-step and art run it again`);
  }
  if (skipped) console.warn(`!!! ${screen}: publishing an UPSCALE-ONLY plate with NO alignment check (${check?.reason ?? 'no reason recorded'})`);
  const m = /^([a-z0-9]+)\.(s[0-9a-f]{2})$/.exec(screen);
  if (!m) throw new Error(`"${screen}" isn't a screen id like lab.s01`);
  const plateOut = run.meta.outputs.plate;
  if (!plateOut) throw new Error(`the run in ${run.dir} has no plate to publish`);
  const rel = `art/rooms/${m[1]}/${m[2]}`;
  await mkdir(join(gameDir, rel), { recursive: true });
  const webp = join(gameDir, rel, 'plate.webp');
  // (encoded beside the plate and renamed over it once it passes: a refusal leaves the published plate as it was)
  const tmp = `${webp}.tmp`;
  let source = plateOut.file;
  let pngBytes: Uint8Array = new Uint8Array(await readFile(source));
  const keyed = deps.original ? blackenKeyBand(decodePng(pngBytes), deps.original) : null;
  if (keyed) {
    // (the strip is made black beside the run's plate, which stays as it was)
    source = join(run.dir, 'plate.published.png');
    pngBytes = encodePng(keyed);
    await writeFile(source, pngBytes);
  }
  const refuse = async (why: string): Promise<never> => {
    await rm(tmp, { force: true });
    throw new Error(`${screen}: ${why}`);
  };
  const enc = await encodeChecked(screen, source, tmp, decodePng(pngBytes), deps, deps.align && !skipped
    ? back => alignCheck(deps.align!.original, back, deps.align!.points, { ...ALIGN_DEFAULTS, maxShift: deps.align!.maxShift ?? ALIGN_DEFAULTS.maxShift })
    : null);
  if (!enc.ok) return refuse(`${enc.why}, even lossless; nothing was published`);
  const { drift, mode } = enc;
  // (the phone's half-size plate, from the same PNG: written with the plate, so the two are never from different runs)
  const half = join(gameDir, rel, HALF_PLATE);
  const size = decodePng(pngBytes);
  await halfEncoder(deps, halfSize(size.width, size.height))(source, `${half}.tmp`);
  await rename(tmp, webp);
  await rename(`${half}.tmp`, half);
  const entry: Record<string, string> = { plate: `${rel}/plate.webp` };
  const files = [entry.plate!, `${rel}/${HALF_PLATE}`];
  for (const layer of DATA_LAYERS) {
    const out = run.meta.outputs[layer];
    if (!out) continue;
    await copyFile(out.file, join(gameDir, rel, `${layer}.png`));
    entry[layer] = `${rel}/${layer}.png`;
    files.push(entry[layer]!);
  }
  const plate = { png: sha(pngBytes), webp: sha(new Uint8Array(await readFile(webp))), meanAbsDiff: drift };
  await writeFile(join(run.dir, 'published.json'), `${JSON.stringify({ screen, plate, quality: QUALITY, encoding: mode, ...(skipped ? { alignSkipped: check?.reason ?? true } : {}) }, null, 2)}\n`);
  const path = join(gameDir, 'presentation.yaml');
  const doc = parseDocument(await readFile(path, 'utf8').catch(() => ''));
  // (masks cut from an earlier plate stay: art masks sets them)
  const masks = doc.getIn(['art', 'rooms', screen, 'masks']);
  doc.setIn(['art', 'rooms', screen], masks === undefined ? entry : { ...entry, masks });
  await writeFile(path, String(doc));
  return { files, plate };
}

/** The stations `art.ship` knows (presentation.yaml's schema). */
/** The areas a station's panel needs (R15-R17); publishShipPlate refuses a recipe without one. */
const STATION_AREAS: Partial<Record<PlateStation, string[]>> = { viewscreen: ['name'], transporter: ['equipment', 'crew', 'kit', 'controls', 'exits'], astrogation: ['map', 'info', 'controls'], computer: ['rows', 'entry', 'scroll', 'exits'] };
/** R15: the window layer's alpha is the mask upscaled this much, grown this many original pixels. */
const WINDOW_SCALE = 4;
// (3: the upscaler leaves a pale dotted rim on the frame's inner curve, a pixel or two beyond the key colour; the picture covers it)
const WINDOW_GROW = 3;

export const SHIP_STATIONS = ['bridge', 'viewscreen', 'transporter', 'astrogation', 'computer'] as const;

/**
 * Copies a ship run's glb to games/unity/art/ship/<station>.glb and sets presentation.yaml's art.ship[<station>]
 * (parseDocument, in place; a viewscreen mesh name set earlier stays). Local and git-ignored, as the rooms are.
 * Refuses a run whose ID check did not pass for every fixture.
 */
export interface ShipCrewFrame {
  /** The bridge object (art.cards is keyed `bridge.<object>`). */
  object: string;
  /** The sprite file the original names (brdgrikr.spr); the card is crew/<its name>.webp. */
  file: string;
  /** The decoded first frame, a PNG at the sprite's own pixels. */
  png: string;
  /** Where the original draws its feet in the 640x480 picture; with the deps' `background`, the picture behind the figure is cut out. */
  at?: [number, number];
  /** bridge.objects' depth: with `at`, it puts the object in art.ship[station].crew (R14). */
  depth?: number;
}

export async function publishShip(
  gameDir: string,
  station: string,
  run: { dir: string; meta: { outputs: Record<string, { file: string } | undefined>; align?: { pass: boolean }[] } },
  deps: { crew?: ShipCrewFrame[]; background?: Rgba; encode?: (png: string, out: string) => Promise<void> } = {},
): Promise<{ file: string; gltf: string; crew: string[] }> {
  if (!(SHIP_STATIONS as readonly string[]).includes(station)) throw new Error(`"${station}" is not a ship station (${SHIP_STATIONS.join(', ')})`);
  const glb = run.meta.outputs.glb;
  if (!glb) throw new Error(`the run in ${run.dir} has no glb to publish`);
  if (!run.meta.align || run.meta.align.length === 0 || run.meta.align.some(a => !a.pass)) {
    throw new Error(`${station}: the run in ${run.dir} has no passing ID check; art ship build ${station} again`);
  }
  const gltf = `art/ship/${station}.glb`;
  await mkdir(join(gameDir, 'art', 'ship'), { recursive: true });
  await copyFile(glb.file, join(gameDir, gltf));
  const path = join(gameDir, 'presentation.yaml');
  const doc = parseDocument(await readFile(path, 'utf8').catch(() => ''));
  const old = doc.getIn(['art', 'ship', station]) as { toJSON?: () => Record<string, unknown> } | undefined;
  const keep = old?.toJSON?.() ?? {};
  doc.setIn(['art', 'ship', station], { ...keep, gltf, camera: 'camera:main' });
  const crew = await writeCrew(doc, gameDir, run.dir, station, deps);
  await writeFile(path, String(doc));
  return { file: join(gameDir, gltf), gltf, crew };
}

/**
 * The crew's first frames, at the sprite's own pixels (alpha kept exactly), as the cards a station stands over its picture: each is
 * written as art/ship/crew/<file>.webp after the frame clean-up (prepareCrewFrame), and set as art.cards[<station>.<object>]. A frame with
 * both `at` and `depth` also goes to art.ship[station].crew, in `deps.crew`'s order (R14).
 */
async function writeCrew(
  doc: ReturnType<typeof parseDocument>,
  gameDir: string,
  runDir: string,
  station: string,
  deps: { crew?: ShipCrewFrame[]; background?: Rgba; encode?: (png: string, out: string) => Promise<void> },
): Promise<string[]> {
  const crew: string[] = [];
  const placed: { object: string; at: [number, number]; depth: number }[] = [];
  for (const c of deps.crew ?? []) {
    const rel = `art/ship/crew/${c.file.replace(/\.spr$/i, '')}.webp`;
    await mkdir(join(gameDir, 'art', 'ship', 'crew'), { recursive: true });
    const frame = decodePng(new Uint8Array(await readFile(c.png)));
    // (specks dropped and the empty edge given the figure's colour; the file written beside the run, the original untouched)
    const prepared = join(runDir, `crew.${c.file.replace(/\.spr$/i, '')}.png`);
    await writeFile(prepared, encodePng(prepareCrewFrame(frame, deps.background && c.at ? { pixels: deps.background, left: c.at[0] - Math.floor(frame.width / 2), top: c.at[1] - frame.height } : undefined)));
    await (deps.encode ?? ((png, out) => toWebp(png, out, { quality: 95, alpha: true })))(prepared, join(gameDir, rel));
    doc.setIn(['art', 'cards', `${station}.${c.object}`], { image: rel, frames: 1, anchor: [0.5, 1], pixelHeight: frame.height });
    crew.push(rel);
    if (c.at && c.depth !== undefined) placed.push({ object: c.object, at: c.at, depth: c.depth });
  }
  if (placed.length > 0) doc.setIn(['art', 'ship', station, 'crew'], placed);
  return crew;
}

/**
 * A crew member's animation strips (bridgeStrips): art/ship/crew/<file>.<anim>.webp, and each one as art.cards[<station>.<object>].anims[<anim>]
 * with its own `scale` (1: the cells are the sprite's own pixels; 4: upscaled). The card's still and every other key stay as they were.
 */
export async function publishCrewStrips(
  gameDir: string,
  station: string,
  crew: { object: string; file: string; strips: Map<number, BridgeStrip> }[],
  encode?: (png: string, out: string) => Promise<void>,
): Promise<string[]> {
  const path = join(gameDir, 'presentation.yaml');
  const doc = parseDocument(await readFile(path, 'utf8').catch(() => ''));
  const files: string[] = [];
  const work = await mkdtemp(join(tmpdir(), 'crew-strip-'));
  const round4 = (v: number): number => Math.round(v * 10000) / 10000;
  try {
    await mkdir(join(gameDir, 'art', 'ship', 'crew'), { recursive: true });
    for (const c of crew) {
      const stem = c.file.replace(/\.spr$/i, '');
      for (const [index, a] of c.strips) {
        const png = join(work, 'strip.png');
        await writeFile(png, encodePng(a.strip));
        const image = `art/ship/crew/${stem}.${index}.webp`;
        await (encode ?? ((from, out) => toWebp(from, out, { quality: 95, alpha: true })))(png, join(gameDir, image));
        files.push(image);
        doc.setIn(['art', 'cards', `${station}.${c.object}`, 'anims', String(index)], {
          image, frames: a.frames, ...(a.columns < a.frames ? { columns: a.columns } : {}), scale: a.scale, cell: a.cell,
          anchor: [round4(a.anchor[0]), round4(a.anchor[1])], delays: a.delays, loop: a.loop, ...(a.next !== undefined ? { next: a.next } : {}),
        });
      }
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  await writeFile(path, String(doc));
  return files;
}

/** Publishes only the crew's cards (and art.ship[station].crew) of a station, as `art ship publish` does beside a plate. */
export async function publishShipCrew(gameDir: string, station: string, runDir: string, deps: { crew: ShipCrewFrame[]; background?: Rgba; encode?: (png: string, out: string) => Promise<void> }): Promise<string[]> {
  const path = join(gameDir, 'presentation.yaml');
  const doc = parseDocument(await readFile(path, 'utf8').catch(() => ''));
  const crew = await writeCrew(doc, gameDir, runDir, station, deps);
  await writeFile(path, String(doc));
  return crew;
}

/**
 * Writes games/unity/art/ship/<station>/plate.webp and sets art.ship[<station>] (parseDocument, in place): the plate and the recipe's areas
 * are set, and `gltf`, `camera`, `viewscreen` and `crew` set earlier stay. Local and git-ignored. Refuses a run without a passing alignment
 * check, a recipe without one of `deps.required`' area names, a WebP that drifts from its PNG, and a WebP that no longer aligns.
 * Both sha256s of the plate go to <run dir>/published.json.
 */
export async function publishShipPlate(
  gameDir: string,
  station: PlateStation,
  run: { dir: string; meta: RunMeta },
  recipe: Pick<RepaintRecipe, 'areas'> & { window?: RepaintRecipe['window'] },
  deps: PublishDeps & { required?: string[] } = {},
): Promise<{ files: string[]; plate: { png: string; webp: string; meanAbsDiff: number } }> {
  if ((run.meta.checks.align as { ok?: boolean } | undefined)?.ok !== true) {
    throw new Error(`${station}: the run in ${run.dir} has no passing alignment check; give the recipe an align post-step and art run it again`);
  }
  // (R15: the viewscreen's strip holds the hailing object's name, in the area `name`)
  const need = [...new Set([...(deps.required ?? []), ...(STATION_AREAS[station] ?? [])])];
  const missing = need.filter(name => recipe.areas[name] === undefined);
  if (missing.length > 0) throw new Error(`${station}: the recipe has no area called ${missing.join(', ')}; the panel needs it`);
  const plateOut = run.meta.outputs.plate;
  if (!plateOut) throw new Error(`the run in ${run.dir} has no plate to publish`);
  if (station === 'viewscreen') {
    if (!recipe.window) throw new Error(`${station}: the recipe has no window (window: { at: [x, y] }); nothing was published`);
    if (!deps.original) throw new Error(`${station}: publishing the window needs the decoded original (art ship originals)`);
  }
  const rel = `art/ship/${station}`;
  await mkdir(join(gameDir, rel), { recursive: true });
  const webp = join(gameDir, rel, 'plate.webp');
  // (the plate and the window layer are encoded beside theirs and renamed over them once they pass: a refusal leaves what was published)
  const tmp = `${webp}.tmp`;
  const windowTmp = join(gameDir, rel, 'window.webp.tmp');
  let pngBytes: Uint8Array = new Uint8Array(await readFile(plateOut.file));
  let source = plateOut.file;
  // R15: the viewscreen's window. The plate's own pixels there are black (the key colour never shows), and window.webp is the layer's alpha.
  let window: { rel: string; box: Rect } | undefined;
  let blackWindow: ((img: Rgba) => Rgba) | undefined;
  if (station === 'viewscreen') {
    const original = deps.original!;
    const found = windowMask(original, recipe.window!.at);
    blackWindow = img => {
      const out: Rgba = { width: img.width, height: img.height, data: new Uint8Array(img.data) };
      for (let i = 0; i < found.mask.length; i++) if (found.mask[i]) out.data.set([0, 0, 0, 255], i * 4);
      return out;
    };
    const plateImg = decodePng(pngBytes);
    const s = plateImg.width / original.width;
    for (let y = 0; y < plateImg.height; y++) {
      for (let x = 0; x < plateImg.width; x++) {
        if (found.mask[Math.floor(y / s) * original.width + Math.floor(x / s)]) plateImg.data.set([0, 0, 0, 255], (y * plateImg.width + x) * 4);
      }
    }
    // (beside the run's plate, which stays as it was)
    source = join(run.dir, 'plate.published.png');
    pngBytes = encodePng(plateImg);
    await writeFile(source, pngBytes);
    // the layer covers the window's box grown by the pixels the alpha grows
    const [bx, by, bw, bh] = found.bbox;
    const x0 = Math.max(0, bx - WINDOW_GROW);
    const y0 = Math.max(0, by - WINDOW_GROW);
    const box: Rect = [x0, y0, Math.min(original.width, bx + bw + WINDOW_GROW) - x0, Math.min(original.height, by + bh + WINDOW_GROW) - y0];
    const alpha = windowAlpha(found.mask, original.width, original.height, WINDOW_SCALE, WINDOW_GROW);
    const layer = join(run.dir, 'window.png');
    await writeFile(layer, encodePng(crop(alpha, [box[0] * WINDOW_SCALE, box[1] * WINDOW_SCALE, box[2] * WINDOW_SCALE, box[3] * WINDOW_SCALE])));
    await (deps.encode ?? ((png, out) => toWebp(png, out, { quality: QUALITY, alpha: true })))(layer, windowTmp);
    window = { rel: `${rel}/window.webp`, box };
  }
  const refuse = async (why: string): Promise<never> => {
    await rm(tmp, { force: true });
    await rm(windowTmp, { force: true });
    throw new Error(`${station}: ${why}`);
  };
  // (a published window is black, so the original it is measured against has a black window too: the edge the key colour makes
  // would otherwise be measured against another)
  const enc = await encodeChecked(station, source, tmp, decodePng(pngBytes), deps, deps.align
    ? back => alignCheck(blackWindow ? blackWindow(deps.align!.original) : deps.align!.original, back, deps.align!.points, { ...ALIGN_DEFAULTS, maxShift: deps.align!.maxShift ?? ALIGN_DEFAULTS.maxShift })
    : null);
  if (!enc.ok) return refuse(`${enc.why}, even lossless; nothing was published`);
  const { drift } = enc;
  const half = join(gameDir, rel, HALF_PLATE);
  const size = decodePng(pngBytes);
  await halfEncoder(deps, halfSize(size.width, size.height))(source, `${half}.tmp`);
  await rename(tmp, webp);
  await rename(`${half}.tmp`, half);
  if (window) await rename(windowTmp, join(gameDir, rel, 'window.webp'));
  const plate = { png: sha(pngBytes), webp: sha(new Uint8Array(await readFile(webp))), meanAbsDiff: drift };
  await writeFile(join(run.dir, 'published.json'), `${JSON.stringify({ station, plate, quality: QUALITY, ...(window ? { window: window.box } : {}) }, null, 2)}\n`);
  const path = join(gameDir, 'presentation.yaml');
  const doc = parseDocument(await readFile(path, 'utf8').catch(() => ''));
  const old = (doc.getIn(['art', 'ship', station]) as { toJSON?: () => Record<string, unknown> } | undefined)?.toJSON?.() ?? {};
  const areas: Record<string, Rect> = {};
  for (const [name, r] of Object.entries(recipe.areas)) areas[name] = [...r] as Rect;
  // (the window layer's box is an area too: the engine maps the render target onto it)
  if (window) areas.window = window.box;
  doc.setIn(['art', 'ship', station], { ...old, plate: `${rel}/plate.webp`, ...(window ? { window: window.rel } : {}), areas });
  await writeFile(path, String(doc));
  return { files: [`${rel}/plate.webp`, `${rel}/${HALF_PLATE}`], plate };
}

/**
 * The viewscreen's frames (R7): each sprite's first frame at its own pixels, as art/ship/view/<stem>.webp, which the engine finds by that path
 * in the asset index (a hail's caller, or a view with no sheet). `frames` are PNGs the CLI decoded from the game's .spr with viewscr.rm's
 * palette (viewFrame). A sprite's `sheets` (viewStrips: the animation the viewscreen starts and those it jumps into) go beside it as atlas
 * pages, art/ship/view/<stem>.<anim>.<n>.webp (no side over 4096), each animation recorded as art.ship.viewscreen.views[<stem>][<anim>] with
 * its pages, where each cell lies in them, and the sprite's own delays. The views are set whole: a stem published with no sheets has none, and
 * an earlier publish's sheet files for a stem are removed. Sheets need the viewscreen's plate published first (its art.ship.viewscreen entry).
 */
export async function publishShipViews(
  gameDir: string,
  frames: { stem: string; png: string; sheets?: Map<number, ViewStrip> }[],
  deps: { encode?: (png: string, out: string) => Promise<void> } = {},
): Promise<string[]> {
  const out: string[] = [];
  const encode = deps.encode ?? ((png: string, to: string) => toWebp(png, to, { quality: 95, alpha: true }));
  await mkdir(join(gameDir, 'art', 'ship', 'view'), { recursive: true });
  const views: Record<string, Record<string, unknown>> = {};
  const round4 = (v: number): number => Math.round(v * 10000) / 10000;
  const work = await mkdtemp(join(tmpdir(), 'view-sheet-'));
  try {
    for (const f of frames) {
      if (!/^[a-z0-9_]+$/.test(f.stem)) throw new Error(`"${f.stem}" isn't a sprite stem`);
      const rel = `art/ship/view/${f.stem}.webp`;
      await encode(f.png, join(gameDir, rel));
      out.push(rel);
      // (an earlier publish's sheets for the stem: a strip, or pages of another count)
      for (const old of await readdir(join(gameDir, 'art', 'ship', 'view'))) if (new RegExp(`^${f.stem}\\.[0-9]+(\\.[0-9]+)?\\.webp$`).test(old)) await rm(join(gameDir, 'art', 'ship', 'view', old));
      for (const [index, a] of f.sheets ?? []) {
        const images: string[] = [];
        for (const [n, page] of a.pages.entries()) {
          const png = join(work, 'page.png');
          await writeFile(png, encodePng(page));
          const image = `art/ship/view/${f.stem}.${index}.${n}.webp`;
          await encode(png, join(gameDir, image));
          images.push(image);
        }
        out.push(...images);
        (views[f.stem] ??= {})[String(index)] = {
          images, pages: a.atlas.pages, cells: a.atlas.cells, frames: a.frames, scale: 1, cell: a.cell,
          anchor: [round4(a.anchor[0]), round4(a.anchor[1])], delays: a.delays, loop: a.loop, ...(a.next !== undefined ? { next: a.next } : {}),
        };
      }
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  const path = join(gameDir, 'presentation.yaml');
  const doc = parseDocument(await readFile(path, 'utf8').catch(() => ''));
  if (!doc.hasIn(['art', 'ship', 'viewscreen'])) {
    if (Object.keys(views).length > 0) throw new Error('the views\' sheets go in art.ship.viewscreen: publish the viewscreen\'s plate first');
    return out;
  }
  if (Object.keys(views).length > 0) doc.setIn(['art', 'ship', 'viewscreen', 'views'], views);
  else doc.deleteIn(['art', 'ship', 'viewscreen', 'views']);
  await writeFile(path, String(doc));
  return out;
}

/**
 * Writes plate.half.webp beside every published plate (rooms and ship stations) that has none, or whose plate is newer: for a game
 * published before `art publish` wrote them. Resized from the published WebP, so it is a second lossy pass; a fresh `art publish`
 * writes it from the run's PNG. Returns the files written.
 */
export async function halfPublishedPlates(gameDir: string, deps: { encode?: (webp: string, out: string, size: [number, number]) => Promise<void> } = {}): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name === 'plate.webp') found.push(path);
    }
  };
  await walk(join(gameDir, 'art', 'rooms'));
  await walk(join(gameDir, 'art', 'ship'));
  const written: string[] = [];
  for (const plate of found.sort()) {
    const half = join(dirname(plate), HALF_PLATE);
    if (existsSync(half) && statSync(half).mtimeMs >= statSync(plate).mtimeMs) continue;
    const size = webpSize(new Uint8Array(await readFile(plate)));
    if (!size) continue;
    const tmp = `${half}.tmp`;
    await (deps.encode ?? ((webp, out, to) => toWebp(webp, out, { quality: QUALITY, resize: to })))(plate, tmp, halfSize(size.width, size.height));
    await rename(tmp, half);
    written.push(relative(gameDir, half));
  }
  return written;
}
