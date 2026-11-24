// SPDX-License-Identifier: GPL-3.0-or-later
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { ArtCache } from './cache';
import type { SpawnLike } from './comfy';
import { decodePng, encodePng, type Rgba } from './image';
import { finishMaterial, runMaterialRecipe } from './material';
import { parseRecipe } from './recipe';

function noise(n: number, seed: number, lo = 60, hi = 190): Rgba {
  const d = new Uint8Array(n * n * 4);
  let s = seed;
  for (let i = 0; i < n * n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const v = lo + ((s >>> 8) % (hi - lo));
    d.set([v, v, v, 255], i * 4);
  }
  return { width: n, height: n, data: d };
}
const TEXT = 'id: mat.test\nkind: material\nscript: mat/test.py\nsize: 128\nband: 32\n';

describe('material recipes', () => {
  it('parse with defaults, and refuse a script outside mat/ or a size that is not a multiple of 64', () => {
    const r = parseRecipe(TEXT, 'mat.test.yaml');
    expect(r.kind === 'material' && [r.seed, r.samples, r.normalStrength]).toEqual([1, 64, 2]);
    expect(() => parseRecipe('id: mat.t\nkind: material\nscript: ship/t.py\n', 'mat.t.yaml')).toThrow();
    expect(() => parseRecipe('id: mat.t\nkind: material\nscript: mat/t.py\nsize: 100\n', 'mat.t.yaml')).toThrow();
  });
  it('a ship recipe lists its materials by id, and refuses one that is not a mat.* id', () => {
    const base = readFileSync(join(__dirname, '..', '..', '..', 'art', 'recipes', 'ship.bridge.yaml'), 'utf8');
    const set = (list: string): string => base.replace(/^materials:.*$/m, `materials: ${list}`);
    const r = parseRecipe(set('[mat.carpet]'), 'ship.bridge.yaml');
    expect(r.kind === 'ship' && r.materials).toEqual(['mat.carpet']);
    expect(() => parseRecipe(set('[carpet]'), 'ship.bridge.yaml')).toThrow();
  });
});

describe('finishMaterial', () => {
  it('keeps the size, packs roughness into G with no metal, and makes a unit normal map', () => {
    const m = finishMaterial({ albedo: noise(128, 1), roughness: noise(128, 2), height: noise(128, 3) }, { band: 32, normalStrength: 2 });
    expect(m.albedo.width).toBe(128);
    for (let i = 0; i < 128 * 128; i += 97) {
      expect(m.mr.data[i * 4]).toBe(255);
      expect(m.mr.data[i * 4 + 1]).toBe(m.roughness.data[i * 4 + 1]);
      expect(m.mr.data[i * 4 + 2]).toBe(0);
      expect(m.normal.data[i * 4 + 2]).toBeGreaterThan(127);
    }
    expect(m.seam.after).toBeLessThanOrEqual(1.5);
  });
});

describe('runMaterialRecipe', () => {
  it('bakes through Blender, writes the maps, a preview and last.json', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mat-'));
    const cache = { root, work: join(root, 'work') } as ArtCache;
    const scriptsDir = root;
    mkdirSync(join(root, 'mat'), { recursive: true });
    writeFileSync(join(root, 'mat', 'test.py'), '# fake');
    const spawnFn: SpawnLike = (_cmd, args) => {
      const out = args[args.indexOf('--out') + 1]!.replace(/\.glb$/, '');
      for (const [i, name] of ['albedo', 'rough', 'height'].entries()) writeFileSync(`${out}.${name}.png`, encodePng(noise(128, i + 5)));
      const child = Object.assign(new EventEmitter(), { pid: 1, stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true }) as unknown as ChildProcess;
      setImmediate(() => {
        (child.stdout as PassThrough).write('Blender 9.9.9 (hash abc)\n');
        child.emit('close', 0);
      });
      return child;
    };
    const recipe = parseRecipe(TEXT, 'mat.test.yaml');
    if (recipe.kind !== 'material') throw new Error('kind');
    const { dir, meta } = await runMaterialRecipe(recipe, TEXT, cache, { spawnFn, env: { BLENDER: process.execPath }, scriptsDir });
    expect(Object.keys(meta.outputs)).toEqual(['albedo', 'roughness', 'height', 'normal', 'mr', 'preview']);
    expect(decodePng(new Uint8Array(readFileSync(join(dir, 'albedo.png')))).width).toBe(128);
    expect(decodePng(new Uint8Array(readFileSync(join(dir, 'preview.png')))).width).toBe(192);
    expect(existsSync(join(cache.work, 'mat.test', 'last.json'))).toBe(true);
  });
});
