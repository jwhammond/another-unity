// SPDX-License-Identifier: GPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { combatSim, SHIP_FLAGS, shipKind, type GameContent } from '@another-unity/engine';
import { describe, expect, it } from 'vitest';
import { loadSpriteFrames } from './combatAssets';
import { liftGame } from './lift';
import { readOverrides } from './overrides';
import { readRaw } from './raw';

// RAW_DIR=$HOME/pcode/unity-raw/runs/export/raw (after Plan 18 Tasks 1-2's export); IMAGES_DIR and AUDIO_DIR are optional
const RAW = process.env.RAW_DIR ?? '';
const IMAGES = process.env.IMAGES_DIR ?? '';
const AUDIO = process.env.AUDIO_DIR ?? '';
const GAMEDATA = process.env.GAMEDATA_DIR ?? '';
if (!RAW) console.info('live-combat.test.ts: skipped; set RAW_DIR to the export (…/runs/export/raw) to check the 40 battles');
if (RAW && !IMAGES) console.info('live-combat.test.ts: the sprite check is skipped; set IMAGES_DIR (…/runs/images/media)');
if (RAW && !AUDIO) console.info('live-combat.test.ts: the sound check is skipped; set AUDIO_DIR (…/runs/audio/media)');
if (RAW && !GAMEDATA) console.info('live-combat.test.ts: the check of the cue files the game lacks is skipped; set GAMEDATA_DIR (~/pcode/unity-gamedata/cd)');
const SPACE = join('games/unity', 'space');
if (RAW && !existsSync(SPACE)) console.info('live-combat.test.ts: the glTF check is skipped; games/unity/space is absent: run npm run space -- --raw $RAW_DIR');

describe.skipIf(!RAW)('the combat data from the real export (Plan 18; spec §3.2)', { timeout: 180_000 }, () => {
  async function lift() {
    const raw = await readRaw(RAW);
    const spriteFrames = IMAGES ? await loadSpriteFrames(IMAGES) : undefined;
    return { raw, result: liftGame(raw, { worlds: [7], spriteFrames }, await readOverrides('games/unity/overrides')) };
  }

  it('lifts all 40 battles; every ship has its model, its tactics and its stats, and anything missing is listed', async () => {
    const { result } = await lift();
    expect(result.problems.errors).toEqual([]);
    const combat = result.lifted.combat!;
    const battles = Object.entries(combat.battles);
    expect(battles).toHaveLength(40);
    const missing: string[] = [];
    let ships = 0;
    for (const [scenario, b] of battles) {
      if (!b.ships.some(s => combat.kinds[s.type]?.name === 'enterprise')) missing.push(`battle ${scenario}: no Enterprise`);
      for (const s of b.ships) {
        ships++;
        const k = combat.kinds[s.type]!;
        const where = `battle ${scenario} ${s.object} (${k.name})`;
        if (!k.models.detail) missing.push(`${where}: no model`);
        if ((k.flags & SHIP_FLAGS.reduced) && !k.models.reduced) missing.push(`${where}: no reduced model`);
        if ((k.flags & SHIP_FLAGS.tactics) && !s.tactics) missing.push(`${where}: no tactics`);
        if (k.base === '') missing.push(`${where}: no stats (_combatShips)`);
      }
    }
    expect(combat.enemyUnits).toHaveLength(20);
    expect(result.lifted.ship.units.every(u => u.hitWeight !== undefined && u.efficiency !== undefined)).toBe(true);
    console.info(`combat: ${battles.length} battles, ${ships} ships, ${Object.keys(combat.models).length} models, ${Object.keys(combat.tactics).length} tactics files`);
    console.info(`combat: missing model/tactics/stats: ${missing.join('; ') || 'none'}`);
    console.info(`combat: gaps: ${(result.lifted.combatGaps ?? []).join('; ') || 'none'}`);
    // Ruling (ledger): battle 3's one object is named with a typo of the Enterprise's name, so no kind matches it, and it is inactive (flags 0):
    // the original has no Enterprise there either (Combat::setup: "no battle the game reaches is like this", combat.cpp:237-241).
    // Evidence: export objects/o_100300.json (name, flags 0); screens/s_1003.json lists only it and o_100301.
    expect(missing).toEqual(['battle 3: no Enterprise']);
    // (without --images combat.yaml has no frame counts: that one gap, Plan 20)
    expect(result.lifted.combatGaps ?? []).toEqual(IMAGES ? [] : ['combat animations: no --images, so combat.yaml has no frame counts (the combat sim refuses it)']);
    expect([ships, Object.keys(combat.models).length, Object.keys(combat.tactics).length]).toEqual([102, 85, 12]);
  });

  it('has the tables at their sizes, and the kinds in the engine\'s order (combat.h\'s kCombat*, KIND)', async () => {
    const { result } = await lift();
    const combat = result.lifted.combat!;
    expect(combat.kinds.map(k => k.name)).toEqual(Object.keys(combatSim.KIND));
    // (by KIND's numbers, which the engine indexes by, not only its keys' order)
    expect(combat.kinds.map(k => (combatSim.KIND as Record<string, number>)[k.name])).toEqual(combat.kinds.map((_, i) => i));
    expect([combat.flight.turns.length, combat.flight.speeds.length, combat.flight.turnScales.length]).toEqual([84, 40, 24]);
    for (const f of [...combat.flight.speeds, ...combat.flight.turnScales]) expect(Math.fround(f)).toBe(f);
    expect(combat.powerLevels.map(l => l.length)).toEqual([35, 35, 35, 35, 35]);
    expect(combat.cues).toHaveLength(0x84);
    expect(combat.hitLists.enterprise).toHaveLength(8);
    expect(combat.scanner.enterprise).toHaveLength(11);
  });

  it('reads every battle\'s ships through shipKind: the Enterprise by name, the friends by kShipKinds\' flags (Plan 23)', async () => {
    const { result } = await lift();
    const combat = result.lifted.combat!;
    const content = { ship: { combat } } as unknown as GameContent;
    const friendlyKinds = ['klingon', 'ferengi', 'starbase', 'shuttle', 'mother'];
    let ships = 0, enterprises = 0, friends = 0;
    const noEnterprise: string[] = [];
    for (const [scenario, b] of Object.entries(combat.battles)) {
      const kinds = b.ships.map(s => ({ name: combat.kinds[s.type]!.name, ...shipKind(content, s.type) }));
      for (const k of kinds) {
        expect(k.enterprise).toBe(k.name === 'enterprise');
        expect(k.friendly).toBe(friendlyKinds.includes(k.name));
      }
      ships += kinds.length;
      enterprises += kinds.filter(k => k.enterprise).length;
      friends += kinds.filter(k => k.friendly).length;
      if (!kinds.some(k => k.enterprise)) noEnterprise.push(scenario);
    }
    console.info(`shipKind: ${Object.keys(combat.battles).length} battles, ${ships} ships, ${enterprises} Enterprises, ${friends} friendly`);
    // (battle 3's one object is a misspelt Enterprise, the ruling above)
    expect(noEnterprise).toEqual(['3']);
    expect(ships).toBe(102);
  });

  it.skipIf(!IMAGES)('names only sprites the images export has', async () => {
    const { result } = await lift();
    const media = result.lifted.combat!.media;
    const sprites = new Set((await readdir(join(IMAGES, 'images/sprites'))).map(n => n.toLowerCase()));
    expect(media.sprites).toHaveLength(21);
    expect(media.sprites.filter(s => !sprites.has(s))).toEqual([]);
  });

  // The cue files the game itself lacks (Plan 24 R3): no member of STTNG.ZIP or STTNGINS.ZIP, nor any file on the CD, has
  // these names, so the audio export (which reads the game's archives) has nothing to decode. ScummVM's cue then plays
  // nothing: Sound::playOnChannel stops the channel and returns at a file it hasn't (sound.cpp:167-172).
  const LACKED_BY_GAME = ['fe0202c1.vac', 'fe040266.vac', 'fe040288.vac', 'fe040289.vac', 'fe04028a.vac', 'fe04028b.vac', 'fe04028c.vac', 'fe04029f.vac', 'fe0602d1.vac', 'fe0602dd.vac', 'fe0602df.vac'];

  it.skipIf(!AUDIO)('has every combat sound and cue file in the audio export but the 11 cue files the game lacks', async () => {
    const { result } = await lift();
    const combat = result.lifted.combat!;
    const audio = new Set((await readdir(join(AUDIO, 'audio'))).map(n => n.toLowerCase().replace(/\.wav$/, '')));
    const sounds = [combat.media.music, ...combat.media.sounds];
    const cues = [...new Set(combat.cues.flatMap(q => (q.file ? [q.file] : [])))].sort();
    const absentSounds = sounds.filter(s => !audio.has(s));
    const absentCues = cues.filter(s => !audio.has(s));
    console.info(`combat: ${sounds.length - absentSounds.length} of ${sounds.length} sounds and ${cues.length - absentCues.length} of ${cues.length} cue files are in the audio export`);
    console.info(`combat: cue files the game lacks, which play nothing: ${absentCues.join(', ') || 'none'}`);
    expect(absentSounds).toEqual([]);
    expect([sounds.length, cues.length]).toEqual([19, 126]);
    expect(absentCues).toEqual(LACKED_BY_GAME);
  });

  it.skipIf(!GAMEDATA)('finds the 11 cue files in none of the game\'s archives or CD files, and every other cue file in them', async () => {
    const { result } = await lift();
    const cues = [...new Set(result.lifted.combat!.cues.flatMap(q => (q.file ? [q.file.toLowerCase()] : [])))].sort();
    // (unzip -Z1 lists an archive's members, one a line; the CD's own files are the directory's)
    const members = (zip: string): string[] => execFileSync('unzip', ['-Z1', join(GAMEDATA, zip)], { encoding: 'utf8', maxBuffer: 1 << 24 }).split('\n').map(m => m.trim().toLowerCase());
    const game = new Set([...members('STTNG.ZIP'), ...members('STTNGINS.ZIP'), ...(await readdir(GAMEDATA)).map(n => n.toLowerCase())]);
    expect(cues.filter(c => !game.has(c))).toEqual(LACKED_BY_GAME);
    expect(new Set(members('STTNG.ZIP')).has('fe0202cb.vac')).toBe(true);
  });

  it.skipIf(!existsSync('games/unity/audio'))('has every combat sound and cue the game has transcoded into games/unity/audio (npm run unity:build)', async () => {
    const { result } = await lift();
    const combat = result.lifted.combat!;
    const stem = (file: string) => file.toLowerCase().replace(/\.[^.]*$/, '');
    const transcoded = new Set<string>();
    for (const dir of ['voice', 'sfx', 'music']) {
      for (const name of await readdir(join('games/unity/audio', dir)).catch(() => [] as string[])) transcoded.add(stem(name));
    }
    const files = [combat.media.music, ...combat.media.sounds, ...new Set(combat.cues.flatMap(q => (q.file ? [q.file.toLowerCase()] : [])))];
    const missing = files.filter(f => !transcoded.has(stem(f)));
    console.info(`combat: ${files.length - missing.length} of ${files.length} sound and cue files are transcoded in games/unity/audio`);
    expect(missing.sort()).toEqual(LACKED_BY_GAME);
  });

  it('counts the scripts that move or re-cloak a battle object before its battle, for Plan 19 (Review Focus 5)', async () => {
    const { raw } = await lift();
    const moves: string[] = [];
    let targeted = 0;
    const visit = (v: unknown, where: string): void => {
      if (Array.isArray(v)) { v.forEach(x => visit(x, where)); return; }
      if (v === null || typeof v !== 'object') return;
      const o = v as Record<string, unknown>;
      if (o.class === 'AlterBlock' && typeof o.target === 'string' && o.target.startsWith('10')) targeted++;
      if (o.class === 'AlterBlock' && typeof o.target === 'string' && o.target.startsWith('10')
        && (o.x_pos !== 65535 || o.y_pos !== 65535 || o.y_adjust !== 65535)) moves.push(`${where} -> ${o.target}`);
      for (const x of Object.values(o)) visit(x, where);
    };
    for (const [id, o] of raw.objects) visit(o, `o_${id}`);
    for (const [id, c] of raw.conversations) visit(c, id);
    console.info(`combat: ${moves.length} AlterBlock(s) move or re-cloak a space-world object: ${moves.join(', ')}`);
    // none of the space world's 58 AlterBlocks sets a position (x_pos, y_pos) or a cloak time (y_adjust): they set a state (11), reset (33)
    // or flags (5), and the other 9 only change the cursor (counted from the live run). So createShip's reading of the object as it stands moves nothing before a battle: the file values hold.
    expect(targeted).toBe(58);
    expect(moves).toEqual([]);
  });

  it.skipIf(!existsSync(SPACE))('built a glTF for every model', async () => {
    const { result } = await lift();
    const models = Object.values(result.lifted.combat!.models);
    expect(models.filter(m => !existsSync(join('games/unity', m.url))).map(m => m.url)).toEqual([]);
  });

  it('says which tactics files no ship runs', async () => {
    const { raw, result } = await lift();
    const used = new Set(Object.keys(result.lifted.combat!.tactics));
    const unused = [...(raw.space?.keys() ?? [])].filter(n => n.endsWith('.bin') && !used.has(n));
    console.info(`combat: tactics files no ship runs: ${unused.join(', ') || 'none'}`);
    expect(unused).toEqual(['bx.bin', 'nowarp.bin', 'probe.bin', 'shuttle.bin', 'warbird.bin']);
  });
});
