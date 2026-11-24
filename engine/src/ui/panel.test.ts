// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { PHASER_LABELS, PHASER_SQUARES, phaserSquareRect, ADMIN, healthBands, INVENTORY_STRIP, inventoryPage, markerRect, PANEL, panelBox, phaserIndexAt, phaserIndexFor, phaserSettingOf, slotRect, VERB_RECTS } from './panel';

describe('panelBox', () => {
  it('maps the original\'s screen rectangles into the 640 by 80 strip as percentages', () => {
    expect(panelBox(PANEL)).toEqual({ left: '0%', top: '0%', width: '100%', height: '100%' });
    expect(panelBox(ADMIN)).toEqual({ left: '0%', top: '26.25%', width: '7.1875%', height: '73.75%' });
    expect(panelBox(slotRect(3))).toEqual({ left: '74.0625%', top: '33.75%', width: '8.125%', height: '60%' });
  });
  it('keeps the verbs\' two by two block: look and use above, talk and walk below', () => {
    expect(VERB_RECTS.map(v => v.mode)).toEqual(['look', 'use', 'talk', 'walk']);
    expect(VERB_RECTS[0]!.rect[3]).toBe(VERB_RECTS[2]!.rect[1]);
    expect(VERB_RECTS[0]!.rect[2]).toBe(VERB_RECTS[1]!.rect[0]);
  });
  it('has the drop strip from the first slot to the end of the last', () => {
    expect(INVENTORY_STRIP).toEqual([242, 427, 634, 475]);
  });
});

describe('the phaser gauge\'s fill and names', () => {
  it('names the four settings by the position under the pointer: four positions each, and 15 squares after the marker\'s box', () => {
    const names = (positions: number[]) => positions.map(i => PHASER_LABELS[phaserSettingOf(i)]);
    expect(names([0, 3, 4, 7, 8, 11, 12, 15])).toEqual([
      'Phaser off', 'Phaser off', 'Low phaser setting', 'Low phaser setting', 'Medium phaser setting', 'Medium phaser setting', 'High phaser setting', 'High phaser setting',
    ]);
    expect(PHASER_SQUARES).toBe(15);
  });

  it('puts each square inside its own 14 pixel cell, in the gauge', () => {
    for (let i = 1; i <= PHASER_SQUARES; i++) {
      const [l, t, r, b] = phaserSquareRect(i);
      expect(l).toBeGreaterThanOrEqual(414 + 14 * i);
      expect(r).toBeLessThanOrEqual(428 + 14 * i);
      expect(t).toBeGreaterThanOrEqual(401);
      expect(b).toBeLessThanOrEqual(421);
    }
  });
});

describe('the phaser gauge', () => {
  it('has 16 positions from x 414, 14 pixels each, clamped at both ends', () => {
    expect(phaserIndexAt(410)).toBe(0);
    expect(phaserIndexAt(427)).toBe(0);
    expect(phaserIndexAt(428)).toBe(1);
    expect(phaserIndexAt(414 + 14 * 15)).toBe(15);
    expect(phaserIndexAt(639)).toBe(15);
  });
  it('makes every 4 positions a setting', () => {
    expect([0, 3, 4, 7, 8, 12, 15].map(phaserSettingOf)).toEqual([0, 0, 1, 1, 2, 3, 3]);
  });
  it('keeps the position last pointed at while the setting is its own, else the setting\'s first', () => {
    expect(phaserIndexFor(2, 10)).toBe(10);
    expect(phaserIndexFor(1, 10)).toBe(4);
    expect(phaserIndexFor(3, null)).toBe(12);
  });
  it('centres the marker on 420 + 14 * position, y 413', () => {
    expect(markerRect(0)).toEqual([412, 403, 428, 423]);
    expect(markerRect(15)).toEqual([622, 403, 638, 423]);
  });
});

describe('inventoryPage', () => {
  const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  it('shows six from the offset, and scrolls whichever way there is more', () => {
    expect(inventoryPage(items, 0)).toEqual({ offset: 0, shown: ['a', 'b', 'c', 'd', 'e', 'f'], left: false, right: true });
    expect(inventoryPage(items, 1)).toEqual({ offset: 1, shown: ['b', 'c', 'd', 'e', 'f', 'g'], left: true, right: true });
    expect(inventoryPage(items, 2)).toEqual({ offset: 2, shown: ['c', 'd', 'e', 'f', 'g', 'h'], left: true, right: false });
  });
  it('clamps an offset past the end, as the inventory shrinks', () => {
    expect(inventoryPage(items, 9).offset).toBe(2);
    expect(inventoryPage(['a', 'b'], 3)).toEqual({ offset: 0, shown: ['a', 'b', undefined, undefined, undefined, undefined], left: false, right: false });
  });
});

describe('healthBands', () => {
  it('fills from the bottom: green over the threshold, red at or under it, empty above the health', () => {
    expect(healthBands(10, 10, 0).every(b => b === 'healthy')).toBe(true);
    const half = healthBands(5, 10, 2);
    expect(half.filter(b => b === 'empty')).toHaveLength(13);
    expect(half.filter(b => b === 'injured')).toHaveLength(5);
    expect(half.filter(b => b === 'healthy')).toHaveLength(7);
    expect(half.at(-1)).toBe('injured');
  });
  it('is full and green for someone with no health to lose', () => {
    expect(healthBands(0, 0, 0).every(b => b === 'healthy')).toBe(true);
  });
});
