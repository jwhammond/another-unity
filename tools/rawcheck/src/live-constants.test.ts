// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CombatFile } from './ir';
import { readJson } from './raw';

// RAW_DIR=$HOME/pcode/unity-raw/runs/export/raw; the citations are the unity-engine branch's (Plan 18 R1), read only
const RAW = process.env.RAW_DIR ?? '';
const REFERENCE = join(homedir(), 'pcode/scummvm/engines/unity');
const ready = RAW !== '' && existsSync(REFERENCE);
if (!ready) console.info('live-constants.test.ts: skipped; needs RAW_DIR and ~/pcode/scummvm/engines/unity');

type Token = number | string;

/** The numbers (decimal or hex, maybe negative), quoted strings and character literals on some lines of C++, in order. */
function cppTokens(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(/"([^"]*)"|'(.)'|(-?)(0x[0-9a-fA-F]+|\d+)/g)) {
    if (m[1] !== undefined) out.push(m[1]);
    else if (m[2] !== undefined) out.push(m[2]);
    else {
      const n = m[4]!.startsWith('0x') ? parseInt(m[4]!.slice(2), 16) : Number(m[4]);
      out.push(m[3] ? -n : n);
    }
  }
  return out;
}

/** A constant's values in order. The -1-terminated lists (*HitLists, *Areas: `terminated`) stop each row after its -1, as the C++ source writes them (the rest is the array's zero fill); every other table, the phasers' {0,-1,200} among them, is compared whole. */
function constantTokens(value: unknown, terminated = true): Token[] {
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every(Array.isArray)) {
      return value.flatMap(row => {
        const r = row as unknown[];
        const end = terminated ? r.indexOf(-1) : -1;
        return constantTokens(end < 0 ? r : r.slice(0, end + 1));
      });
    }
    return value.flatMap(v => constantTokens(v));
  }
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(v => constantTokens(v));
  return [value as Token];
}

function isSubsequence(want: Token[], have: Token[]): boolean {
  let i = 0;
  for (const t of have) if (i < want.length && t === want[i]) i++;
  return i === want.length;
}

describe('the drift guard\'s reading of C++ (synthetic)', () => {
  it('reads numbers, hex, negatives, strings and characters, and trims rows at -1', () => {
    expect(cppTokens(`static const int k[2][3] = { { 'c', 0x3b }, { "zap", -1 } };`)).toEqual([2, 3, 'c', 59, 'zap', -1]);
    expect(constantTokens([[7, 1, -1, 0], [20, -1, 0, 0]])).toEqual([7, 1, -1, 20, -1]);
    expect(constantTokens({ screen: 52, ids: [1, 5] })).toEqual([52, 1, 5]);
    expect(isSubsequence([1, 5], [52, 1, 2, 5])).toBe(true);
    expect(isSubsequence([5, 1], [52, 1, 2, 5])).toBe(false);
  });
});

describe.skipIf(!ready)('combat.json\'s constants against the ScummVM source they cite (Plan 18 R2)', () => {
  it('finds every constant\'s values, in order, on its cited lines', async () => {
    const combat = CombatFile.parse(await readJson(RAW, 'combat.json'));
    const problems: string[] = [];
    let checked = 0;
    // (kCueIds is a table of cited constants, one a cue: Plan 23 R1; kConsoleText one a string the console draws: Plan 27 R15)
    const entries = [
      ...Object.entries(combat), ...Object.entries(combat.kCueIds).map(([n, e]) => [`kCueIds.${n}`, e] as const),
      ...Object.entries(combat.kConsoleText ?? {}).map(([n, e]) => [`kConsoleText.${n}`, e] as const),
    ];
    for (const [name, entry] of entries) {
      if (entry === null || typeof entry !== 'object' || !('source' in entry)) continue;
      const { source, value } = entry as { source: string; value: unknown };
      const m = /^([a-z_0-9]+\.(?:cpp|h)):(\d+)(?:-(\d+))?$/.exec(source)!;
      const lines = (await readFile(join(REFERENCE, m[1]!), 'utf8')).split('\n');
      const have = cppTokens(lines.slice(Number(m[2]) - 1, Number(m[3] ?? m[2])).join('\n'));
      if (!isSubsequence(constantTokens(value, /HitLists$|Areas$/.test(name)), have)) problems.push(`${name}: not all of ${JSON.stringify(value)} is on ${source}`);
      checked++;
    }
    expect(problems).toEqual([]);
    // (Plan 18's 18, kBearing and kShieldNames, the 65 cue ids, and the console's 7 strings)
    expect(checked).toBe(92);
  });
});
