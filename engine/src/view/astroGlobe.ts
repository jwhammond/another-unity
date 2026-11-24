// SPDX-License-Identifier: GPL-3.0-or-later
import { AstroRandom } from '../sim/shipSystems';

// The planet's globe on the system view, ported from engines/unity/astrogation.cpp (makeGlobeTexture, makeGlobeColours, drawGlobe; read-only reference).
// The original does not reproduce the fractal surfaces of the game's own planets either: layers of smoothed noise that wrap around the planet, in
// a ramp of colours for its class, the texture turning slowly on a sphere.

export const GLOBE_SIZE = 120;
const TEXTURE_WIDTH = 256, TEXTURE_HEIGHT = 168;
/** The globe's colours, from 16 to 127 of the palette: 112 of them (kGlobeFirstColour, kGlobeColours). */
export const GLOBE_COLOURS = 112;

/** Dark, middle and light for each class of planet (kGlobeRamps). */
export const GLOBE_RAMPS: readonly (readonly (readonly [number, number, number])[])[] = [
  [[60, 30, 10], [200, 130, 60], [250, 220, 160]],
  [[50, 40, 20], [190, 160, 110], [240, 230, 200]],
  [[80, 30, 0], [220, 140, 60], [255, 230, 150]],
  [[40, 0, 0], [200, 40, 0], [255, 200, 40]],
  [[50, 40, 40], [140, 110, 90], [220, 200, 180]],
  [[40, 50, 60], [130, 150, 160], [230, 240, 250]],
  [[70, 20, 0], [200, 90, 20], [255, 210, 120]],
  [[30, 0, 0], [160, 50, 10], [250, 150, 50]],
  [[40, 40, 40], [120, 115, 110], [210, 205, 200]],
  [[60, 40, 20], [180, 140, 90], [240, 220, 180]],
  [[30, 40, 70], [110, 130, 90], [220, 210, 170]],
  [[60, 80, 110], [170, 200, 230], [250, 250, 255]],
  [[0, 30, 90], [40, 120, 50], [230, 220, 180]],
  [[0, 20, 80], [20, 90, 180], [200, 230, 255]],
  [[80, 20, 10], [230, 120, 40], [255, 240, 170]],
  [[20, 40, 80], [120, 140, 170], [230, 220, 200]],
];

/** The planet's 112 colours as RGB triples (makeGlobeColours: dark to middle over the first half, middle to light over the second). */
export function globeColours(type: number): Uint8Array {
  const ramp = GLOBE_RAMPS[Math.min(type, GLOBE_RAMPS.length - 1)]!;
  const out = new Uint8Array(GLOBE_COLOURS * 3);
  const half = GLOBE_COLOURS / 2;
  for (let i = 0; i < GLOBE_COLOURS; i++) {
    for (let j = 0; j < 3; j++) {
      out[i * 3 + j] = i < half
        ? ramp[0]![j]! + Math.trunc((ramp[1]![j]! - ramp[0]![j]!) * i / half)
        : ramp[1]![j]! + Math.trunc((ramp[2]![j]! - ramp[1]![j]!) * (i - half) / (GLOBE_COLOURS - half));
    }
  }
  return out;
}

/** The surface of a planet or moon: a colour index (0 to 111) for each of 256 by 168 points, made from its class and seed (makeGlobeTexture). */
export function globeTexture(type: number, seed: number): Uint8Array {
  const random = new AstroRandom();
  random.seed((seed & 0xff) + ((seed >>> 8) & 0xf) * 0x100 + type * 0x1000);
  const sum = new Int32Array(TEXTURE_WIDTH * TEXTURE_HEIGHT);
  let total = 0;
  for (let cell = 64, weight = 64; cell >= 4; cell = cell >> 1, weight = weight >> 1) {
    const columns = TEXTURE_WIDTH / cell, rows = Math.trunc(TEXTURE_HEIGHT / cell) + 2;
    const grid = new Int32Array(columns * rows);
    for (let i = 0; i < grid.length; i++) grid[i] = random.next() & 0xff;
    for (let y = 0; y < TEXTURE_HEIGHT; y++) {
      const row = Math.trunc(y / cell), fy = Math.trunc((y % cell) * 256 / cell);
      for (let x = 0; x < TEXTURE_WIDTH; x++) {
        const column = Math.trunc(x / cell), fx = Math.trunc((x % cell) * 256 / cell);
        const next = (column + 1) % columns;
        const top = grid[row * columns + column]! * (256 - fx) + grid[row * columns + next]! * fx;
        const bottom = grid[(row + 1) * columns + column]! * (256 - fx) + grid[(row + 1) * columns + next]! * fx;
        sum[y * TEXTURE_WIDTH + x]! += Math.trunc(((top >> 8) * (256 - fy) + (bottom >> 8) * fy) / 256) * weight;
      }
    }
    total += weight;
  }
  // gas giants are banded
  const banded = type === 0 || type === 1 || type === 14 || type === 15;
  const bands = 6 + random.rnd(8);
  const texture = new Uint8Array(TEXTURE_WIDTH * TEXTURE_HEIGHT);
  for (let y = 0; y < TEXTURE_HEIGHT; y++) {
    for (let x = 0; x < TEXTURE_WIDTH; x++) {
      let value = Math.trunc(sum[y * TEXTURE_WIDTH + x]! / total);
      if (banded) value = Math.trunc((value + 3 * Math.trunc(127 + 127 * Math.sin(y * bands * Math.PI / TEXTURE_HEIGHT + value / 40))) / 4);
      texture[y * TEXTURE_WIDTH + x] = Math.trunc(Math.max(0, Math.min(255, value)) * (GLOBE_COLOURS - 1) / 255);
    }
  }
  return texture;
}

/** For each point of the globe, the texture's row and column (before turning), or -1 outside the sphere: the same for every planet, so it is made once. */
let mapping: { v: Int16Array; u: Int16Array } | null = null;
function sphere(): { v: Int16Array; u: Int16Array } {
  if (mapping) return mapping;
  const v = new Int16Array(GLOBE_SIZE * GLOBE_SIZE).fill(-1), u = new Int16Array(GLOBE_SIZE * GLOBE_SIZE).fill(-1);
  const radius = GLOBE_SIZE / 2;
  for (let row = 0; row < GLOBE_SIZE; row++) {
    const y = (row - radius + 0.5) / radius;
    for (let column = 0; column < GLOBE_SIZE; column++) {
      const x = (column - radius + 0.5) / radius;
      if (x * x + y * y > 1) continue;
      const latitude = Math.asin(y);
      const across = x / Math.cos(latitude);
      const longitude = Math.asin(Math.max(-1, Math.min(1, across)));
      u[row * GLOBE_SIZE + column] = Math.trunc((longitude * 180 / Math.PI + 90) * 256 / 360);
      v[row * GLOBE_SIZE + column] = Math.max(0, Math.min(167, Math.trunc((latitude * 180 / Math.PI + 90) * 168 / 180)));
    }
  }
  return (mapping = { v, u });
}

/** drawGlobe: the texture wrapped round a sphere and turned by `ticks` of the clock (a column of the texture each 16 ticks), as RGBA with the sphere's corners clear. */
export function renderGlobe(texture: Uint8Array, colours: Uint8Array, ticks: number): Uint8ClampedArray {
  const { v, u } = sphere();
  const rotation = (ticks >> 4) & 0xff;
  const out = new Uint8ClampedArray(GLOBE_SIZE * GLOBE_SIZE * 4);
  for (let i = 0; i < GLOBE_SIZE * GLOBE_SIZE; i++) {
    if (v[i]! < 0) continue;
    const c = texture[v[i]! * TEXTURE_WIDTH + ((u[i]! + rotation) & 0xff)]! * 3;
    out[i * 4] = colours[c]!;
    out[i * 4 + 1] = colours[c + 1]!;
    out[i * 4 + 2] = colours[c + 2]!;
    out[i * 4 + 3] = 255;
  }
  return out;
}
