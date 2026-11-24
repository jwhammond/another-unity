// SPDX-License-Identifier: GPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { readScanInputs, type Sample, type ScanInputs } from './inputs';
import { formatHit, scanRepo, scanTree } from './scan';
import type { Hit } from './scan';
import { publishSnapshot } from './snapshot';
import { addSpdx } from './spdx';

/** Tracked files only: git-ignored paths (the lifted game data among them) are never listed. */
function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 });
  return out.split('\0').filter(Boolean);
}

function spdx(): void {
  let changed = 0;
  for (const path of trackedFiles()) {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    const next = addSpdx(path, text);
    if (next === null) continue;
    writeFileSync(path, next);
    changed++;
  }
  console.log(`spdx: ${changed} file(s) changed`);
}

const GAME_DIR = 'games/unity';

/** The game's .gitignore, as repo-relative paths (a trailing slash is a folder). */
function ignoredGamePaths(): string[] {
  const file = `${GAME_DIR}/.gitignore`;
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .map(l => `${GAME_DIR}/${l.replace(/^\//, '')}`);
}

/** The scan's inputs (inputs.ts): a tree to publish needs every one, the history takes what it finds. */
function scanInputs(sample: Sample, strict: boolean): ScanInputs {
  return readScanInputs({ gameDir: GAME_DIR, allowPath: 'tools/publish/allow.json', sample, strict });
}

/** Prints the hits and the summary line; true when none fails. */
function report(hits: Hit[]): boolean {
  for (const h of hits) console.log(formatHit(h));
  const fails = hits.filter(h => h.level === 'fail').length;
  console.log(`scan: ${fails} failure(s), ${hits.length - fails} warning(s)`);
  return fails === 0;
}

/** The folders the public tree leaves out: the working notes, which quote the game while the engine was built (docs/publish.md). */
const PUBLIC_EXCLUDE = ['docs/superpowers/'];

/** The keys whose values are names (of characters, places, ships and things), which the public tree may hold (docs/publish.md). */
const NAME_KEYS = ['name', 'title', 'heading'];

/** A tree's inputs: every lifted string (not a sample) but the names; each input must be there (throws). */
const treeInputs = (): ScanInputs => scanInputs({ count: Infinity, minLength: 12, skipKeys: NAME_KEYS }, true);

/** Every tracked file of `rev`, against every lifted string but the names. */
async function scanTreeOf(rev: string, exclude: string[], inputs: ScanInputs = treeInputs()): Promise<boolean> {
  const { gate, text, allow } = inputs;
  const hits = await scanTree({
    repo: '.', rev, strings: text, exclude, ignoredGamePaths: ignoredGamePaths(), gate,
    allow: allow.flatMap(a => (a.lineHash ? [{ lineHash: a.lineHash, ...(a.path ? { path: a.path } : {}) }] : [])),
    allowFiles: allow.flatMap(a => (a.path && a.blob ? [{ path: a.path, blob: a.blob }] : [])),
  });
  return report(hits);
}

async function scan(args: string[]): Promise<void> {
  const tree = args.indexOf('--tree');
  if (tree >= 0) {
    const rev = args[tree + 1];
    if (!rev) throw new Error('--tree needs a rev');
    if (!(await scanTreeOf(rev, args.includes('--all') ? [] : PUBLIC_EXCLUDE))) process.exit(1);
    return;
  }
  const { gate, text, allow } = scanInputs({}, false);
  const hits = await scanRepo({
    repo: '.', ignoredGamePaths: ignoredGamePaths(), textSample: text, gate,
    allow: allow.flatMap(a => (a.commit && a.lineHash ? [{ commit: a.commit, lineHash: a.lineHash }] : [])),
  });
  if (!report(hits)) process.exit(1);
}

const PUBLIC_BRANCH = 'public';

/** Puts HEAD's tree, less the working notes, on the public branch (docs/publish.md) once it scans clean. */
async function snapshot(): Promise<void> {
  console.log("snapshot: from HEAD's tree; uncommitted changes are not in it");
  // (read first: with an input missing, no commit is made at all)
  const inputs = treeInputs();
  // (the whole tree of the new commit: the notes are out of it already)
  const s = await publishSnapshot(
    { repo: '.', branch: PUBLIC_BRANCH, exclude: PUBLIC_EXCLUDE, message: 'Another Unity\n\nAssisted-by: Claude:claude-opus-5-5' },
    commit => scanTreeOf(commit, [], inputs),
  );
  const short = s.commit.slice(0, 12);
  if (!s.passed) {
    console.log(`snapshot: the scan failed; ${PUBLIC_BRANCH} stays at ${s.parent ? s.parent.slice(0, 12) : '(none)'}`);
    process.exit(1);
  }
  if (s.unchanged) console.log(`snapshot: ${PUBLIC_BRANCH} is HEAD's tree already (${short}); no commit made`);
  else console.log(`snapshot: ${PUBLIC_BRANCH} is ${short}${s.parent ? `, on top of ${s.parent.slice(0, 12)}` : ', a first commit with no parent'}`);
}

const [cmd, ...rest] = process.argv.slice(2);
const run = (name: string, p: Promise<void>): void => {
  p.catch((e: unknown) => {
    console.error(`${name}: ${e instanceof Error ? e.message : 'failed'}`);
    process.exit(2);
  });
};
if (cmd === 'spdx') spdx();
else if (cmd === 'scan') run('scan', scan(rest));
else if (cmd === 'snapshot') run('snapshot', snapshot());
else {
  console.error('usage: cli.ts spdx | scan [--tree <rev> [--all]] | snapshot');
  process.exit(2);
}
