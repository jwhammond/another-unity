// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { miniCombat } from '../testing/combat';
import { ContentError, parseCombat, parseGame, type SourceFile } from './parse';
import type { CombatData } from './types';

const game = 'id: demo\nstart: { screen: room, entrance: door, awayTeam: [picard], leader: picard }\n';
const room = 'id: room\nmarkers: { door: { x: 0, z: 0 } }\nregions: { bridge: false }\n';
const picard = 'id: picard\nname: Picard\nscreen: room\ncrew: true\n';
const panel = (effect: string) =>
  `id: panel\nname: Panel\nscreen: room\non:\n  use:\n    - do:\n        - ${effect}\n`;

function files(extra: Record<string, string>): SourceFile[] {
  const all: Record<string, string> = {
    'game.yaml': game,
    'screens/room.yaml': room,
    'objects/crew/picard.yaml': picard,
    ...extra,
  };
  return Object.entries(all).map(([path, text]) => ({ path, text }));
}

function problemsOf(f: SourceFile[]): string[] {
  try {
    parseGame(f);
  } catch (e) {
    if (e instanceof ContentError) return e.problems;
    throw e;
  }
  throw new Error('expected a ContentError');
}

describe('parseGame', () => {
  it('reads the missions, and refuses one whose screen or entrance doesn\'t exist (M3 Decision 12)', () => {
    const withMissions = (missions: string) => `${game}missions:\n${missions}`;
    const c = parseGame(files({ 'game.yaml': withMissions('  - { world: test, screen: room, entrance: door, beamEffect: false }\n') }));
    expect(c.missions).toEqual([{ world: 'test', screen: 'room', entrance: 'door', beamEffect: false }]);
    expect(problemsOf(files({ 'game.yaml': withMissions('  - { world: test, screen: moon, entrance: door }\n') })).join('\n'))
      .toMatch(/missions\[0\]\.screen: unknown screen "moon"/);
    expect(problemsOf(files({ 'game.yaml': withMissions('  - { world: test, screen: room, entrance: hatch }\n') })).join('\n'))
      .toMatch(/missions\[0\]\.entrance: unknown marker "hatch" on screen "room"/);
  });

  it('takes $current as a screen change\'s screen, $anyone as an act\'s object, and a missing effect (M3 Decisions 2, 3, 6)', () => {
    const c = parseGame(files({
      'objects/panel.yaml': 'id: panel\nname: Panel\nscreen: room\non:\n  use:\n    - do:\n'
        + '        - screen: { to: $current, entrance: entrance_3, stepIn: true }\n'
        + '        - act: { verb: walk, object: $anyone }\n'
        + '        - missing: { kind: conversation, id: w003c007 }\n',
    }));
    expect(c.objects.panel.on?.use?.[0].do).toEqual([
      { screen: { to: '$current', entrance: 'entrance_3', stepIn: true } },
      { act: { verb: 'walk', object: '$anyone' } },
      { missing: { kind: 'conversation', id: 'w003c007' } },
    ]);
  });

  it('reads a proximity trigger, and refuses a proximity test on any other kind or a proximity trigger without one', () => {
    const prox = "proximity: { dist: 5, from: '5f0100', to: '5f0101', reversed: false, instant: true }";
    const c = parseGame(files({
      'objects/panel.yaml': 'id: panel\nname: Panel\nscreen: room\n',
      'triggers.yaml': `- { id: t9, type: proximity, context: ship, target: panel, enabled: false, ${prox} }\n`,
    }));
    expect(c.triggers[0].proximity).toEqual({ dist: 5, from: '5f0100', to: '5f0101', reversed: false, instant: true });
    for (const bad of [
      `- { id: t9, type: normal, context: ship, target: panel, enabled: false, ${prox} }\n`,
      '- { id: t9, type: proximity, context: ship, target: panel, enabled: false }\n',
    ]) {
      const problems = problemsOf(files({ 'objects/panel.yaml': 'id: panel\nname: Panel\nscreen: room\n', 'triggers.yaml': bad }));
      expect(problems.join('\n')).toMatch(/proximity/);
    }
  });

  it('parses a valid game', () => {
    const c = parseGame(files({ 'objects/panel.yaml': panel('alter: { object: panel, state: 1 }') }));
    expect(c.id).toBe('demo');
    expect(c.start.leader).toBe('picard');
    expect(c.objects.panel.on?.use?.[0].do[0]).toEqual({ alter: { object: 'panel', state: 1 } });
    expect(c.screens.room.regions).toEqual({ bridge: false });
    expect(c.triggers).toEqual([]);
  });

  it('reports an unknown object reference with its file and path', () => {
    const problems = problemsOf(files({ 'objects/panel.yaml': panel('alter: { object: dor, state: 1 }') }));
    expect(problems).toEqual(['objects/panel.yaml: on.use[0].do[0].alter.object: unknown object "dor"']);
  });

  it('takes $none, nobody, as the actor of an act and of a screen\'s startup action', () => {
    const c = parseGame(files({
      'objects/panel.yaml': panel('act: { verb: use, object: panel, who: $none }'),
      'screens/room.yaml': `${room}startup: { action: { verb: use, target: panel, who: $none } }\n`,
    }));
    expect(c.objects.panel.on?.use?.[0].do[0]).toEqual({ act: { verb: 'use', object: 'panel', who: '$none' } });
    expect(c.screens.room.startup?.action?.who).toBe('$none');
  });

  it('reads a pixel metric\'s floor, and reports a floor polygon whose region the screen doesn\'t have', () => {
    const metric = 'pixelMetric: { kind: flat, slope: 0, horizonY: 0, meanScale: 128, topY: 0, metersPerPixel: 0.0125, floor: [{ region: bridge, points: [{ x: 0, y: 0, scale: 128 }, { x: 9, y: 0, scale: 128 }, { x: 0, y: 9, scale: 128 }] }] }\n';
    const c = parseGame(files({ 'screens/room.yaml': `${room}${metric}` }));
    expect(c.screens.room.pixelMetric?.floor[0].points[2]).toEqual({ x: 0, y: 9, scale: 128 });
    const problems = problemsOf(files({ 'screens/room.yaml': `${room}${metric.replace('region: bridge', 'region: deck')}` }));
    expect(problems).toEqual(['screens/room.yaml: pixelMetric.floor.0.region: unknown region "deck"']);
  });

  it('reports an unknown marker and region', () => {
    const problems = problemsOf(files({
      'objects/panel.yaml': 'id: panel\nname: Panel\nscreen: room\nat: nowhere\non:\n  use:\n    - do:\n        - path: { enable: [bridg] }\n',
    }));
    expect(problems).toEqual([
      'objects/panel.yaml: at: unknown marker "nowhere" on screen "room"',
      'objects/panel.yaml: on.use[0].do[0].path: unknown region "bridg" on screen "room"',
    ]);
  });

  it('reports YAML syntax errors', () => {
    const problems = problemsOf(files({ 'objects/panel.yaml': 'id: [unclosed\n' }));
    expect(problems[0]).toMatch(/^objects\/panel\.yaml: YAML error: /);
  });

  it('reports an unknown effect with its path', () => {
    const problems = problemsOf(files({ 'objects/panel.yaml': panel('altr: { object: panel }') }));
    expect(problems[0]).toMatch(/^objects\/panel\.yaml: on\.use\[0\]\.do\[0\]: /);
  });

  it('reports duplicate object ids', () => {
    const problems = problemsOf(files({ 'objects/again.yaml': picard }));
    expect(problems).toEqual(['objects/crew/picard.yaml: duplicate object id "picard" (also in objects/again.yaml)']);
  });

  it('requires game.yaml', () => {
    const problems = problemsOf(files({}).filter(f => f.path !== 'game.yaml'));
    expect(problems).toEqual(['game.yaml: missing']);
  });

  it('requires the away team and leader to be crew', () => {
    const problems = problemsOf(files({ 'objects/crew/picard.yaml': 'id: picard\nname: Picard\nscreen: room\n' }));
    expect(problems).toEqual(['game.yaml: start: "picard" is not a crew object']);
  });

  const check = (c: string) => `id: panel\nname: Panel\nscreen: room\non:\n  use:\n    - when:\n        checks: [${c}]\n      do: []\n`;

  it('checks a check\'s marker on the screen it is about', () => {
    const hall = 'id: hall\nmarkers: { entry: { x: 0, z: 0 } }\n';
    const box = 'id: box\nname: Box\nscreen: hall\n';
    const problems = problemsOf(files({
      'screens/hall.yaml': hall,
      'objects/box.yaml': box,
      'objects/panel.yaml': check('{ object: box, at: door }, { object: box, screen: room, at: entry }, { object: $anyone, at: nowhere }, { object: box, at: entry }'),
    }));
    expect(problems).toEqual([
      'objects/panel.yaml: on.use[0].when.checks[0].at: unknown marker "door" on screen "hall"',
      'objects/panel.yaml: on.use[0].when.checks[1].at: unknown marker "entry" on screen "room"',
      'objects/panel.yaml: on.use[0].when.checks[2].at: unknown marker "nowhere" on screen "room"',
    ]);
  });

  it('requires a crew object for status inTeam', () => {
    const problems = problemsOf(files({
      'objects/panel.yaml': check('{ object: panel, status: inTeam }, { object: picard, status: inTeam }, { object: $anyone, status: inTeam }'),
    }));
    expect(problems).toEqual(['objects/panel.yaml: on.use[0].when.checks[0].status: status inTeam needs a crew object']);
  });

  it('reports duplicate trigger ids', () => {
    const t = '- { id: t, type: normal, context: away, target: picard, enabled: true }\n';
    const problems = problemsOf(files({ 'triggers.yaml': t + t }));
    expect(problems).toEqual(['triggers.yaml: [1].id: duplicate trigger id "t"']);
  });

  describe('the ship', () => {
    const universe = 'sectors: []\nstars: []\nphenomena: []\nstations: []\nspecials: []\nflags: []\nregionChatter: []\nwarpSpeeds: [1]\nimpulseSpeeds: [1]\nscriptedWarps: []\nplanetOrbits: []\nreveals: []\n';
    const shipYaml = (enterprise = 'w.ent') => `bridge: { items: [], objects: [], turbolift: [] }
transporter: { exits: [], teams: [{ world: 1, members: [picard], items: [] }], targets: [], pads: [] }
crew: { leaderOrder: [picard], voices: [] }
speeds: { warp: [1], impulse: [1] }
units: []
astro:
  enterprise: ${enterprise}
  starbaseBattle: 80
  defaultBattle: 8
  triggers: { arriveStarbase: t1, arriveStar: t1, firstVisit: t1, runAway: t1, secondVisitCheck: t1, secondVisit: t1 }
equipment: [picard]
contacts: { comms: [], lounge: [] }
`;
    const computer = 'entries: []\nentryIds: []\nreadingParents: {}\nhidden: []\nstartReadings: []\nreadings: []\n';
    const shipFiles = (extra: Record<string, string> = {}) => files({
      'objects/ship/ent.yaml': 'id: w.ent\nname: Ent\nscreen: null\n',
      'triggers.yaml': '- { id: t1, type: normal, context: ship, target: w.ent, enabled: true }\n',
      'universe.yaml': universe, 'ship.yaml': shipYaml(), 'computer.yaml': computer, ...extra,
    });

    it('loads universe.yaml, ship.yaml and computer.yaml into content.ship', () => {
      const c = parseGame(shipFiles());
      expect(c.ship?.data.astro.enterprise).toBe('w.ent');
      expect(c.ship?.universe.warpSpeeds).toEqual([1]);
    });

    const combatYaml = (edit: (c: CombatData) => void = () => {}) => {
      const c = miniCombat({ screen: 'room', enterprise: 'w.ent', enemy: 'w.ent' });
      edit(c);
      return stringify(c);
    };

    it('loads combat.yaml into content.ship.combat, and leaves it unset without one (Plan 18)', () => {
      const c = parseGame(shipFiles({ 'combat.yaml': combatYaml() }));
      expect(c.ship?.combat?.kinds).toHaveLength(10);
      expect(c.ship?.combat?.battles[3]?.ships.map(s => s.object)).toEqual(['w.ent', 'w.ent']);
      expect(c.ship?.combat?.tactics['mini.bin']?.kernel).toBe(0x6b);
      expect(parseGame(shipFiles()).ship?.combat).toBeUndefined();
    });

    it('reports a combat.yaml that names a missing tactics file, model, screen or object', () => {
      const text = problemsOf(shipFiles({
        'combat.yaml': combatYaml(c => {
          c.kinds[0]!.tactics = 'gone.bin';
          c.kinds[1]!.models.detail = 'gone.3dv';
          c.effects.shields[0] = 'gone.3dv';
          c.battles[3]!.screen = 'moon';
          c.battles[3]!.ships[1]!.object = 'w.gone';
          c.battles[3]!.ships[1]!.type = 12;
        }),
      })).join('\n');
      expect(text).toMatch(/combat\.yaml: kinds\[0\]\.tactics: unknown tactics "gone\.bin"/);
      expect(text).toMatch(/combat\.yaml: kinds\[1\]\.models\.detail: unknown model "gone\.3dv"/);
      expect(text).toMatch(/combat\.yaml: effects\.shields\[0\]: unknown model "gone\.3dv"/);
      expect(text).toMatch(/combat\.yaml: battles\.3\.screen: unknown screen "moon"/);
      expect(text).toMatch(/combat\.yaml: battles\.3\.ships\[1\]\.object: unknown object "w\.gone"/);
      expect(text).toMatch(/combat\.yaml: battles\.3\.ships\[1\]\.type: no kind 12/);
    });

    it('refuses a combat.yaml with nine kinds or a float that is not a number', () => {
      expect(problemsOf(shipFiles({ 'combat.yaml': combatYaml(c => { c.kinds.pop(); }) })).join('\n')).toMatch(/combat\.yaml: kinds/);
      expect(problemsOf(shipFiles({ 'combat.yaml': combatYaml(c => { c.flight.speeds = ['fast' as unknown as number]; }) })).join('\n')).toMatch(/combat\.yaml: flight\.speeds/);
    });

    it('parses combat.yaml on its own for the space build (parseCombat)', () => {
      expect(parseCombat(combatYaml()).models['mini.3dv']?.url).toBe('space/mini.3dv.glb');
      expect(() => parseCombat('kinds: []\n')).toThrow(ContentError);
    });

    it('leaves content.ship unset without them, and for an empty universe.yaml', () => {
      expect(parseGame(files({})).ship).toBeUndefined();
      expect(parseGame(files({ 'universe.yaml': '{}\n', 'ship.yaml': shipYaml() })).ship).toBeUndefined();
    });

    it('refuses some of the three without the others, naming the missing file', () => {
      const f = shipFiles().filter(x => x.path !== 'computer.yaml');
      expect(problemsOf(f).join('\n')).toMatch(/computer\.yaml: missing/);
      expect(problemsOf(shipFiles().filter(x => x.path !== 'ship.yaml')).join('\n')).toMatch(/ship\.yaml: missing/);
    });

    // (a ship.yaml lifted before Plan 23: one message saying to lift again, not the schema's bare complaints)
    it('refuses a ship.yaml from before Plan 23 that has battles, saying to lift again', () => {
      const old = shipYaml().replace('contacts:', 'battles: {}\ncontacts:');
      expect(problemsOf(shipFiles({ 'ship.yaml': old }))).toEqual(['ship.yaml is from before Plan 23: lift the game again (npm run unity:build)']);
    });

    it('refuses a ship.yaml from before Plan 23 whose unit has no efficiency, saying to lift again', () => {
      const unit = '{ name: C, type: 11, current: 100, target: 100, max: 100, chargeTicks: 0, dischargeTicks: 0, damage: 0, repair: 0, baseDamage: 0, maxDamage: 0 }';
      const old = shipYaml().replace('units: []', `units:\n  - ${unit}`);
      expect(problemsOf(shipFiles({ 'ship.yaml': old }))).toEqual(['ship.yaml is from before Plan 23: lift the game again (npm run unity:build)']);
      // (the same unit with its efficiency loads)
      expect(parseGame(shipFiles({ 'ship.yaml': old.replace('maxDamage: 0 }', 'maxDamage: 0, efficiency: 0 }') })).ship?.data.units).toHaveLength(1);
    });

    const withContacts = (ship: string) => ship
      .replace('contacts: { comms: [], lounge: [] }', 'contacts: { comms: [{ object: w.ent, sprite: true }], lounge: [picard] }');
    const computerWith = (hidden: number, reading: string) =>
      `entries: [{ title: a, heading: b, text: c, flags: 0, subentries: [] }]\nentryIds: []\nreadingParents: {}\nhidden: [${hidden}]\nstartReadings: [70011]\nreadings: [${reading}]\n`;
    const goodReading = '{ key: 70011, world: w, group: 1, index: 1, entry: 0, parent: 0 }';

    it('loads the contacts and the computer\'s starting state', () => {
      const c = parseGame(shipFiles({ 'ship.yaml': withContacts(shipYaml()), 'computer.yaml': computerWith(0, goodReading) }));
      expect(c.ship?.data.contacts).toEqual({ comms: [{ object: 'w.ent', sprite: true }], lounge: ['picard'] });
      expect(c.ship?.computer).toMatchObject({ hidden: [0], startReadings: [70011], readings: [{ key: 70011, world: 'w', group: 1, index: 1, entry: 0, parent: 0 }] });
    });

    it('reports a contact, a hidden entry or a reading that names what is missing', () => {
      const bad = withContacts(shipYaml()).replace('lounge: [picard]', 'lounge: [ghost]');
      const text = problemsOf(shipFiles({ 'ship.yaml': bad, 'computer.yaml': computerWith(7, goodReading.replace('entry: 0', 'entry: 3')) })).join('\n');
      expect(text).toMatch(/contacts\.lounge\[0\]: unknown object "ghost"/);
      expect(text).toMatch(/readings\[0\]\.entry: no entry 3/);
      expect(text).toMatch(/hidden: no entry 7/);
    });

    it('reports a slug that names no object or trigger', () => {
      expect(problemsOf(shipFiles({ 'ship.yaml': shipYaml('w.nope') })).join('\n')).toMatch(/ship\.yaml: astro\.enterprise: unknown object "w\.nope"/);
      expect(problemsOf(shipFiles({ 'ship.yaml': shipYaml().replace('equipment: [picard]', 'equipment: [gone]') })).join('\n')).toMatch(/equipment\[0\]: unknown object "gone"/);
      expect(problemsOf(shipFiles({ 'ship.yaml': shipYaml().replace('arriveStar: t1', 'arriveStar: t99') })).join('\n')).toMatch(/astro\.triggers\.arriveStar: unknown trigger "t99"/);
      expect(problemsOf(shipFiles({ 'ship.yaml': shipYaml().replace('members: [picard]', 'members: [ghost]') })).join('\n')).toMatch(/teams\[0\]\.members\[0\]: unknown object "ghost"/);
    });
  });
});
