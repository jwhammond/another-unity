// SPDX-License-Identifier: GPL-3.0-or-later
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { MaskGeometry } from './maskdenoise';
import type { Rgba } from './image';
import { checkPoints, CLOSE_UP_POINTS, edgePoints, EDGE_POINTS, type CheckPoint, type RoomHotspots } from './points';

export interface ScreenInputs {
  points: CheckPoint[];
  /** The lifted room's background, relative to the images export (e.g. images/backgrounds/s_0401.png). */
  backgroundPng: string | null;
  /** The hotspot rects and walk polygons, for the denoise mask. */
  geometry: MaskGeometry;
}

/** The lifted room and screen of a screen id such as lab.s01: games/unity/rooms/lab/s01.json and screens/lab/s01.yaml. */
export async function loadScreenInputs(gameDir: string, screen: string, original?: Rgba): Promise<ScreenInputs> {
  const m = /^([a-z0-9]+)\.(s[0-9a-f]{2})$/.exec(screen);
  if (!m) throw new Error(`"${screen}" isn't a screen id like lab.s01`);
  const [, world, slug] = m;
  const read = async (path: string): Promise<string> => {
    try {
      return await readFile(path, 'utf8');
    } catch {
      throw new Error(`no lifted data at ${path}: run npm run lift (docs/lift.md)`);
    }
  };
  const room = JSON.parse(await read(join(gameDir, 'rooms', world!, `${slug}.json`))) as RoomHotspots & { background: { png: string } | null };
  if (room.hotspots.some(h => !h.rect)) throw new Error(`${screen}'s room file has hotspots without a rect: run npm run lift again`);
  const def = parseYaml(await read(join(gameDir, 'screens', world!, `${slug}.yaml`))) as Parameters<typeof checkPoints>[1];
  const pm = (def as { pixelMetric?: { floor: { points: { x: number; y: number }[] }[] } }).pixelMetric;
  const geometry: MaskGeometry = {
    // a hotspot with no extent (a walk target) still marks a spot
    rects: room.hotspots.map(h => h.rect),
    polygons: (pm?.floor ?? []).map(r => r.points.map(p => ({ x: p.x, y: p.y }))),
  };
  const points = checkPoints(room, def);
  // a close-up has too few hotspot corners to show a drift: add the original's strongest-edge windows (R5), labelled `edge`
  if (original && points.length < CLOSE_UP_POINTS) for (const p of edgePoints(original, EDGE_POINTS)) points.push({ x: p.x, y: p.y, source: `${p.label} ${p.x},${p.y}` });
  return { points, backgroundPng: room.background?.png ?? null, geometry };
}
