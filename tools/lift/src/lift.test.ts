// SPDX-License-Identifier: GPL-3.0-or-later
import { makeAstroDb } from './testing/astro-db';
import { makeDb } from './testing/computer-db';
import { describe, expect, it } from 'vitest';
import { liftGame } from './lift';
import { alter, convBlock, miniRaw, NONE, obj, response, trig, triggerBlock, type J } from './testing/mini';
import { rawFromMini } from './testing/ctx';

describe('liftGame on the synthetic export', () => {
  it('lists the lifted worlds\' missions, and starts in the first of the original\'s order (M3 Plan 8 R6, R7)', () => {
    const result = liftGame(rawFromMini(), { worlds: [2, 7] });
    const c = result.content!;
    expect(c.start.screen).toBe('horst3.s01');
    expect(c.missions).toEqual([{ world: 'horst3', number: 7, screen: 'horst3.s01', entrance: 'entrance_0' }]);
    // (the synthetic export has no located allanor screen: its mission is left out, and said so)
    expect(result.problems.warnings.some(w => w.includes("s_0201 for world 2's beam-down"))).toBe(true);
  });

  it('lifts Horst III without problems, and the engine loads the result', () => {
    const result = liftGame(rawFromMini(), { worlds: [7] });
    expect(result.problems.errors).toEqual([]);
    const c = result.content!;
    expect(Object.keys(c.objects).filter(id => c.objects[id].crew)).toEqual(['picard', 'riker', 'data', 'troi', 'worf', 'crusher']);
    expect(['medical_tricorder', 'tricorder', 'communicator', 'phaser', 'medkit'].map(id => c.objects[id].inventory ?? false))
      .toEqual([true, true, false, true, true]);
    expect(c.start).toEqual({ screen: 'horst3.s01', entrance: 'entrance_0', awayTeam: ['picard', 'riker', 'data', 'troi'], leader: 'picard' });
    expect(Object.keys(c.conversations).sort()).toEqual(['frigis.c015', 'horst3.c000', 'ship.c034']);
    expect(Object.keys(c.screens).sort()).toEqual(['horst3.s01', 'horst3.s02', 'horst3.s03', 'ship.s01']);
    expect(c.triggers.map(t => t.id)).toEqual(['t3', 't4', 't9', 't2', 't8', 't10', 't21', 't69', 't71', 't12']);
    expect(c.advice['horst3.a1'].easy?.picard).toBe('@horst3.c000,1');
  });

  it('writes the same files every time', () => {
    const a = liftGame(rawFromMini(), { worlds: [7] }).files;
    const b = liftGame(rawFromMini(), { worlds: [7] }).files;
    expect([...a.keys()]).toEqual([...b.keys()].sort());
    expect([...a]).toEqual([...b]);
  });

  it('matches the golden files', async () => {
    const { files } = liftGame(rawFromMini(), { worlds: [7] });
    expect([...files.keys()]).toEqual([
      'advice.yaml', 'combat.yaml', 'conversations/frigis/c015.yaml', 'conversations/horst3/c000.yaml', 'conversations/ship/c034.yaml',
      'coords.yaml', 'coverage/horst3.json', 'game.yaml', 'hooks/generated.ts', 'ids.yaml',
      'objects/crew/00-picard.yaml', 'objects/crew/01-riker.yaml', 'objects/crew/02-data.yaml', 'objects/crew/03-troi.yaml',
      'objects/crew/04-worf.yaml', 'objects/crew/05-crusher.yaml', 'objects/horst3/s01/door.yaml', 'objects/horst3/s01/rubble.yaml',
      'objects/horst3/s01/setup_world.yaml', 'objects/horst3/s02/guard.yaml', 'objects/items/communicator.yaml',
      'objects/items/medical_tricorder.yaml', 'objects/items/medkit.yaml', 'objects/items/phaser.yaml',
      'objects/items/tricorder.yaml', 'objects/ship/offscreen/beacon.yaml', 'objects/ship/offscreen/enterprise.yaml', 'objects/ship/offscreen/planet.yaml', 'presentation.yaml', 'readings.yaml',
      'rooms/horst3/s01.json', 'rooms/horst3/s02.json', 'rooms/horst3/s03.json',
      'screens/horst3/s01.yaml', 'screens/horst3/s02.yaml', 'screens/horst3/s03.yaml', 'screens/ship/s01.yaml', 'screentexts.yaml', 'ship.yaml', 'triggers.yaml', 'universe.yaml', 'voices.yaml',
    ]);
    for (const [path, text] of files) await expect(text).toMatchFileSnapshot(`./__golden__/mini/${path}`);
  });

  it('writes the ship\'s computer when the export has computer.db', async () => {
    const r = rawFromMini();
    const executable = { ...r.executable, _computerEntryIds: [1], _tricorderReadings: [{ key: 70010, parent: 0, entry: 1 }] };
    const computer = makeDb([{ title: '-Root-', heading: '-r-', text: '-Zap-', subentries: [1] }, { title: '-Leaf-', heading: '-l-', text: '-Zip-', flags: 1 }]);
    // (entry 1 is hidden at the start, and one reading is recorded)
    const compstat = new Uint8Array(268);
    compstat[0] = 1 << 1;
    compstat[256] = 1;
    compstat.set([70010 & 0xff, (70010 >> 8) & 0xff, 70010 >> 16, 0], 264);
    const { files, problems } = liftGame({ ...r, executable, computer, compstat }, { worlds: [7] });
    expect(problems.errors).toEqual([]);
    await expect(files.get('computer.yaml')).toMatchFileSnapshot('./__golden__/mini/computer.yaml');
  });

  it('writes the universe when the export has astro.db, and an empty file without it', () => {
    const r = rawFromMini();
    expect(liftGame(r, { worlds: [7] }).files.get('universe.yaml')).toMatch(/\n\{\}\n$/);
    const executable = { ...r.executable, _sectorRegions: Array.from({ length: 512 }, () => 1), _regionChatter: [4], _warpSpeeds: [9], _impulseSpeeds: [3] };
    const astro = makeAstroDb({ sectors: [{ numStars: 1 }], stars: [{ id: 5, name: '-Sol-' }] });
    // (a universe needs the computer beside it: the engine loads the ship's three files together)
    const computer = makeDb([{ title: '-Root-', heading: '-r-', text: '-Zap-' }]);
    const { files, lifted, problems } = liftGame({ ...r, executable, astro, computer }, { worlds: [7] });
    expect(problems.errors).toEqual([]);
    expect(lifted.universe?.stars.map(x => x.name)).toEqual(['-Sol-']);
    expect(files.get('universe.yaml')).toContain('-Sol-');
  });

  it('reports coverage for the world, with every IR field accounted for', () => {
    const { lifted } = liftGame(rawFromMini(), { worlds: [7] });
    const cov = lifted.coverage.get('horst3')!;
    expect(cov).toMatchObject({
      generated: 'tools/lift', world: 'horst3', objects: 4, stubs: 0, conversations: 1, screens: 3,
      hooks: [{ name: 'unity.general.g5', ported: false, usedBy: 1 }],
      voices: { mapped: null },
      layout: { flat: ['horst3.s03'], noPolygons: [] },
    });
    expect(cov.fields.consumed + cov.fields.ignored).toBe(cov.fields.total);
    expect(cov.rules.entries).toMatchObject({ ConditionBlock: 3, AlterBlock: 6, ChoiceBlock: 1, ScreenBlock: 2 });
    const ported = liftGame(rawFromMini(), { worlds: [7], ported: new Set(['unity.general.g5']) });
    expect(ported.lifted.coverage.get('horst3')!.hooks[0].ported).toBe(true);
    expect(ported.files.get('hooks/generated.ts')).toContain("import { hook as ported0 } from './ported/unity.general.g5';");
  });

  it('lifts the ship world: its objects with their positions in space, and its ship triggers', () => {
    const result = liftGame(rawFromMini(), { worlds: [7] });
    expect(result.problems.errors).toEqual([]);
    const c = result.content!;
    expect(c.objects['ship.enterprise'].universe).toEqual({ x: 90, y: 90, z: 90 });
    expect(c.objects['ship.planet'].universe).toEqual({ x: 10, y: 20, z: 30 });
    const near = c.triggers.find(t => t.id === 't9')!;
    expect(near.proximity).toEqual({ dist: 5, from: 'ship.enterprise', to: 'ship.planet', reversed: false, instant: true });
    expect(c.triggers.find(t => t.id === 't12')).toMatchObject({ type: 'timer', context: 'ship', seconds: 25 });
    expect(c.screens['ship.s01']).toBeDefined();
    expect(result.files.has('rooms/ship/s01.json')).toBe(false);
    expect(result.lifted.ship.astro.enterprise).toBe('ship.enterprise');
    expect(result.lifted.ship.astro.starbaseBattle).toBe(0x50);
    expect(result.lifted.ship.equipment).toEqual(['medical_tricorder', 'tricorder', 'phaser', 'medkit']);
  });

  it('lifts what Horst III refers to in other worlds: their screens, and their objects as stubs', () => {
    const raw = rawFromMini(miniRaw(files => {
      files['objects/o_020101.json'] = obj('020101', { name: 'guard', x: 100, y: 390, use_entries: [[alter({ target: '020101', alter_state: 2 })]] });
      files['screens/s_0201.json'] = {
        id: 's_0201', world: 2, screen: 1, objects: ['020101'],
        location: { background: 'sb002001.scr', polygons: 'st002001.scr', entrypoints: [[{ x: 1, y: 390 }, { x: 2, y: 390 }, { x: 3, y: 390 }, { x: 4, y: 390 }]] },
        polygons: [],
      };
      const setup = files['objects/o_070100.json'] as J;
      ((setup.use_entries as J[][])[0][4] as J).target = ['070103', '000020', '020101'];
    }));
    const result = liftGame(raw, { worlds: [7] });
    expect(result.problems.errors).toEqual([]);
    const c = result.content!;
    expect(c.objects['allanor.guard']).toMatchObject({ screen: 'allanor.s01', at: 'allanor.guard' });
    expect(c.objects['allanor.guard'].on).toBeUndefined();
    expect(c.screens['allanor.s01']).toBeDefined();
    expect(result.lifted.coverage.get('horst3')!.stubs).toBe(1);
  });

  it('stops the closure at stubs and secondary content, which warn instead of failing', () => {
    const raw = rawFromMini(miniRaw(files => {
      // an allanor object whose talk names a conversation that turns on an away trigger: it is a stub, so none of it is lifted
      files['objects/o_020106.json'] = obj('020106', { name: 'viewer', x: 10, y: 390, talk_string: '@3,0' });
      files['screens/s_0201.json'] = {
        id: 's_0201', world: 2, screen: 1, objects: ['020106'],
        location: { background: 'sb002001.scr', polygons: 'st002001.scr', entrypoints: [[{ x: 1, y: 390 }, { x: 2, y: 390 }, { x: 3, y: 390 }, { x: 4, y: 390 }]] },
        polygons: [],
      };
      files['conversations/w002c003.json'] = {
        id: 'w002c003', our_world: 2, our_id: 3,
        responses: [response({ id: 0, text: 'Show the viewer.', results: [[[triggerBlock({ trigger_id: 13 })]]] })],
      };
      (files['triggers.json'] as J[]).push(trig({ id: 13, type: 0, target: '020106', context: 1 }));
      // a fixed-line conversation that names "the current world", which a ship conversation can't know
      const lines = files['conversations/w05fc034.json'] as J;
      (lines.responses as J[]).push(response({ id: 50, text: 'Hm.', results: [[[convBlock({ world_id: 0xffff })]]] }));
      const setup = files['objects/o_070100.json'] as J;
      ((setup.use_entries as J[][])[0][4] as J).target = ['070103', '000020', '020106'];
    }));
    const result = liftGame(raw, { worlds: [7] });
    expect(result.problems.errors).toEqual([]);
    const c = result.content!;
    expect(c.objects['allanor.viewer']).toEqual({ id: 'allanor.viewer', name: 'viewer', screen: 'allanor.s01', at: 'allanor.viewer' });
    expect(c.conversations['allanor.c003']).toBeUndefined();
    expect(c.triggers.map(t => t.id)).not.toContain('t13');
    expect(c.screens['allanor.s01'].startup).toBeUndefined();
    expect(result.files.has('rooms/allanor/s01.json')).toBe(false);
    expect(result.problems.warnings.some(w => w.startsWith('w05fc034#/responses/6/results/0/0/0: ') && w.endsWith('(in closure-only content, so it is dropped)'))).toBe(true);
  });

  it('never lets secondary content widen the triggers: what it names is a warning, and is not lifted', () => {
    const raw = rawFromMini(miniRaw(files => {
      // ship.c034 is secondary (the fixed lines); trigger 13 is an away trigger on a stub, and 11 targets no object
      files['objects/o_020106.json'] = obj('020106', { name: 'viewer', x: 10, y: 390 });
      files['screens/s_0201.json'] = {
        id: 's_0201', world: 2, screen: 1, objects: ['020106'],
        location: { background: 'sb002001.scr', polygons: 'st002001.scr', entrypoints: [[{ x: 1, y: 390 }, { x: 2, y: 390 }, { x: 3, y: 390 }, { x: 4, y: 390 }]] },
        polygons: [],
      };
      const lines = files['conversations/w05fc034.json'] as J;
      (lines.responses as J[]).push(
        response({ id: 50, text: 'Engage.', results: [[[triggerBlock({ trigger_id: 13 })]]] }),
        response({ id: 51, text: 'Go ahead with it.', results: [[[triggerBlock({ trigger_id: 11 })]]] }),
      );
      (files['triggers.json'] as J[]).push(trig({ id: 11, type: 0, target: NONE }), trig({ id: 13, type: 0, target: '020106' }));
    }));
    const result = liftGame(raw, { worlds: [7] });
    expect(result.problems.errors).toEqual([]);
    expect(result.content!.triggers.map(t => t.id)).not.toContain('t13');
    expect(result.problems.warnings).toContain(
      "w05fc034#/responses/6/results/0/0/0: trigger 13 is outside the lift's scope (only primary content widens it) (in closure-only content, so it is dropped)",
    );
    expect(result.problems.warnings).toContain(
      "w05fc034#/responses/7/results/0/0/0: trigger 11 is outside the lift's scope (only primary content widens it) (in closure-only content, so it is dropped)",
    );
  });

  it('lists screens with no walk polygons, and flat ones, for checking by hand', () => {
    const raw = rawFromMini(miniRaw(files => {
      files['screens/s_0704.json'] = {
        id: 's_0704', world: 7, screen: 4, objects: null,
        location: { background: 'sb007004.scr', polygons: 'st007004.scr', entrypoints: [[{ x: 1, y: 390 }, { x: 2, y: 390 }, { x: 3, y: 390 }, { x: 4, y: 390 }]] },
        polygons: [],
      };
    }));
    const result = liftGame(raw, { worlds: [7] });
    expect(result.problems.errors).toEqual([]);
    expect(result.lifted.coverage.get('horst3')!.layout).toEqual({ flat: ['horst3.s03', 'horst3.s04'], noPolygons: ['horst3.s04'] });
  });

  it('fails on an IR field the lifter neither reads nor ignores', () => {
    const raw = rawFromMini(miniRaw(files => {
      ((files['objects/o_070100.json'] as J).use_entries as J[][])[0][0] = { ...((files['objects/o_070100.json'] as J).use_entries as J[][])[0][0], foo: 1 };
    }));
    expect(liftGame(raw, { worlds: [7] }).problems.errors).toEqual([
      'IR field "entry:AlterBlock.foo" is neither lifted nor in the ignored table (tools/lift/src/ignored.ts)',
    ]);
  });

  it('fails on a position in a crew member\'s script, unless contexts.yaml gives it a screen', () => {
    const raw = rawFromMini(miniRaw(files => {
      (files['objects/o_000001.json'] as J).use_entries = [[alter({ target: '000001', x_pos: 320, y_pos: 390 })]];
    }));
    expect(liftGame(raw, { worlds: [7] }).problems.errors).toEqual([
      "o_000001#/use_entries/0/0: refers to the current screen, but o_000001's lists can run on any screen (give it a screen in overrides/contexts.yaml)",
    ]);
    const fixed = liftGame(raw, { worlds: [7], contexts: { o_000001: { screen: 's_0701' } } });
    expect(fixed.problems.errors).toEqual([]);
    expect(fixed.content!.objects.riker.on?.use?.[0].do[0]).toEqual({ alter: { object: 'riker', at: 'p320_390' } });
  });

  it('fails when the engine rejects the result', () => {
    const raw = rawFromMini(miniRaw(files => {
      (files['objects/o_070201.json'] as J).talk_string = '@0,x';
    }));
    const errors = liftGame(raw, { worlds: [7] }).problems.errors;
    expect(errors[0]).toBe('o_070201#/talk_string: bad conversation string "@0,x"');
    expect(errors[1]).toMatch(/^content: objects\/horst3\/s02\/guard\.yaml: talk: bad conversation string/);
  });

  it('warns, and does not fail, when the export has no computer.db', () => {
    const r = rawFromMini();
    const raw = { ...r, executable: { ...r.executable, _tricorderReadings: [{ key: 70010, parent: 0, entry: 0 }] } };
    expect(raw).not.toHaveProperty('computer');
    const result = liftGame(raw, { worlds: [7] });
    expect(result.problems.errors).toEqual([]);
    expect(result.problems.warnings.join('\n')).toMatch(/computer\.db/);
  });
});
