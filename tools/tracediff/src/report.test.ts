// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { runTracediff } from './cli';
import { diffTraces } from './diff';
import { run } from './testing/runs';
import { renderReport, summarize } from './report';
import { testMaps } from './testing/maps';

describe('the report', () => {
  it('gives the verdict, each step\'s differences, the allowances used and what wasn\'t compared', () => {
    const s = run(['use 000000 070104', [{ k: 'set', key: 'obj:lever.state', value: 2 }, { k: 'set', key: 'trigger:?64', value: true }]]);
    const t = run(['use 000000 070104', [{ k: 'set', key: 'obj:lever.state', value: 3 }]]);
    const text = renderReport(diffTraces(s, t, testMaps(), new Map([['obj.sprite_id', 3]])), 'trace.jsonl');
    expect(text).toContain('# Trace diff: trace.jsonl');
    expect(text).toContain('**Not clean:** 1 step(s) differ.');
    expect(text).toContain('## Line 1: `use 000000 070104`');
    expect(text).toContain('- obj:lever.state: ScummVM 2, TypeScript 3');
    expect(text).toMatch(/\| unlifted-triggers \| 1 \| forgiven \| /);
    expect(text).toContain('| obj.sprite_id | 3 |');
    expect(renderReport(diffTraces(t, t, testMaps()), 'same')).toContain('**CLEAN**');
  });

  it('summarizes a trace step by step, for writing walkthroughs', () => {
    expect(summarize(run(['look 000000 070103', [
      { k: 'action', verb: 'look', target: 'rubble', who: 'picard', other: null, depth: 1 },
      { k: 'say', who: 'picard', voice: 'fe0000e6', text: 'A pile of rubble.' },
      { k: 'set', key: 'counter:rubble/look/0', value: 1 },
      { k: 'set', key: 'obj:rubble.state', value: 1 },
    ]]))).toBe([
      'line 1: look 000000 070103',
      '  look rubble by picard (depth 1)',
      '  picard says [fe0000e6] "A pile of rubble."',
      '  obj:rubble.state = 1',
    ].join('\n'));
  });

  it('answers a bad command line with its usage, and exit code 2', async () => {
    const log: string[] = [];
    expect(await runTracediff([], line => log.push(line))).toBe(2);
    expect(log[0]).toMatch(/^usage: tracediff run/);
    expect(await runTracediff(['diff', '--game', 'games/unity'], () => {})).toBe(2);
    // (a flag with no value, an unknown flag, a seed that isn't a number)
    expect(await runTracediff(['diff', '--game', '--scummvm', 'a', '--ts', 'b'], () => {})).toBe(2);
    expect(await runTracediff(['diff', '--game', 'g', '--nope', 'a'], () => {})).toBe(2);
    expect(await runTracediff(['run', '--game', 'g', '--walk', 'w', '--seed', 'x', '--out', 'o'], () => {})).toBe(2);
  });

  it('answers a file it can\'t read with its reason and exit code 2, not a stack trace', async () => {
    const log: string[] = [];
    expect(await runTracediff(['summary', '--game', 'g', '--ts', '/nonexistent/ts.jsonl'], line => log.push(line))).toBe(2);
    expect(log).toEqual([expect.stringMatching(/^tracediff: .*ENOENT.*\/nonexistent\/ts\.jsonl/)]);
  });

  it('says which allowances used only explain, and are still reported', () => {
    const g = (passed: boolean) => run(['use 000000 070103', [{ k: 'group', key: 'rubble/use/0', passed }]]);
    expect(renderReport(diffTraces(g(true), g(false), testMaps()), 't')).toMatch(/\| proximity-threshold \| 1 \| explained, still reported \| /);
  });
});
