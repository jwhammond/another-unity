// SPDX-License-Identifier: GPL-3.0-or-later
// The pre-upload checks of a deploy build (docs/deploy.md): Cloudflare Pages' limits, and nothing that must not ship.
// The rules are pure functions (check.test.ts); `main` walks the output directory and prints the report. Exit 1 on any failure.
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sampleLiftedText } from '../../../../tools/publish/src/textSample';
import { HEADER_BYTES, isSealed } from '../../src/gate/crypto';
import { GAME_PAGE, SITE_PAGES, type Manifest } from '../../src/swRules';

/** Cloudflare Pages' limits (free and paid plans alike for a direct upload): files per deployment, and the size of one file. */
export const MAX_FILES = 20_000;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** Header and redirect file limits of Pages. */
export const MAX_HEADER_RULES = 100;
export const MAX_HEADER_LINE = 2000;
/** Warn when within this share of a limit. */
const WARN_SHARE = 0.9;

export interface FileInfo { path: string; size: number }
export interface Finding { level: 'fail' | 'warn'; message: string }

/** File names that must never ship, with why. (Paths are relative to the output, with `/`.) */
const FORBIDDEN_NAMES: { re: RegExp; why: string }[] = [
  { re: /\.map$/i, why: 'a source map' },
  { re: /(^|\/)\.env(\.|$)|\.env$/i, why: 'an env file (secrets)' },
  { re: /(^|\/)\.dev\.vars/i, why: 'a Wrangler secrets file' },
  { re: /\.(pem|key|p12|pfx|crt|cer)$/i, why: 'a key or certificate' },
  { re: /jellyfin/i, why: 'Jellyfin configuration' },
  { re: /(^|\/)(traces?|walks?)(\/|$)|\.(trace|walk|jsonl)$|(^|\/)trace[-_.]/i, why: 'a trace or walkthrough file' },
  { re: /(^|\/)\.git(\/|ignore$|attributes$|$)/i, why: 'git metadata' },
  { re: /(^|\/)node_modules(\/|$)/, why: 'node_modules' },
  { re: /site-media[^/]*\.(tmp|old)(\/|$)|\.site-media\./i, why: 'a half-built site-media folder' },
  { re: /\.(log|tsbuildinfo)$/i, why: 'a log or build-info file' },
  { re: /\.(ya?ml|ts|tsx|md)$/i, why: 'a source or raw data file (the build bundles what it needs)' },
  { re: /(^|\/)(functions|\.wrangler)(\/|$)/, why: 'Wrangler/Functions sources (wrangler reads functions/ from the project root, not the output)' },
];

/** The names that are only a nuisance: dropped by Wrangler itself, but listed. */
const NUISANCE = /(^|\/)\.DS_Store$/;

/** Text found inside the shipped code that means a dev hook or a secret got in. */
const FORBIDDEN_TEXT: { re: RegExp; why: string }[] = [
  { re: /sourceMappingURL=/, why: 'a source-map reference' },
  { re: /\bastroKnow\b/, why: 'the astroKnow test hook' },
  { re: /\b__au(?![A-Za-z0-9_])/, why: 'the window.__au test handle' },
  { re: /\bexposeDebug\b/, why: 'the debug handle (exposeDebug)' },
  { re: /Dev tools/, why: 'the dev overlay' },
  { re: /VITE_AU_DEPLOY/, why: 'an unreplaced VITE_AU_DEPLOY (the build was not a deploy build)' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, why: 'a private key' },
  { re: /\b(CLOUDFLARE_API_TOKEN|CF_API_TOKEN|JELLYFIN_[A-Z_]+|SITE_PASSWORD|COMFY_URL|TURNSTILE_SECRET_KEY|FEEDBACK_WEBHOOK)\b/, why: 'the name of a secret or local setting' },
  { re: /\/Users\/[A-Za-z0-9._-]+\//, why: 'a local absolute path' },
];

const TEXT_FILE = /\.(m?js|css|html?|json|webmanifest|svg|txt)$/i;
/** Files that are not scanned for text (served as they are; the lifted game data is already part of the bundle). */
export const SCAN_LIMIT_BYTES = 64 * 1024 * 1024;

export function checkLimits(files: readonly FileInfo[]): Finding[] {
  const out: Finding[] = [];
  const count = files.length;
  if (count > MAX_FILES) {
    out.push({
      level: 'fail',
      message: `${count} files: over Pages' limit of ${MAX_FILES}. Bundle small files together (one audio sprite sheet or pack per scene instead of one file each, `
        + 'as engineering.pack does), or move the media to Cloudflare R2 and serve them from there.',
    });
  } else if (count > MAX_FILES * WARN_SHARE) {
    out.push({ level: 'warn', message: `${count} files: within 10% of Pages' limit of ${MAX_FILES}.` });
  }
  for (const f of files) {
    if (f.size > MAX_FILE_BYTES) {
      out.push({
        level: 'fail',
        message: `${f.path} is ${mib(f.size)}: over Pages' limit of ${mib(MAX_FILE_BYTES)} for one file. Split it (more manualChunks / one chunk per world), `
          + 'recompress it (lossy WebP or Opus at a lower bitrate, a smaller movie), or move it to Cloudflare R2.',
      });
    } else if (f.size > MAX_FILE_BYTES * WARN_SHARE) {
      out.push({ level: 'warn', message: `${f.path} is ${mib(f.size)}: within 10% of the ${mib(MAX_FILE_BYTES)} single-file limit.` });
    }
  }
  return out;
}

export function checkNames(files: readonly FileInfo[]): Finding[] {
  const out: Finding[] = [];
  for (const f of files) {
    if (NUISANCE.test(f.path)) {
      out.push({ level: 'warn', message: `${f.path}: a .DS_Store (Wrangler skips it)` });
      continue;
    }
    for (const rule of FORBIDDEN_NAMES) if (rule.re.test(f.path)) out.push({ level: 'fail', message: `${f.path}: ${rule.why} would ship.` });
  }
  return out;
}

/** Scans one text file's contents for dev hooks and secrets. */
export function checkText(path: string, text: string): Finding[] {
  const out: Finding[] = [];
  for (const rule of FORBIDDEN_TEXT) if (rule.re.test(text)) out.push({ level: 'fail', message: `${path}: contains ${rule.why}.` });
  return out;
}

/** Pages' `_headers` limits: 100 rules, 2000 characters a line. A rule is a path line (not indented) followed by its indented headers. */
export function checkHeadersFile(text: string): Finding[] {
  const out: Finding[] = [];
  const rules = text.split('\n').filter(l => /^\S/.test(l) && !l.startsWith('#')).length;
  if (rules > MAX_HEADER_RULES) out.push({ level: 'fail', message: `_headers has ${rules} rules: Pages allows ${MAX_HEADER_RULES}.` });
  for (const [i, line] of text.split('\n').entries()) {
    if (line.length > MAX_HEADER_LINE) out.push({ level: 'fail', message: `_headers line ${i + 1} is ${line.length} characters: Pages allows ${MAX_HEADER_LINE}.` });
  }
  return out;
}

/** What a built game output must have to be worth uploading. */
export function checkRequired(files: readonly FileInfo[]): Finding[] {
  const have = new Set(files.map(f => f.path));
  // (every page of the site, and the game's shell: the worker precaches them, so one missing from the output is a broken deploy)
  const need = [...new Set([...SITE_PAGES.map(p => `${p.slice(1)}index.html`), `${GAME_PAGE.slice(1)}index.html`, 'sw.js', 'au-manifest.json', '_headers'])];
  return need.filter(n => !have.has(n)).map(n => ({ level: 'fail' as const, message: `${n} is missing from the output.` }));
}

/** Every file the worker precaches (the manifest's shell and data lists) must be in the output: the worker's install fails on one missing file, and then nothing works offline. */
export function checkManifest(files: readonly FileInfo[], manifestText: string): Finding[] {
  let m: { shell?: string[]; data?: string[] };
  try { m = JSON.parse(manifestText) as typeof m; } catch { return [{ level: 'fail', message: 'au-manifest.json is not valid JSON.' }]; }
  const have = new Set(files.map(f => `/${f.path}`));
  // (and every page of the site is in it: a page left out would not be there offline)
  const pages = SITE_PAGES.map(p => `${p}index.html`).filter(u => !(m.shell ?? []).includes(u)).map(u => ({ level: 'fail' as const, message: `au-manifest.json does not precache ${u}.` }));
  return [...pages, ...[...(m.shell ?? []), ...(m.data ?? [])].filter(u => !have.has(u)).map(u => ({ level: 'fail' as const, message: `au-manifest.json lists ${u}, which is not in the output (the service worker would fail to install).` }))];
}

/**
 * The gate (docs/deploy.md): every file the manifest calls sealed starts with the sealed header, and no shipped file is a byte-for-byte
 * copy of one under games/unity (`plainHashes`: their SHA-256s, but the committed hooks and theme.css, and the sealed copies). The site's
 * before-and-after pictures are outside games/unity, so they ship as they are.
 */
export function checkSealed(files: readonly FileInfo[], manifest: Pick<Manifest, 'sealed'>, head: (path: string) => Uint8Array,
  plainHashes: ReadonlySet<string>, hash: (path: string) => string): Finding[] {
  const out: Finding[] = [];
  const have = new Set(files.map(f => f.path));
  for (const url of manifest.sealed ?? []) {
    const path = url.replace(/^\//, '');
    if (!have.has(path)) out.push({ level: 'fail', message: `${path}: listed as sealed, but not in the output.` });
    else if (!isSealed(head(path))) out.push({ level: 'fail', message: `${path}: listed as sealed, but has no sealed header.` });
  }
  if (plainHashes.size > 0) {
    for (const f of files) if (plainHashes.has(hash(f.path))) out.push({ level: 'fail', message: `${f.path}: a plain copy of a file from games/unity.` });
  }
  return out;
}

/** The forms a string takes in a shipped file: as it is, and inside a JS or JSON string literal. */
function shippedForms(s: string): string[] {
  const literal = JSON.stringify(s).slice(1, -1);
  return literal === s ? [s] : [s, literal];
}

/** Whether a shipped file holds any of the sampled lifted strings. Only the count is said: the text itself is never quoted. */
export function checkLiftedText(path: string, text: string, sample: readonly string[]): Finding[] {
  const hits = sample.filter(s => shippedForms(s).some(form => text.includes(form))).length;
  return hits === 0 ? [] : [{ level: 'fail', message: `${path}: holds lifted game text (${hits} sampled string${hits === 1 ? '' : 's'}).` }];
}

/** Compressed pictures, sounds, movies and fonts: they can't hold the game's text as it is, so the lifted-text search passes over them. */
const COMPRESSED_MEDIA = /\.(webp|png|jpe?g|gif|opus|ogg|webm|mp4|woff2?)$/i;

function sha256File(path: string): string {
  const h = createHash('sha256');
  const buf = Buffer.alloc(1 << 20);
  const fd = openSync(path, 'r');
  try {
    for (let n; (n = readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return h.digest('hex');
}

function headOf(path: string): Uint8Array {
  const buf = Buffer.alloc(HEADER_BYTES);
  const fd = openSync(path, 'r');
  try {
    return buf.subarray(0, readSync(fd, buf, 0, HEADER_BYTES, 0));
  } finally {
    closeSync(fd);
  }
}

/**
 * The SHA-256 of every file under games/unity but `hooks/`, `theme.css` and `.sealed/` (and empty files, which say nothing), read a
 * piece at a time. Only files of a size in `sizes` (the shipped files') are hashed: a file of another size can't be a copy of a shipped
 * one. `sizes` in the answer are those the hashed files have.
 */
export function gamePlainHashes(gameDir: string, sizes: ReadonlySet<number>): { hashes: Set<string>; sizes: Set<number> } {
  const out = { hashes: new Set<string>(), sizes: new Set<number>() };
  const walk = (d: string, top: boolean): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (top && (e.name === 'hooks' || e.name === 'theme.css' || e.name === '.sealed')) continue;
      if (e.isDirectory()) walk(full, false);
      else if (e.isFile()) {
        const size = statSync(full).size;
        if (size > 0 && sizes.has(size)) {
          out.hashes.add(sha256File(full));
          out.sizes.add(size);
        }
      }
    }
  };
  walk(gameDir, true);
  return out;
}

export const mib = (n: number): string => `${(n / 1024 / 1024).toFixed(n < 1024 * 1024 ? 3 : 1)} MiB`;

export interface Report {
  count: number;
  total: number;
  largest: FileInfo[];
  byExt: { ext: string; count: number; bytes: number }[];
}

export function summarize(files: readonly FileInfo[], top = 10): Report {
  const byExt = new Map<string, { count: number; bytes: number }>();
  for (const f of files) {
    const ext = /\.([A-Za-z0-9]+)$/.exec(f.path)?.[1]?.toLowerCase() ?? '(none)';
    const e = byExt.get(ext) ?? { count: 0, bytes: 0 };
    e.count++;
    e.bytes += f.size;
    byExt.set(ext, e);
  }
  return {
    count: files.length,
    total: files.reduce((n, f) => n + f.size, 0),
    largest: [...files].sort((a, b) => b.size - a.size).slice(0, top),
    byExt: [...byExt].map(([ext, v]) => ({ ext, ...v })).sort((a, b) => b.bytes - a.bytes),
  };
}

export async function listFiles(dir: string): Promise<FileInfo[]> {
  const out: FileInfo[] = [];
  async function walk(d: string): Promise<void> {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) out.push({ path: relative(dir, full).split(sep).join('/'), size: (await stat(full)).size });
    }
  }
  await walk(dir);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export const GAME_DIR = fileURLToPath(new URL('../../../../games/unity', import.meta.url));

/**
 * Runs every check on a built directory. Returns the findings and the report; the caller prints and decides. With the lifted game here
 * (`gameDir`/game.yaml), the gate's checks too: the sealed files are sealed, nothing is a plain copy of a game file, and no file but a
 * sealed one or compressed media holds a sample of the lifted text.
 */
export async function checkDir(dir: string, gameDir = GAME_DIR): Promise<{ findings: Finding[]; report: Report }> {
  const files = await listFiles(dir);
  const findings: Finding[] = [...checkRequired(files), ...checkLimits(files), ...checkNames(files)];
  const gate = existsSync(join(gameDir, 'game.yaml'));
  let manifest: Pick<Manifest, 'sealed'> = { sealed: [] };
  if (files.some(f => f.path === 'au-manifest.json')) {
    try { manifest = JSON.parse(await readFile(join(dir, 'au-manifest.json'), 'utf8')) as Manifest; } catch { /* (checkManifest says so) */ }
  }
  const sealed = new Set((manifest.sealed ?? []).map(u => u.replace(/^\//, '')));
  const sample = gate ? sampleLiftedText(gameDir) : [];
  for (const f of files) {
    if (f.path === 'au-manifest.json') findings.push(...checkManifest(files, await readFile(join(dir, f.path), 'utf8')));
    if (f.path === '_headers') findings.push(...checkHeadersFile(await readFile(join(dir, f.path), 'utf8')));
    const text = TEXT_FILE.test(f.path) && f.size <= SCAN_LIMIT_BYTES;
    const lifted = gate && !sealed.has(f.path) && !COMPRESSED_MEDIA.test(f.path) && f.size <= SCAN_LIMIT_BYTES;
    if (!text && !lifted) continue;
    const content = await readFile(join(dir, f.path), 'utf8');
    if (text) findings.push(...checkText(f.path, content));
    if (lifted) findings.push(...checkLiftedText(f.path, content, sample));
  }
  if (gate) {
    const sizeOf = new Map(files.map(f => [f.path, f.size]));
    const plain = gamePlainHashes(gameDir, new Set(sizeOf.values()));
    // (a shipped file of a size no game file has can't be a copy of one: it isn't read)
    findings.push(...checkSealed(files, manifest, p => headOf(join(dir, p)), plain.hashes,
      p => (plain.sizes.has(sizeOf.get(p)!) ? sha256File(join(dir, p)) : '')));
    if (sample.length === 0) findings.push({ level: 'warn', message: 'no lifted text found to sample: the lifted-text check had nothing to look for.' });
  }
  return { findings, report: summarize(files) };
}

export function printReport(report: Report, findings: readonly Finding[], log: (s: string) => void = console.log): void {
  log(`files:  ${report.count} (limit ${MAX_FILES})`);
  log(`size:   ${mib(report.total)} in total (single-file limit ${mib(MAX_FILE_BYTES)})`);
  log('largest files:');
  for (const f of report.largest) log(`  ${mib(f.size).padStart(11)}  ${f.path}`);
  log('by type:');
  for (const e of report.byExt.slice(0, 8)) log(`  ${String(e.count).padStart(6)} x .${e.ext.padEnd(8)} ${mib(e.bytes)}`);
  for (const f of findings) log(`${f.level === 'fail' ? 'FAIL' : 'warn'}: ${f.message}`);
  const fails = findings.filter(f => f.level === 'fail').length;
  log(fails === 0 ? 'checks passed.' : `checks FAILED: ${fails} problem${fails === 1 ? '' : 's'}. Nothing should be uploaded.`);
}

export const DEFAULT_DIR = fileURLToPath(new URL('../../dist-deploy', import.meta.url));

async function main(): Promise<void> {
  const dir = process.argv[2] ?? DEFAULT_DIR;
  const { findings, report } = await checkDir(dir).catch((e: unknown) => {
    console.error(`cannot read ${dir}: ${e instanceof Error ? e.message : String(e)}\nRun \`npm run deploy:build\` first.`);
    process.exit(1);
  });
  printReport(report, findings);
  process.exit(findings.some(f => f.level === 'fail') ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main();
