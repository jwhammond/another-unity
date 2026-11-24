// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { BACKDROP_PLATES, BACKDROP_TABLE, backdropPlate } from './files';

const root = resolve(__dirname, '../../../..');

function battleIds(file: string): number[] | null {
  const path = resolve(root, file);
  if (!existsSync(path)) return null;
  const doc = parse(readFileSync(path, 'utf8')) as { battles?: Record<string, unknown> };
  return Object.keys(doc.battles ?? {}).map(Number);
}

const plateOf = (id: number): string => backdropPlate(id);

describe('backdropPlate', () => {
  it.each(['games/unity/combat.yaml', 'tools/lift/src/__golden__/mini/combat.yaml'])(
    'every battle in %s has a plate',
    (file) => {
      const ids = battleIds(file);
      if (ids === null) return; // lifted data is local: skip when absent
      for (const id of ids) expect(BACKDROP_TABLE[id], `battle ${id}`).toBeDefined();
    },
  );

  it('each plate takes 10 of the 40 battles', () => {
    const ids = Object.keys(BACKDROP_TABLE).map(Number);
    expect(ids).toHaveLength(40);
    for (let p = 0; p < BACKDROP_PLATES; p++) {
      expect(ids.filter((id) => BACKDROP_TABLE[id] === p)).toHaveLength(10);
    }
  });

  it('battles one after another differ', () => {
    for (const id of Object.keys(BACKDROP_TABLE).map(Number)) {
      if (BACKDROP_TABLE[id + 1] !== undefined) expect(plateOf(id), `${id}, ${id + 1}`).not.toBe(plateOf(id + 1));
    }
    const route = [51, 71, 52];
    for (let i = 1; i < route.length; i++) expect(plateOf(route[i - 1]!)).not.toBe(plateOf(route[i]!));
  });

  it('keeps the path form', () => {
    expect(backdropPlate(4)).toMatch(/^art\/space\/backdrop\/plate[0-3]\.webp$/);
  });

  it('an unknown battle falls back to mod 4', () => {
    expect(backdropPlate(999)).toBe('art/space/backdrop/plate3.webp');
    expect(backdropPlate(1000)).toBe('art/space/backdrop/plate0.webp');
    expect(backdropPlate(-1)).toBe('art/space/backdrop/plate3.webp');
  });
});
