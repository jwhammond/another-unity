// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LiftError } from './problems';
import { readRaw } from './raw';
import { writeMiniRaw } from './testing/mini';

describe('readRaw', () => {
  it('reads every file the manifest lists, by id', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'raw-'));
    await writeMiniRaw(dir);
    const raw = await readRaw(dir);
    expect(raw.objects.get('070103')?.name).toBe('rubble');
    expect(raw.conversations.get('w007c000')?.responses).toHaveLength(2);
    expect(raw.screens.get('s_0703')?.location).toBeNull();
    expect(raw.worlds.get('w_07')?.startups).toHaveLength(4);
    expect(raw.triggers.map(t => t.id)).toEqual([3, 4, 9, 2, 8, 10, 21, 69, 71, 12]);
    expect(raw.movies.movies[0].filename).toBe('arrive.fvf');
    expect(raw.executable._presetSounds['1']).toBe('beep7.mac');
  });

  it('names every bad file and field, then fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'raw-'));
    await writeMiniRaw(dir, files => {
      (files['objects/o_070103.json'] as Record<string, unknown>).x = 70000;
      (files['screens/s_0702.json'] as Record<string, unknown>).extra = 1;
    });
    const error = await readRaw(dir).catch(e => e);
    expect(error).toBeInstanceOf(LiftError);
    expect((error as LiftError).problems).toEqual([
      'objects/o_070103.json: x: Number must be less than or equal to 32767',
      "screens/s_0702.json: (root): Unrecognized key(s) in object: 'extra'",
    ]);
  });
});
