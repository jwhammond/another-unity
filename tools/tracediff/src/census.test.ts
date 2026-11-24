// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { RuleGroup } from '@another-unity/engine';
import { combatCensus } from './census';
import { content, group, rawObjects } from './testing/census-fixtures';

describe('combatCensus (R6)', () => {
  it('finds each battle hail, the scenario screen scripts\' writes, and whether a gate reads them', () => {
    const c = content({
      'w.hailer': [group({ do: [{ communicate: { scenario: 3, type: 0xa } }] })],
      'w.door': [group({ when: { checks: [{ object: 'w.flag', state: 1 }] }, do: [] })],
    });
    // screen s_1003's Exit object writes 020101 (w.flag); scenario 4's writes nothing anyone reads
    const raw = rawObjects({ '100301': { name: 'Exit', alters: ['020101'] }, '100401': { name: 'Exit', alters: ['020202'] } });
    const rows = combatCensus(c, raw, { 'w.flag': '020101', 'w.hailer': '020100', 'w.door': '020102' });
    expect(rows).toEqual([
      { scenario: 3, hails: [{ owner: '020100', type: 0xa, needs: [] }], writes: ['020101'], readBy: ['020102'], mandatory: true },
    ]);
  });

  it('marks a scenario optional when another group writes the same value', () => {
    const c = content({
      'w.hailer': [group({ do: [{ communicate: { scenario: 3, type: 0x10 } }] })],
      'w.door': [group({ when: { checks: [{ object: 'w.flag', state: 1 }] }, do: [] })],
      'w.lever': [group({ do: [{ alter: { object: 'w.flag', state: 1 } }] })],
    });
    const raw = rawObjects({ '100301': { name: 'Exit', alters: ['020101'] } });
    const [row] = combatCensus(c, raw, { 'w.flag': '020101', 'w.hailer': '020100', 'w.door': '020102', 'w.lever': '020103' });
    expect(row.mandatory).toBe(false);
  });

  const ids = { 'w.flag': '020101', 'w.hailer': '020100', 'w.door': '020102', 'w.lever': '020103' };
  const hailAndDoor = (lever?: RuleGroup) => content({
    'w.hailer': [group({ do: [{ communicate: { scenario: 3, type: 0xa } }] })],
    'w.door': [group({ when: { checks: [{ object: 'w.flag', state: 1 }] }, do: [] })],
    ...(lever ? { 'w.lever': [lever] } : {}),
  });

  it('reads the destroyed hook (phaser_data.kill_entries) of the scenario\'s ships', () => {
    const raw = rawObjects({ '100301': { name: 'Ship', kill: ['020101'] } });
    const [row] = combatCensus(hailAndDoor(), raw, ids);
    expect(row).toMatchObject({ writes: ['020101'], readBy: ['020102'], mandatory: true });
  });

  it('ignores an alter_state of 255 and a hail-only alter: they write nothing', () => {
    const raw = rawObjects({ '100301': { name: 'Exit', alters: [{ id: '020101', state: 255 }] } });
    const [row] = combatCensus(hailAndDoor(), raw, ids);
    expect(row).toMatchObject({ writes: [], mandatory: false });
  });

  it('is still mandatory when another script writes a different value, optional when it writes the gate\'s value', () => {
    const raw = rawObjects({ '100301': { name: 'Exit', alters: ['020101'] } });
    const reset = group({ do: [{ alter: { object: 'w.flag', state: 0 } }] });
    const same = group({ do: [{ alter: { object: 'w.flag', state: 1 } }] });
    expect(combatCensus(hailAndDoor(reset), raw, ids)[0].mandatory).toBe(true);
    expect(combatCensus(hailAndDoor(same), raw, ids)[0].mandatory).toBe(false);
  });

  it('compares a raw script\'s written value too, and another scenario\'s', () => {
    const c = content({
      'w.hailer': [group({ do: [{ communicate: { scenario: 3, type: 0xa } }, { communicate: { scenario: 4, type: 0xa } }] })],
      'w.door': [group({ when: { checks: [{ object: 'w.flag', state: 1 }] }, do: [] })],
    });
    const raw = rawObjects({
      '100301': { name: 'Exit', alters: ['020101'] },
      '100401': { name: 'Exit', alters: [{ id: '020101', state: 0 }] },
    });
    const rows = combatCensus(c, raw, ids);
    expect(rows.map(r => r.mandatory)).toEqual([true, false]);
    raw.objects.set('100402', { id: '100402', name: 'Ship', phaser_data: { kill_entries: [[{ class: 'AlterBlock', target: '020101', alter_state: 1, alter_flags: 0, alter_reset: 0 }]] } } as never);
    expect(combatCensus(c, raw, ids).map(r => r.mandatory)).toEqual([false, false]);
  });
});
