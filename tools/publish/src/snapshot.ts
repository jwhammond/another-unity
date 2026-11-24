// SPDX-License-Identifier: GPL-3.0-or-later
// The public snapshot (docs/publish.md): the public repo holds HEAD's tree, less the working notes, as commits on a branch of its own
// whose first commit has no parent, since the local history holds the game's text. Built through a private index, so the working tree,
// the real index and the other branches are never touched; uncommitted changes are not in it. The commit is made first and checked, and
// the branch moves to it only when the check passes, so a tree that fails never becomes the parent of a later snapshot.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface SnapshotOptions {
  repo: string;
  /** The branch the snapshot goes on ('public'). */
  branch: string;
  /** Repo-relative folders left out of the snapshot. */
  exclude: string[];
  message: string;
  /** The rev whose tree is published ('HEAD'). */
  rev?: string;
}

export interface Snapshot {
  commit: string;
  /** The branch's head before, which is the new commit's parent; null for the first snapshot. */
  parent: string | null;
  /** True when the tree is the branch's already, so no commit was made. */
  unchanged: boolean;
}

/** Makes the snapshot's commit object, on top of the branch's head when there is one; the branch itself is not moved. */
export function makeSnapshot(o: SnapshotOptions): Snapshot {
  const dir = mkdtempSync(join(tmpdir(), 'snapshot-'));
  const env = { ...process.env, GIT_INDEX_FILE: join(dir, 'index') };
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: o.repo, env, encoding: 'utf8' }).trim();
  try {
    git('read-tree', o.rev ?? 'HEAD');
    for (const path of o.exclude) git('rm', '--cached', '-r', '-q', '--ignore-unmatch', '--', path);
    const tree = git('write-tree');
    const ref = `refs/heads/${o.branch}`;
    let parent: string | null = null;
    try {
      parent = git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`) || null;
    } catch {
      // (no such branch yet: the first snapshot)
    }
    if (parent && git('rev-parse', `${parent}^{tree}`) === tree) return { commit: parent, parent, unchanged: true };
    const commit = git('commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', o.message);
    return { commit, parent, unchanged: false };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Moves `branch` to the snapshot's commit, only from the head the snapshot was made on. */
export function moveBranch(repo: string, branch: string, s: Snapshot): void {
  if (s.unchanged) return;
  execFileSync('git', ['update-ref', '-m', 'publish:snapshot', `refs/heads/${branch}`, s.commit, s.parent ?? ''], { cwd: repo });
}

/**
 * Makes the snapshot, runs `check` on its commit, and moves the branch to it only when the check passes. On a failure the branch stays
 * where it was (the commit object is left unreferenced, for git's gc).
 */
export async function publishSnapshot(
  o: SnapshotOptions,
  check: (commit: string) => Promise<boolean>,
): Promise<Snapshot & { passed: boolean }> {
  const s = makeSnapshot(o);
  const passed = await check(s.commit);
  if (passed) moveBranch(o.repo, o.branch, s);
  return { ...s, passed };
}
