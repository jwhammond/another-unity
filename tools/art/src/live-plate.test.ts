// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { artCache, liveReady } from './cache';
import { withGenerator } from './comfy';
import { decodePng } from './image';
import { loadModels } from './models';
import { parseRecipe } from './recipe';
import { runRecipe } from './run';
import { shipOriginal } from './shiporig';

const REPO = join(__dirname, '..', '..', '..');
const ready = liveReady();
const cache = artCache();
const missing = [
  !ready.ok && ready.why,
  ready.ok && !existsSync(shipOriginal(cache, 'bridge')) && 'no decoded bridge original (art ship originals)',
  !existsSync(join(REPO, 'games', 'unity', 'ship.yaml')) && 'no games/unity/ship.yaml',
].filter(Boolean);
if (missing.length > 0) console.info(`live-plate skipped: ${missing.join(', ')}`);

describe.skipIf(missing.length > 0)('live plate.bridge', () => {
  it('repaints the bridge: alignment passes, and the kept strip is the original\'s upscale exactly', async () => {
    const file = join(REPO, 'art', 'recipes', 'plate.bridge.yaml');
    const text = readFileSync(file, 'utf8');
    const recipe = parseRecipe(text, file);
    const models = loadModels(readFileSync(join(REPO, 'art', 'models.yaml'), 'utf8'));
    await withGenerator(cache, async generator => {
      const { meta } = await runRecipe(recipe, text, { generator, models, cache });
      expect((meta.checks.align as { ok: boolean }).ok).toBe(true);
      const plate = decodePng(new Uint8Array(readFileSync(meta.outputs.plate!.file)));
      // (the kept strip is the original's own 4x upscale, `keepUpscaled`; `upscaled` is the de-dithered one since 268fea8)
      const up = decodePng(new Uint8Array(readFileSync(meta.outputs.keepUpscaled!.file)));
      // interior: 2 original px (8 plate px) inside the strip's top edge and below
      let differing = 0;
      for (let y = (364 + 2) * 4; y < plate.height; y++) for (let x = 0; x < plate.width; x++) {
        const i = (y * plate.width + x) * 4;
        if (plate.data[i] !== up.data[i] || plate.data[i + 1] !== up.data[i + 1] || plate.data[i + 2] !== up.data[i + 2]) differing++;
      }
      expect(differing, 'plate pixels in the kept interior that differ from the upscale').toBe(0);
    });
  }, 7_500_000);
});
