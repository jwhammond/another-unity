// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { miniBattleDef, miniCombat, type ConversationDef, type Effect, type GameContent, type ObjectDef, type ShipKind, type TriggerDef } from '@another-unity/engine';
import { routeCensus } from './route';

const obj = (id: string, ...effects: Effect[]): ObjectDef => ({ id, name: id, screen: null, on: { use: [{ do: effects }] } });
const trig = (id: string, target: string, enabled: boolean, type: TriggerDef['type'] = 'normal'): TriggerDef => ({ id, type, context: 'ship', target, enabled });
const conv = (id: string, ...effects: Effect[]): ConversationDef => ({
  id, ship: true, responses: [{ situation: 0, key: 0, state: 'set', who: ['$anyone'], results: [[{ do: effects }]] }],
});

function game(objects: ObjectDef[], triggers: TriggerDef[], conversations: ConversationDef[]): GameContent {
  return {
    id: 'demo', start: { screen: 'r', entrance: 'e', awayTeam: [], leader: 'l' }, screens: {},
    objects: Object.fromEntries(objects.map(o => [o.id, o])), triggers,
    conversations: Object.fromEntries(conversations.map(c => [c.id, c])), rules: { items: {}, lines: {} }, advice: {},
  };
}

describe('routeCensus', () => {
  it('chains two triggers and a type-7 hail to a conversation with a beam', () => {
    const c = game(
      [
        obj('a', { trigger: { id: 't2', enabled: true } }),
        obj('b', { ship: { reveal: 3 } }, { communicate: { type: 7, conversation: 'cv', situation: 0 } }),
        obj('ent'),
      ],
      [trig('t1', 'a', true), trig('t2', 'b', false, 'proximity')],
      [conv('cv', { beam: { to: 'screen.one' } })],
    );
    expect(routeCensus(c)).toEqual([{
      beam: 'screen.one',
      chain: [{ node: 'a', via: 'start' }, { node: 'b', via: 't2/proximity' }, { node: 'cv@0', via: 'hail7' }, { node: 'screen.one', via: 'beam' }],
      hails: [7], shipFx: ['reveal:3'], battles: [], mission: 0, gaps: [],
    }]);
  });

  it('follows a hail through the talk string of the object that hails, and an alter that starts a conversation', () => {
    const c = game(
      [
        { ...obj('a', { communicate: { type: 4, from: 'npc' } }), },
        { ...obj('npc'), talk: '@cv1,0' },
      ],
      [trig('t1', 'a', true)],
      [conv('cv1', { alter: { object: 'npc', converseNow: '@cv2,0' } }), conv('cv2', { beam: { to: 's' } })],
    );
    const [row] = routeCensus(c);
    expect(row.chain.map(s => s.via)).toEqual(['start', 'hail4', 'alterHail', 'beam']);
    expect(row.chain.map(s => s.node)).toEqual(['a', 'cv1@0', 'cv2@0', 's']);
    expect(row.hails).toEqual([4]);
  });

  it('skips a group whose state check names a state nothing sets, and follows a response to its next situation', () => {
    const gated: ObjectDef = { ...obj('a'), on: { use: [
      { when: { checks: [{ object: 'flag', state: 5 }] }, do: [{ communicate: { type: 7, conversation: 'dead', situation: 0 } }] },
      { do: [{ communicate: { type: 7, conversation: 'cv', situation: 0 } }] },
    ] } };
    const c = game(
      [gated, { ...obj('flag'), state: 1 }],
      [trig('t1', 'a', true)],
      [
        conv('dead', { beam: { to: 'never' } }),
        { id: 'cv', ship: true, responses: [
          { situation: 0, key: 0, state: 'set', who: ['$anyone'], next: 2 },
          { situation: 2, key: 0, state: 'set', who: ['$anyone'], results: [[{ do: [{ beam: { to: 'there' } }] }]] },
        ] },
      ],
    );
    const rows = routeCensus(c).filter(r => r.gaps.length === 0);
    expect(rows.map(r => r.beam)).toEqual(['there']);
    expect(rows[0].chain.map(s => s.node)).toEqual(['a', 'cv@0', 'cv@2', 'there']);
  });

  it('lists a trigger enabled from nowhere as a gap, and records a battle hail on the way', () => {
    const c = game(
      [
        obj('a'),
        obj('mid', { communicate: { type: 0xa, scenario: 16 } }, { communicate: { type: 7, conversation: 'cv', situation: 0 } }),
      ],
      [trig('t1', 'a', true), trig('t2', 'mid', false)],
      [conv('cv', { beam: { to: 's' } })],
    );
    const [row] = routeCensus(c);
    expect(row.gaps).toEqual(['mid']);
    expect(row.chain[0]).toEqual({ node: 'mid', via: 'start' });
    expect(row.hails).toEqual([7]);
    expect(row.battles).toEqual([{ scenario: 16, mandatory: false, via: 'hail' }]);
  });

  /** The battles in combat.yaml's form (Plan 23): a romulan (kind 1) is no friend by kShipKinds' flags. */
  const withBattles = (c: GameContent, battles: Record<number, { enter: string | null; exit: string | null; warp: string | null; ships: { object: string; kind: ShipKind }[] }>): GameContent => {
    const combat = miniCombat();
    combat.battles = Object.fromEntries(Object.entries(battles).map(([k, b]) => [k, miniBattleDef({ screen: 'sp', ...b, ships: b.ships.map(s => [s.object, s.kind]) })]));
    return { ...c, ship: { data: { contacts: { comms: [], lounge: [] } }, combat } } as unknown as GameContent;
  };

  it('follows a battle hail to its scenario\'s Exit, and to a hail its hooks raise', () => {
    const c = withBattles(game(
      [
        obj('a', { communicate: { type: 0xa, scenario: 16 } }),
        obj('exit16', { trigger: { id: 't2', enabled: true } }),
        obj('kill', { communicate: { type: 0xa, scenario: 17 } }),
        obj('exit17', { trigger: { id: 't3', enabled: true } }),
        obj('b', { beam: { to: 'zone.s01', world: 8 } }),
        obj('c'),
      ],
      [trig('t1', 'a', true), trig('t2', 'b', false), trig('t3', 'c', false)],
      [],
    ), { 16: { enter: null, exit: 'exit16', warp: null, ships: [{ object: 'kill', kind: 'romulan' }] }, 17: { enter: null, exit: 'exit17', warp: null, ships: [] } });
    const [row] = routeCensus(c, { mandatory: new Set([17]), worlds: { zone: 5 } });
    expect(row.chain.map(s => s.node)).toEqual(['a', 'scenario16', 'exit16', 'b', 'zone.s01']);
    expect(row.chain.map(s => s.via)).toEqual(['start', 'hail10', 'exit', 't2/normal', 'beam']);
    expect(row.battles).toEqual([{ scenario: 16, mandatory: false, via: 'hail' }]);
    expect(row.mission).toBe(8);
  });

  it('marks a hail a battle\'s own kill list raises as a hook, and a mandatory scenario as mandatory', () => {
    const c = withBattles(game(
      [
        obj('a', { communicate: { type: 0xa, scenario: 16 } }),
        obj('kill', { communicate: { type: 0xa, scenario: 17 } }, { beam: { to: 'zone.s01' } }),
      ],
      [trig('t1', 'a', true)],
      [],
    ), { 16: { enter: null, exit: null, warp: null, ships: [{ object: 'kill', kind: 'romulan' }] } });
    const [row] = routeCensus(c, { mandatory: new Set([17]), worlds: { zone: 5 } });
    expect(row.chain.map(s => s.via)).toEqual(['start', 'hail10', 'kill', 'beam']);
    expect(row.battles).toEqual([{ scenario: 16, mandatory: false, via: 'hail' }, { scenario: 17, mandatory: true, via: 'hook' }]);
    expect(row.mission).toBe(5);
  });

  it('takes an away object that enables a ship trigger as a root, marked away:<world>', () => {
    const base = game(
      [obj('lab.panel', { trigger: { id: 't2', enabled: true } }), obj('b', { beam: { to: 'zone.s01' } })],
      [trig('t2', 'b', false)],
      [],
    );
    const c = { ...base, screens: { 'lab.s01': {} } } as unknown as GameContent;
    const [row] = routeCensus(c);
    expect(row.gaps).toEqual([]);
    expect(row.chain.map(s => `${s.node}[${s.via}]`)).toEqual(['away:lab[away]', 'b[t2/normal]', 'zone.s01[beam]']);
  });

  it('starts a contact\'s talk when an alter makes it active', () => {
    const c = game(
      [obj('a', { alter: { object: 'npc', active: true } }), { ...obj('npc'), active: false, talk: '@cv,0' }],
      [trig('t1', 'a', true)],
      [conv('cv', { beam: { to: 's' } })],
    );
    const withContacts = { ...c, ship: { data: { contacts: { comms: [{ object: 'npc', sprite: true }], lounge: [] } } } } as unknown as GameContent;
    const [row] = routeCensus(withContacts);
    expect(row.chain.map(s => s.via)).toEqual(['start', 'comms', 'beam']);
  });
});
