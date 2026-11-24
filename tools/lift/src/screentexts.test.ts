// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { Problems } from './problems';
import { rawFromMini } from './testing/ctx';
import { liftScreenTexts, parseScreenTexts } from './screentexts';

const bytes = (s: string) => new TextEncoder().encode(s);
const FILE = '# Record 0\r\n#\r\n 0  214  140 230 75 6\r\n@\r\n  -A-\r\n\r\n -B-@\r\n\r\n1 10 20 30 40 7\r\n@-One-@\r\n';

describe('parseScreenTexts', () => {
  it('reads showScreenText\'s records: a box, a font, and lines ended by carriage returns', () => {
    const t = parseScreenTexts(bytes(FILE));
    expect([...t.keys()]).toEqual([0, 1]);
    expect(t.get(0)).toEqual({ x: 214, y: 140, width: 230, height: 75, font: 6, lines: ['', '  -A-', '', ' -B-'] });
    expect(t.get(1)).toEqual({ x: 10, y: 20, width: 30, height: 40, font: 7, lines: ['-One-'] });
  });

  it('stops at a record it cannot read, or the end-of-file mark', () => {
    expect(parseScreenTexts(bytes('0 1 2 3 4 5 @a@\r\nbroken\r\n')).size).toBe(1);
    expect(parseScreenTexts(bytes('0 1 2 3 4 5 @a@\x1a1 1 2 3 4 5 @b@')).size).toBe(1);
  });
});

describe('liftScreenTexts', () => {
  const raw = () => ({ ...rawFromMini(), screenTexts: new Map([['070b', bytes(FILE)], ['020f', bytes(FILE)]]) });

  it('lifts the lifted worlds\' screens by slug and record', () => {
    const out = liftScreenTexts(raw(), [7], new Problems());
    expect(Object.keys(out)).toEqual(['horst3.s0b']);
    expect(Object.keys(out['horst3.s0b'] ?? {})).toEqual(['0', '1']);
  });

  it('is empty without any screen text files', () => {
    expect(liftScreenTexts(rawFromMini(), [7], new Problems())).toEqual({});
  });
});
