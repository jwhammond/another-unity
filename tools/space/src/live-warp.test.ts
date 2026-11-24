// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CombatSpriteSheet } from '../../../engine/src/view/combat/files';
import { WARP_SPRITES, warpLayerAt } from '../../../engine/src/view/combat/warp';

// (games/unity/space/sprites.json after npm run unity:build, docs/unity-local.md)
const INDEX = fileURLToPath(new URL('../../../games/unity/space/sprites.json', import.meta.url));
const built = existsSync(INDEX);
if (!built) console.info('live-warp.test.ts: skipped; run npm run unity:build for games/unity/space/sprites.json (docs/unity-local.md)');

describe.skipIf(!built)('the warp overlay\'s sheets in the space build (showWarp, tactical.cpp:818-854; Plan 24 R2)', () => {
  it('has each in cheap.pic\'s palette, and plays each through the overlay\'s 3000 ms on frames the sheet has', () => {
    const index = JSON.parse(readFileSync(INDEX, 'utf8')) as Record<string, CombatSpriteSheet>;
    for (const { file } of WARP_SPRITES) {
      const sheet = index[file];
      expect(sheet, file).toBeDefined();
      expect(sheet!.palette, file).toBe('cheap');
      for (let ms = 0; ms <= 3000; ms += 10) {
        const layer = warpLayerAt(sheet!, file, ms);
        expect(layer, `${file} at ${ms} ms`).not.toBeNull();
        expect(layer!.frames.every(f => Number.isInteger(f) && f >= 0 && f < sheet!.frames), `${file} at ${ms} ms`).toBe(true);
      }
    }
  });
});
