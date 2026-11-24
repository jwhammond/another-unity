// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { objectsBlocks, readJson } from './raw';

// JsonWriter writes every byte >= 0x7f or < 0x20 as \u00XX, and \" and \\ as escapes.
// No exported conversation (or object) has such a byte, so this stands in for a live check.
describe('reading the export\'s JSON strings', () => {
  it('decodes \\u00XX escapes to the original byte values, and \\" and \\\\', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rawcheck-'));
    try {
      await writeFile(join(dir, 's.json'), '{"t": "caf\\u00e9 \\u0001 \\u00ff \\" \\\\"}');
      const { t } = (await readJson(dir, 's.json')) as { t: string };
      expect([...t].map(c => c.charCodeAt(0))).toEqual(
        [0x63, 0x61, 0x66, 0xe9, 0x20, 0x01, 0x20, 0xff, 0x20, 0x22, 0x20, 0x5c]);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});


describe('objectsBlocks', () => {
  it('finds each objects listing, skipping log lines in between', () => {
    const log = [
      'Screen 7/1 has 2 object(s):',
      '  0: 070100 Setup World                    flags 22 state 255 at (-1, -1)',
      'WARNING: no phaser data for x!',
      '  1: 070103 rubble                         flags 22 state 0 at (208, 336)',
      'export: 1 objects',
      'Screen 7/1 has 2 object(s):',
      '  0: 070100 Setup World                    flags 22 state 255 at (-1, -1)',
      '  1: 070103 rubble                         flags 22 state 0 at (208, 336)',
    ].join('\n');
    const blocks = objectsBlocks(log);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual(blocks[1]);
    expect(blocks[0]).toHaveLength(2);
  });
});
