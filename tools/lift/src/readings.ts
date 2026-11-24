// SPDX-License-Identifier: GPL-3.0-or-later
import type { ReadingPage } from '@another-unity/engine';
import { worldSlug } from './ids';
import type { Problems } from './problems';
import type { RawIR } from './raw';

export type ReadingsFile = Record<string, Record<number, ReadingPage[]>>;

const latin1 = new TextDecoder('latin1');

export interface ParsedComputerEntry {
  flags: number;
  title: string;
  heading: string;
  text: string;
  /** Entry indexes. 0 or -1 is a subentry offset no entry has (loadComputerDatabase's error(): the root is never a subentry). */
  subentries: number[];
}

/**
 * UnityData::loadComputerDatabase: each entry's flags, strings and subentries (its picture or place isn't needed: M3 Plan 8 R8).
 * A subentry is stored as an entry's offset; it resolves to that entry's index, or -1 when no entry has the offset.
 */
export function parseComputerDb(bytes: Uint8Array): ParsedComputerEntry[] {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = v.getUint32(0, true);
  const offsets = Array.from({ length: count }, (_, i) => v.getUint32(4 + 4 * i, true));
  // (one more offset, the end of the file, is skipped)
  const start = 8 + 4 * count;
  const str = (at: number) => {
    let end = start + at;
    while (end < bytes.length && bytes[end] !== 0) end++;
    return latin1.decode(bytes.subarray(start + at, end));
  };
  return offsets.map(off => {
    const e = start + off;
    const subentries = Array.from({ length: v.getUint16(e, true) }, (_, j) => offsets.indexOf(v.getUint32(e + 20 + 4 * j, true)));
    return {
      flags: v.getUint16(e + 2, true), title: str(v.getUint32(e + 4, true)), heading: str(v.getUint32(e + 8, true)),
      text: str(v.getUint32(e + 12, true)), subentries,
    };
  });
}

/** _tricorderReadings for the lifted worlds: key = world * 10000 + group * 10 + i (runTricorder). */
export function liftReadings(raw: RawIR, worlds: readonly number[], problems: Problems): ReadingsFile {
  const table = raw.executable._tricorderReadings
    .filter(r => worlds.includes(Math.floor(r.key / 10000)))
    .sort((a, b) => a.key - b.key);
  if (table.length === 0) return {};
  if (!raw.computer) {
    problems.warn('verbatim/computer.db', 'not in the export (sh tools/rawcheck/run-harness.sh export 300): the tricorder shows reading numbers');
    return {};
  }
  const entries = parseComputerDb(raw.computer);
  const out: ReadingsFile = {};
  for (const r of table) {
    const e = entries[r.entry];
    if (!e) {
      problems.warn('executable.json#/_tricorderReadings', `reading ${r.key} names computer entry ${r.entry}, which computer.db lacks`);
      continue;
    }
    const world = worldSlug(Math.floor(r.key / 10000));
    const group = Math.floor((r.key % 10000) / 10);
    ((out[world] ??= {})[group] ??= []).push({ title: e.title, heading: e.heading, text: e.text });
  }
  return out;
}
