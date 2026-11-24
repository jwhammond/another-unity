// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The bridge strip's Viewscreen button (sensor.mrg; BridgeScreen::draw, bridge.cpp:456-459), published as it is, the way the transporter's are
 * (transporter.ts): entry 3 is the button up and entry 1 the button down (drawn while the viewscreen is up), each decoded in colour over bridge.rm's
 * palette (the screen draws it; standard.pal's the upper half: astro.ts's screenPalette), index 13 clear, scaled up 4x nearest-neighbour and written
 * as lossless WebP to games/unity/art/sensor/<name>.webp, with presentation.yaml's art.sensor (the sprites by name, the scale, and the rectangle the
 * original draws each in). The strip's other buttons (the admin button and the sensor arrows) are transp.mrg's, which the bridge's plate has painted
 * already. Local and git-ignored, like the rest of art/.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { COLOUR_BLANK, screenPalette } from './astro';
import { encodePng, meanAbsDiff, type Rgba } from './image';
import { parseMrg } from './icon';
import { nearestResize } from './pixel';
import { readWebp, toWebp } from './webp';

/** sensor.mrg's entries the bridge draws (bridge.cpp:459: `_viewscreenUp ? 1 : 3`), by name. */
export const SENSOR_SPRITES: Record<number, string> = { 3: 'viewscreen', 1: 'viewscreenDown' };
/** kViewscreenButtonX, kViewscreenButtonY (bridge.cpp:56): where the original draws either, from the sprite's own corner. */
export const SENSOR_AT: [number, number] = [484, 426];

/** Each named entry in colour (index 13 clear) at `scale` times its size. */
export function sensorSprites(mrg: Uint8Array, screen: Uint8Array, standardPal: Uint8Array, scale = 4): { name: string; image: Rgba; width: number; height: number }[] {
  const entries = parseMrg(mrg);
  const pal = screenPalette(screen, standardPal);
  return Object.entries(SENSOR_SPRITES).map(([i, name]) => {
    const e = entries[Number(i)];
    if (!e) throw new Error(`sensor.mrg has no entry ${i} (${name})`);
    const img: Rgba = { width: e.width, height: e.height, data: new Uint8Array(e.width * e.height * 4) };
    for (let p = 0; p < e.width * e.height; p++) {
      const idx = e.pixels[p]!;
      if (idx === COLOUR_BLANK) continue;
      img.data.set([pal[idx * 3]!, pal[idx * 3 + 1]!, pal[idx * 3 + 2]!, 255], p * 4);
    }
    return { name, image: nearestResize(img, e.width * scale, e.height * scale), width: e.width, height: e.height };
  });
}

export interface SensorDeps {
  encode?: (png: string, out: string) => Promise<void>;
  decode?: (webp: string) => Promise<Rgba>;
}

/** Publishes the buttons; every WebP is read back and must be the scaled picture exactly, or nothing is renamed or recorded. */
export async function publishSensor(gameDir: string, mrg: Uint8Array, screen: Uint8Array, standardPal: Uint8Array, deps: SensorDeps = {}, scale = 4): Promise<string[]> {
  const encode = deps.encode ?? ((png, out) => toWebp(png, out, { quality: 100, lossless: true, alpha: true }));
  const decode = deps.decode ?? readWebp;
  const sprites = sensorSprites(mrg, screen, standardPal, scale);
  const work = await mkdtemp(join(tmpdir(), 'sensor-'));
  const staged: { tmp: string; dest: string; name: string; rel: string }[] = [];
  try {
    await mkdir(join(gameDir, 'art', 'sensor'), { recursive: true });
    for (const s of sprites) {
      const rel = `art/sensor/${s.name}.webp`;
      const dest = join(gameDir, rel);
      const png = join(work, `${s.name}.png`);
      await writeFile(png, encodePng(s.image));
      const tmp = `${dest}.tmp`;
      await encode(png, tmp);
      staged.push({ tmp, dest, name: s.name, rel });
      const drift = meanAbsDiff(s.image, await decode(tmp));
      if (drift !== 0) throw new Error(`${rel}: the WebP differs from the sprite's pixels (mean ${drift.toFixed(2)}/255); nothing was published`);
    }
  } catch (e) {
    for (const s of staged) await rm(s.tmp, { force: true });
    throw e;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  for (const s of staged) await rename(s.tmp, s.dest);
  const path = join(gameDir, 'presentation.yaml');
  const doc = parseDocument(existsSync(path) ? await readFile(path, 'utf8') : '');
  doc.setIn(['art', 'sensor'], {
    scale,
    sprites: Object.fromEntries(sprites.map((s, i) => [s.name, { image: staged[i]!.rel, rect: [...SENSOR_AT, s.width, s.height] }])),
  });
  await writeFile(path, String(doc));
  return staged.map(s => s.rel);
}
