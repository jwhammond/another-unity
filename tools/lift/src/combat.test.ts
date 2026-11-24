// SPDX-License-Identifier: GPL-3.0-or-later
import { decodeBase64, makeTacticsBin, parseCombat } from '@another-unity/engine';
import { describe, expect, it } from 'vitest';
import { raceFile } from './combat';
import { liftGame } from './lift';
import type { RawIR } from './raw';
import { rawFromMini } from './testing/ctx';
import { miniRaw, obj, type J } from './testing/mini';
import { makeGif, makeSpaceMaterials, makeSpaceModel } from './testing/space-files';

const bin = makeTacticsBin([{ cls: 3, opcode: 0x1f, page: 'MAIN', args: [0] }, { cls: 1, opcode: 0x2b, args: [0] }]);
const part = { vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]] as [number, number, number][], faces: [{ material: 0, v: [0, 1, 2] as [number, number, number] }] };
const model = makeSpaceModel({ size: [100, 50, 200], parts: [part] });
const mtl = makeSpaceMaterials([{ flags: 0 }]);
const set = (base: string): [string, Uint8Array][] => [
  [`${base}.3dv`, model], [`${base}.mtl`, mtl], [`${base}.3dr`, model], [`${base}.mtr`, mtl], [`${base}.dmg`, mtl],
  ...[1, 2, 3, 4, 5, 6].map((n): [string, Uint8Array] => [`${base}.pc${n}`, model]),
];

/** The mini export with battle 0x34 (the surprise screen): the Enterprise, an active chodak with phaser data, an inactive probe and Enter. Kinds 0 and 2 have all their files. */
function withBattle(): RawIR {
  const raw = rawFromMini(miniRaw(files => {
    const add = (o: J) => { files[`objects/o_${o.id as string}.json`] = o; };
    add(obj('103401', { name: 'Enterprise', flags: 0x20, x: 12, y: -3, z: 400, sprite_id: 0xff4c }));
    add(obj('103402', { name: 'Enter', flags: 0x22 }));
    add(obj('103405', {
      name: 'Chodak', flags: 0x20, y_adjust: 5,
      phaser_data: { max_health: -56, threshold: 30, damage_setting: 1, gtp_setting: 1, gtp_min_setting: 1, stun_entries: [], gtp_entries: [], kill_entries: [] },
    }));
    add(obj('103407', { name: 'Probe', flags: 0 }));
    files['screens/s_1034.json'] = { id: 's_1034', world: 0x10, screen: 0x34, objects: ['103401', '103402', '103405', '103407'], location: null, polygons: [] };
  }));
  return {
    ...raw,
    space: new Map<string, Uint8Array>([
      ['kind0.bin', bin], ['kind2.bin', bin], ['zap.bin', bin], ...set('kind0'), ...set('kind2'),
      ...[1, 2, 3, 4, 5, 6].map((n): [string, Uint8Array] => [`generic.pc${n}`, model]),
    ]),
  };
}

describe('liftCombat (Plan 18 Task 7; spec §3.2)', () => {
  it('lifts a battle: its ships by kind with their placement, strength and tactics, its Enter object, and the surprise', () => {
    const result = liftGame(withBattle(), { worlds: [7] });
    expect(result.problems.errors).toEqual([]);
    const battle = result.lifted.combat!.battles[0x34]!;
    expect(battle).toMatchObject({ screen: 'space.s34', enter: 'space.enter', exit: null, warp: null, quietContacts: true });
    expect(battle.ships).toEqual([
      // (x, y, z × 10; sprite_id 0xff4c is -180 degrees)
      { object: 'space.enterprise', type: 2, position: [120, -30, 4000], heading: -180, decloak: 0, strength: 100, hullLow: 50, tactics: 'kind2.bin' },
      // ((byte)-56 is 200; 30 squared / 100 is 9; kTacticOverrides gives 103405 zap.bin)
      { object: 'space.chodak', type: 0, position: [-10, -10, -10], heading: null, decloak: 5, strength: 200, hullLow: 9, tactics: 'zap.bin' },
      // (inactive ships stay in the list: the sim skips them by the object's state; a probe has no tactics)
      { object: 'space.probe', type: 4, position: [-10, -10, -10], heading: null, decloak: 0, strength: 100, hullLow: 50, tactics: null },
    ]);
  });

  it('resolves each kind\'s files: its models by its flags, its tactics, and raceFile\'s sprites and sounds', () => {
    const { kinds, models, tactics } = liftGame(withBattle(), { worlds: [7] }).lifted.combat!;
    expect(kinds[0]).toMatchObject({
      name: 'chodak', base: 'kind0', maxSpeed: 300, contactCue: 0x39, className: '-Zap-', tactics: 'kind0.bin',
      models: { detail: 'kind0.3dv', reduced: 'kind0.3dr', damaged: 'kind0.dmg', debris: [1, 2, 3, 4, 5, 6].map(n => `kind0.pc${n}`) },
    });
    expect(models['kind0.dmg']).toMatchObject({ url: 'space/kind0.dmg.glb', geometry: 'kind0.3dv', materials: 'kind0.dmg', size: [100, 50, 200] });
    // (a probe has no debris of its own, 0x8600: the generic pieces)
    expect(kinds[4]!.models.debris).toEqual([1, 2, 3, 4, 5, 6].map(n => `generic.pc${n}`));
    expect(models['generic.pc1']!.materials).toBeNull();
    expect(Object.keys(tactics)).toEqual(['kind0.bin', 'kind2.bin', 'zap.bin']);
    // (the klingon's own shield and torpedo sound; the generic phaser sprite, as the archive has no k_phaser.spr)
    expect(kinds[3]!.effects).toEqual({ phaserSprite: '__phaser.spr', phaserSound: '__phaser.mac', photonSprite: '__photon.spr', photonSound: 'k_photon.mac', shieldSprite: 'k_shield.spr' });
    // (the starbase has neither phasers nor torpedoes: 0x08008000)
    expect(kinds[6]!.effects).toMatchObject({ phaserSprite: null, phaserSound: null, photonSprite: null, photonSound: null, shieldSprite: '__shield.spr' });
  });

  it('lists every gap, never skipping one quietly: a kind\'s missing model or tactics, and media the archive lacks', () => {
    const { combatGaps } = liftGame(withBattle(), { worlds: [7] }).lifted;
    expect(combatGaps).toEqual(expect.arrayContaining([
      'kinds[1] (romulan): no model kind1.3dv', 'kinds[1] (romulan): no tactics kind1.bin', 'kinds[4] (probe): no model kind4.3dr',
      'effects: no model phaser.3dv', "combat media: cheap.pic isn't in the archive",
    ]));
    expect(combatGaps!.some(g => g.startsWith('kinds[0]') || g.startsWith('kinds[2]'))).toBe(false);
  });

  it('lists a battle object the export lacks as a gap, never skipping it quietly', () => {
    const raw = withBattle();
    const screen = raw.screens.get('s_1034')!;
    raw.screens.set('s_1034', { ...screen, objects: [...(screen.objects ?? []), '103409'] });
    const { lifted } = liftGame(raw, { worlds: [7] });
    expect(lifted.combatGaps).toContain("screens/s_1034: the object list names 103409, which isn't in the export: left out of the battle");
    expect(lifted.combat!.battles[0x34]!.ships).toHaveLength(3);
  });

  it('lifts the tables: units with their hit weights, float32 flight values, lists trimmed at -1, cues and sources', () => {
    const c = liftGame(withBattle(), { worlds: [7] }).lifted.combat!;
    expect(c.enemyUnits).toEqual([{ name: '-Unit-', type: 7, current: 10, target: 10, max: 10, chargeTicks: 1, dischargeTicks: 1, damage: 0, repair: 0, baseDamage: 0, maxDamage: 10, efficiency: 95, hitWeight: 4, depth: 0 }]);
    expect(c.flight).toEqual({ turns: [0, 5], speeds: [Math.fround(0.1)], turnScales: [Math.fround(1 / 3)] });
    expect(c.hitLists.enterprise[0]).toEqual([22, 8]);
    expect(c.scanner.other[0]).toEqual([1]);
    expect(c.phasers).toMatchObject({ enterprise: [[0, -20, 210], [0, -20, 210], [0, -20, 210], [0, -20, 210], [0, -20, 210], [0, -20, 210]], units: { enterprisePhaser: 13, otherTube: 10 } });
    expect(c.cues).toEqual([{ speaker: 2, file: 'zap.vac', gap: 291 }, { speaker: 0, file: null, gap: 0 }]);
    expect(c.powerLevels).toEqual([[0, 0, 0], [1, 1, 1], [2, 2, 2], [3, 3, 3], [4, 4, 4]]);
    expect(c.sources.kShipKinds).toBe('combat.cpp:35-49');
    // (Plan 18's 18, kBearing, kShieldNames, each of the 65 cue ids by its own line (Plan 23 R1), and each of the console's 7 strings (Plan 27 R15))
    expect(Object.keys(c.sources)).toHaveLength(92);
    expect([c.consoleText?.megawatts, c.consoleText?.alien, c.sources['kConsoleText.alien']]).toEqual(['-T0-', '-T2-', 'tactical.cpp:1052']);
    expect([c.bearing[0], c.bearing[7], c.shieldNames[7]]).toEqual([[0, 2, 6], [0, 2, 6], 'S7']);
    expect([c.cueIds.decloak, c.cueIds.allStop, c.sources['kCueIds.decloak'], c.sources['kCueIds.allStop']]).toEqual([0x100, 0x140, 'weapons.cpp:600', 'weapons.cpp:664']);
  });

  it('reads a float32 back exactly from nine significant digits, as the export writes them (Review Focus 3)', () => {
    const f32 = new Float32Array(1);
    const u32 = new Uint32Array(f32.buffer);
    let seed = 12345;
    for (let i = 0; i < 2000; i++) {
      seed = (Math.imul(seed, 0x41c64e6d) + 0x3039) >>> 0;
      u32[0] = seed;
      const v = f32[0]!;
      if (!Number.isFinite(v)) continue;
      expect(Math.fround(Number(v.toPrecision(9)))).toBe(v);
    }
  });

  it('writes combat.yaml, which the engine\'s schema takes, with every new IR field read or ignored', () => {
    const result = liftGame(withBattle(), { worlds: [7] });
    expect(result.problems.errors).toEqual([]);
    expect(parseCombat(result.files.get('combat.yaml')!).battles[0x34]?.ships).toHaveLength(3);
  });

  it('counts each effect sprite\'s frames from the images export, listing a sprite without any as a gap (space3d.cpp:482-517)', () => {
    const frames: Record<string, number> = { '__boom.spr': 9, '1_boom.spr': 8, '2_boom.spr': 7, '__phaser.spr': 6, '__photon.spr': 5, '__shield.spr': 4, 'k_shield.spr': 3 };
    const { combat, combatGaps } = liftGame(withBattle(), { worlds: [7], spriteFrames: f => frames[f] }).lifted;
    expect(combat!.animations).toEqual(frames);
    expect(combatGaps).toContain('combat animations: 3_boom.spr has no frames in the images export');
    const without = liftGame(withBattle(), { worlds: [7] }).lifted;
    expect(without.combat!.animations).toBeUndefined();
    expect(without.combatGaps).toContain('combat animations: no --images, so combat.yaml has no frame counts (the combat sim refuses it)');
  });

  it('lifts each kind\'s damage materials, true where a texture loads (space3d.cpp:537-585)', () => {
    const raw = withBattle();
    const gif = makeGif(1, 1, [1], new Uint8Array(6));
    raw.space!.set('kind0.dmg', makeSpaceMaterials([{ flags: 1, texture: 'zap.img' }, { flags: 1, texture: 'gone.img' }, { flags: 0, texture: 'zap.img' }, { flags: 2, texture: 'ZAP.IMG' }]));
    raw.space!.set('zap.img', gif);
    const { combat, combatGaps } = liftGame(raw, { worlds: [7] }).lifted;
    // (kinds 0 and 2 have their files; the others' .dmg is missing: a gap, and no entry)
    expect(combat!.damageMaterials!['kind0.dmg']).toEqual([true, false, false, true]);
    expect(combat!.damageMaterials!['kind2.dmg']).toEqual([false]);
    expect(Object.keys(combat!.damageMaterials!)).toEqual(['kind0.dmg', 'kind2.dmg']);
    expect(combatGaps).toContain("combat damage materials: kind1.dmg isn't in the export's verbatim files");
  });

  it('lifts trig.json as float32 columns in base64, which the engine reads back exactly; without it, warns (Plan 22 R1)', () => {
    // (made-up values, not a C library's: each angle's sin as i / 16384 + 1/3, so most need all of float32's bits)
    const sin = Array.from({ length: 0x4000 }, (_, i) => Math.fround(i / 0x4000 + 1 / 3));
    const cos = sin.map(v => -v);
    const raw = { ...withBattle(), trig: { file: 'scummvm' as const, sin: sin.map(v => Number(v.toPrecision(9))), cos: cos.map(v => Number(v.toPrecision(9))) } };
    const result = liftGame(raw, { worlds: [7] });
    expect(result.problems.errors).toEqual([]);
    const combat = parseCombat(result.files.get('combat.yaml')!);
    const back = (text: string) => {
      const bytes = decodeBase64(text);
      return Array.from({ length: bytes.length / 4 }, (_, i) => new DataView(bytes.buffer, bytes.byteOffset).getFloat32(i * 4, true));
    };
    expect(back(combat.trig!.sin)).toEqual(sin);
    expect(back(combat.trig!.cos)).toEqual(cos);
    const without = liftGame(withBattle(), { worlds: [7] });
    expect(without.lifted.combat!.trig).toBeUndefined();
    expect(without.problems.warnings.some(w => w.includes('the export has no trig.json (Plan 22 Task 1)'))).toBe(true);
  });

  it('leaves the console\'s text out, with a warning, for an export from before Plan 27 (R15)', () => {
    const result = liftGame(rawFromMini(miniRaw(files => { delete (files['combat.json'] as Record<string, unknown>).kConsoleText; })), { worlds: [7] });
    expect(result.problems.errors).toEqual([]);
    expect(result.lifted.combat!.consoleText).toBeUndefined();
    expect(Object.keys(result.lifted.combat!.sources)).toHaveLength(85);
    expect(result.problems.warnings.some(w => w.includes('no kConsoleText (Plan 27'))).toBe(true);
    expect(parseCombat(result.files.get('combat.yaml')!).consoleText).toBeUndefined();
  });

  it('leaves combat.yaml out, with a warning, for an export without combat.json', () => {
    const result = liftGame(rawFromMini(miniRaw(files => { delete files['combat.json']; })), { worlds: [7] });
    expect(result.files.has('combat.yaml')).toBe(false);
    expect(result.problems.warnings.some(w => w.includes('no combat.json'))).toBe(true);
  });

  it('takes a race\'s own file only if its bit is set and the archive has it (raceFile, weapons.cpp:92-99)', () => {
    const archive = new Set(['k_shield.spr']);
    expect(raceFile({ letter: 'k', mask: 1 }, 1, 'shield.spr', archive)).toBe('k_shield.spr');
    expect(raceFile({ letter: 'k', mask: 0 }, 1, 'shield.spr', archive)).toBe('__shield.spr');
    expect(raceFile({ letter: 'r', mask: 1 }, 1, 'shield.spr', archive)).toBe('__shield.spr');
  });
});

describe('kShipKinds against the engine\'s KIND (Plan 23)', () => {
  /** The mini export with battle 0x34, its combat.json's kShipKinds edited. */
  const withKinds = (edit: (kinds: { name: string; flags: number }[]) => void): RawIR => {
    const raw = withBattle();
    const kinds = (raw.combat as unknown as { kShipKinds: { value: { name: string; flags: number }[] } }).kShipKinds.value;
    edit(kinds);
    return raw;
  };
  const kindErrors = (raw: RawIR) => liftGame(raw, { worlds: [7] }).problems.errors.map(String).filter(e => e.includes('kShipKinds'));

  it('takes the mini export\'s kinds, each at its KIND number', () => {
    expect(kindErrors(withBattle())).toEqual([]);
  });

  it('fails the lift on two kinds swapped: the engine indexes them by KIND\'s numbers', () => {
    const errors = kindErrors(withKinds(k => { [k[0], k[1]] = [k[1]!, k[0]!]; }));
    expect(errors).toHaveLength(2);
    expect(errors.join('\n')).toMatch(/kinds\[0\] is "romulan", which the engine numbers 1/);
    expect(errors.join('\n')).toMatch(/kinds\[1\] is "chodak", which the engine numbers 0/);
  });

  it('fails the lift on a kind the engine doesn\'t know', () => {
    const errors = kindErrors(withKinds(k => { k[4]!.name = 'zap'; }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/"zap" isn't a kind of ship the engine knows/);
  });
});
