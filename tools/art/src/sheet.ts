// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { drawText } from './font';
import { areaResize, decodePng, encodePng, type Rgba } from './image';

export interface Cell {
  png: Uint8Array;
  caption: string;
  /** With `label`, drawn into the cell's top-left corner too (the caption goes bottom-left). */
  title?: string;
}

const GREY = 128;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Grid of equal cells (each fitted, aspect kept, letterboxed in mid-grey), one row per entry. Writes `<out>.png`
 * and a sibling `<out>.html` that captions each cell in reading order; with `label`, each caption is also drawn into its cell's bottom-left corner.
 */
export async function writeSheet(rows: Cell[][], out: string, opts: { cell?: [number, number]; label?: boolean } = {}): Promise<void> {
  const [cw, ch] = opts.cell ?? [320, 240];
  const cols = Math.max(1, ...rows.map(r => r.length));
  const sheet: Rgba = { width: cols * cw, height: rows.length * ch, data: new Uint8Array(cols * cw * rows.length * ch * 4) };
  for (let i = 0; i < sheet.data.length; i += 4) sheet.data.set([GREY, GREY, GREY, 255], i);
  const captions: string[] = [];
  rows.forEach((row, r) =>
    row.forEach((cell, c) => {
      const src = decodePng(cell.png);
      const s = Math.min(cw / src.width, ch / src.height);
      const w = Math.max(1, Math.min(cw, Math.round(src.width * s)));
      const h = Math.max(1, Math.min(ch, Math.round(src.height * s)));
      const img = w === src.width && h === src.height ? src : areaResize(src, w, h);
      const ox = c * cw + Math.floor((cw - w) / 2);
      const oy = r * ch + Math.floor((ch - h) / 2);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const a = img.data[(y * w + x) * 4 + 3]! / 255;
          const d = ((oy + y) * sheet.width + ox + x) * 4;
          for (let k = 0; k < 3; k++) sheet.data[d + k] = Math.round(img.data[(y * w + x) * 4 + k]! * a + GREY * (1 - a));
        }
      if (opts.label) drawText(sheet, cell.caption, c * cw + 6, (r + 1) * ch - 20, { scale: 2, bg: [0, 0, 0, 170] });
      if (opts.label && cell.title) drawText(sheet, cell.title, c * cw + 6, r * ch + 6, { scale: 2, bg: [0, 0, 0, 170] });
      captions.push(`<span style="left:${c * cw}px;top:${r * ch}px">${esc([cell.title, cell.caption].filter(Boolean).join(' '))}</span>`);
    }),
  );
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(`${out}.png`, encodePng(sheet));
  const name = esc(out.split('/').pop() ?? 'sheet');
  writeFileSync(
    `${out}.html`,
    `<!doctype html><meta charset="utf-8"><title>${name}</title><style>body{margin:0;background:#111}div{position:relative;width:${sheet.width}px}span{position:absolute;font:11px monospace;color:#fff;background:#000a;padding:1px 3px;max-width:${cw - 8}px}</style><div><img src="${name}.png">${captions.join('')}</div>`,
  );
}
