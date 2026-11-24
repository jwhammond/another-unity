// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { isMap, parseDocument } from 'yaml';
import { z } from 'zod';
import type { Episode, Jellyfin } from './jellyfin';
import { areaResize, decodePng, encodePng, type Rgba } from './image';

const SET = 'lab|corridor|jefferies-tube|engineering|sickbay|transporter|science-station|cargo|bridge|observation-lounge|transporter-room|astrogation';
const MATERIAL = 'wall-panel|lcars-display|console|floor|ceiling-light|conduit|grating|door|carpet|wood-rail|ceiling-panel|pad';
/** The fixed tag vocabulary (plan R1). */
const TAG = new RegExp(`^(crew:[a-z0-9_]+|view:(face|body|back|profile-left|profile-right)|set:(${SET})|material:(${MATERIAL})|light:(key|ambient|alarm))$`);

export const refSchema = z
  .object({
    item: z.string().regex(/^[0-9a-f]{32}$/),
    season: z.number().int().min(1),
    episode: z.number().int().min(1),
    ms: z.number().int().min(0),
    crop: z.tuple([z.number().int().min(0), z.number().int().min(0), z.number().int().min(1), z.number().int().min(1)]),
    tags: z.array(z.string().regex(TAG)).min(1),
    sha256: z.union([z.literal('pending'), z.string().regex(/^[0-9a-f]{64}$/)]),
  })
  .strict();
export type ShowRef = z.infer<typeof refSchema>;

export const manifestSchema = z
  .object({
    series: z.string().regex(/^[0-9a-f]{32}$/),
    refs: z.record(z.string().regex(/^[a-z0-9][a-z0-9._-]*$/), refSchema),
  })
  .strict();
export type Manifest = z.infer<typeof manifestSchema>;

export function parseManifest(text: string, parse: (t: string) => unknown): Manifest {
  return manifestSchema.parse(parse(text));
}

export interface FrameGrabber {
  /** Reads the video from `input` in one pass and writes `<ms>.png` (full frames) into `outDir`; returns the files in `ms` order. */
  grab(input: ReadableStream<Uint8Array>, ms: number[], outDir: string): Promise<string[]>;
}

type SpawnFn = (cmd: string, args: string[], opts: { stdio: ['pipe', 'ignore', 'pipe']; env: NodeJS.ProcessEnv }) => ChildProcess;

/** Frames closer than this share one decoded frame. */
const SAME_FRAME_MS = 50;

/** The argv for one pass: the video on stdin (no URL, no key), one `select` over every wanted time. */
export function ffmpegArgs(targets: number[], pattern: string): string[] {
  const sel = targets.map(t => `gte(t,${(t / 1000).toFixed(3)})*(isnan(prev_selected_t)+lt(prev_selected_t,${(t / 1000).toFixed(3)}))`).join('+');
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', 'pipe:0', '-an', '-sn', '-dn', '-vf', `select='${sel}'`, '-fps_mode', 'vfr', '-frames:v', String(targets.length), '-start_number', '0', pattern];
}

export function makeGrabber(spawnFn: SpawnFn = nodeSpawn as unknown as SpawnFn): FrameGrabber {
  return {
    async grab(input, ms, outDir) {
      mkdirSync(outDir, { recursive: true });
      const sorted = [...new Set(ms)].sort((a, b) => a - b);
      const targets: number[] = [];
      for (const t of sorted) if (targets.length === 0 || t - targets[targets.length - 1]! >= SAME_FRAME_MS) targets.push(t);
      const tmp = mkdtempSync(join(outDir, '.grab-'));
      try {
        // the child gets only PATH and HOME: nothing of this process's environment
        const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME };
        const p = spawnFn('ffmpeg', ffmpegArgs(targets, join(tmp, '%06d.png')), { stdio: ['pipe', 'ignore', 'pipe'], env });
        let err = '';
        p.stderr?.on('data', d => (err += d));
        const src = Readable.fromWeb(input as never);
        const done = new Promise<void>((resolve, reject) => {
          p.on('error', reject);
          p.on('close', code => {
            // ffmpeg ends early once -frames:v is met: stop reading the rest of the file
            src.destroy();
            if (code === 0) resolve();
            else reject(new Error(`ffmpeg exited ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`));
          });
        });
        p.stdin!.on('error', () => {}); // EPIPE when ffmpeg is done reading
        src.on('error', () => p.stdin!.destroy());
        src.pipe(p.stdin!);
        await done;
        const made = readdirSync(tmp).filter(f => f.endsWith('.png')).sort();
        if (made.length !== targets.length) throw new Error(`ffmpeg wrote ${made.length} of ${targets.length} frames (a time past the end of the file?)`);
        targets.forEach((t, i) => renameSync(join(tmp, made[i]!), join(outDir, `${t}.png`)));
        const files = ms.map(t => {
          const near = targets.filter(x => Math.abs(x - t) < SAME_FRAME_MS).sort((a, b) => Math.abs(a - t) - Math.abs(b - t))[0] ?? t;
          const f = join(outDir, `${t}.png`);
          if (near !== t) copyFileSync(join(outDir, `${near}.png`), f);
          return f;
        });
        return files;
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
  };
}

export const ffmpegGrabber: FrameGrabber = makeGrabber();

const COLS = 6;
const ROWS = 5;
const THUMB_W = 240;

function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Contact sheets of one episode, a frame every `everyS` seconds: 6×5 thumbnails of 240 px, written to `outDir` as
 * `s<season>e<episode>-<n>.png`, each with a sibling .html captioning every cell by timestamp. The full frames land
 * in `<outDir>/../frames/<item>/<ms>.png`. Returns the sheet PNG paths.
 */
export async function scan(j: Jellyfin, g: FrameGrabber, ep: Episode, everyS: number, outDir: string): Promise<string[]> {
  const times: number[] = [];
  for (let t = everyS * 1000; t < ep.ms; t += everyS * 1000) times.push(t);
  if (times.length === 0) throw new Error(`episode runs ${clock(ep.ms)}: nothing to scan every ${everyS} s`);
  const framesDir = join(outDir, '..', 'frames', ep.item);
  const files = await g.grab(await j.stream(ep.item), times, framesDir);
  mkdirSync(outDir, { recursive: true });
  const sheets: string[] = [];
  const per = COLS * ROWS;
  for (let first = 0, n = 1; first < times.length; first += per, n++) {
    const group = times.slice(first, first + per);
    let h = 0;
    const thumbs = group.map((_, i) => {
      const img = decodePng(new Uint8Array(readFileSync(files[first + i]!)));
      const t = areaResize(img, THUMB_W, Math.round((img.height * THUMB_W) / img.width));
      h = Math.max(h, t.height);
      return t;
    });
    const sheet: Rgba = { width: COLS * THUMB_W, height: ROWS * h, data: new Uint8Array(COLS * THUMB_W * ROWS * h * 4) };
    for (let i = 3; i < sheet.data.length; i += 4) sheet.data[i] = 255;
    thumbs.forEach((t, i) => {
      const ox = (i % COLS) * THUMB_W;
      const oy = Math.floor(i / COLS) * h;
      for (let y = 0; y < t.height; y++) sheet.data.set(t.data.subarray(y * t.width * 4, (y + 1) * t.width * 4), ((oy + y) * sheet.width + ox) * 4);
    });
    const name = `s${ep.season}e${ep.episode}-${n}`;
    const png = join(outDir, `${name}.png`);
    writeFileSync(png, encodePng(sheet));
    const cells = group
      .map((t, i) => `<span style="left:${(i % COLS) * THUMB_W}px;top:${Math.floor(i / COLS) * h}px">${clock(t)} (${t} ms)</span>`)
      .join('');
    writeFileSync(
      join(outDir, `${name}.html`),
      `<!doctype html><meta charset="utf-8"><title>${name}</title><style>body{margin:0;background:#111}div{position:relative;width:${sheet.width}px}span{position:absolute;font:11px monospace;color:#fff;background:#000a;padding:1px 3px}</style><div><img src="${name}.png">${cells}</div>`,
    );
    sheets.push(png);
  }
  return sheets;
}

export interface GrabResult {
  id: string;
  file: string;
  sha256: string;
  matched: boolean;
}

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

function cropPng(frame: Uint8Array, [x, y, w, h]: ShowRef['crop']): Uint8Array {
  const img = decodePng(frame);
  if (x + w > img.width || y + h > img.height) throw new Error(`crop ${x},${y},${w},${h} lies outside the ${img.width}x${img.height} frame`);
  const out = new Uint8Array(w * h * 4);
  for (let r = 0; r < h; r++) out.set(img.data.subarray(((y + r) * img.width + x) * 4, ((y + r) * img.width + x + w) * 4), r * w * 4);
  return encodePng({ width: w, height: h, data: out });
}

/**
 * The crop file for a ref id (for recipes); throws if missing, suggesting `art refs grab`. With `manifests` (every
 * manifest under art/refs), the id must be in exactly one of them: crops share one `crops/<id>.png` namespace.
 */
export function refFile(cacheRefs: string, id: string, manifests?: Manifest[]): string {
  if (manifests) {
    const n = manifests.filter(m => id in m.refs).length;
    if (n === 0) throw new Error(`no ref "${id}" in any manifest`);
    if (n > 1) throw new Error(`ref id "${id}" is in ${n} manifests: ids must be unique across art/refs/*.yaml`);
  }
  const f = join(cacheRefs, 'crops', `${id}.png`);
  if (!existsSync(f)) throw new Error(`reference crop ${id} is not in the cache (${f}): run \`npm run art -- refs grab --only ${id}\``);
  return f;
}

/**
 * Grabs and crops every manifest ref (one pass per episode item), writes `crops/<id>.png`, and fills (`record`) or
 * checks sha256. A crop whose hash differs from the manifest is re-grabbed once; if it still differs, `matched` is false.
 */
export async function grabRefs(
  j: Jellyfin,
  g: FrameGrabber,
  manifest: Manifest,
  cacheRefs: string,
  opts: { only?: string[]; record?: boolean } = {},
): Promise<GrabResult[]> {
  const ids = Object.keys(manifest.refs).filter(id => !opts.only || opts.only.includes(id));
  for (const o of opts.only ?? []) if (!manifest.refs[o]) throw new Error(`no ref "${o}" in the manifest`);
  const byItem = new Map<string, string[]>();
  for (const id of ids) byItem.set(manifest.refs[id]!.item, [...(byItem.get(manifest.refs[id]!.item) ?? []), id]);
  mkdirSync(join(cacheRefs, 'crops'), { recursive: true });
  const results: GrabResult[] = [];
  for (const [item, group] of byItem) {
    const framesDir = join(cacheRefs, 'frames', item);
    const frameFile = (id: string): string => join(framesDir, `${manifest.refs[id]!.ms}.png`);
    const ensure = async (want: string[], force: boolean): Promise<void> => {
      const need = want.filter(id => force || !existsSync(frameFile(id)));
      if (need.length === 0) return;
      await g.grab(await j.stream(item), need.map(id => manifest.refs[id]!.ms), framesDir);
    };
    await ensure(group, false);
    const redo: string[] = [];
    const make = (id: string): GrabResult => {
      const ref = manifest.refs[id]!;
      const png = cropPng(new Uint8Array(readFileSync(frameFile(id))), ref.crop);
      const file = join(cacheRefs, 'crops', `${id}.png`);
      writeFileSync(file, png);
      const h = sha(png);
      return { id, file, sha256: h, matched: ref.sha256 === 'pending' || opts.record === true || ref.sha256 === h };
    };
    const first = group.map(make);
    for (const r of first) if (!r.matched) redo.push(r.id);
    if (redo.length) {
      await ensure(redo, true);
      for (const id of redo) first[group.indexOf(id)] = make(id);
    }
    results.push(...first);
  }
  return results;
}

/** The manifest text with each result's sha256 filled in (one flow-style line per ref, as written by hand). */
export function recordHashes(manifestText: string, results: GrabResult[]): string {
  const doc = parseDocument(manifestText);
  for (const r of results) doc.setIn(['refs', r.id, 'sha256'], r.sha256);
  const refs = doc.get('refs');
  if (isMap(refs)) for (const pair of refs.items) if (isMap(pair.value)) pair.value.flow = true;
  return doc.toString({ lineWidth: 0, flowCollectionPadding: true });
}
