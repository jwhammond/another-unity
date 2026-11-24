// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { ReadingTable } from './readings';

describe('ReadingTable', () => {
  it('reads readings.yaml, and has no pages for a reading it lacks', () => {
    const t = ReadingTable.parse('horst3:\n  1:\n    - { title: -A-, heading: -a-, text: -Zap- }\n');
    expect(t.pages('horst3', 1)).toEqual([{ title: '-A-', heading: '-a-', text: '-Zap-' }]);
    expect(t.pages('horst3', 2)).toEqual([]);
    expect(ReadingTable.parse(undefined).pages('zoo', 1)).toEqual([]);
  });
});
