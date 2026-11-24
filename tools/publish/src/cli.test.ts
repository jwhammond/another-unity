// SPDX-License-Identifier: GPL-3.0-or-later
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { gateParamsJson } from '../../../apps/web/src/gate/params';

// The cli in a made-up repo: a tree to publish fails closed when an input of the scan is missing.
const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));
const TSX = fileURLToPath(new URL('../../../node_modules/.bin/tsx', import.meta.url));
const made: string[] = [];
afterEach(async () => {
  await Promise.all(made.splice(0).map(d => rm(d, { recursive: true, force: true })));
});

const git = (repo: string, ...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'publish-cli-'));
  made.push(dir);
  git(dir, 'init', '-q', '-b', 'work');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  await writeFile(join(dir, 'a.txt'), 'nothing here\n');
  git(dir, 'add', 'a.txt');
  git(dir, 'commit', '-q', '-m', 'made up');
  // (the game folder is ignored, as in the real repo: the scan reads it from the working tree)
  for (const [p, text] of Object.entries(files)) {
    await mkdir(join(dir, p, '..'), { recursive: true });
    await writeFile(join(dir, p), text);
  }
  return dir;
}

const cli = (cwd: string, ...args: string[]) => spawnSync(TSX, [CLI, ...args], { cwd, encoding: 'utf8' });

const GATE = gateParamsJson({
  version: 1,
  salt: new Uint8Array(32).map((_, i) => i),
  ranges: [1, 2, 3].map(n => ({ path: `MADEUP/FILE${n}.BIN`, offset: 10_000 * n, length: 65_536 })),
});

describe('publish cli', () => {
  it('scan --tree and snapshot fail without gate.yaml, and no public branch is made', async () => {
    const dir = await repo({});
    const scan = cli(dir, 'scan', '--tree', 'HEAD');
    expect(scan.status).not.toBe(0);
    expect(scan.stderr).toMatch(/no usable games\/unity\/gate\.yaml/);
    const snap = cli(dir, 'snapshot');
    expect(snap.status).not.toBe(0);
    expect(snap.stderr).toMatch(/no usable games\/unity\/gate\.yaml/);
    expect(git(dir, 'branch', '--list', 'public')).toBe('');
  }, 30_000);

  it('scan --tree and snapshot fail when the lifted text yields no string', async () => {
    const dir = await repo({ 'games/unity/gate.yaml': GATE, 'games/unity/game.yaml': 'id: 1\n' });
    const scan = cli(dir, 'scan', '--tree', 'HEAD');
    expect(scan.status).not.toBe(0);
    expect(scan.stderr).toMatch(/no lifted text found under games\/unity/);
    expect(cli(dir, 'snapshot').status).not.toBe(0);
    expect(git(dir, 'branch', '--list', 'public')).toBe('');
  }, 30_000);

  it('passes a clean tree once every input is there', async () => {
    const dir = await repo({ 'games/unity/gate.yaml': GATE, 'games/unity/game.yaml': 'line: a made-up line long enough to count\n' });
    const scan = cli(dir, 'scan', '--tree', 'HEAD');
    expect(scan.stdout).toContain('scan: 0 failure(s), 0 warning(s)');
    expect(scan.status).toBe(0);
  }, 30_000);
});
