// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync, mkdtempSync, existsSync, renameSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { build as buildMedia } from '../site-media';
import { build, siteMediaStep } from './build';

describe('deploy build: the site media step', () => {
  it('builds the pictures when the game data is here', () => {
    const calls: { env?: Record<string, string | undefined> }[] = [];
    expect(siteMediaStep({ data: true, art: true }, (_c, _a, o) => { calls.push(o ?? {}); return 0; })).toBe(0);
    expect(calls).toEqual([{}]);
  });
  it('still runs, pointed at no game, in a demo-only build, so stale pictures are cleared', async () => {
    let env: Record<string, string | undefined> | undefined;
    siteMediaStep({ data: false, art: false }, (_c, _a, o) => { env = o?.env; return 0; });
    expect(env?.GAMES_DIR).toBeTruthy();
    // (and that run empties the folder and writes an empty manifest)
    const out = mkdtempSync(join(tmpdir(), 'au-sm-'));
    writeFileSync(join(out, 'stale.webp'), 'x');
    const m = await buildMedia({ GAMES_DIR: env!.GAMES_DIR }, out, `${out}-stage`);
    expect(m.items).toEqual({});
    expect(existsSync(join(out, 'stale.webp'))).toBe(false);
    expect(JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')).items).toEqual({});
  });
});

describe('deploy build: the sealed game', () => {
  const stub = () => {
    const calls: string[] = [];
    const exec = (c: string, a: string[]) => { calls.push([c, ...a].join(' ')); return 0; };
    return { calls, exec };
  };
  const out = () => mkdtempSync(join(tmpdir(), 'au-deploy-'));

  it('the deploy build seals before vite', () => {
    const { calls, exec } = stub();
    expect(build({ exec, have: { data: true, art: true }, gateYaml: true, out: out() })).toBe(true);
    const seal = calls.indexOf('npm run gate:seal');
    const vite = calls.findIndex(c => c.startsWith('npx vite build'));
    expect(seal).toBeGreaterThanOrEqual(0);
    expect(vite).toBeGreaterThan(seal);
  });

  it('without gate.yaml the build stops with the init hint', () => {
    const { calls, exec } = stub();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(build({ exec, have: { data: true, art: true }, gateYaml: false, out: out() })).toBe(false);
      expect(error.mock.calls.flat().join('\n')).toContain('run `npm run gate:init` first');
    } finally {
      error.mockRestore();
    }
    expect(calls).toEqual([]);
  });

  it('a demo-only build has nothing to seal', () => {
    const { calls, exec } = stub();
    vi.stubEnv('AU_DEPLOY_DEMO_ONLY', '1');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(build({ exec, have: { data: false, art: false }, gateYaml: false, out: out() })).toBe(true);
    } finally {
      warn.mockRestore();
      vi.unstubAllEnvs();
    }
    expect(calls.some(c => c.includes('gate:seal'))).toBe(false);
    expect(calls.some(c => c.startsWith('npx vite build'))).toBe(true);
  });
});

describe('site media: a refused or failed run keeps the good set', () => {
  const fixture = (yaml: string) => {
    const games = mkdtempSync(join(tmpdir(), 'au-games-'));
    writeFileSync(join(games, 'presentation.yaml'), yaml);
    const root = mkdtempSync(join(tmpdir(), 'au-dest-'));
    const dest = join(root, 'site-media');
    const stage = join(root, 'stage');
    mkdirSync(dest);
    writeFileSync(join(dest, 'good.webp'), 'x');
    return { games, dest, stage };
  };
  const EMPTY_ART = 'art: { rooms: {}, cards: {}, ship: {}, portraits: {}, icons: {} }\n';

  it('fails, naming IMAGES_DIR, when the game data is here but the originals are not, and changes nothing', async () => {
    const { games, dest, stage } = fixture(EMPTY_ART);
    await expect(buildMedia({ GAMES_DIR: games }, dest, stage)).rejects.toThrow(/IMAGES_DIR is not set/);
    await expect(buildMedia({ GAMES_DIR: games, IMAGES_DIR: join(games, 'nope') }, dest, stage)).rejects.toThrow(/does not exist/);
    expect(existsSync(join(dest, 'good.webp'))).toBe(true);
    expect(existsSync(stage)).toBe(false);
  });
  it('swaps the new set in only on success', async () => {
    const { games, dest, stage } = fixture(EMPTY_ART);
    const m = await buildMedia({ GAMES_DIR: games, IMAGES_DIR: games }, dest, stage);
    expect(m.items).toEqual({});
    expect(existsSync(join(dest, 'good.webp'))).toBe(false);
    expect(existsSync(join(dest, 'manifest.json'))).toBe(true);
    expect(existsSync(stage)).toBe(false);
  });
  it('keeps the old set when the build breaks half way', async () => {
    const { games, dest, stage } = fixture('art: {}\n');
    await expect(buildMedia({ GAMES_DIR: games, IMAGES_DIR: games }, dest, stage)).rejects.toThrow();
    expect(existsSync(join(dest, 'good.webp'))).toBe(true);
    expect(existsSync(stage)).toBe(false);
  });
  it('puts the old set back when the final rename fails', async () => {
    const { games, dest, stage } = fixture(EMPTY_ART);
    let n = 0;
    const flaky: typeof renameSync = (a, b) => { if (++n === 2) throw new Error('disk gone'); renameSync(a, b); };
    await expect(buildMedia({ GAMES_DIR: games, IMAGES_DIR: games }, dest, stage, flaky)).rejects.toThrow('disk gone');
    expect(existsSync(join(dest, 'good.webp'))).toBe(true);
    expect(existsSync(`${stage}-old`)).toBe(false);
  });
});
