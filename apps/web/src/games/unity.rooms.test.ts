// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NavMesh } from '../../../../engine/src/view/navmesh';
import type { Triangle } from '../../../../engine/src/view/room';

type Point = { x: number; z: number };
/** Plan 4's room file, as much of it as this needs: triangles are the lifter's, ear-clipped in pixels, as indices into points. */
interface Room { regions: { walkable: boolean; points: Point[]; triangles: [number, number, number][] }[]; markers: Record<string, Point> }

const base = fileURLToPath(new URL('../../../../games/unity/rooms/', import.meta.url));
const ready = !!process.env.RAW_DIR && existsSync(base);
const files = ready
  ? readdirSync(base).flatMap(w => readdirSync(join(base, w)).filter(f => f.endsWith('.json')).map(f => `${w}/${f}`)).sort()
  : [];
/** Rooms where an entrance's own slots are apart at the start, as in the original (each a ledger ruling, with why). */
const APART: Record<string, string> = {
  // (ScummVM: `start 2 17 0`, then Picard walks toward the far side: he stops at the edge of his own polygon, 46 pixels short of the other)
  'allanor/s11.json': "entrance_0's first slot is in a polygon apart from the other three, in the original too",
  // (ScummVM: `start 6 16 0` and a walk: Picard stays inside the 16-pixel polygon he is placed in)
  'unity/s10.json': "entrance_0's first slot is in a small polygon apart from the other three, in the original too",
  // (no script enters there; the entrance's four points are off the screen, e.g. (3585, -18175))
  'allanor/s0b.json': "entrance_3's points are junk, off the screen, and nothing enters by it",
};

describe.skipIf(!ready)('every away world\'s floors (needs RAW_DIR and npm run unity:build)', () => {
  it.each(files)('%s: the team can walk between the spots each entrance puts them on', file => {
    const room = JSON.parse(readFileSync(join(base, file), 'utf8')) as Room;
    // (the lifter's own triangles, never re-triangulated: the greybox floors are built from the same ones)
    const triangles: Triangle[] = room.regions
      .filter(r => r.walkable)
      .flatMap(r => r.triangles.map(([a, b, c]): Triangle => [r.points[a], r.points[b], r.points[c]]));
    // (a close-up has no floor)
    if (triangles.length === 0) return;
    const nav = NavMesh.build(triangles);
    const snap = (name: string) => nav.nearest(room.markers[name])?.point;
    const unreachable: string[] = [];
    const entrances = Object.keys(room.markers).filter(m => /^entrance_\d+$/.test(m)).sort();
    for (const e of entrances) {
      const from = snap(e);
      for (const slot of [`${e}.1`, `${e}.2`, `${e}.3`].filter(m => room.markers[m])) {
        const to = snap(slot);
        if (!from || !to || !nav.path(from, to).reachable) unreachable.push(`${e} -> ${slot}`);
      }
    }
    // (between entrances, only reported: a region a script opens later, such as behind the rubble, may join them)
    const apart = entrances.slice(1).filter(e => {
      const a = snap(entrances[0]);
      const b = snap(e);
      return !a || !b || !nav.path(a, b).reachable;
    });
    if (apart.length > 0) console.info(`${file}: from ${entrances[0]}, not reachable at the start: ${apart.join(', ')}`);
    if (APART[file]) return console.info(`${file}: ${APART[file]}`);
    expect(unreachable).toEqual([]);
  });
});
