// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { artCache, comfyLockHeld, liveReady } from './cache';
import { withGenerator } from './comfy';
import { loadModels } from './models';
import { backgroundOf, parseRecipe, type RepaintRecipe } from './recipe';
import { decodePng, meanAbsDiff } from './image';
import { originalBackground } from './originals';
import { repaint } from './repaint';
import { checkPins, choiceFor, runRecipe, verifyRecipe } from './run';
import { modelsFor } from './select';

const ready = liveReady();
const images = process.env.IMAGES_DIR;
const held = ready.ok && comfyLockHeld();
const skip = !ready.ok || !images || held;
if (skip) console.info(`live-repaint skipped: ${!ready.ok ? ready.why : !images ? 'IMAGES_DIR is not set' : 'the ComfyUI lock (.comfy.lock) is held by another run'}`);

const REPO = join(__dirname, '..', '..', '..');
const FILE = join(REPO, 'art', 'recipes', 'lab.s01.yaml');

describe.skipIf(skip)('live repaint of lab.s01', () => {
  it('runs lab.s01.yaml to a 2560x1920 plate, and verify passes on a second run', async () => {
    const text = readFileSync(FILE, 'utf8');
    const recipe = parseRecipe(text, FILE);
    const models = loadModels(readFileSync(join(REPO, 'art', 'models.yaml'), 'utf8'));
    const cache = artCache();
    await withGenerator(cache, async generator => {
      const deps = { generator, models, cache, imagesDir: images };
      const { meta } = await runRecipe(recipe, text, deps);
      expect(meta.outputs.plate).toMatchObject({ width: 2560, height: 1920 });
      const v = await verifyRecipe(recipe, text, deps);
      expect(v.ok, v.detail).toBe(true);
    });
  }, 900_000);

  it('lab.s01 with ControlNets differs from without by a mean of at least 1/255 (I2: the windows act on sampled steps)', async () => {
    const text = readFileSync(FILE, 'utf8');
    const recipe = parseRecipe(text, FILE) as RepaintRecipe;
    const models = loadModels(readFileSync(join(REPO, 'art', 'models.yaml'), 'utf8'));
    const cache = artCache();
    await withGenerator(cache, async generator => {
      const choice = choiceFor(recipe, models);
      await checkPins(choice, { generator, models, cache });
      const m = modelsFor(models, choice);
      const original = await originalBackground(images!, backgroundOf(recipe));
      const withCn = await repaint(recipe, original, generator, m, 'live-with');
      const without = await repaint({ ...recipe, depth: undefined, lineart: undefined }, original, generator, m, 'live-without');
      for (const c of withCn.controls) expect(c.activeFraction, `${c.name} acts on no sampled step`).toBeGreaterThan(0);
      const diff = meanAbsDiff(decodePng(withCn.repainted), decodePng(without.repainted));
      expect(diff, `mean difference ${diff.toFixed(3)}/255`).toBeGreaterThanOrEqual(1);
    });
  }, 900_000);
});
