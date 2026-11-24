// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { ObjectDef } from '../content/types';
import { settle } from '../sim/settle';
import { makeWorld } from '../testing/fixture';
import { describeEvent, flagNames, RuleTrace } from './trace';

const lever: ObjectDef = {
  id: 'lever', name: 'Lever', screen: 'room',
  on: {
    use: [
      { when: { other: 'tricorder' }, do: [{ say: { who: 'picard', text: 'Scanned.' } }] },
      { do: [{ alter: { object: 'lever', state: 1 } }, { say: { who: 'picard', text: 'Pulled.' } }] },
    ],
  },
};

describe('RuleTrace', () => {
  it('records the groups that ran and were skipped, and their effects', async () => {
    const w = makeWorld([lever]);
    const trace = new RuleTrace();
    trace.attach(w);
    void w.act('use', { target: 'lever', who: 'picard' });
    await settle(w);
    expect(trace.entries.map(e => `${e.kind} ${e.text}`)).toEqual([
      'skipped use lever: lever/use/0 skipped (FAILOTHER)',
      'rule use lever: lever/use/1 ran',
      'effect lever/use/1: alter',
      'effect lever/use/1: say',
    ]);
    // (the say waits a second of ticks before its effect is reported)
    expect(trace.entries.map(e => e.tick)).toEqual([0, 0, 0, 60]);
  });

  it('keeps the newest entries up to its limit, and tells subscribers', () => {
    const trace = new RuleTrace(3);
    let told = 0;
    trace.subscribe(() => told++);
    for (let i = 0; i < 5; i++) trace.push({ tick: i, kind: 'event', text: `e${i}` });
    expect(trace.entries.map(e => e.text)).toEqual(['e2', 'e3', 'e4']);
    expect(told).toBe(5);
    trace.clear();
    expect(trace.entries).toEqual([]);
  });

  it('describes failures, warnings and screen changes, and leaves out object changes', () => {
    expect(describeEvent({ type: 'actionFailed', error: 'boom' })).toEqual({ kind: 'error', text: 'failed: boom' });
    expect(describeEvent({ type: 'warning', message: 'odd' })).toEqual({ kind: 'warning', text: 'warning: odd' });
    expect(describeEvent({ type: 'screenChanged', screen: 'lab' })).toEqual({ kind: 'screen', text: 'screen lab' });
    expect(describeEvent({ type: 'objectChanged', id: 'panel' })).toBeNull();
    expect(flagNames(0x2 | 0x8000)).toBe('FAILOTHER DIDSOMETHING');
    expect(flagNames(0)).toBe('0');
  });
});
