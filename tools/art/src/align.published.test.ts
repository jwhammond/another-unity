// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { alignCheck, ALIGN_DEFAULTS } from './align';
import { artCache } from './cache';
import { decodePng, type Rgba } from './image';
import { readWebp } from './webp';
import { PLATE_STEMS, parseRecipe, plateStation, type PlateStation, type RepaintRecipe } from './recipe';
import { loadScreenInputs } from './screen';
import { readShipLift } from './run';
import { shipInputs } from './shipscreen';
import { shipOriginal } from './shiporig';
import type { CheckPoint } from './points';

/**
 * The alignment check against the published plates themselves (the ones in games/unity/art, which are not in the repository):
 * every one still passes, a copy moved 3 px is still refused, one moved 1 px still passes. Skipped when the art or the original
 * exports are not on this machine (IMAGES_DIR, ART_CACHE: see docs/art-pipeline.md), so CI skips it.
 */
const REPO = join(__dirname, '..', '..', '..');
const GAME = join(REPO, 'games', 'unity');
const images = process.env.IMAGES_DIR;
const cache = artCache();
const roomsDir = join(GAME, 'art', 'rooms');
const published: string[] = existsSync(roomsDir)
  ? readdirSync(roomsDir).flatMap(w => readdirSync(join(roomsDir, w)).filter(s => existsSync(join(roomsDir, w, s, 'plate.webp'))).map(s => `${w}.${s}`))
  : [];
/** Whether the room's recipe turns the check off (`align: { skip, reason }`, allowed only for an upscale-only plate with nothing measurable). */
function checkSkipped(id: string): boolean {
  const file = join(REPO, 'art', 'recipes', `${id}.yaml`);
  if (!existsSync(file)) return false;
  const recipe = parseRecipe(readFileSync(file, 'utf8'), `${id}.yaml`);
  return recipe.kind === 'repaint' && recipe.post.some(p => 'align' in p && p.align.skip === true);
}
const unmeasurable = published.filter(checkSkipped);
const rooms = published.filter(id => !unmeasurable.includes(id));
if (unmeasurable.length > 0) console.info(`[align] not measured, as their recipes say (align skip): ${unmeasurable.join(', ')}`);
// (the viewscreen's plate is measured against an original with its window blacked, as publish does: not rebuilt here)
const stations = (['bridge', 'astrogation', 'computer', 'transporter'] as PlateStation[]).filter(s => existsSync(join(GAME, 'art', 'ship', s, 'plate.webp')) && existsSync(shipOriginal(cache, PLATE_STEMS[s])));
const ready = images !== undefined && existsSync(images) && rooms.length > 0;

interface Subject { id: string; original: Rgba; plate: Rgba; points: CheckPoint[]; maxShift: number }

/** The plate moved by whole pixels of the original (the plate is a whole multiple of its size), the border repeated. */
function moved(plate: Rgba, original: Rgba, dx: number, dy: number): Rgba {
  const k = plate.width / original.width;
  const sx = dx * k;
  const sy = dy * k;
  const out = new Uint8Array(plate.data.length);
  for (let y = 0; y < plate.height; y++) {
    const yy = Math.min(plate.height - 1, Math.max(0, y - sy));
    for (let x = 0; x < plate.width; x++) {
      const xx = Math.min(plate.width - 1, Math.max(0, x - sx));
      out.set(plate.data.subarray((yy * plate.width + xx) * 4, (yy * plate.width + xx) * 4 + 4), (y * plate.width + x) * 4);
    }
  }
  return { width: plate.width, height: plate.height, data: out };
}

async function roomSubject(id: string): Promise<Subject> {
  const first = await loadScreenInputs(GAME, id);
  const original = decodePng(new Uint8Array(readFileSync(join(images!, first.backgroundPng!))));
  const [world, slug] = id.split('.');
  const plate = await readWebp(join(roomsDir, world!, slug!, 'plate.webp'));
  return { id, original, plate, points: (await loadScreenInputs(GAME, id, original)).points, maxShift: 2 };
}

async function shipSubject(station: PlateStation): Promise<Subject> {
  const recipes = join(REPO, 'art', 'recipes');
  const file = `plate.${station}.yaml`;
  const recipe = parseRecipe(readFileSync(join(recipes, file), 'utf8'), file) as RepaintRecipe;
  expect(plateStation(recipe)).toBe(station);
  const original = decodePng(new Uint8Array(readFileSync(shipOriginal(cache, PLATE_STEMS[station]))));
  const plate = await readWebp(join(GAME, 'art', 'ship', station, 'plate.webp'));
  const align = recipe.post.find(p => 'align' in p);
  return { id: `plate.${station}`, original, plate, points: shipInputs(station, recipe, await readShipLift(GAME), original).points, maxShift: align && 'align' in align ? align.align.maxShift : 2 };
}

const SHIFTS_OUT: [number, number][] = [[3, 0], [0, -3], [-3, 3]];
const SHIFTS_IN: [number, number][] = [[1, 0], [0, 1], [-1, 0], [0, -1]];

describe.skipIf(!ready)('the alignment check on the published plates', () => {
  const subjects = async (): Promise<Subject[]> => [...(await Promise.all(rooms.map(roomSubject))), ...(await Promise.all(stations.map(shipSubject)))];
  const opts = (s: Subject) => ({ ...ALIGN_DEFAULTS, maxShift: s.maxShift });

  it('passes every one as published', { timeout: 600_000 }, async () => {
    const bad: string[] = [];
    for (const s of await subjects()) {
      const r = alignCheck(s.original, s.plate, s.points, opts(s));
      if (!r.ok) bad.push(`${s.id}: ${r.why}`);
    }
    expect(bad).toEqual([]);
  });

  it('refuses a copy moved 3 px, along either axis and diagonally, on every plate', { timeout: 900_000 }, async () => {
    const passed: string[] = [];
    for (const s of await subjects()) {
      for (const [dx, dy] of SHIFTS_OUT) if (alignCheck(s.original, moved(s.plate, s.original, dx, dy), s.points, opts(s)).ok) passed.push(`${s.id} moved (${dx}, ${dy})`);
    }
    expect(passed).toEqual([]);
  });

  it('passes a copy moved 1 px along either axis, on every plate that is itself within 0.9 px (so 1 px more stays within the limit, measurement noise included)', { timeout: 900_000 }, async () => {
    const refused: string[] = [];
    let tried = 0;
    const names: string[] = [];
    for (const s of await subjects()) {
      const base = alignCheck(s.original, s.plate, s.points, opts(s));
      const w = base.worst;
      const drift = Math.max(base.axes?.x.median ?? 0, base.axes?.y.median ?? 0);
      if (!base.ok || !w || Math.hypot(w.dx, w.dy) > 0.9 || drift > 0.15) continue;
      tried++;
      names.push(s.id);
      for (const [dx, dy] of SHIFTS_IN) {
        const r = alignCheck(s.original, moved(s.plate, s.original, dx, dy), s.points, opts(s));
        if (!r.ok) refused.push(`${s.id} moved (${dx}, ${dy}): ${r.why}`);
      }
    }
    console.log(`[align] ${tried} plates within 0.9 px (${names.join(' ')}), each moved 1 px four ways`);
    expect(tried).toBeGreaterThanOrEqual(5);
    expect(refused).toEqual([]);
  });
});
