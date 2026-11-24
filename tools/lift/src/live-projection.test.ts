// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { Projection, type ScreenDef } from '@another-unity/engine';
import { WalkFloor } from '../../../engine/src/sim/walkFloor';
import type { CoordsFile } from './markers';
import { fitRows } from './projection';

const GAME = 'games/unity';
const ready = !!process.env.RAW_DIR && existsSync(`${GAME}/coords.yaml`);
if (!ready) console.info('live-projection.test.ts: skipped (needs RAW_DIR and npm run unity:build)');

/** How far the fitted scale may be from the original's at an entrance before the crew looks wrong (M3 Plan 8 R4). */
const MAX_RATIO = 1.5;
/** Screens no line fits, with why (each a ledger ruling). */
const FAR = "an entrance sits on the floor's far sliver, at a scale under 7, so no line through the slots keeps the floor in front of its horizon";
const BEHIND = "the line through its slots puts the horizon at or below the floor's back edge, so no line keeps the floor in front of it";
const MIX = "the original's scale at its entrances isn't a line over row (it varies along a row, or a slot is off the floor), so no line fits them";
const LOOSE: Record<string, string> = {
  'horst3.s02': "its walkway's scale changes along a row (Plan 6 Task 12), so no line fits it",
  'allanor.s04': MIX,
  'allanor.s0a': BEHIND,
  'allanor.s0b': MIX,
  'allanor.s0d': FAR,
  'allanor.s0e': BEHIND,
  'allanor.s11': FAR,
  'unity.s01': FAR,
  'unity.s05': FAR,
  'unity.s0b': FAR,
  'zoo.s01': MIX,
  'zoo.s02': MIX,
  'zoo.s0a': BEHIND,
};

describe.skipIf(!ready)('the projections at the entrances', () => {
  it('draws the crew at every entrance within 1.5x of the original\'s scale, or the screen is listed', () => {
    const coords = parse(readFileSync(`${GAME}/coords.yaml`, 'utf8')) as CoordsFile;
    const bad: string[] = [];
    // (a screen listed in LOOSE that now passes: its entry is stale)
    const stale: string[] = [];
    for (const [slug, s] of Object.entries(coords.screens).sort()) {
      if (s.projection.kind !== 'perspective') continue;
      const loose = slug in LOOSE;
      const [world, n] = slug.split('.');
      const def = parse(readFileSync(`${GAME}/screens/${world}/${n}.yaml`, 'utf8')) as ScreenDef;
      const polygons = (def.pixelMetric?.floor ?? []).filter(p => def.regions?.[p.region]).map(p => p.points);
      if (polygons.length === 0) continue;
      const floor = new WalkFloor(polygons);
      const p = new Projection(s.projection);
      const samples: [number, number][] = [];
      const wrong: string[] = [];
      for (const [name, [x, y]] of Object.entries(s.markers)) {
        if (!/^entrance_\d+(\.\d)?$/.test(name)) continue;
        const original = floor.scaleAt({ x, y });
        samples.push([y, original]);
        const ratio = p.scaleAt(y) / original;
        if (ratio > MAX_RATIO || ratio < 1 / MAX_RATIO) wrong.push(`${name} ${ratio.toFixed(2)}x`);
      }
      if (wrong.length === 0) {
        if (loose) stale.push(slug);
        continue;
      }
      if (loose) continue;
      bad.push(`${slug}: ${wrong.join(', ')}`);
      // (a line through the entrances' own scales: paste it into overrides/coords.yaml, then look at the room)
      console.info(`${slug}: try ${JSON.stringify(fitRows(samples))}`);
    }
    expect(bad).toEqual([]);
    expect(stale).toEqual([]);
  });
});
