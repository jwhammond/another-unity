// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { assignObjectSlugs, conversationKey, IdTable, isCrewId, nameSlug, parseId, Scope, screenKey, worldSlug } from './ids';
import { Problems } from './problems';

describe('slugs', () => {
  it('names worlds, and falls back to the number', () => {
    expect([worldSlug(0), worldSlug(7), worldSlug(0x5f), worldSlug(0x42)]).toEqual(['crew', 'horst3', 'ship', 'w42']);
  });

  it('turns names into slugs', () => {
    expect(nameSlug('La Forge')).toBe('la_forge');
    expect(nameSlug('Dr. Crusher!')).toBe('dr_crusher');
    expect(nameSlug('éé')).toBe('');
  });

  it('gives world 0 bare names, others a world prefix, and every duplicate its id', () => {
    const slugs = assignObjectSlugs([
      { id: '000000', name: 'Picard' }, { id: '070103', name: 'rubble' }, { id: '070201', name: 'guard' },
      { id: '070202', name: 'Guard' }, { id: '070300', name: '' }, { id: '020101', name: 'guard' },
    ]);
    expect(Object.fromEntries(slugs)).toEqual({
      '000000': 'picard', '070103': 'horst3.rubble', '070201': 'horst3.guard.0201', '070202': 'horst3.guard.0202',
      '070300': 'horst3.o0300', '020101': 'allanor.guard',
    });
  });

  it('reads ids', () => {
    expect(parseId('070103')).toEqual({ world: 7, screen: 1, id: 3 });
    expect([isCrewId('000005'), isCrewId('000010'), isCrewId('007001')]).toEqual([true, false, false]);
    expect([screenKey(7, 1), conversationKey(0x5f, 34)]).toEqual(['s_0701', 'w05fc034']);
  });
});

describe('IdTable', () => {
  const known = {
    objects: new Set(['070103']), conversations: new Set(['w007c000']), screens: new Set(['s_0701']), triggers: new Set([3]),
  };

  it('maps ids to slugs, records what was used, and what is needed', () => {
    const problems = new Problems();
    const ids = new IdTable(new Map([['070103', 'horst3.rubble']]), known, problems);
    expect(ids.object('070103', 'here')).toBe('horst3.rubble');
    expect(ids.screen(7, 1, 'here')).toBe('horst3.s01');
    expect(ids.conversation(7, 0, 'here')).toBe('horst3.c000');
    expect(ids.trigger(3, 'here')).toBe('t3');
    expect(ids.advice(7, 1, 'here')).toBe('horst3.a1');
    ids.list('o_070103#/use_entries', 'horst3.rubble/use');
    expect(problems.errors).toEqual([]);
    expect([...ids.need.objects, ...ids.need.screens, ...ids.need.conversations, ...ids.need.advice]).toEqual([
      '070103', 's_0701', 'w007c000', 'w_07/1',
    ]);
    expect(ids.toYaml()).toEqual({
      worlds: { '07': 'horst3' },
      screens: { s_0701: 'horst3.s01' },
      objects: { '070103': 'horst3.rubble' },
      conversations: { w007c000: 'horst3.c000' },
      triggers: { '3': 't3' },
      advice: { 'w_07/1': 'horst3.a1' },
      lists: { 'o_070103#/use_entries': 'horst3.rubble/use' },
    });
  });

  it('reports a reference to something the export lacks, and goes on', () => {
    const problems = new Problems();
    const ids = new IdTable(new Map(), known, problems);
    expect(ids.object('070199', 'o_070103#/use_entries/0/1')).toBe('unknown.070199');
    expect(ids.screen(7, 9, 'there')).toBe('horst3.s09');
    expect(ids.conversation(7, 4, 'there')).toBe('horst3.c004');
    expect(ids.trigger(8, 'there')).toBe('t8');
    expect(problems.errors).toEqual([
      'o_070103#/use_entries/0/1: no object 070199 in the export',
      'there: no screen s_0709 in the export',
      'there: no conversation w007c004 in the export',
      'there: no trigger 8 in triggers.json',
    ]);
  });
});

describe('IdTable, lenient', () => {
  it('only accepts what is already in scope, and asks for nothing', () => {
    const problems = new Problems();
    const scope = new Scope();
    scope.objects.add('070103');
    const ids = new IdTable(new Map([['070103', 'horst3.rubble'], ['070201', 'horst3.guard']]), {
      objects: new Set(['070103', '070201']), conversations: new Set(['w007c000']), screens: new Set(), triggers: new Set(),
    }, problems, scope);
    ids.lenient = true;
    expect(ids.object('070103', 'a')).toBe('horst3.rubble');
    expect(ids.object('070201', 'b')).toBe('horst3.guard');
    ids.conversation(7, 0, 'c');
    expect(problems.errors).toEqual([
      'b: 070201 is outside the lift\'s scope (only primary content widens it)',
      'c: w007c000 is outside the lift\'s scope (only primary content widens it)',
    ]);
    expect(ids.need.objects.size + ids.need.conversations.size).toBe(0);
  });
});

describe('Scope', () => {
  it('says whether adding another scope grew it', () => {
    const a = new Scope();
    const b = new Scope();
    b.objects.add('070103');
    expect(a.addAll(b)).toBe(true);
    expect(a.addAll(b)).toBe(false);
  });
});
