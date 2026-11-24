// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { LiftError } from './problems';
import { IGNORED, isIgnored, losslessCheck } from './ignored';
import { FieldTracker, fieldPaths } from './track';

const object = {
  id: '070103',
  name: 'rubble',
  use_entries: [[{ class: 'AlterBlock', _order: 1, target: '070103' }]],
  advice: { '1': { easy: [{ name: 'Picard', text: 'Hm.' }] } },
};

describe('FieldTracker.trackRaw', () => {
  it('carries every optional verbatim file the lift reads, the screens\' texts too (they once were dropped and screentexts.yaml came out empty)', () => {
    const bytes = new Uint8Array([1]);
    const raw = {
      manifest: {}, objects: new Map(), conversations: new Map(), screens: new Map(), worlds: new Map(), triggers: {}, movies: {}, sprites: {}, executable: {},
      computer: bytes, compstat: bytes, astro: bytes, sectorNames: bytes, astStat: {}, screenTexts: new Map([['040a', bytes]]),
    } as unknown as Parameters<FieldTracker['trackRaw']>[0];
    const tracked = new FieldTracker().trackRaw(raw);
    for (const key of ['computer', 'compstat', 'astro', 'sectorNames', 'astStat', 'screenTexts'] as const) expect(tracked[key], key).toBeDefined();
    expect([...tracked.screenTexts!.keys()]).toEqual(['040a']);
  });
});

describe('FieldTracker', () => {
  it('records the kind of each field read, with entries by class and records folded', () => {
    const t = new FieldTracker();
    const o = t.track(object, 'object');
    expect(o.name).toBe('rubble');
    expect(o.use_entries[0].map(e => e.target)).toEqual(['070103']);
    for (const [, a] of Object.entries(o.advice)) expect(a.easy[0].text).toBe('Hm.');
    expect([...t.used].sort()).toEqual([
      'entry:AlterBlock.target', 'object.advice', 'object.advice.*', 'object.advice.*.easy',
      'object.advice.*.easy[].text', 'object.name', 'object.use_entries',
    ]);
  });

  it('gives the same proxy for the same value, so identity comparisons work', () => {
    const t = new FieldTracker();
    const o = t.track(object, 'object');
    expect(o.use_entries[0][0]).toBe(o.use_entries[0][0]);
  });
});

describe('FieldTracker enumeration and kinds', () => {
  it('refuses to enumerate a block, which would count every field as read', () => {
    const t = new FieldTracker();
    const o = t.track(object, 'object');
    const entry = o.use_entries[0][0];
    expect(() => ({ ...entry })).toThrow(LiftError);
    expect(() => JSON.stringify(entry)).toThrow('tracked IR value enumerated at entry:AlterBlock');
    expect(() => Object.keys(o)).toThrow('read fields explicitly');
    expect(t.used.has('entry:AlterBlock._order')).toBe(false);
  });

  it('still iterates arrays, and enumerates id-keyed records', () => {
    const t = new FieldTracker();
    const o = t.track(object, 'object');
    let n = 0;
    for (const e of o.use_entries[0]) n += e.target.length;
    expect(n).toBe(6);
    expect(o.use_entries.length).toBe(1);
    expect(Object.keys(o.advice)).toEqual(['1']);
    void o.advice['1'];
    expect(t.used.has('entry:AlterBlock.target')).toBe(true);
    expect(t.used.has('object.advice.*')).toBe(true);
  });

  it('tracks by kind: reading a field of one element marks it for every element', () => {
    const list = [{ class: 'AlterBlock', target: 'a' }, { class: 'AlterBlock', target: 'b' }];
    const t = new FieldTracker();
    void t.track(list, 'list')[0].target;
    const result = losslessCheck(t.used, [{ value: list, root: 'list' }], []);
    expect(result.problems).toEqual(['IR field "entry:AlterBlock.class" is neither lifted nor in the ignored table (tools/lift/src/ignored.ts)']);
    expect(t.used.has('entry:AlterBlock.target')).toBe(true);
    expect(result.consumed).toBe(1);
  });
});

describe('fieldPaths', () => {
  it('lists every field kind in a value, skipping subtrees it is told to', () => {
    expect([...fieldPaths(object, 'object', new Set(), new Set(['object.advice']))].sort()).toEqual([
      'entry:AlterBlock._order', 'entry:AlterBlock.class', 'entry:AlterBlock.target',
      'object.advice', 'object.id', 'object.name', 'object.use_entries',
    ]);
  });
});

describe('losslessCheck', () => {
  it('fails on a field nobody read and nobody listed, naming it', () => {
    const value = [{ class: 'AlterBlock', target: '070103', foo: 1 }];
    const t = new FieldTracker();
    const [e] = t.track(value, 'list');
    void e.class;
    void e.target;
    const result = losslessCheck(t.used, [{ value, root: 'list' }], []);
    expect(result.problems).toEqual([
      'IR field "entry:AlterBlock.foo" is neither lifted nor in the ignored table (tools/lift/src/ignored.ts)',
    ]);
    expect(result).toMatchObject({ consumed: 2, ignored: 0, total: 3 });
  });

  it('accepts a field listed as ignored, and everything below an ignored field', () => {
    expect(IGNORED['executable._transporterSpriteNames']).toBeDefined();
    expect(isIgnored('executable._transporterSpriteNames[]')).toBe(true);
    const value = { _transporterSpriteNames: [{ name: 'a.spt' }] };
    const result = losslessCheck(new Set(), [{ value, root: 'executable' }], []);
    expect(result.problems).toEqual([]);
    expect(result).toMatchObject({ consumed: 0, ignored: 2, total: 2 });
  });

  it('fails on a file it neither reads nor ignores', () => {
    const files = ['objects/o_070103.json', 'verbatim/enterprs.bin', 'maps/icon.json', 'mystery.json'];
    expect(losslessCheck(new Set(), [], files).problems).toEqual([
      'IR file "mystery.json" is neither read nor in IGNORED_FILES (tools/lift/src/ignored.ts)',
    ]);
  });
});
