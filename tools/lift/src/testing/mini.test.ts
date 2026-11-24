// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  AstStatFile, CombatFile, ConversationFile, ExecutableFile, GameObject, IconMap, MovieMap, PhaserMap, ScreenFile,
  SpriteList, TriggersFile, WorldFile,
} from '@another-unity/rawcheck/ir';
import { checkManifest } from '@another-unity/rawcheck/manifest';
import { miniRaw, writeMiniRaw } from './mini';

function schemaFor(path: string): z.ZodTypeAny {
  if (path.startsWith('objects/')) return GameObject;
  if (path.startsWith('conversations/')) return ConversationFile;
  if (path.startsWith('screens/')) return ScreenFile;
  if (path.startsWith('worlds/')) return WorldFile;
  const fixed: Record<string, z.ZodTypeAny> = {
    'triggers.json': TriggersFile, 'maps/phaser.json': PhaserMap, 'maps/icon.json': IconMap,
    'maps/movie.json': MovieMap, 'maps/sprite.json': SpriteList, 'executable.json': ExecutableFile,
    'ast_stat.json': AstStatFile, 'combat.json': CombatFile,
  };
  const schema = fixed[path];
  if (!schema) throw new Error(`no schema for ${path}`);
  return schema;
}

describe('the synthetic raw IR', () => {
  it('passes Plan 3\'s schemas, file by file', () => {
    for (const [path, value] of Object.entries(miniRaw())) {
      if (path === 'manifest.json') continue;
      const result = schemaFor(path).safeParse(value);
      expect(result.success, `${path}: ${result.success ? '' : result.error.message}`).toBe(true);
    }
  });

  it('has a manifest that lists every file it wrote', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mini-raw-'));
    await writeMiniRaw(dir);
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
    expect(checkManifest(manifest)).toEqual([]);
    expect(manifest.objects).toContain('070103');
    expect(manifest.objects).toContain('000004');
    expect(manifest.conversations).toEqual(['w005c015', 'w007c000', 'w05fc034']);
    expect(manifest.screens).toEqual(['s_0701', 's_0702', 's_0703', 's_5f01']);
    expect(manifest.files).toContain('objects/o_070103.json');
    expect(manifest.files).not.toContain('manifest.json');
  });

  it('lets a test change a file before the manifest is built', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mini-raw-'));
    await writeMiniRaw(dir, files => {
      delete files['objects/o_070201.json'];
    });
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
    expect(manifest.objects).not.toContain('070201');
  });
});
