// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { fitCell, selectCards } from './characters';

const m = (object: string, card = true) => ({ object, image: `${object}.webp`, card });

describe('selectCards', () => {
  it('puts people before props, drops non-cards, and keeps one per name', () => {
    const got = selectCards([m('lab.hull_breach'), m('lab.trapped_woman.0200'), m('lab.energize.0a02'), m('lab.trapped_woman.0301'), m('lab.dr_griems'), m('lab.plate_only', false)]);
    expect(got.map(p => p.name)).toEqual(['trapped_woman', 'dr_griems', 'hull_breach', 'energize']);
  });
  it('caps the count', () => {
    const many = Array.from({ length: 30 }, (_, i) => m(`zoo.constable_${i}`));
    expect(selectCards(many, 12)).toHaveLength(12);
  });
  it('a world with no people gets its props (Horst III)', () => {
    expect(selectCards([m('horst3.rubble.0103'), m('horst3.glow')]).map(p => p.name)).toEqual(['rubble', 'glow']);
  });
  it('is empty with no masks', () => expect(selectCards([])).toEqual([]));
});

describe('fitCell', () => {
  it('centres a wide image in a square cell', () => {
    const img = { width: 8, height: 2, data: new Uint8Array(8 * 2 * 4).fill(255) };
    const c = fitCell(img, 4);
    expect([c.width, c.height]).toEqual([4, 4]);
    const a = (x: number, y: number) => c.data[(y * 4 + x) * 4 + 3];
    expect(a(0, 0)).toBe(0);
    expect(a(0, 1)).toBe(255);
  });
});
