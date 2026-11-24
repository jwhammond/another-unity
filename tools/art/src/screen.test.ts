// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Rgba } from './image';
import { loadScreenInputs } from './screen';

let tmp = '';
afterEach(() => rm(tmp, { recursive: true, force: true }));

function stripes(): Rgba {
  const data = new Uint8Array(640 * 480 * 4);
  for (let y = 0; y < 480; y++) for (let x = 0; x < 640; x++) data.set([((x >> 5) + (y >> 5)) % 2 ? 220 : 30, 90, 90, 255], (y * 640 + x) * 4);
  return { width: 640, height: 480, data };
}
async function game(hotspots: number): Promise<string> {
  tmp = await mkdtemp(join(tmpdir(), 'screen-'));
  await mkdir(join(tmp, 'rooms', 'w'), { recursive: true });
  await mkdir(join(tmp, 'screens', 'w'), { recursive: true });
  const spots = Array.from({ length: hotspots }, (_, i) => ({ object: `w.o${i}`, rect: [20 + i * 60, 30, 40 + i * 60, 60] }));
  await writeFile(join(tmp, 'rooms', 'w', 's01.json'), JSON.stringify({ hotspots: spots, background: null }));
  await writeFile(join(tmp, 'screens', 'w', 's01.yaml'), 'pixelMetric:\n  floor:\n    - region: r1\n      points:\n        - { x: 5, y: 5 }\n');
  return tmp;
}

describe('loadScreenInputs', () => {
  it('a screen with fewer than 8 points gets labelled edge points when the original is given; others do not', async () => {
    const close = await loadScreenInputs(await game(1), 'w.s01', stripes());
    const edges = close.points.filter(p => p.source.startsWith('edge '));
    expect(close.points.length - edges.length).toBe(5);
    expect(edges.length).toBeGreaterThan(0);
    expect(edges.length).toBeLessThanOrEqual(16);
    expect((await loadScreenInputs(await game(1), 'w.s01')).points).toHaveLength(5);
    const room = await loadScreenInputs(await game(2), 'w.s01', stripes());
    expect(room.points.some(p => p.source.startsWith('edge '))).toBe(false);
    expect(room.points).toHaveLength(9);
  });
  it('gives the mask its hotspot rects and floor polygons', async () => {
    const s = await loadScreenInputs(await game(2), 'w.s01');
    expect(s.geometry.rects).toHaveLength(2);
    expect(s.geometry.polygons).toEqual([[{ x: 5, y: 5 }]]);
  });
});
