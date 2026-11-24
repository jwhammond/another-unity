// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { liftComputer } from './computer';
import { Problems } from './problems';
import { rawFromMini } from './testing/ctx';
import { makeDb } from './testing/computer-db';

const A = { title: '-Alpha-', heading: '-a-', text: '-Zap-' };
const B = { title: '-Beta-', heading: '-b-', text: '-Zip-' };

const raw = (computer?: Uint8Array) => {
  const r = rawFromMini();
  const executable = {
    ...r.executable, _computerEntryIds: [2, 1],
    _tricorderReadings: [{ key: 70011, parent: 0, entry: 1 }, { key: 70010, parent: 2, entry: 0 }],
  };
  return { ...r, executable, compstat: new Uint8Array(260), ...(computer ? { computer } : {}) };
};

describe('liftComputer', () => {
  it('returns the entries with their subentries, and the entry ids', () => {
    const problems = new Problems();
    const tree = liftComputer(raw(makeDb([{ ...A, subentries: [1, 2] }, B, { ...A, flags: 2 }])), problems);
    expect(tree?.entries).toEqual([
      { ...A, flags: 0, subentries: [1, 2] }, { ...B, flags: 0, subentries: [] }, { ...A, flags: 2, subentries: [] },
    ]);
    expect(tree?.entryIds).toEqual([2, 1]);
    expect(problems.warnings).toEqual([]);
  });

  it('maps each reading key to its parent', () => {
    expect(liftComputer(raw(makeDb([A, B, A])), new Problems())?.readingParents).toEqual({ 70011: 0, 70010: 2 });
  });

  it('drops a subentry offset no entry has, naming the entry', () => {
    const problems = new Problems();
    const tree = liftComputer(raw(makeDb([{ ...A, subentries: [1, { offset: 9999 }] }, B])), problems);
    expect(tree?.entries[0].subentries).toEqual([1]);
    expect(problems.warnings).toHaveLength(1);
    expect(problems.warnings[0]).toMatch(/entry 0 .*subentry 1 of 2/);
  });

  it('lifts the starting state from compstat: the hidden entries, then the recorded readings', () => {
    const bits = new Uint8Array(256);
    bits[0] = 1 << 5;
    const count = [1, 0, 0, 0];
    const row = [0, 0, 0, 0, ...[7020031 & 0xff, (7020031 >> 8) & 0xff, (7020031 >> 16) & 0xff, 7020031 >>> 24]];
    const compstat = Uint8Array.from([...bits, ...count, ...row]);
    const tree = liftComputer({ ...raw(makeDb([A, B, A])), compstat }, new Problems());
    expect(tree?.hidden).toEqual([5]);
    expect(tree?.startReadings).toEqual([7020031]);
  });

  it('has no hidden entries or readings, with a warning, without compstat', () => {
    const problems = new Problems();
    const { compstat: _c, ...without } = raw(makeDb([A, B, A]));
    const tree = liftComputer(without, problems);
    expect(tree?.hidden).toEqual([]);
    expect(tree?.startReadings).toEqual([]);
    expect(problems.warnings.join('\n')).toMatch(/compstat/);
  });

  it('lifts every reading row with its key taken apart, the world as a slug', () => {
    const r = raw(makeDb([A, B, A]));
    const executable = { ...r.executable, _tricorderReadings: [{ key: 70031, entry: 9, parent: 4 }, { key: 20120, entry: 1, parent: 0 }] };
    const tree = liftComputer({ ...r, executable }, new Problems());
    expect(tree?.readings).toEqual([
      { key: 70031, world: 'horst3', group: 3, index: 1, entry: 9, parent: 4 },
      { key: 20120, world: 'allanor', group: 12, index: 0, entry: 1, parent: 0 },
    ]);
  });

  it('is undefined, with one warning, without computer.db', () => {
    const problems = new Problems();
    expect(liftComputer(raw(), problems)).toBeUndefined();
    expect(problems.warnings).toHaveLength(1);
    expect(problems.warnings[0]).toMatch(/computer\.db/);
  });
});
