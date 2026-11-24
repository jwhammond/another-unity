// SPDX-License-Identifier: GPL-3.0-or-later
import { makeGame, type GameContent } from '@another-unity/engine';
import { describe, expect, it } from 'vitest';
import { outline } from './outline';

describe('the route outline', () => {
  it('lists screens with their timers, and each gated group with what it needs, sets and is flagged for', () => {
    const base = makeGame([]);
    const content: GameContent = makeGame([
      { id: 'w.clock', name: '-Tick-', screen: 'w.s01', timer: 60, on: { timer: [{ do: [{ alter: { object: 'w.door', state: 1 } }] }] } },
      { id: 'w.door', name: '-Door-', screen: 'w.s01', state: 0, on: { use: [
        { when: { checks: [{ object: 'w.door', state: 1 }], other: 'w.clock' }, do: [{ screen: { to: 'w.s02', entrance: 'entrance_0' } }] },
        { do: [{ trigger: { id: 't9', enabled: true } }, { missing: { kind: 'movie', id: '42' } }] },
      ] } },
      { id: 'ship.script', name: '-Script-', screen: null },
      { id: 'w.flag', name: '-Flag-', screen: 'w.s02', on: { use: [{ when: { checks: [{ object: 'w.flag', state: 0 }] }, do: [{ screen: { to: '$ship' } }] }] } },
    ], {
      screens: { 'w.s01': { ...base.screens.room }, 'w.s02': { ...base.screens.hall } },
      triggers: [{ id: 't9', type: 'timer', context: 'away', target: 'ship.script', enabled: false, seconds: 900 }],
    });
    expect(outline(content, 'w', { 'w.door': '020101', 'w.flag': '050801' })).toEqual([
      'screen w.s01: timers [w.clock 60s]',
      'screen w.s02: timers []',
      'w.clock timer/0: needs [] -> w.door=1',
      '020101 w.door use/0: needs [020101 w.door=1, with w.clock] -> -> w.s02',
      '020101 w.door use/1: needs [] -> trigger t9 on; MISSING movie 42  WATCH t9 -> ship.script (away, 900s) has no lifted rules',
      '050801 w.flag use/0: needs [050801 w.flag=0] -> -> $ship  GOAL; WATCH ship-written',
    ]);
  });
});
