// SPDX-License-Identifier: GPL-3.0-or-later
// The scan before the repo goes public: the working history and every commit in it (scanRepo), or every file of one tree (scanTree), for
// the game's files, original media, secrets, lifted text and the gate's parameters. A hit names its rule, commit, path and line, never
// the matched text (the strings are the original game's, or secrets).
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { GateParams } from '../../../apps/web/src/gate/params';

export interface Hit {
  rule: string;
  commit: string;
  path: string;
  line?: number;
  lineHash?: string;
  /** A file rule's hit (tree mode): the blob's git object id, for an `allowFiles` entry. */
  blob?: string;
  level: 'fail' | 'warn';
}

export interface ScanOptions {
  repo: string;
  /** Repo-relative paths the game's .gitignore lists: a trailing slash is a folder, otherwise one file. */
  ignoredGamePaths: string[];
  textSample: string[];
  gate?: GateParams;
  allow: { commit: string; lineHash: string }[];
}

const MEDIA = /\.(spr|pic|fvf|rac|voc|mrg|3dv|3dr|dmg|zip)$/i;
const IMAGE = /\.(png|webp|jpg)$/i;
/** In a tree to publish, any picture, sound, movie, model or packed file: a transcoded copy of the game's media would be one of these. */
const TREE_MEDIA = /\.(webp|png|jpg|jpeg|gif|bmp|ktx2|opus|ogg|wav|mp3|webm|mp4|glb|gltf|pack|fon)$/i;

const SECRETS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY/,
  /ghp_[A-Za-z0-9]{30,}/,
  /sk-[A-Za-z0-9]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /JELLYFIN_[A-Z_]*=\S{8,}/,
  /(api[_-]?key|token|password)\s*[:=]\s*['"][^'"\s]{12,}['"]/i,
];

const ABS_PATH = '/Us' + 'ers/';
const MARK = '@@COMMIT@@ ';

/** Streams the lines of `git <args>` run in `repo`. */
async function* gitLines(repo: string, args: string[]): AsyncGenerator<string> {
  const child = spawn('git', ['-c', 'core.quotepath=false', ...args], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
  const exited = new Promise<number | null>(resolve => child.on('close', resolve));
  for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) yield line;
  if ((await exited) !== 0) throw new Error(`git ${args[0]} failed: ${err.trim().slice(0, 200)}`);
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function isIgnoredGamePath(path: string, ignored: string[]): boolean {
  return ignored.some(p => (p.endsWith('/') ? path.startsWith(p) : path === p));
}

export async function scanRepo(o: ScanOptions): Promise<Hit[]> {
  const hits: Hit[] = [];
  const allowed = new Set(o.allow.map(a => `${a.commit}\0${a.lineHash}`));
  const allowedFor = (commit: string, lineHash: string): boolean =>
    allowed.has(`${commit}\0${lineHash}`) || o.allow.some(a => a.lineHash === lineHash && a.commit.length >= 7 && commit.startsWith(a.commit));

  // Paths: every path any commit touched.
  let commit = '';
  for await (const line of gitLines(o.repo, ['log', '--all', '--name-only', `--format=${MARK}%H`])) {
    if (line.startsWith(MARK)) { commit = line.slice(MARK.length); continue; }
    if (!line) continue;
    if (isIgnoredGamePath(line, o.ignoredGamePaths)) hits.push({ rule: 'game-path', commit, path: line, level: 'fail' });
    if (MEDIA.test(line)) hits.push({ rule: 'original-media', commit, path: line, level: 'fail' });
    else if (IMAGE.test(line)) hits.push({ rule: 'image', commit, path: line, level: 'warn' });
  }

  // Added lines.
  const sample = o.textSample.filter(s => s.length > 0);
  const gateRule = gateTest(o.gate);
  let path = '';
  let inHunk = false;
  let next = 0;
  commit = '';
  for await (const line of gitLines(o.repo, ['log', '-p', '--all', '--no-color', '--no-renames', `--format=${MARK}%H`])) {
    if (line.startsWith(MARK)) { commit = line.slice(MARK.length); inHunk = false; continue; }
    if (line.startsWith('diff --git ')) { inHunk = false; path = ''; continue; }
    if (!inHunk || line.startsWith('@@ ')) {
      // (headers, until the first hunk; then each hunk's own header)
      if (!inHunk && line.startsWith('+++ ')) path = line.startsWith('+++ b/') ? line.slice(6) : path;
      else if (line.startsWith('@@ ')) {
        const m = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
        next = m ? Number(m[1]) : 0;
        inHunk = true;
      }
      continue;
    }
    if (line[0] === '+' || line[0] === ' ') {
      const lineNo = next++;
      if (line[0] === '+') added(line.slice(1), lineNo);
    }
  }
  return hits;

  function added(text: string, lineNo: number): void {
    const matched = lineRules(text, l => sample.some(s => l.includes(s)), gateRule);
    if (matched.length === 0) return;
    const lineHash = sha256(text);
    if (allowedFor(commit, lineHash)) return;
    for (const [rule, level] of matched) hits.push({ rule, commit, path, line: lineNo, lineHash, level });
  }
}

/** The gate rule's test for one line: the salt (as base64 or hex), or a range's path with its offset. */
function gateTest(gate: GateParams | undefined): (text: string) => boolean {
  const salt = gate?.salt;
  const saltB64 = salt ? Buffer.from(salt).toString('base64') : '';
  const saltHex = salt ? Buffer.from(salt).toString('hex') : '';
  const ranges = (gate?.ranges ?? []).map(r => ({ path: r.path, offset: String(r.offset) }));
  return text =>
    (!!salt && (text.includes(saltB64) || text.toLowerCase().includes(saltHex))) ||
    ranges.some(r => text.includes(r.path) && text.includes(r.offset));
}

/** The line rules a line breaks, in report order. An absolute home path is a warning in the history and a failure in a tree to publish. */
function lineRules(
  text: string,
  lifted: (text: string) => boolean,
  gate: (text: string) => boolean,
  absPath: 'fail' | 'warn' = 'warn',
): [string, 'fail' | 'warn'][] {
  const matched: [string, 'fail' | 'warn'][] = [];
  if (SECRETS.some(re => re.test(text))) matched.push(['secret', 'fail']);
  if (lifted(text)) matched.push(['lifted-text', 'fail']);
  if (gate(text)) matched.push(['gate', 'fail']);
  if (text.includes(ABS_PATH)) matched.push(['abs-path', absPath]);
  return matched;
}

const PREFIX = 8;

/**
 * A test for whether a line holds any of `strings` as a substring, for many strings at once: the strings are indexed by their first
 * eight characters, and each position of the line is one lookup. (Shorter strings are checked one by one.)
 */
export function substringMatcher(strings: string[]): (text: string) => boolean {
  const byPrefix = new Map<string, string[]>();
  const short: string[] = [];
  for (const s of new Set(strings)) {
    if (s.length === 0) continue;
    if (s.length < PREFIX) { short.push(s); continue; }
    const k = s.slice(0, PREFIX);
    const list = byPrefix.get(k);
    if (list) list.push(s);
    else byPrefix.set(k, [s]);
  }
  return text => {
    if (short.some(s => text.includes(s))) return true;
    if (byPrefix.size === 0) return false;
    for (let i = 0; i + PREFIX <= text.length; i++) {
      const list = byPrefix.get(text.slice(i, i + PREFIX));
      if (list && list.some(s => text.startsWith(s, i))) return true;
    }
    return false;
  };
}

export interface TreeScanOptions {
  repo: string;
  /** A commit, branch or tree-ish. */
  rev: string;
  /** The lifted strings: a line holding any of them is a `lifted-text` hit. */
  strings: string[];
  /** Repo-relative path prefixes passed over (a trailing slash is a folder). */
  exclude?: string[];
  /** The game's ignored paths, as for `scanRepo`: a tracked file under one is a `game-path` hit. */
  ignoredGamePaths?: string[];
  gate?: GateParams;
  /** Reviewed lines: an entry drops the hits on a line with its hash (and, when it names one, in its path). */
  allow?: { lineHash: string; path?: string }[];
  /** Reviewed files: a binary, media or oversized file at `path` whose blob is `blob` (its git object id) is let through. */
  allowFiles?: { path: string; blob: string }[];
}

const MAX_BYTES = 2 * 1024 * 1024;

/** The contents of `oids`, in order, through one `git cat-file --batch`. */
async function blobs(repo: string, oids: string[]): Promise<Buffer[]> {
  if (oids.length === 0) return [];
  const child = spawn('git', ['cat-file', '--batch'], { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] });
  const chunks: Buffer[] = [];
  let err = '';
  child.stdout.on('data', (d: Buffer) => chunks.push(d));
  child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
  const exited = new Promise<number | null>(resolve => child.on('close', resolve));
  child.stdin.end(oids.join('\n') + '\n');
  if ((await exited) !== 0) throw new Error(`git cat-file failed: ${err.trim().slice(0, 200)}`);
  const all = Buffer.concat(chunks);
  const out: Buffer[] = [];
  let at = 0;
  for (const oid of oids) {
    const nl = all.indexOf(0x0a, at);
    const header = all.subarray(at, nl).toString();
    const m = /^(\S+) (\S+) (\d+)$/.exec(header);
    if (!m) throw new Error(`git cat-file: no object ${oid}`);
    const size = Number(m[3]);
    out.push(all.subarray(nl + 1, nl + 1 + size));
    at = nl + 1 + size + 1;
  }
  return out;
}

/**
 * Every tracked file of `rev` (text files of 2 MB or less, outside `exclude`), line by line: the lifted strings, secrets, the gate's
 * parameters and absolute home paths (all failures); and the paths themselves, for the game's files and original media. A tree to
 * publish holds no media at all: a binary file, a picture, sound, movie or model by its extension, or a file over 2 MB fails too
 * (`binary`, `media`, `large`; their hits carry the blob's id), unless `allowFiles` names its path and blob. Hits carry the commit the
 * rev names (or the rev itself, for a bare tree), the path, the line number and the line's SHA-256, never the text.
 */
export async function scanTree(o: TreeScanOptions): Promise<Hit[]> {
  const exclude = o.exclude ?? [];
  const ignored = o.ignoredGamePaths ?? [];
  const excluded = (p: string): boolean => exclude.some(e => (e.endsWith('/') ? p.startsWith(e) : p === e));
  let commit = o.rev;
  try {
    for await (const line of gitLines(o.repo, ['rev-parse', '--verify', '--quiet', `${o.rev}^{commit}`])) if (line) commit = line;
  } catch {
    // (a bare tree: the hits name the rev)
  }
  const lifted = substringMatcher(o.strings);
  const gate = gateTest(o.gate);
  const allow = o.allow ?? [];
  const allowed = (path: string, lineHash: string): boolean => allow.some(a => a.lineHash === lineHash && (!a.path || a.path === path));
  const fileAllowed = (path: string, blob: string): boolean => (o.allowFiles ?? []).some(a => a.path === path && a.blob === blob);
  const hits: Hit[] = [];
  const fileHit = (rule: string, path: string, blob: string): void => {
    if (!fileAllowed(path, blob)) hits.push({ rule, commit, path, blob, level: 'fail' });
  };

  const files: { path: string; oid: string }[] = [];
  for await (const line of gitLines(o.repo, ['ls-tree', '-r', '-l', '--full-tree', o.rev])) {
    // (<mode> <type> <oid> <size>\t<path>)
    const tab = line.indexOf('\t');
    const [, type, oid, size] = line.slice(0, tab).split(/\s+/);
    const path = line.slice(tab + 1);
    if (type !== 'blob' || excluded(path)) continue;
    if (isIgnoredGamePath(path, ignored)) hits.push({ rule: 'game-path', commit, path, level: 'fail' });
    if (MEDIA.test(path)) hits.push({ rule: 'original-media', commit, path, level: 'fail' });
    if (TREE_MEDIA.test(path)) fileHit('media', path, oid!);
    if (Number(size) > MAX_BYTES) {
      fileHit('large', path, oid!);
      continue;
    }
    files.push({ path, oid: oid! });
  }

  const contents = await blobs(o.repo, files.map(f => f.oid));
  files.forEach(({ path, oid }, i) => {
    const buf = contents[i]!;
    if (buf.subarray(0, 8000).includes(0)) {
      fileHit('binary', path, oid);
      return;
    }
    buf.toString('utf8').split('\n').forEach((raw, n) => {
      const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      const matched = lineRules(text, lifted, gate, 'fail');
      if (matched.length === 0) return;
      const lineHash = sha256(text);
      if (allowed(path, lineHash)) return;
      for (const [rule, level] of matched) hits.push({ rule, commit, path, line: n + 1, lineHash, level });
    });
  });
  return hits;
}

/** One line per hit: rule, level, commit, path and line number (or the file's blob id), never the line. */
export function formatHit(h: Hit): string {
  return `${h.level.toUpperCase().padEnd(4)} ${h.rule.padEnd(14)} ${h.commit.slice(0, 12)} ${h.path}${h.line ? `:${h.line}` : ''}`
    + `${h.lineHash ? ` [${h.lineHash}]` : ''}${h.blob ? ` [blob ${h.blob}]` : ''}`;
}
