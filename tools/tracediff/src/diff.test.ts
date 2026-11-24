// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { Norm } from './model';
import { diff, run } from './testing/runs';

describe('diffTraces', () => {
  it('reports content the export lacks as structure: ScummVM would fail there (M3 Decision 3)', () => {
    const s = run(['use 000000 070104', []]);
    const t = run(['use 000000 070104', [{ k: 'missing', kind: 'movie', id: '42' }]]);
    const report = diff(s, t);
    expect(report.clean).toBe(false);
    expect(report.structure).toEqual(['line 1: TypeScript reached content the export lacks: movie 42 (ScummVM fails there)']);
  });

  it('finds nothing between two identical runs', () => {
    const r = run(
      ['seed 42', [{ k: 'seed', seed: 42 }]],
      ['use 000000 070104', [
        { k: 'action', verb: 'use', target: 'lever', who: 'picard', other: null, depth: 1 },
        { k: 'group', key: 'lever/use/0', passed: true },
        { k: 'actionEnd', verb: 'use', target: 'lever', flags: 0x8000, depth: 1 },
        { k: 'set', key: 'obj:lever.state', value: 2 },
      ]],
      ['end', []],
    );
    const report = diff(r, r);
    expect(report.clean).toBe(true);
    expect(report.steps).toEqual([]);
    expect(report.structure).toEqual([]);
  });

  it('reports, by step, a different value, an extra group and a different draw', () => {
    const s = run(['talk 000000 000001', [
      { k: 'group', key: 'lever/use/0', passed: true },
      { k: 'rng', site: 'reply', max: 3, value: 1 },
      { k: 'set', key: 'obj:lever.state', value: 2 },
    ]]);
    const t = run(['talk 000000 000001', [
      { k: 'group', key: 'lever/use/0', passed: true },
      { k: 'group', key: 'lever/use/1', passed: true },
      { k: 'rng', site: 'reply', max: 3, value: 2 },
      { k: 'set', key: 'obj:lever.state', value: 3 },
    ]]);
    const report = diff(s, t);
    expect(report.clean).toBe(false);
    expect(report.steps).toEqual([{
      line: 1,
      text: 'talk 000000 000001',
      onlyScummvm: [],
      onlyTs: ['group lever/use/1 passed'],
      rng: ['reply/3: ScummVM 1, TypeScript 2'],
      state: [{ key: 'obj:lever.state', scummvm: 2, ts: 3 }],
      explained: [],
    }]);
  });

  it('compares state by its value at the step\'s end, wherever in the step it was set', () => {
    // (ScummVM checkpoints mid-step, after a group; the TypeScript recorder at the step's end)
    const s = run(['use 000000 070104', [
      { k: 'action', verb: 'use', target: 'lever', who: 'picard', other: null, depth: 1 },
      { k: 'group', key: 'lever/use/0', passed: true },
      { k: 'set', key: 'obj:lever.state', value: 1 },
      { k: 'set', key: 'obj:lever.state', value: 2 },
      { k: 'actionEnd', verb: 'use', target: 'lever', flags: 0x8000, depth: 1 },
    ]]);
    const t = run(['use 000000 070104', [
      { k: 'action', verb: 'use', target: 'lever', who: 'picard', other: null, depth: 1 },
      { k: 'group', key: 'lever/use/0', passed: true },
      { k: 'actionEnd', verb: 'use', target: 'lever', flags: 0x8000, depth: 1 },
      { k: 'set', key: 'obj:lever.state', value: 2 },
    ]]);
    expect(diff(s, t).clean).toBe(true);
  });

  it('reports steps that don\'t line up, and a run that didn\'t end', () => {
    const s = run(['start 7 1 0', []], ['look 000000 070104', []]);
    const t: Norm[] = [{ k: 'step', line: 1, text: 'start 7 1 0' }, { k: 'step', line: 3, text: 'end' }];
    expect(diff(s, t).structure).toEqual([
      'step 2: ScummVM is on line 2 (look 000000 070104), TypeScript on line 3 (end)',
      "TypeScript's trace has no end",
    ]);
  });

  it('says when a step was too long to align by LCS, and compared position by position', () => {
    const lines: Norm[] = Array.from({ length: 5001 }, (_, n) => ({ k: 'movie', file: `m${n}` }));
    const report = diff(run(['advance 2', lines]), run(['advance 2', lines]));
    expect(report.clean).toBe(true);
    expect(report.info).toEqual(['line 1: too many events to align by LCS, so they were compared position by position']);
  });

  it('reports an error as structure, even when both engines stop alike', () => {
    const stop = run(['look 000000 999999', [{ k: 'error', what: 'unknown object 999999' }]]);
    const report = diff(stop, stop);
    expect(report.clean).toBe(false);
    expect(report.structure).toEqual([
      'line 1: ScummVM stopped with an error: unknown object 999999',
      'line 1: TypeScript stopped with an error: unknown object 999999',
    ]);
  });
});
