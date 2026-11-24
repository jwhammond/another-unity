// SPDX-License-Identifier: GPL-3.0-or-later
import type { ComputerReading, ComputerTree } from '@another-unity/engine';
import type { Problems } from './problems';
import { worldSlug } from './ids';
import { parseComputerDb } from './readings';
import type { RawIR } from './raw';

/** computer.cpp's kNumHiddenBits: the hidden bits' size in compstat is a bit each. */
const NUM_HIDDEN_BITS = 2048;

/** ComputerScreen::reset (computer.cpp:192-204): the hidden bits (a bit per entry), then a count of rows each with 4 skipped bytes and the reading's key. */
export function parseCompstat(bytes: Uint8Array): { hidden: number[]; startReadings: number[] } {
  const hidden: number[] = [];
  for (let i = 0; i < NUM_HIDDEN_BITS; i++) if (((bytes[i >> 3] ?? 0) >> (i & 7)) & 1) hidden.push(i);
  const startReadings: number[] = [];
  const at = NUM_HIDDEN_BITS / 8;
  if (bytes.length >= at + 4) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = v.getUint32(at, true);
    // (the loop stops at the end of the file, as `!stream->eos()` does)
    for (let i = 0; i < count && at + 4 + 8 * i + 8 <= bytes.length; i++) startReadings.push(v.getUint32(at + 4 + 8 * i + 4, true));
  }
  return { hidden, startReadings };
}

/**
 * The ship's computer (Plan 10 Task 8): every computer.db entry with its subentries as indexes, `_computerEntryIds`, and each
 * reading's parent heading. A subentry offset no entry has is dropped with a warning, where loadComputerDatabase calls error().
 */
export function liftComputer(raw: RawIR, problems: Problems): ComputerTree | undefined {
  // (read before the early return, so the lossless check sees them read even without computer.db)
  const readingParents: Record<number, number> = {};
  for (const r of raw.executable._tricorderReadings) readingParents[r.key] = r.parent;
  const entryIds = raw.executable._computerEntryIds.map(id => id);
  // (key = world * 10000 + group * 10 + i: tricorder.cpp:100; the engine never parses a key)
  const readings: ComputerReading[] = raw.executable._tricorderReadings.map(r => ({
    key: r.key, world: worldSlug(Math.floor(r.key / 10000)), group: Math.floor(r.key / 10) % 1000, index: r.key % 10, entry: r.entry, parent: r.parent,
  }));
  if (!raw.computer) {
    problems.warn('verbatim/computer.db', 'not in the export (sh tools/rawcheck/run-harness.sh export 300): the ship\'s computer is not lifted');
    return undefined;
  }
  const entries = parseComputerDb(raw.computer).map((e, i) => ({
    title: e.title, heading: e.heading, text: e.text, flags: e.flags,
    subentries: e.subentries.filter((s, j) => {
      if (s > 0) return true;
      problems.warn('verbatim/computer.db', `entry ${i} (${JSON.stringify(e.title)}): subentry ${j} of ${e.subentries.length} matches no entry (ScummVM stops with an error)`);
      return false;
    }),
  }));
  if (!raw.compstat) problems.warn('verbatim/compstat', 'not in the export (sh tools/rawcheck/run-harness.sh export 300): no entry is hidden and no reading is recorded at the start');
  const { hidden, startReadings } = raw.compstat ? parseCompstat(raw.compstat) : { hidden: [], startReadings: [] };
  return { entries, entryIds, readingParents, hidden, startReadings, readings };
}
