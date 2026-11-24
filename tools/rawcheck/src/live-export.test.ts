// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_BLOCK_CLASSES, AstStatFile, CombatFile, ConversationFile, entryClasses, ExecutableFile, GameObject, IconMap, MovieMap, objectLists, PhaserMap, ScreenFile, SpriteList, TrigFile, TriggersFile, WorldFile } from './ir';
import { checkManifest, Manifest } from './manifest';
import { objectsBlocks, readJson } from './raw';

// RAW_DIR=$HOME/pcode/unity-raw/runs/export/raw (from run-harness.sh export)
const RAW = process.env.RAW_DIR ?? '';

/** A game line's sha256 prefix and length: it pins the text without the test holding it (the game's text is Paramount's). */
const fingerprint = (text: string) => `${createHash('sha256').update(text).digest('hex').slice(0, 12)}:${text.length}`;

describe.skipIf(!RAW)('the export of the real game', () => {
  it('lists every object, conversation, screen and world', async () => {
    const value = await readJson(RAW, 'manifest.json');
    expect(checkManifest(value)).toEqual([]);
    const m = Manifest.parse(value);
    expect(m.objects).toHaveLength(2561);
    expect(m.conversations).toHaveLength(182);
    expect(m.screens).toHaveLength(128);
    expect(m.worlds).toHaveLength(9);
    expect(m.screens).toContain('s_0202'); // in sl002.scr, with no object list
    expect(m.screens).toContain('s_0705'); // an object list, but not in sl007.scr
  });
});

describe.skipIf(!RAW)('the real objects', () => {
  const object = async (id: string) => GameObject.parse(await readJson(RAW, `objects/o_${id}.json`));

  it('writes every object, and between them they use every block class', async () => {
    const m = Manifest.parse(await readJson(RAW, 'manifest.json'));
    const classes = new Set<string>();
    let withPhaser = 0;
    for (const id of m.objects) {
      expect(m.files).toContain(`objects/o_${id}.json`);
      const obj = await object(id);
      expect(obj.id).toBe(id);
      entryClasses(objectLists(obj), classes);
      if (obj.phaser_data) withPhaser++;
    }
    expect([...classes].sort()).toEqual([...ALL_BLOCK_CLASSES]);
    expect(withPhaser).toBe(77); // 79 in phaser.map, two without a p_ file
  }, 120_000);

  it('writes rubble (070103) as the file has it', async () => {
    const rubble = await object('070103');
    expect(rubble).toMatchObject({ name: 'rubble', sprite_id: 709, x: 208, y: 336, width: 70, height: 70, flags: 0x22, state: 0 });
    expect(rubble.descriptions).toHaveLength(9);
    const { text: look, ...lookVoice } = rubble.descriptions[0];
    expect(lookVoice).toEqual({ entry_id: 8, voice_id: 0xa7, voice_group: 0xfe, voice_subgroup: 2 });
    expect(fingerprint(look)).toBe('206fac5b8105:41');
    expect(rubble.use_entries.map(group => group.map(e => [e.class, e._order]))).toEqual([[['ConditionBlock', -1], ['AlterBlock', 1]]]);
    expect(rubble.phaser_data).toMatchObject({ max_health: 2, threshold: 2, damage_setting: 1, gtp_min_setting: 1, gtp_setting: 1 });
  });

  it('writes Horst III\'s setup (070100) in execution order, not file order', async () => {
    const setup = await object('070100');
    // the file has alter 1, command 4, general 2, trigger 3, trigger -1
    expect(setup.use_entries[0].map(e => [e.class, e._order])).toEqual([
      ['TriggerBlock', -1], ['AlterBlock', 1], ['GeneralBlock', 2], ['TriggerBlock', 3], ['CommandBlock', 4],
    ]);
  });

  it('writes Picard\'s file values, though the export ran with him placed on 7/1', async () => {
    const picard = await object('000000');
    expect(picard).toMatchObject({ name: 'Picard', curr_screen: 1, x: 1, y: 1, skills: 0x5444, flags: 0x24, objwalktype: 1, sprite_id: 0, talk_string: '!' });
    const { text, ...voice } = picard.descriptions[0];
    expect(voice).toEqual({ entry_id: 0, voice_id: 0x92, voice_group: 0xfe, voice_subgroup: 4 });
    expect(fingerprint(text)).toBe('0a3c933c7821:29');
  });
});

describe.skipIf(!RAW)('the real conversations', () => {
  it('writes every conversation, using every block class but ChoiceBlock', async () => {
    const m = Manifest.parse(await readJson(RAW, 'manifest.json'));
    const classes = new Set<string>();
    for (const id of m.conversations) {
      const conv = ConversationFile.parse(await readJson(RAW, `conversations/${id}.json`));
      expect(conv.id).toBe(id);
      expect(conv.responses.length).toBeGreaterThan(0);
      for (const r of conv.responses) entryClasses(r.results, classes);
    }
    expect([...classes].sort()).toEqual(ALL_BLOCK_CLASSES.filter(c => c !== 'ChoiceBlock'));
  }, 60_000);

  it('writes Horst III\'s tricorder reading (w007c000) as the file has it', async () => {
    const conv = ConversationFile.parse(await readJson(RAW, 'conversations/w007c000.json'));
    expect(conv).toMatchObject({ our_world: 7, our_id: 0 });
    expect(conv.responses[0]).toMatchObject({
      id: 1, state: 0, response_state: 2, next_situation: 65535, target: 'ffffff',
      voice_id: 0xe7, voice_group: 0xfe, voice_subgroup: 0,
    });
    expect(fingerprint(conv.responses[0].text)).toBe('340da10d25ff:118');
  });
});

describe.skipIf(!RAW)('the real screens and worlds', () => {
  it('writes every screen; 78 have a location', async () => {
    const m = Manifest.parse(await readJson(RAW, 'manifest.json'));
    let located = 0;
    for (const id of m.screens) {
      const screen = ScreenFile.parse(await readJson(RAW, `screens/${id}.json`));
      expect(screen.id).toBe(id);
      if (screen.location) located++;
      for (const poly of screen.polygons) expect(poly.distances).toHaveLength(poly.points.length);
    }
    expect(located).toBe(78);
  });

  it('writes Horst III\'s first screen as sl007.scr and st007001.scr have it', async () => {
    const screen = ScreenFile.parse(await readJson(RAW, 'screens/s_0701.json'));
    expect(screen.objects).toHaveLength(13);
    expect(screen.objects?.[0]).toBe('070100');
    // (ScummVM's Pascal strings keep the file's trailing NUL)
    expect(screen.location?.background).toBe('sb007001.scr\u0000');
    expect(screen.location?.entrypoints).toHaveLength(2);
    expect(screen.location?.entrypoints[0]).toEqual([{ x: 312, y: 332 }, { x: 339, y: 332 }, { x: 322, y: 326 }, { x: 332, y: 327 }]);
    expect(screen.polygons).toHaveLength(8);
    expect(screen.polygons[0]).toMatchObject({ id: 23, type: 0, points: expect.arrayContaining([{ x: 176, y: 321 }]) });
    expect(screen.polygons[0].distances[0]).toBe(130);
  });

  it('writes screens with no st*.scr file with a location and no polygons', async () => {
    for (const id of ['s_0202', 's_0215', 's_050b']) {
      const s = ScreenFile.parse(await readJson(RAW, `screens/${id}.json`));
      expect(s.location, id).not.toBeNull();
      expect(s.polygons, id).toEqual([]);
    }
  });

  it('writes the startups and advice of Horst III', async () => {
    const world = WorldFile.parse(await readJson(RAW, 'worlds/w_07.json'));
    expect(world.startups).toHaveLength(256);
    expect(world.startups[1]).toMatchObject({ advice_id: 1, advice_timer: 65535, closeup: 0, combadge: 1, screen: 1, target: '070100', action: 6, who: '070100', input_blocked: 0 });
    expect(world.advice?.['1']?.easy[0]).toEqual({ name: 'Picard', text: '@10,1' });
    expect(world.advice?.['1']?.hard[0]).toEqual({ name: 'Picard', text: '@12,1' });
    const ship = WorldFile.parse(await readJson(RAW, 'worlds/w_00.json'));
    expect(ship.advice).toBeNull();
  });

  it('leaves the running game as it was', async () => {
    const log = await readFile(join(RAW, '..', 'out.log'), 'utf8');
    const blocks = objectsBlocks(log);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].length).toBeGreaterThan(0);
    expect(blocks[1]).toEqual(blocks[0]);
  });
});

describe.skipIf(!RAW)('the real tables', () => {
  it('writes the 226 triggers in file order', async () => {
    const triggers = TriggersFile.parse(await readJson(RAW, 'triggers.json'));
    expect(triggers).toHaveLength(226);
    const byType = [0, 1, 2, 3].map(t => triggers.filter(x => x.type === t).length);
    expect(byType).toEqual([72, 56, 78, 20]);
    for (const t of triggers) expect(t.dist === null).toBe(t.type !== 2);
  });

  it('writes the maps', async () => {
    expect(PhaserMap.parse(await readJson(RAW, 'maps/phaser.json'))._phaserableObjects).toHaveLength(79);
    const icons = IconMap.parse(await readJson(RAW, 'maps/icon.json'))._iconSprites;
    expect(Object.keys(icons)).toHaveLength(180);
    expect(icons['000000']).toBe('smhdpcrd.spr');
    const movies = MovieMap.parse(await readJson(RAW, 'maps/movie.json')).movies;
    expect(movies).toHaveLength(27); // movie.map has 27 entries
    const horst = movies.find(m => m.id === 55);
    expect(horst?.filename).toBe('ho3arriv.fvf');
    expect(fingerprint(horst?.description.trimEnd() ?? '')).toBe('850cd4601b75:20');
    expect(SpriteList.parse(await readJson(RAW, 'maps/sprite.json'))._spriteFilenames).toHaveLength(837);
  });

  it('writes the executable tables and ast_stat.dat', async () => {
    const exe = ExecutableFile.parse(await readJson(RAW, 'executable.json'));
    expect(Object.keys(exe._presetSounds).length).toBeGreaterThan(0);
    expect(Object.keys(exe._adviceNames).length).toBeGreaterThan(0);
    expect(exe._awayTeamScreenData.length).toBeGreaterThan(0);
    expect(exe._phaserMuzzles.length).toBeGreaterThan(0);
    expect(exe._transporterPads.length).toBeGreaterThan(0);
    expect(exe._scriptedWarps).toHaveLength(23); // NUM_SCRIPTED_WARPS
    expect(exe._planetOrbits).toHaveLength(16); // NUM_PLANET_ORBITS
    expect(exe._arrowCursor.pixels).toHaveLength(exe._arrowCursor.width * exe._arrowCursor.height);
    expect(exe._sectorRegions).toHaveLength(512); // 8x8x8, NUM_SECTORS
    expect(exe._bridgeItems.length).toBeGreaterThan(0);
    expect(exe._bridgeObjects.length).toBeGreaterThan(0);
    expect(exe._bridgeScreenEntries.length).toBeGreaterThan(0);
    expect(exe._shipUnits.length).toBeGreaterThan(0);
    const ast = AstStatFile.parse(await readJson(RAW, 'ast_stat.json'));
    expect(ast._flags).toHaveLength(ast.count);
    expect(0x6e2 + 2 * ast.count).toBeLessThanOrEqual(9596); // ast_stat.dat's size
  });

  it('writes the combat tables: enemy units, ship types, the flight model and the cues (Plan 18 Task 1)', async () => {
    const exe = ExecutableFile.parse(await readJson(RAW, 'executable.json'));
    expect(exe._enemyShip).toHaveLength(20); // NUM_ENEMY_UNITS
    expect(exe._combatShips).toHaveLength(11); // NUM_COMBAT_SHIP_TYPES
    expect(exe._combatShips.slice(0, 10).every(s => s.base !== '')).toBe(true);
    expect(exe._flightTurns).toHaveLength(84);
    expect(exe._flightSpeeds).toHaveLength(40);
    expect(exe._flightTurnScales).toHaveLength(24);
    expect(exe._cues).toHaveLength(0x84); // NUM_CUES
    expect(exe._cues.some(c => c.filename !== '')).toBe(true);
    // (the reactors' efficiency, which shipSystems.ts has hard-coded as 95 until now; and some unit can be hit)
    expect([exe._shipUnits[33]!.efficiency, exe._shipUnits[34]!.efficiency]).toEqual([95, 95]);
    expect(exe._shipUnits.some(u => u.hitWeight > 0)).toBe(true);
    expect(exe._enemyShip.some(u => u.hitWeight > 0)).toBe(true);
    console.info(`combat ship bases: ${exe._combatShips.map(s => s.base).join(', ')}`);
  });

  it('copies the files with no structured parser, and the space models (Plan 18 Task 2)', async () => {
    const m = Manifest.parse(await readJson(RAW, 'manifest.json'));
    const verbatim = m.files.filter(f => f.startsWith('verbatim/'));
    expect(verbatim).toHaveLength(435); // 48, 384 model, material and texture files (STTNG.ZIP's listing), and tactical's 3 still pictures
    expect(verbatim).toContain('verbatim/enterprs.bin');
    expect(verbatim).toContain('verbatim/w_07scrn.bst');
    expect(verbatim).toContain('verbatim/computer.db');
    expect(verbatim).toContain('verbatim/compstat');
    expect(verbatim).toContain('verbatim/astro.db');
    expect(verbatim).toContain('verbatim/sector.ast');
    for (const f of ['enterprs.3dv', 'enterprs.3dr', 'enterprs.mtl', 'enterprs.mtr', 'enterprs.dmg', 'generic.pc1', 'shield_8.3dv', 'bboard.mtl', 'boom.lbm', 'purple.img']) {
      expect(verbatim).toContain(`verbatim/${f}`);
    }
  });

  it('copies tactical\'s still pictures: the console, its images and the warp\'s background (Plan 24 Task 1)', async () => {
    const m = Manifest.parse(await readJson(RAW, 'manifest.json'));
    for (const f of ['spc00a.pic', 'space.mrg', 'cheap.pic']) expect(m.files).toContain(`verbatim/${f}`);
    // (a .pic is 256 6-bit colours and 640x480 indices, as setBackgroundImage reads it: graphics.cpp:311-342)
    for (const f of ['spc00a.pic', 'cheap.pic']) expect((await readFile(join(RAW, 'verbatim', f))).length).toBeGreaterThanOrEqual(768 + 640 * 480);
  });

  it('writes trig.json: sinf and cosf of the 16384 whole angles, as this Mac\'s C library gives them (Plan 22 Task 1)', async () => {
    const trig = TrigFile.parse(await readJson(RAW, 'trig.json'));
    const f = Math.fround;
    expect([f(trig.sin[0]!), f(trig.sin[4096]!), f(trig.cos[0]!), f(trig.cos[8192]!)]).toEqual([0, 1, 1, -1]);
    // (measured for Plan 22: Apple's sinf and cosf differ from Math's, rounded, on these many whole angles)
    const radians = (i: number) => f(f(f(i * 2) * f(Math.PI)) / 16384);
    const apart = (column: number[], m: (x: number) => number) => column.filter((v, i) => f(v) !== f(m(radians(i)))).length;
    expect([apart(trig.sin, Math.sin), apart(trig.cos, Math.cos)]).toEqual([218, 211]);
  });

  it('writes combat.json: five power levels of 35 units, the archive\'s media and the cited constants (Plan 18 Task 2)', async () => {
    const combat = CombatFile.parse(await readJson(RAW, 'combat.json'));
    expect(combat._powerLevels.map(l => l.length)).toEqual([35, 35, 35, 35, 35]);
    for (const f of ['__boom.spr', '__phaser.mac', 'enterpri.rac', 'spc00a.pic', 'cheap.pic', 'space.mrg']) expect(combat.archive).toContain(f);
    expect(combat.kShipKinds.value.map(k => k.name)).toEqual(['chodak', 'romulan', 'enterprise', 'klingon', 'probe', 'ferengi', 'starbase', 'garidian', 'shuttle', 'mother']);
  });
});
