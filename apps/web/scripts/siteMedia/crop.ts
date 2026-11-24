// SPDX-License-Identifier: GPL-3.0-or-later
// The scene's rectangle inside a room picture. The game draws an away room in the top 400 rows of its 640x480 screen and the HUD panel
// owns the strip below (engine/src/ui/panel.ts: PANEL = [0, 400, 640, 480]), so the room pictures' lower sixth is the panel's black.
// The box is that rectangle scaled to the picture, the same for every room; no columns are trimmed and nothing is judged from the pixels.
import type { Rgba } from '../../../../tools/art/src/image';

export type Rect = { x: number; y: number; w: number; h: number };

/** The game's screen and the room's part of it, in the game's own pixels (the panel starts where the scene ends). */
export const SCREEN: [number, number] = [640, 480];
export const SCENE: [number, number, number, number] = [0, 0, 640, 400];

/** The scene rectangle for a picture of the whole 640x480 screen at any scale. */
export function sceneRect(width: number, height: number): Rect {
  const kx = width / SCREEN[0], ky = height / SCREEN[1];
  const x = Math.round(SCENE[0] * kx), y = Math.round(SCENE[1] * ky);
  return { x, y, w: Math.round(SCENE[2] * kx) - x, h: Math.round(SCENE[3] * ky) - y };
}

/** The part of a picture inside a rectangle. */
export function crop(img: Rgba, r: Rect): Rgba {
  const out: Rgba = { width: r.w, height: r.h, data: new Uint8Array(r.w * r.h * 4) };
  for (let y = 0; y < r.h; y++) out.data.set(img.data.subarray(((r.y + y) * img.width + r.x) * 4, ((r.y + y) * img.width + r.x + r.w) * 4), y * r.w * 4);
  return out;
}
