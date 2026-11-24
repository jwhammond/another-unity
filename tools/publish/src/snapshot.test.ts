// SPDX-License-Identifier: GPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanTree } from './scan';
import { makeSnapshot, moveBranch, publishSnapshot } from './snapshot';
import type { Snapshot, SnapshotOptions } from './snapshot';

const made: string[] = [];
afterEach(async () => {
  await Promise.all(made.splice(0).map(d => rm(d, { recursive: true, force: true })));
});

const git = (repo: string, ...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

async function write(repo: string, files: Record<string, string>): Promise<void> {
  for (const [p, text] of Object.entries(files)) {
    await mkdir(dirname(join(repo, p)), { recursive: true });
    await writeFile(join(repo, p), text);
  }
}

async function fixture(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'snapshot-test-'));
  made.push(repo);
  git(repo, 'init', '-q', '-b', 'work');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  await write(repo, { 'a.txt': 'one\n', 'docs/notes/x.md': 'a note\n', 'docs/keep.md': 'kept\n' });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'first');
  await write(repo, { 'a.txt': 'two\n' });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'second');
  return repo;
}

const opts = (repo: string): SnapshotOptions => ({ repo, branch: 'public', exclude: ['docs/notes'], message: 'Made Up' });
/** Makes the snapshot and moves the branch to it, unchecked. */
const snap = (repo: string): Snapshot => {
  const s = makeSnapshot(opts(repo));
  moveBranch(repo, 'public', s);
  return s;
};
const files = (repo: string, rev: string) => git(repo, 'ls-tree', '-r', '--name-only', rev).split('\n');

describe('makeSnapshot', () => {
  it("makes one commit with no parent holding HEAD's tree less the excluded folders", async () => {
    const repo = await fixture();
    const s = makeSnapshot(opts(repo));
    expect(s).toMatchObject({ parent: null, unchanged: false });
    // (the commit is made before the branch moves)
    expect(() => git(repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/public')).toThrow();
    moveBranch(repo, 'public', s);
    expect(git(repo, 'rev-parse', 'public')).toBe(s.commit);
    expect(git(repo, 'rev-list', '--count', 'public')).toBe('1');
    expect(git(repo, 'log', '-1', '--format=%B', 'public')).toBe('Made Up');
    expect(files(repo, 'public')).toEqual(['a.txt', 'docs/keep.md']);
    expect(git(repo, 'show', 'public:a.txt')).toBe('two');
  });

  it('leaves the working tree, the real index and the checked-out branch alone', async () => {
    const repo = await fixture();
    await write(repo, { 'a.txt': 'staged\n', 'b.txt': 'untracked\n' });
    git(repo, 'add', 'a.txt');
    await write(repo, { 'a.txt': 'unstaged\n' });
    const before = [git(repo, 'status', '--porcelain'), git(repo, 'diff', '--cached'), git(repo, 'rev-parse', 'HEAD'), git(repo, 'branch', '--show-current')];
    snap(repo);
    const after = [git(repo, 'status', '--porcelain'), git(repo, 'diff', '--cached'), git(repo, 'rev-parse', 'HEAD'), git(repo, 'branch', '--show-current')];
    expect(after).toEqual(before);
    // (uncommitted changes are not in the snapshot)
    expect(git(repo, 'show', 'public:a.txt')).toBe('two');
    expect(files(repo, 'public')).not.toContain('b.txt');
  });

  it('puts a later snapshot on top of the last, and makes none when nothing changed', async () => {
    const repo = await fixture();
    const first = snap(repo);
    expect(snap(repo)).toEqual({ commit: first.commit, parent: first.commit, unchanged: true });
    await write(repo, { 'a.txt': 'three\n', 'docs/notes/y.md': 'another note\n' });
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'third');
    const second = snap(repo);
    expect(second).toMatchObject({ parent: first.commit, unchanged: false });
    expect(git(repo, 'rev-parse', `${second.commit}^`)).toBe(first.commit);
    expect(git(repo, 'rev-list', '--count', 'public')).toBe('2');
    expect(files(repo, 'public')).toEqual(['a.txt', 'docs/keep.md']);
    expect(git(repo, 'show', 'public:a.txt')).toBe('three');
  });

  it('moves the branch only when the check passes: a tree with a planted hit leaves it where it was', async () => {
    const repo = await fixture();
    const SENTENCE = 'an invented sentence planted as lifted text';
    const check = async (commit: string) =>
      (await scanTree({ repo, rev: commit, strings: [SENTENCE] })).every(h => h.level !== 'fail');
    const first = await publishSnapshot(opts(repo), check);
    expect(first).toMatchObject({ passed: true, parent: null });
    expect(git(repo, 'rev-parse', 'public')).toBe(first.commit);

    await write(repo, { 'b.txt': `say: ${SENTENCE}\n` });
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'planted');
    const failed = await publishSnapshot(opts(repo), check);
    expect(failed).toMatchObject({ passed: false, parent: first.commit, unchanged: false });
    expect(git(repo, 'rev-parse', 'public')).toBe(first.commit);

    // (fixed: the next snapshot goes on the last good one, not the failed one)
    await write(repo, { 'b.txt': 'say: something else\n' });
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'fixed');
    const fixed = await publishSnapshot(opts(repo), check);
    expect(fixed).toMatchObject({ passed: true, parent: first.commit });
    expect(git(repo, 'rev-parse', 'public^')).toBe(first.commit);
  });
});
