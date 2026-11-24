// SPDX-License-Identifier: GPL-3.0-or-later
import type { Rgba } from '../../../../tools/art/src/image';
import { scaleTo } from './sources';

export type MaskRef = { object: string; image?: string; card?: boolean };
export type Pick = { name: string; image: string };

/** Names (an object's name without its world prefix or trailing hex id) that are people or creatures, not props. */
const CHARACTER = /woman|man$|crewman|griems|brodnack|chodak_master|optimator|drone|alien\.|crawl|hyunh|iydia|constable|tzudan|zzolis|healer|watcher|bird|snake|monkey|reptile|deer|gibbon|boar|mole|aelont|laraq|chancellor|madia|nachyl|stamblyr|gatekeeper|staff|guardian|creature|pentara|picard|borg|akire|worm$|luginumo|ticulpus|sultis|atol/;
const stem = (object: string) => object.replace(/^[^.]+\./, '').replace(/\.[0-9a-f]{4}$/, '');

/**
 * The room masks that are card stills, one per distinct name, characters first and props after, at most `cap`.
 * (Order is the rooms' own, so a world's first people lead.)
 */
export function selectCards(masks: MaskRef[], cap = 12): Pick[] {
  const seen = new Set<string>();
  const people: Pick[] = [];
  const props: Pick[] = [];
  for (const m of masks) {
    if (!m.card || !m.image) continue;
    const name = stem(m.object);
    if (seen.has(name)) continue;
    seen.add(name);
    (CHARACTER.test(name) ? people : props).push({ name, image: m.image });
  }
  return [...people, ...props].slice(0, cap);
}

/** An image shrunk or enlarged to fit a size x size cell, centred on transparent. */
export function fitCell(img: Rgba, size: number): Rgba {
  const k = Math.min(size / img.width, size / img.height);
  const fit = scaleTo(img, Math.max(1, Math.round(img.width * k)));
  const out: Rgba = { width: size, height: size, data: new Uint8Array(size * size * 4) };
  const ox = Math.floor((size - fit.width) / 2);
  const oy = Math.floor((size - Math.min(fit.height, size)) / 2);
  for (let y = 0; y < Math.min(fit.height, size); y++) out.data.set(fit.data.subarray(y * fit.width * 4, (y + 1) * fit.width * 4), ((oy + y) * size + ox) * 4);
  return out;
}
