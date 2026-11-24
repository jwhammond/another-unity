// SPDX-License-Identifier: GPL-3.0-or-later
import { sheetColumns, type CombatSpriteSheet } from '../../../engine/src/view/combat/files';
import type { Rgba } from './image';

/**
 * An effect's sheet upscaled (Plan 30 R11): the original sheet's frames, each `scale` times, laid out again in rows of at most
 * SPRITE_SHEET_MAX pixels (sheetColumns), so the frames keep their order and every frame its whole cell. `alphaFrom` is the original
 * sheet: its alpha, read nearest, is the upscale's alpha (the original's clear pixels stay clear).
 */
export function relayoutSheet(upscaled: Rgba, sheet: Pick<CombatSpriteSheet, 'frames' | 'columns' | 'cell'>, scale: number, alphaFrom: Rgba): { picture: Rgba; columns: number; cell: [number, number] } {
  const [w, h] = [sheet.cell[0] * scale, sheet.cell[1] * scale];
  if (upscaled.width !== sheet.columns * w || upscaled.height !== Math.ceil(sheet.frames / sheet.columns) * h) throw new Error(`relayoutSheet: a ${upscaled.width}x${upscaled.height} upscale isn't ${scale} times the sheet`);
  const columns = sheetColumns(sheet.frames, w);
  const out: Rgba = { width: columns * w, height: Math.ceil(sheet.frames / columns) * h, data: new Uint8Array(columns * w * Math.ceil(sheet.frames / columns) * h * 4) };
  for (let f = 0; f < sheet.frames; f++) {
    const [sx, sy] = [(f % sheet.columns) * w, Math.floor(f / sheet.columns) * h];
    const [dx, dy] = [(f % columns) * w, Math.floor(f / columns) * h];
    for (let y = 0; y < h; y++) {
      out.data.set(upscaled.data.subarray(((sy + y) * upscaled.width + sx) * 4, ((sy + y) * upscaled.width + sx + w) * 4), ((dy + y) * out.width + dx) * 4);
      for (let x = 0; x < w; x++) {
        const a = alphaFrom.data[((Math.floor((sy + y) / scale)) * alphaFrom.width + Math.floor((sx + x) / scale)) * 4 + 3]!;
        out.data[((dy + y) * out.width + dx + x) * 4 + 3] = a;
      }
    }
  }
  return { picture: out, columns, cell: [w, h] };
}

/** The console's plate as it is published (Plan 30 R7): the view's rectangle ([x, y, w, h] in the original's pixels) clear, as the space view shows through it. */
export function clearView(plate: Rgba, view: readonly [number, number, number, number], scale: number): Rgba {
  const data = new Uint8Array(plate.data);
  for (let y = view[1] * scale; y < (view[1] + view[3]) * scale; y++) for (let x = view[0] * scale; x < (view[0] + view[2]) * scale; x++) data[(y * plate.width + x) * 4 + 3] = 0;
  return { width: plate.width, height: plate.height, data };
}
