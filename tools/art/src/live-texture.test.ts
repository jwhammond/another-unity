// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { artCache, liveReady } from './cache';
import { withGenerator } from './comfy';
import { loadModels } from './models';
import { parseRecipe } from './recipe';
import { runRecipe } from './run';

const ready = liveReady();
if (!ready.ok) console.info(`live-texture skipped: ${ready.why}`);

const REPO = join(__dirname, '..', '..', '..');
const FILE = join(REPO, 'art', 'recipes', 'tex.panel-grey.yaml');

describe.skipIf(!ready.ok)('live texture tex.panel-grey', () => {
  it('tiles: seamAfter <= 1.5', async () => {
    const text = readFileSync(FILE, 'utf8');
    const recipe = parseRecipe(text, FILE);
    const models = loadModels(readFileSync(join(REPO, 'art', 'models.yaml'), 'utf8'));
    const cache = artCache();
    await withGenerator(cache, async generator => {
      const { meta } = await runRecipe(recipe, text, { generator, models, cache });
      expect(meta.outputs.albedo).toMatchObject({ width: 1024, height: 1024 });
      expect((meta.checks.seam as { after: number }).after).toBeLessThanOrEqual(1.5);
    });
  }, 900_000);
});
