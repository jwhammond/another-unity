// SPDX-License-Identifier: GPL-3.0-or-later
import { makeDb } from './testing/computer-db';
import { describe, expect, it } from 'vitest';
import { Problems } from './problems';
import { liftReadings, parseComputerDb } from './readings';
import { rawFromMini } from './testing/ctx';

const A = { title: '-Alpha-', heading: '-a-', text: '-Zap-' };
const B = { title: '-Beta-', heading: '-b-', text: '-Zip-\n-Zop-' };

describe('computer.db', () => {
  it('reads the entries\' strings as loadComputerDatabase does', () => {
    expect(parseComputerDb(makeDb([A, B]))).toEqual([{ flags: 0, subentries: [], ...A }, { flags: 0, subentries: [], ...B }]);
  });

  it('resolves a subentry\'s offset to the entry\'s index, as loadComputerDatabase does', () => {
    const [root, a, b] = parseComputerDb(makeDb([{ ...A, subentries: [1, 2] }, B, { ...A, flags: 4, subentries: [1] }]));
    expect(root.subentries).toEqual([1, 2]);
    expect(a.subentries).toEqual([]);
    expect(b).toMatchObject({ flags: 4, subentries: [1] });
    expect(parseComputerDb(makeDb([{ ...A, subentries: [{ offset: 9999 }] }]))[0].subentries).toEqual([-1]);
  });
});

describe('liftReadings', () => {
  const raw = (computer?: Uint8Array) => {
    const r = rawFromMini();
    const readings = [{ key: 70011, parent: 0, entry: 1 }, { key: 70010, parent: 0, entry: 0 }, { key: 20010, parent: 0, entry: 0 }];
    return { ...r, executable: { ...r.executable, _tricorderReadings: readings }, ...(computer ? { computer } : {}) };
  };

  it('groups the lifted worlds\' readings by world and group, in key order', () => {
    const problems = new Problems();
    expect(liftReadings(raw(makeDb([A, B])), [7], problems)).toEqual({ horst3: { 1: [A, B] } });
    expect(problems.warnings).toEqual([]);
  });

  it('says so when the export has no computer.db, or an entry is missing', () => {
    const none = new Problems();
    expect(liftReadings(raw(), [7], none)).toEqual({});
    expect(none.warnings.join('\n')).toMatch(/computer\.db/);
    const short = new Problems();
    expect(liftReadings(raw(makeDb([A])), [7], short)).toEqual({ horst3: { 1: [A] } });
    expect(short.warnings.join('\n')).toMatch(/reading 70011 names computer entry 1/);
  });
});
