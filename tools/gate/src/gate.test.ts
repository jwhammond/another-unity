// SPDX-License-Identifier: GPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, utimesSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deriveGateKey, deriveIvKey, open } from '../../../apps/web/src/gate/crypto';
import { rangeDigests } from '../../../apps/web/src/gate/disc';
import { parseGateParams, type GateParams } from '../../../apps/web/src/gate/params';
import { chooseRanges, gateYaml } from './init';
import { nodeFolderSource } from './nodeSource';
import { sealGame } from './seal';

const made: string[] = [];
afterEach(async () => {
  await Promise.all(made.splice(0).map(d => rm(d, { recursive: true, force: true })));
});
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'gate-'));
  made.push(d);
  return d;
}

/** A tiny seeded generator (mulberry32). */
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bytes(n: number, seed: number): Buffer {
  const r = seeded(seed);
  return Buffer.from(Uint8Array.from({ length: n }, () => Math.floor(r() * 256)));
}

async function fixtureCd(): Promise<string> {
  const cd = join(await tmp(), 'cd');
  await mkdir(join(cd, 'sub'), { recursive: true });
  await writeFile(join(cd, 'big.zip'), bytes(2_500_000, 1));
  await writeFile(join(cd, 'other.dat'), bytes(1_200_000, 2));
  await writeFile(join(cd, 'tiny.txt'), 'x');
  await writeFile(join(cd, 'sub', 'deep.bin'), bytes(3_000_000, 3));
  return cd;
}

async function fixtureGame(): Promise<string> {
  const g = join(await tmp(), 'game');
  await mkdir(join(g, 'art/x'), { recursive: true });
  await mkdir(join(g, 'audio'), { recursive: true });
  await mkdir(join(g, 'rooms'), { recursive: true });
  await mkdir(join(g, 'overrides'), { recursive: true });
  await writeFile(join(g, 'art/x/a.png'), bytes(300, 4));
  await writeFile(join(g, 'audio/s.ogg'), bytes(500, 5));
  await writeFile(join(g, 'rooms/r.yaml'), 'id: made.up\n');
  await writeFile(join(g, 'game.yaml'), 'title: made up\n');
  await writeFile(join(g, 'combat.yaml'), 'tables: [1, 2]\n');
  await writeFile(join(g, 'overrides/o.yaml'), 'skip: me\n');
  await writeFile(join(g, 'gate.yaml'), 'never: sealed\n');
  return g;
}

const files = [
  { path: 'STTNG.ZIP', size: 40_000_000 },
  { path: 'DATA.DAT', size: 2_000_000 },
  { path: 'SMALL.DAT', size: 900_000 },
  { path: 'SUB/DEEP.BIN', size: 50_000_000 },
];

describe('chooseRanges', () => {
  it('keeps every range inside its file, past byte 5000, 64 KiB-1 MiB', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const ranges = chooseRanges(files, seeded(seed));
      expect(ranges).toHaveLength(4);
      expect(ranges.slice(0, 3).every(r => r.path === 'SUB/DEEP.BIN')).toBe(true);
      expect(['DATA.DAT', 'STTNG.ZIP']).toContain(ranges[3].path);
      for (const r of ranges) {
        const size = files.find(f => f.path === r.path)!.size;
        expect(r.offset).toBeGreaterThanOrEqual(5000);
        expect(r.length).toBeGreaterThanOrEqual(65536);
        expect(r.length).toBeLessThanOrEqual(1048576);
        expect(r.offset + r.length).toBeLessThanOrEqual(size);
      }
    }
  });
  it('is deterministic for a seed and refuses a CD with no second big root file', () => {
    expect(chooseRanges(files, seeded(9))).toEqual(chooseRanges(files, seeded(9)));
    expect(() => chooseRanges([files[0], files[2]], seeded(1))).toThrow(/second root file/);
  });
});

async function params(cdDir: string): Promise<GateParams> {
  const ranges = chooseRanges(
    [{ path: 'BIG.ZIP', size: 2_500_000 }, { path: 'OTHER.DAT', size: 1_200_000 }],
    seeded(7),
  );
  const p = parseGateParams(gateYaml({ version: 1, salt: Uint8Array.from({ length: 32 }, (_, i) => i), ranges }));
  expect(await rangeDigests(nodeFolderSource(cdDir), p)).toHaveLength(4);
  return p;
}

describe('sealGame', () => {
  it('twice gives identical bytes and skips the second time', async () => {
    const cdDir = await fixtureCd();
    const game = await fixtureGame();
    const p = await params(cdDir);
    const outDir = join(game, '.sealed');
    const first = await sealGame({ gameDir: game, outDir, params: p, cd: nodeFolderSource(cdDir) });
    expect(first.sealed).toBe(6);
    const a = await readFile(join(outDir, 'art/x/a.png'));
    const pack = await readFile(join(outDir, 'content.pack'));
    const second = await sealGame({ gameDir: game, outDir, params: p, cd: nodeFolderSource(cdDir) });
    expect(second).toEqual({ sealed: 0, skipped: 6 });
    expect(Buffer.compare(await readFile(join(outDir, 'art/x/a.png')), a)).toBe(0);
    expect(Buffer.compare(await readFile(join(outDir, 'content.pack')), pack)).toBe(0);
    // an input touched later is sealed again, to the same bytes
    const later = new Date(Date.now() + 5000);
    utimesSync(join(game, 'art/x/a.png'), later, later);
    expect(await sealGame({ gameDir: game, outDir, params: p, cd: nodeFolderSource(cdDir) })).toEqual({ sealed: 1, skipped: 5 });
    expect(Buffer.compare(await readFile(join(outDir, 'art/x/a.png')), a)).toBe(0);
  });

  it('content.pack opens to the yaml map without combat.yaml or overrides', async () => {
    const cdDir = await fixtureCd();
    const game = await fixtureGame();
    const p = await params(cdDir);
    const outDir = join(game, '.sealed');
    await sealGame({ gameDir: game, outDir, params: p, cd: nodeFolderSource(cdDir) });
    const digests = await rangeDigests(nodeFolderSource(cdDir), p);
    const key = await deriveGateKey(digests, p.salt);
    const map = JSON.parse(new TextDecoder().decode(await open(key, await readFile(join(outDir, 'content.pack')))));
    expect(map).toEqual({ 'game.yaml': 'title: made up\n', 'rooms/r.yaml': 'id: made.up\n' });
    expect(new TextDecoder().decode(await open(key, await readFile(join(outDir, 'combat.pack'))))).toBe('tables: [1, 2]\n');
    expect(new TextDecoder().decode(await open(key, await readFile(join(outDir, 'audio/s.ogg'))))).toBe(new TextDecoder().decode(bytes(500, 5)));
    expect(JSON.parse(readFileSync(join(outDir, 'gate.json'), 'utf8')).version).toBe(1);
    expect(await deriveIvKey(digests, p.salt)).toBeTruthy();
  });

  it('a removed input is removed from the output', async () => {
    const cdDir = await fixtureCd();
    const game = await fixtureGame();
    const p = await params(cdDir);
    const outDir = join(game, '.sealed');
    await sealGame({ gameDir: game, outDir, params: p, cd: nodeFolderSource(cdDir) });
    expect(existsSync(join(outDir, 'audio/s.ogg'))).toBe(true);
    await rm(join(game, 'audio/s.ogg'));
    await sealGame({ gameDir: game, outDir, params: p, cd: nodeFolderSource(cdDir) });
    expect(existsSync(join(outDir, 'audio/s.ogg'))).toBe(false);
    expect(existsSync(join(outDir, 'art/x/a.png'))).toBe(true);
  });

  it('never seals the transcoder\'s *.cmd notes, and removes one an older run left', async () => {
    const cdDir = await fixtureCd();
    const game = await fixtureGame();
    const p = await params(cdDir);
    const outDir = join(game, '.sealed');
    await writeFile(join(game, 'audio/s.ogg.cmd'), 'ffmpeg -i /made/up/path s.ogg\n');
    await mkdir(join(outDir, 'audio'), { recursive: true });
    await writeFile(join(outDir, 'audio/old.cmd'), 'stale');
    const r = await sealGame({ gameDir: game, outDir, params: p, cd: nodeFolderSource(cdDir) });
    expect(r.sealed).toBe(6);
    expect(existsSync(join(outDir, 'audio/s.ogg.cmd'))).toBe(false);
    expect(existsSync(join(outDir, 'audio/old.cmd'))).toBe(false);
    expect(existsSync(join(outDir, 'audio/s.ogg'))).toBe(true);
  });
});

describe('the CLI', () => {
  it('never prints the salt or an offset', async () => {
    const cdDir = await fixtureCd();
    const game = await fixtureGame();
    await rm(join(game, 'gate.yaml'));
    const root = resolve(import.meta.dirname, '../../..');
    const run = (cmd: string) => spawnSync(join(root, 'node_modules/.bin/tsx'), [join(root, 'tools/gate/src/cli.ts'), cmd], {
      cwd: root, encoding: 'utf8', env: { ...process.env, GAMEDATA_DIR: cdDir, GATE_GAME_DIR: game },
    });
    const init = run('init');
    expect(init.status).toBe(0);
    expect(init.stdout.trim()).toBe('wrote gate.yaml (4 ranges)');
    const yaml = readFileSync(join(game, 'gate.yaml'), 'utf8');
    const p = parseGateParams(yaml);
    const again = run('init');
    expect(again.status).not.toBe(0);
    const seal = run('seal');
    expect(seal.status).toBe(0);
    expect(existsSync(join(game, '.sealed/check.bin'))).toBe(true);
    const salt = Buffer.from(p.salt).toString('base64');
    const secrets = [salt, ...p.ranges.flatMap(r => [String(r.offset), String(r.length)])];
    for (const out of [init.stdout + init.stderr, again.stdout + again.stderr, seal.stdout + seal.stderr]) {
      for (const s of secrets) expect(out).not.toContain(s);
    }
  }, 60000);

  it('prints no range path when a file gate.yaml names is missing', async () => {
    const cdDir = await fixtureCd();
    const game = await fixtureGame();
    await rm(join(game, 'gate.yaml'));
    const root = resolve(import.meta.dirname, '../../..');
    const run = (cmd: string, cd: string) => spawnSync(join(root, 'node_modules/.bin/tsx'), [join(root, 'tools/gate/src/cli.ts'), cmd], {
      cwd: root, encoding: 'utf8', env: { ...process.env, GAMEDATA_DIR: cd, GATE_GAME_DIR: game },
    });
    expect(run('init', cdDir).status).toBe(0);
    const p = parseGateParams(readFileSync(join(game, 'gate.yaml'), 'utf8'));
    const empty = join(await tmp(), 'empty');
    await mkdir(empty);
    const seal = run('seal', empty);
    expect(seal.status).toBe(1);
    const out = seal.stdout + seal.stderr;
    for (const r of p.ranges) expect(out.toLowerCase()).not.toContain(r.path.toLowerCase());
    expect(out).not.toMatch(/\bat .*\(/);
  }, 60000);
  it('writes gate.yaml readable by its owner only', async () => {
    const cdDir = await fixtureCd();
    const game = await fixtureGame();
    await rm(join(game, 'gate.yaml'));
    const root = resolve(import.meta.dirname, '../../..');
    spawnSync(join(root, 'node_modules/.bin/tsx'), [join(root, 'tools/gate/src/cli.ts'), 'init'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, GAMEDATA_DIR: cdDir, GATE_GAME_DIR: game },
    });
    expect(statSync(join(game, 'gate.yaml')).mode & 0o777).toBe(0o600);
  }, 60000);
});
