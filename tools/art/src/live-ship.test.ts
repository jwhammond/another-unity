// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { blenderPath, inspectGlb } from './blender';
import { runMaterialRecipe } from './material';
import { artCache } from './cache';
import { materialRecipe, shipRecipe } from './recipe';
import { shipOriginal } from './shiporig';
import { runShipRecipe } from './shipbuild';
import { MAX_SPILL, MIN_COVERAGE } from './shipalign';

const REPO = join(__dirname, '..', '..', '..');
const SHIP = join(REPO, 'games', 'unity', 'ship.yaml');
const gameData = process.env.GAMEDATA_DIR ?? join(homedir(), 'pcode', 'unity-gamedata', 'cd');
const cache = artCache();
const missing = [
  !process.env.ART_CACHE && 'ART_CACHE is not set',
  !blenderPath() && 'no Blender',
  !existsSync(join(gameData, 'STTNG.ZIP')) && `no ${gameData}/STTNG.ZIP`,
  !existsSync(SHIP) && 'no games/unity/ship.yaml',
  process.env.ART_CACHE && !existsSync(shipOriginal(cache, 'bridge')) && 'no decoded bridge original (art ship originals)',
].filter(Boolean);
if (missing.length > 0) console.info(`live-ship skipped: ${missing.join(', ')}`);

describe.skipIf(missing.length > 0)('live ship bridge', () => {
  it('builds ship.bridge: the camera fits, all ten 3D items pass R3, and the glb carries a camera and the 11 item: nodes', async () => {
    const text = readFileSync(join(REPO, 'art', 'recipes', 'ship.bridge.yaml'), 'utf8');
    const recipe = shipRecipe.parse(parseYaml(text));
    const work = { ...cache, work: mkdtempSync(join(tmpdir(), 'au-ship-')) };
    // R5: the materials are baked first (into the same temporary cache), at most eight of them
    expect(recipe.materials.length).toBeLessThanOrEqual(8);
    for (const id of recipe.materials) {
      const mt = readFileSync(join(REPO, 'art', 'recipes', `${id}.yaml`), 'utf8');
      await runMaterialRecipe(materialRecipe.parse(parseYaml(mt)), mt, work);
    }
    const { meta, fits, dir } = await runShipRecipe(recipe, text, work);
    expect(meta.fit.rms).toBeLessThanOrEqual(3);
    expect(fits).toHaveLength(10);
    for (const f of fits) {
      expect(f.coverage, `item ${f.index} coverage`).toBeGreaterThanOrEqual(MIN_COVERAGE);
      expect(f.spill, `item ${f.index} spill`).toBeLessThanOrEqual(MAX_SPILL);
    }
    const g = await inspectGlb(new Uint8Array(readFileSync(join(dir, 'ship.bridge.glb'))));
    expect(g.cameras).toBeGreaterThanOrEqual(2);
    // (R6 is superseded and the 3D set is dev-only: the build exports three lights)
    expect(g.lights, 'KHR_lights_punctual lights').toBeGreaterThanOrEqual(3);
    expect(g.textures, 'baked textures, three per material').toBeGreaterThanOrEqual(recipe.materials.length * 3);
    expect(g.nodes.find(n => n.name === 'camera:main')!.extras).toMatchObject({ projection: 'perspective', width: 640, height: 480 });
    expect(g.nodes.find(n => n.name === 'camera:viewscreen')).toBeTruthy();
    const items = g.nodes.filter(n => n.name.startsWith('item:'));
    expect(items).toHaveLength(11);
    for (const n of items) expect(n.extras).toMatchObject({ proxy: true });
    expect(g.nodes.find(n => n.name === 'item:4')!.extras).toMatchObject({ item: 4, action: '4', role: 'fixture' });
    expect(g.nodes.find(n => n.name === 'item:10')!.extras).toMatchObject({ ui: true });
    expect(meta.inputs.shipYaml).toMatch(/^[0-9a-f]{64}$/);
  }, 420_000);
});
