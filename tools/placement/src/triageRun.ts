// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { WalkFloor } from '../../../engine/src/sim/walkFloor';
import { decodePng } from '../../art/src/image';
import { animEntries, maskRect } from '../../art/src/masks';
import type { Finding } from './compare';
import type { ScummObject } from './scummvm';
import { BUCKETS, triage, type Bucket, type Pixels, type Triage } from './triage';

export interface TriageRow extends Finding {
  world: string;
  sprite: string;
  anim: number;
  rect: [number, number, number, number];
  frames: number;
  bucket: Bucket;
  why: string;
}

interface Dirs {
  repo: string;
  rawDir: string;
  imagesDir: string;
}

interface SpriteJson {
  anims?: number[];
  entries: { type: string; width?: number; height?: number; png?: string; x?: number; y?: number }[];
}

/** The floor's scale (out of 256) at a pixel of the screen, as `art masks` reads it. 256 without a floor. */
function floorScaleAt(repo: string, screen: string, x: number, y: number): number {
  const [world, slug] = screen.split('.');
  const file = join(repo, 'games', 'unity', 'screens', world!, `${slug}.yaml`);
  if (!existsSync(file)) return 256;
  const yaml = parse(readFileSync(file, 'utf8')) as { regions?: Record<string, boolean>; pixelMetric?: { floor: { region: string; points: { x: number; y: number; scale: number }[] }[] } };
  const open = yaml.pixelMetric?.floor.filter(poly => yaml.regions?.[poly.region] === true) ?? [];
  return open.length === 0 ? 256 : new WalkFloor(open.map(poly => poly.points)).scaleAt({ x, y });
}

/** The frames an animation plays up to its first pause or exit, as pixels. */
function playedFrames(json: SpriteJson, anim: number, imagesDir: string): { frames: Pixels[]; position?: { x: number; y: number } } {
  const entries = animEntries(json, anim);
  const end = entries.findIndex(e => e.type === 'pause' || e.type === 'exit');
  const played = end < 0 ? entries : entries.slice(0, end);
  const pos = entries.find(e => e.type === 'position');
  const frames = played.filter(e => e.type === 'sprite' && e.png).map(e => decodePng(new Uint8Array(readFileSync(join(imagesDir, e.png!)))));
  return { frames, position: pos ? { x: pos.x ?? 0, y: pos.y ?? 0 } : undefined };
}

/** Triage of every `no-art` / `later-no-art` finding of a `compare` report, against the dump it was made from. */
export function triageFindings(findings: Finding[], dump: Record<string, (ScummObject & { slug?: string })[]>, dirs: Dirs): TriageRow[] {
  const ids = parse(readFileSync(join(dirs.repo, 'games', 'unity', 'ids.yaml'), 'utf8')) as { screens: Record<string, string> };
  const stemOf = new Map(Object.entries(ids.screens).map(([stem, room]) => [room, stem]));
  const manifest = JSON.parse(readFileSync(join(dirs.imagesDir, 'images', 'manifest.json'), 'utf8')) as { backgrounds: { screen: string; png: string }[] };
  const names = (JSON.parse(readFileSync(join(dirs.rawDir, 'maps', 'sprite.json'), 'utf8')) as { _spriteFilenames: string[] })._spriteFilenames;
  const backgrounds = new Map<string, Pixels | null>();
  const background = (room: string): Pixels | null => {
    if (!backgrounds.has(room)) {
      const entry = manifest.backgrounds.find(b => b.screen === stemOf.get(room));
      backgrounds.set(room, entry ? decodePng(new Uint8Array(readFileSync(join(dirs.imagesDir, entry.png)))) : null);
    }
    return backgrounds.get(room) ?? null;
  };
  const rows: TriageRow[] = [];
  for (const f of findings) {
    if (f.kind !== 'no-art' && f.kind !== 'later-no-art') continue;
    const s = dump[f.room]?.find(o => o.slug === f.object);
    if (!s) continue;
    const raw = JSON.parse(readFileSync(join(dirs.rawDir, 'objects', `o_${s.id}.json`), 'utf8')) as { x: number; y: number; objwalktype?: number };
    const sprite = (names[s.sprite] ?? '').toLowerCase();
    const sj = join(dirs.imagesDir, 'images', 'sprites', `${sprite}.spr`, 'sprite.json');
    const anim = s.playing >= 0 ? s.playing : s.anim;
    let result: Triage;
    let rect: [number, number, number, number] = [0, 0, 0, 0];
    let frames = 0;
    // (ScummVM draws every object the screen lists whatever its curr_screen: openLocation/drawObjects)
    if (!existsSync(sj)) result = { bucket: 'invisible', why: 'no sprite file in the export' };
    else {
      const played = playedFrames(JSON.parse(readFileSync(sj, 'utf8')) as SpriteJson, anim, dirs.imagesDir);
      frames = played.frames.length;
      const first = played.frames[0];
      if (first) rect = maskRect(raw, played.position, first.width, first.height);
      const scale = raw.objwalktype === 1 && first ? floorScaleAt(dirs.repo, f.room, rect[0] + Math.trunc(rect[2] / 2), rect[1] + rect[3]) : 256;
      result = triage({ frames: played.frames, rect, background: background(f.room), scale });
    }
    rows.push({ ...f, world: f.room.split('.')[0]!, sprite, anim, rect, frames, ...result });
  }
  return rows;
}

/** Counts per world and bucket, split by kind. */
export function countRows(rows: TriageRow[]): Map<string, Record<Bucket, number>> {
  const out = new Map<string, Record<Bucket, number>>();
  for (const r of rows) {
    const c = out.get(r.world) ?? { 'in-plate': 0, 'static-missing': 0, animated: 0, invisible: 0 };
    c[r.bucket]++;
    out.set(r.world, c);
  }
  return new Map([...out].sort((a, b) => a[0].localeCompare(b[0])));
}

/** The markdown table of counts per world. */
export function countTable(rows: TriageRow[]): string {
  const counts = countRows(rows);
  const total: Record<Bucket, number> = { 'in-plate': 0, 'static-missing': 0, animated: 0, invisible: 0 };
  const lines = [`| World | ${BUCKETS.join(' | ')} | Total |`, `|---|${BUCKETS.map(() => '---').join('|')}|---|`];
  for (const [w, c] of counts) {
    for (const b of BUCKETS) total[b] += c[b];
    lines.push(`| ${w} | ${BUCKETS.map(b => c[b]).join(' | ')} | ${BUCKETS.reduce((n, b) => n + c[b], 0)} |`);
  }
  lines.push(`| **all** | ${BUCKETS.map(b => total[b]).join(' | ')} | ${BUCKETS.reduce((n, b) => n + total[b], 0)} |`);
  return lines.join('\n');
}

