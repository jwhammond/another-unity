// SPDX-License-Identifier: GPL-3.0-or-later
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { makeWorld } from '../testing/fixture';
import type { SimEvent } from './events';
import { R } from './result';
import { Rng } from './rng';
import { advance } from './settle';

/** The text between the parentheses of the call that starts at `open`. */
function callArgs(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return text.slice(open + 1, i);
  }
  return '';
}

function topLevelCommas(args: string): number {
  let depth = 0;
  let commas = 0;
  for (const c of args) {
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) commas++;
  }
  return commas;
}

describe('trace points', () => {
  it('reports each draw with its site', () => {
    const draws: [string, number, number][] = [];
    const rng = new Rng({ rngSeed: 12345 }, (site, max, value) => draws.push([site, max, value]));
    expect(rng.next(255, 'skill')).toBe(186);
    expect(rng.next(255)).toBe(111);
    expect(draws).toEqual([['skill', 255, 186], ['unsited', 255, 111]]);
  });

  it('names the site of every draw in the sim, as ScummVM\'s trace does', () => {
    const dir = fileURLToPath(new URL('.', import.meta.url));
    const unsited: string[] = [];
    for (const file of readdirSync(dir).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
      const text = readFileSync(join(dir, file), 'utf8');
      for (let at = text.indexOf('rng.next('); at !== -1; at = text.indexOf('rng.next(', at + 1)) {
        const args = callArgs(text, at + 'rng.next'.length);
        if (topLevelCommas(args) === 0) unsited.push(`${file}: rng.next(${args})`);
      }
    }
    expect(unsited).toEqual([]);
  });

  it('puts the world\'s draws on its bus', () => {
    const w = makeWorld([]);
    const events: SimEvent[] = [];
    w.bus.on(e => { if (e.type === 'rng') events.push(e); });
    const value = w.rng.next(2, 'stepInX');
    expect(events).toEqual([{ type: 'rng', site: 'stepInX', max: 2, value }]);
  });

  it('reports triggers, timers, and each action\'s start and end with its depth', async () => {
    const w = makeWorld([
      {
        id: 'lever', name: 'Lever', screen: 'room',
        on: { use: [{ do: [
          { alter: { object: 'lever', state: 2 } },
          { trigger: { id: 't1', enabled: false } },
          { act: { verb: 'look', object: 'clock', who: '$actor' } },
        ] }] },
      },
      { id: 'clock', name: 'Clock', screen: 'room', timer: 1, on: { timer: [{ do: [{ alter: { object: 'clock', active: false } }] }] } },
    ], { triggers: [{ id: 't1', type: 'normal', context: 'away', target: 'lever', enabled: true }] });
    const events: SimEvent[] = [];
    const kinds = new Set(['actionStarted', 'actionEnded', 'triggerFired', 'timerFired']);
    w.bus.on(e => { if (kinds.has(e.type)) events.push(e); });

    await advance(w, 1.5);

    expect(events).toMatchObject([
      { type: 'triggerFired', id: 't1', target: 'lever' },
      { type: 'actionStarted', verb: 'use', target: 'lever', who: 'picard', other: null, depth: 1 },
      { type: 'actionStarted', verb: 'look', target: 'clock', who: 'picard', depth: 2 },
      { type: 'actionEnded', verb: 'look', target: 'clock', depth: 2 },
      { type: 'actionEnded', verb: 'use', target: 'lever', depth: 1 },
      { type: 'timerFired', object: 'clock' },
      { type: 'actionStarted', verb: 'timer', target: 'clock', depth: 1 },
      { type: 'actionEnded', verb: 'timer', target: 'clock', depth: 1 },
    ]);
    const used = events.find(e => e.type === 'actionEnded' && e.verb === 'use');
    expect(used?.type === 'actionEnded' && (used.result & R.DIDSOMETHING) !== 0).toBe(true);
  });

  it('reports a passed condition with the action\'s other object, and nothing for a group with no condition', async () => {
    const w = makeWorld([
      { id: 'tricorder', name: 'Tricorder', screen: null, inventory: true },
      { id: 'panel', name: 'Panel', screen: 'room', on: { use: [{ when: { other: 'tricorder' }, do: [] }, { do: [] }] } },
    ]);
    const events: SimEvent[] = [];
    w.bus.on(e => { if (e.type === 'conditionPassed') events.push(e); });
    void w.act('use', { target: 'panel', who: 'picard', other: 'tricorder' });
    await advance(w, 0);
    expect(events).toEqual([{ type: 'conditionPassed', group: 'panel/use/0', other: 'tricorder' }]);
  });
});
