// SPDX-License-Identifier: GPL-3.0-or-later
// A sample of the lifted game text, for the deploy check that no shipped file holds it (docs/deploy.md). The sample lives in memory only:
// it is never written down or printed, as the strings are the original game's.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAllDocuments } from 'yaml';

/** Folders and files under the game folder that aren't lifted text: the committed overrides, the sealed copies, and the gate's parameters
 * (which the bundle holds of necessity, docs/deploy.md). */
const SKIP_DIRS = new Set(['overrides', '.sealed', 'node_modules']);
const SKIP_FILES = new Set(['gate.yaml']);

function yamlFiles(dir: string, top: boolean, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (!(top && SKIP_DIRS.has(e.name))) yamlFiles(full, false, out);
    } else if (e.isFile() && /\.ya?ml$/i.test(e.name) && !(top && SKIP_FILES.has(e.name))) {
      out.push(full);
    }
  }
}

/** A name's shape: four words or fewer, not ending as a sentence does. */
function nameShaped(s: string): boolean {
  return s.split(/\s+/).length <= 4 && !/[.?!]$/.test(s);
}

/** Every string value in a parsed document (keys are ids, not text), except name-shaped ones held directly under a key in `skipKeys`. */
function strings(v: unknown, out: Set<string>, minLength: number, skipKeys: Set<string>): void {
  if (typeof v === 'string') {
    const s = v.trim();
    // (prose only: an id or a path has no space, and the engine's own code may name one)
    if (s.length >= minLength && /\s/.test(s)) out.add(s);
  } else if (Array.isArray(v)) {
    for (const x of v) strings(x, out, minLength, skipKeys);
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (!(typeof x === 'string' && skipKeys.has(k) && nameShaped(x.trim()))) strings(x, out, minLength, skipKeys);
    }
  }
}

/**
 * Up to `count` (500) strings of at least `minLength` (20) characters, chosen at random from the string scalars of every yaml file under
 * `gameDir`, except `overrides/` and `.sealed/`. A file that doesn't parse is passed over. A name-shaped value (four words or fewer, not
 * ending in . ? or !) held directly under a key in `skipKeys` is left out unless it also appears elsewhere (the tree scan skips names,
 * which the public tree may hold: docs/publish.md); a longer value there is taken like any other.
 */
export function sampleLiftedText(
  gameDir: string,
  o: { count?: number; minLength?: number; skipKeys?: string[]; random?: () => number } = {},
): string[] {
  const count = o.count ?? 500;
  const skipKeys = new Set(o.skipKeys ?? []);
  const random = o.random ?? Math.random;
  const files: string[] = [];
  yamlFiles(gameDir, true, files);
  const found = new Set<string>();
  for (const file of files.sort()) {
    try {
      for (const doc of parseAllDocuments(readFileSync(file, 'utf8'))) {
        if (!('errors' in doc) || doc.errors.length > 0) continue;
        strings(doc.toJS({ maxAliasCount: -1 }), found, o.minLength ?? 20, skipKeys);
      }
    } catch {
      // (not yaml we can read: nothing from it)
    }
  }
  // (a partial Fisher-Yates shuffle: the first `count` are the sample)
  const all = [...found].sort();
  const n = Math.min(count, all.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(random() * (all.length - i));
    [all[i], all[j]] = [all[j]!, all[i]!];
  }
  return all.slice(0, n);
}
