// SPDX-License-Identifier: GPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatHit, scanRepo, scanTree, substringMatcher } from './scan';
import type { GateParams } from '../../../apps/web/src/gate/params';

const made: string[] = [];
afterEach(async () => {
  await Promise.all(made.splice(0).map(d => rm(d, { recursive: true, force: true })));
});

const git = (repo: string, ...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });

async function commit(repo: string, files: Record<string, string>): Promise<string> {
  for (const [p, text] of Object.entries(files)) {
    await mkdir(dirname(join(repo, p)), { recursive: true });
    await writeFile(join(repo, p), text);
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'made up');
  return git(repo, 'rev-parse', 'HEAD').trim();
}

// (assembled, so this file doesn't trip the scan itself)
const GHP = 'gh' + 'p_' + 'a'.repeat(32);
const SENTENCE = 'a made-up sentence of invented prose';
const SALT = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const GATE: GateParams = { version: 1, salt: SALT, ranges: [{ path: 'DISC/MADEUP.BIN', offset: 123457, length: 70000 }] };

async function fixture(): Promise<{ repo: string; commits: Record<string, string>; secretHash: string }> {
  const repo = await mkdtemp(join(tmpdir(), 'scan-'));
  made.push(repo);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  const commits: Record<string, string> = {};
  commits.clean = await commit(repo, { 'a.txt': 'nothing here\n' });
  commits.game = await commit(repo, { 'game/secret/one.txt': 'x\n' });
  commits.media = await commit(repo, { 'dump/Thing.SPR': 'x\n' });
  commits.image = await commit(repo, { 'art/pic.png': 'x\n' });
  commits.secret = await commit(repo, { 'b.txt': `line one\nkey ${GHP}\n` });
  commits.lifted = await commit(repo, { 'c.txt': `say: ${SENTENCE}\n` });
  commits.gate = await commit(repo, { 'd.txt': `salt ${Buffer.from(SALT).toString('base64')}\n` });
  commits.abs = await commit(repo, { 'e.txt': `see ${'/Us' + 'ers/'}someone/x\n` });
  return { repo, commits, secretHash: createHash('sha256').update(`key ${GHP}`).digest('hex') };
}

describe('scanRepo', () => {
  it('reports one hit per rule, by location only', async () => {
    const { repo, commits } = await fixture();
    const hits = await scanRepo({ repo, ignoredGamePaths: ['game/secret/'], textSample: [SENTENCE], gate: GATE, allow: [] });
    const byRule = (r: string) => hits.filter(h => h.rule === r);
    expect(byRule('game-path')).toMatchObject([{ commit: commits.game, path: 'game/secret/one.txt', level: 'fail' }]);
    expect(byRule('original-media')).toMatchObject([{ commit: commits.media, path: 'dump/Thing.SPR', level: 'fail' }]);
    expect(byRule('image')).toMatchObject([{ commit: commits.image, path: 'art/pic.png', level: 'warn' }]);
    expect(byRule('secret')).toMatchObject([{ commit: commits.secret, path: 'b.txt', line: 2, level: 'fail' }]);
    expect(byRule('lifted-text')).toMatchObject([{ commit: commits.lifted, path: 'c.txt', line: 1 }]);
    expect(byRule('gate')).toMatchObject([{ commit: commits.gate, path: 'd.txt', line: 1 }]);
    expect(byRule('abs-path')).toMatchObject([{ commit: commits.abs, path: 'e.txt', line: 1, level: 'warn' }]);
    expect(hits).toHaveLength(7);
    const shown = JSON.stringify(hits) + hits.map(formatHit).join('\n');
    for (const secret of [GHP, SENTENCE, Buffer.from(SALT).toString('base64')]) expect(shown).not.toContain(secret);
  });

  it('flags a line holding a range path and its offset', async () => {
    const { repo } = await fixture();
    await commit(repo, { 'f.txt': 'read DISC/MADEUP.BIN at 123457\n' });
    const hits = await scanRepo({ repo, ignoredGamePaths: [], textSample: [], gate: GATE, allow: [] });
    expect(hits.filter(h => h.rule === 'gate').map(h => h.path).sort()).toEqual(['d.txt', 'f.txt']);
  });

  it('drops a hit whose commit and line hash are allow-listed', async () => {
    const { repo, commits, secretHash } = await fixture();
    const hits = await scanRepo({
      repo, ignoredGamePaths: [], textSample: [], allow: [{ commit: commits.secret!, lineHash: secretHash }],
    });
    expect(hits.filter(h => h.rule === 'secret')).toEqual([]);
    expect(hits.filter(h => h.rule === 'abs-path')).toHaveLength(1);
  });

  it('takes an allow-list entry straight from the report line', async () => {
    const { repo } = await fixture();
    const opts = { repo, ignoredGamePaths: [], textSample: [], allow: [] };
    const hit = (await scanRepo(opts)).find(h => h.rule === 'secret')!;
    const m = /^\S+\s+secret\s+(\w+) \S+ \[([0-9a-f]{64})\]$/.exec(formatHit(hit));
    expect(m).not.toBeNull();
    const after = await scanRepo({ ...opts, allow: [{ commit: m![1]!, lineHash: m![2]! }] });
    expect(after.filter(h => h.rule === 'secret')).toEqual([]);
  });
});

describe('substringMatcher', () => {
  it('finds any of many strings, long or short, anywhere in a line', () => {
    const has = substringMatcher(['an invented line of prose', 'another invented line', 'tiny']);
    expect(has('x: "another invented line here"')).toBe(true);
    expect(has('an invented line of prose')).toBe(true);
    expect(has('it is tiny')).toBe(true);
    expect(has('an invented line of pros')).toBe(false);
    expect(has('')).toBe(false);
    expect(substringMatcher([])('anything')).toBe(false);
  });
});

describe('scanTree', () => {
  async function treeFixture(): Promise<string> {
    const repo = await mkdtemp(join(tmpdir(), 'scantree-'));
    made.push(repo);
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'user.email', 'test@example.invalid');
    // (the history holds a line the tree no longer does: a tree scan doesn't see it)
    await commit(repo, { 'old.txt': `${SENTENCE}\n` });
    await rm(join(repo, 'old.txt'));
    await commit(repo, {
      'src/a.ts': `const x = 1;\nconst y = 'say: ${SENTENCE}';\n`,
      'src/b.ts': `line\r\nkey ${GHP}\r\n`,
      'notes/skip/c.md': `${SENTENCE}\n`,
      'd.txt': `salt ${Buffer.from(SALT).toString('base64')}\nsee ${'/Us' + 'ers/'}someone/x\n`,
      'game/secret/one.txt': 'x\n',
      'dump/Thing.SPR': 'x\n',
      'bin.dat': Buffer.from([1, 0, 2]).toString('latin1') + SENTENCE,
    });
    return repo;
  }

  it('reports every rule in the tree by path and line, never the text', async () => {
    const repo = await treeFixture();
    const head = git(repo, 'rev-parse', 'HEAD').trim();
    const hits = await scanTree({
      repo, rev: 'HEAD', strings: [SENTENCE], exclude: ['notes/skip/'], ignoredGamePaths: ['game/secret/'], gate: GATE,
    });
    const byRule = (r: string) => hits.filter(h => h.rule === r).map(h => ({ path: h.path, line: h.line, level: h.level, commit: h.commit }));
    expect(byRule('lifted-text')).toEqual([{ path: 'src/a.ts', line: 2, level: 'fail', commit: head }]);
    expect(byRule('secret')).toEqual([{ path: 'src/b.ts', line: 2, level: 'fail', commit: head }]);
    expect(byRule('gate')).toEqual([{ path: 'd.txt', line: 1, level: 'fail', commit: head }]);
    // (a failure in a tree, unlike the history)
    expect(byRule('abs-path')).toEqual([{ path: 'd.txt', line: 2, level: 'fail', commit: head }]);
    expect(byRule('game-path')).toMatchObject([{ path: 'game/secret/one.txt', level: 'fail' }]);
    expect(byRule('original-media')).toMatchObject([{ path: 'dump/Thing.SPR', level: 'fail' }]);
    expect(byRule('binary')).toMatchObject([{ path: 'bin.dat', level: 'fail' }]);
    expect(hits).toHaveLength(7);
    // (the line hash is of the line without its carriage return)
    expect(hits.find(h => h.rule === 'secret')!.lineHash).toBe(createHash('sha256').update(`key ${GHP}`).digest('hex'));
    const shown = JSON.stringify(hits) + hits.map(formatHit).join('\n');
    for (const secret of [GHP, SENTENCE, Buffer.from(SALT).toString('base64')]) expect(shown).not.toContain(secret);
  });

  it('drops a hit whose line hash is allow-listed, in any path or in the one named', async () => {
    const repo = await treeFixture();
    const hash = createHash('sha256').update(`const y = 'say: ${SENTENCE}';`).digest('hex');
    const run = (allow: { lineHash: string; path?: string }[]) =>
      scanTree({ repo, rev: 'HEAD', strings: [SENTENCE], exclude: ['notes/skip/'], allow });
    expect((await run([{ lineHash: hash }])).filter(h => h.rule === 'lifted-text')).toEqual([]);
    expect((await run([{ lineHash: hash, path: 'src/a.ts' }])).filter(h => h.rule === 'lifted-text')).toEqual([]);
    expect((await run([{ lineHash: hash, path: 'src/other.ts' }])).filter(h => h.rule === 'lifted-text')).toHaveLength(1);
  });

  it('fails on media, binary and oversized files unless their path and blob are allow-listed', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'scantree-'));
    made.push(repo);
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'user.email', 'test@example.invalid');
    await commit(repo, {
      'art/made-up.webp': 'not really a picture\n',
      'audio/made-up.OPUS': 'not really a sound\n',
      'big.txt': 'x'.repeat(2 * 1024 * 1024 + 1),
      'bin.dat': Buffer.from([1, 0, 2]).toString('latin1'),
      'ok.ts': 'const fine = 1;\n',
    });
    const blob = (path: string): string => git(repo, 'rev-parse', `HEAD:${path}`).trim();
    const hits = await scanTree({ repo, rev: 'HEAD', strings: [] });
    expect(hits.map(h => [h.rule, h.path, h.level]).sort()).toEqual([
      ['binary', 'bin.dat', 'fail'],
      ['large', 'big.txt', 'fail'],
      ['media', 'art/made-up.webp', 'fail'],
      ['media', 'audio/made-up.OPUS', 'fail'],
    ]);
    // (the report names the blob, for an allow-list entry)
    expect(formatHit(hits.find(h => h.path === 'bin.dat')!)).toContain(`[blob ${blob('bin.dat')}]`);
    const allowFiles = ['art/made-up.webp', 'audio/made-up.OPUS', 'big.txt', 'bin.dat'].map(path => ({ path, blob: blob(path) }));
    expect(await scanTree({ repo, rev: 'HEAD', strings: [], allowFiles })).toEqual([]);
    // (the same path with other bytes, or the same bytes elsewhere, is not the file reviewed)
    const wrongBlob = allowFiles.map(a => (a.path === 'bin.dat' ? { ...a, blob: blob('ok.ts') } : a));
    expect((await scanTree({ repo, rev: 'HEAD', strings: [], allowFiles: wrongBlob })).map(h => h.path)).toEqual(['bin.dat']);
    const wrongPath = allowFiles.map(a => (a.path === 'big.txt' ? { ...a, path: 'other.txt' } : a));
    expect((await scanTree({ repo, rev: 'HEAD', strings: [], allowFiles: wrongPath })).map(h => h.path)).toEqual(['big.txt']);
  });

  it('scans an older rev, not the working tree', async () => {
    const repo = await treeFixture();
    const first = git(repo, 'rev-list', '--max-parents=0', 'HEAD').trim();
    const hits = await scanTree({ repo, rev: first, strings: [SENTENCE] });
    expect(hits.map(h => [h.rule, h.path, h.line])).toEqual([['lifted-text', 'old.txt', 1]]);
  });
});
