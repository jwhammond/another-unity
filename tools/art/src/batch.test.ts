// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { itemKey, runBatch, type BatchItem } from './batch';

const item = (id: string, key: string, r: () => Promise<{ ok: boolean; detail: string }>): BatchItem => ({ id, key, run: r });

describe('runBatch', () => {
  it('skips an item whose key has a passing output, runs the rest, and logs one line each', async () => {
    const ran: string[] = [];
    const log: string[] = [];
    const res = await runBatch(
      [item('a', 'k1', async () => (ran.push('a'), { ok: true, detail: 'x' })), item('b', 'k2', async () => (ran.push('b'), { ok: true, detail: 'y' }))],
      { done: async k => k === 'k1', log: l => log.push(l) },
    );
    expect(ran).toEqual(['b']);
    expect(res).toEqual({ ran: 1, skipped: 1, failed: [] });
    expect(log.filter(l => /^\[\d\/2\]/.test(l)).filter(l => /skipped|ok/.test(l))).toHaveLength(2);
    expect(log.some(l => l.includes('a skipped'))).toBe(true);
  });
  it('a failed item (a returned failure or a throw) is reported and the batch goes on', async () => {
    const ran: string[] = [];
    const log: string[] = [];
    const res = await runBatch(
      [
        item('a', '1', async () => ({ ok: false, detail: 'misaligned' })),
        item('b', '2', async () => {
          throw new Error('boom');
        }),
        item('c', '3', async () => (ran.push('c'), { ok: true, detail: '' })),
      ],
      { done: async () => false, log: l => log.push(l) },
    );
    expect(ran).toEqual(['c']);
    expect(res.failed).toEqual(['a', 'b']);
    expect(log.some(l => l.includes('b FAILED') && l.includes('boom'))).toBe(true);
  });
  it('itemKey changes with any input and not with the order of the lists', () => {
    const base = { recipe: 'r', models: ['m1', 'm2'], references: ['r1'], sources: ['s'], pins: 'p' };
    const k = itemKey(base);
    expect(itemKey({ ...base, models: ['m2', 'm1'] })).toBe(k);
    for (const change of [{ recipe: 'r2' }, { models: ['m1'] }, { references: ['r2'] }, { sources: ['t'] }, { pins: 'q' }]) expect(itemKey({ ...base, ...change })).not.toBe(k);
  });
});
