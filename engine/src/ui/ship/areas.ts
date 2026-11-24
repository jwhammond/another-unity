// SPDX-License-Identifier: GPL-3.0-or-later
import type { Rect } from '../../view/art';

/** The plate's size, in the original's pixels: an area is a rectangle of it. */
const W = 640;
const H = 480;

const pct = (v: number): string => `${Number((v * 100).toFixed(4))}%`;

/** An area as absolute percentages of the 640x480 box, so a panel's section sits on its place in the plate at any size. */
export function areaStyle(rect: Rect): { position: 'absolute'; left: string; top: string; width: string; height: string } {
  return { position: 'absolute', left: pct(rect[0] / W), top: pct(rect[1] / H), width: pct(rect[2] / W), height: pct(rect[3] / H) };
}
