// SPDX-License-Identifier: GPL-3.0-or-later
// `gate:init`: choose which byte ranges of the CD feed the key. Done once; the choice is kept in gate.yaml, never committed.
import { stringify } from 'yaml';
import { normalizeCdPath } from '../../../apps/web/src/gate/disc';
import type { GateParams, GateRange } from '../../../apps/web/src/gate/params';

const MIN_OFFSET = 5000;
const MIN_LENGTH = 65536;
const MAX_LENGTH = 1048576;
const MIN_OTHER = 1048576;

const between = (random: () => number, lo: number, hi: number): number => lo + Math.floor(random() * (hi - lo + 1));

function rangeIn(path: string, size: number, random: () => number): GateRange {
  const length = Math.min(between(random, MIN_LENGTH, MAX_LENGTH), size - MIN_OFFSET);
  if (length < MIN_LENGTH) throw new Error('gate init: a file is too small to hold a range');
  return { path: normalizeCdPath(path), offset: between(random, MIN_OFFSET, size - length), length };
}

/** Three ranges inside the largest file, one inside another root file of at least 1 MiB. */
export function chooseRanges(files: { path: string; size: number }[], random: () => number): GateRange[] {
  if (files.length === 0) throw new Error('gate init: the CD folder has no files');
  const largest = files.reduce((a, b) => (b.size > a.size ? b : a));
  const others = files.filter(f => f !== largest && !f.path.replace(/\\/g, '/').includes('/') && f.size >= MIN_OTHER);
  if (others.length === 0) throw new Error('gate init: no second root file of at least 1 MiB');
  const other = others[between(random, 0, others.length - 1)];
  return [
    rangeIn(largest.path, largest.size, random),
    rangeIn(largest.path, largest.size, random),
    rangeIn(largest.path, largest.size, random),
    rangeIn(other.path, other.size, random),
  ];
}

export function newSalt(): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(32));
}

/** The gate.yaml text: version, salt (base64) and ranges. */
export function gateYaml(p: GateParams): string {
  return stringify({ version: p.version, salt: Buffer.from(p.salt).toString('base64'), ranges: p.ranges });
}
