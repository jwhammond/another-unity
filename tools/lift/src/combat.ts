// SPDX-License-Identifier: GPL-3.0-or-later
import { COMBAT_CUE_NAMES, CONSOLE_TEXT_NAMES, combatSim, encodeBase64, SHIP_FLAGS, type CombatBattle, type CombatData, type CombatKind, type CombatShipDef, type CombatUnit, type ShipKind, type Vec3 } from '@another-unity/engine';
import { liftDamageMaterials, liftModels, liftTactics, type ModelWant, type SpriteFrames } from './combatAssets';
import type { LiftCtx } from './context';
import type { CombatFileT, ExecutableT, GameObjectT } from './raw';
import { spaceBattles } from './ship';

/** The kinds of ship the engine knows, by combat.h's kCombat* numbers (combat/types.ts KIND): combat.json's kShipKinds must name these, each at its number. */
const KIND: Readonly<Record<string, number>> = combatSim.KIND;
/** kMaxShips (combat.cpp:51): the most ships in a battle, so the shield models setupWeapons can name, shield_1 to shield_8 (weapons.cpp:138). */
const MAX_SHIPS = 8;
const PIECES = [1, 2, 3, 4, 5, 6];
/** combat.json's cited constants, read by name: the tracked IR may not be enumerated (track.ts). */
const CONSTANTS = [
  'kShipKinds', 'kContactCues', 'kDestroyedCues', 'kTargetCues', 'kSurpriseObjects', 'kEnterpriseHitLists', 'kOtherHitLists', 'kRaceBits',
  'kRaces', 'kEnterprisePhasers', 'kOtherPhasers', 'kWeaponUnits', 'kTacticOverrides', 'kClassNames', 'kScannerImages', 'kEnterpriseAreas',
  'kOtherAreas', 'kRadarColours', 'kBearing', 'kShieldNames',
] as const satisfies readonly (keyof CombatFileT)[];

/** A row up to its -1, which ends each of ScummVM's lists (damage.cpp:36-53, tactical.cpp:219-226). */
const untilEnd = (row: readonly number[]): number[] => {
  const end = row.indexOf(-1);
  return end < 0 ? [...row] : row.slice(0, end);
};
const vec3 = (row: readonly number[]): Vec3 => [row[0]!, row[1]!, row[2]!];

/** raceFile (weapons.cpp:92-99): the race's own file if its mask has the bit and the archive has the file, else the generic one. */
export function raceFile(race: { letter: string; mask: number }, bit: number, suffix: string, archive: ReadonlySet<string>): string {
  if (race.mask & bit) {
    const name = `${race.letter}_${suffix}`;
    if (archive.has(name)) return name;
  }
  return `__${suffix}`;
}

export interface LiftedCombat { data: CombatData; gaps: string[] }

/**
 * combat.yaml (spec §3.2): sttng.ovl's combat tables, combat.json's constants, the space world's battles, and the tactics and models they name.
 * Anything a kind, ship, effect or the media list wants that the export lacks is a gap: warned, listed, and its field null.
 * `frames` counts each sprite's frames from the images export (`--images`); without it combat.yaml has no
 * animations, which the sim refuses (Plan 20).
 */
export function liftCombat(raw: LiftCtx['raw'], ctx: LiftCtx, frames?: SpriteFrames): LiftedCombat | undefined {
  const c = raw.combat;
  if (!c) {
    ctx.problems.warn('combat.json', 'the export has no combat.json (Plan 18 Task 2): combat.yaml is left out');
    return undefined;
  }
  const e = raw.executable;
  const files = raw.space ?? new Map<string, Uint8Array>();
  const archive = new Set(c.archive.map(n => n.toLowerCase()));
  // (read by name, each field once, so the lossless check sees them all whichever kinds use them)
  const rb = c.kRaceBits.value;
  const bits = { shield: rb.shield, phaser: rb.phaser, photon: rb.photon, phaserSound: rb.phaserSound, photonSound: rb.photonSound };
  const races = c.kRaces.value.map(r => ({ letter: r.letter, mask: r.mask }));
  const wu = c.kWeaponUnits.value;
  const units = { enterprisePhaser: wu.enterprisePhaser, otherPhaser: wu.otherPhaser, enterpriseTube: wu.enterpriseTube, otherTube: wu.otherTube };
  const surprise = { screen: c.kSurpriseObjects.value.screen, ids: [...c.kSurpriseObjects.value.ids] };
  const gaps: string[] = [];

  // what each kind wants (createShip, combat.cpp:291-300, 382-383; destroyShip, damage.cpp:489-497; loadScript, tactics.cpp:170-171)
  const wants: ModelWant[] = [];
  const want = (key: string, geometry: string, materials: string | null): string => {
    wants.push({ key, geometry, materials });
    return key;
  };
  // (_combatShips has a row more than there are kinds, data.cpp:827-836; no kind's type reaches it, so it isn't lifted)
  const drafts = c.kShipKinds.value.map((k, type) => {
    const name = k.name.toLowerCase();
    // (the engine indexes kinds by KIND's values, so each name must sit at its number, not merely be known)
    if (!Object.hasOwn(KIND, name)) ctx.problems.error('combat.json kShipKinds', `"${k.name}" isn't a kind of ship the engine knows`);
    else if (KIND[name] !== type) ctx.problems.error('combat.json kShipKinds', `kinds[${type}] is "${k.name}", which the engine numbers ${KIND[name]} (combat.h's kCombat*, KIND)`);
    const ship = e._combatShips[type];
    const base = (ship?.base ?? '').toLowerCase();
    const where = `kinds[${type}] (${name})`;
    if (base === '') gaps.push(`${where}: no _combatShips entry (data.cpp:827-836)`);
    const has = (flag: number) => (k.flags & flag) !== 0;
    const own = (key: string, geometry: string, materials: string | null) => (base === '' ? null : want(key, geometry, materials));
    return {
      name: name as ShipKind, flags: k.flags, base, ship, where,
      detail: own(`${base}.3dv`, `${base}.3dv`, `${base}.mtl`),
      reduced: has(SHIP_FLAGS.reduced) ? own(`${base}.3dr`, `${base}.3dr`, `${base}.mtr`) : null,
      damaged: has(SHIP_FLAGS.damageTextures) ? own(`${base}.dmg`, `${base}.3dv`, `${base}.dmg`) : null,
      debris: PIECES.map(n => (has(SHIP_FLAGS.debris) ? own(`${base}.pc${n}`, `${base}.pc${n}`, `${base}.mtl`) : want(`generic.pc${n}`, `generic.pc${n}`, null))),
      tactics: has(SHIP_FLAGS.tactics) && base !== '' ? `${base}.bin` : null,
    };
  });
  // the effects' models (combat.cpp:183-186; setupWeapons, weapons.cpp:138-150): generic debris takes the dying ship's materials (damage.cpp:486)
  const effectWants = {
    phaser: want('phaser.3dv', 'phaser.3dv', 'phaser.mtl'),
    photon: want('photon.3dv', 'photon.3dv', 'photon.mtl'),
    billboard: want('bboard.3dv', 'bboard.3dv', 'bboard.mtl'),
    shields: Array.from({ length: MAX_SHIPS }, (_, i) => want(`shield_${i + 1}.3dv`, `shield_${i + 1}.3dv`, `shield_${i + 1}.mtl`)),
    genericDebris: PIECES.map(n => want(`generic.pc${n}`, `generic.pc${n}`, null)),
  };

  // kTacticOverrides' objects are C++ numbers, world << 16 | screen << 8 | id (tactics.cpp:160-163)
  const overrides = new Map(c.kTacticOverrides.value.map(o => [o.object.toString(16).padStart(6, '0'), o.file.toLowerCase()]));
  const tactics = liftTactics(files, [...drafts.flatMap(d => (d.tactics ? [d.tactics] : [])), ...overrides.values()], ctx.problems);
  const models = liftModels(files, wants, ctx.problems);
  const present = (key: string | null, where: string): string | null => {
    if (key === null) return null;
    if (models[key]) return key;
    gaps.push(`${where}: no model ${key}`);
    return null;
  };

  const kinds: CombatKind[] = drafts.map((d, type) => {
    const race = races[type]!;
    const has = (flag: number) => (d.flags & flag) !== 0;
    if (d.tactics && !tactics[d.tactics]) gaps.push(`${d.where}: no tactics ${d.tactics}`);
    return {
      name: d.name, flags: d.flags, base: d.base,
      maxSpeed: d.ship?.maxSpeed ?? 0, detailDistance: d.ship?.detailDistance ?? 0, reducedDistance: d.ship?.reducedDistance ?? 0,
      contactCue: c.kContactCues.value[type]!, destroyedCue: c.kDestroyedCues.value[type]!, targetCue: c.kTargetCues.value[type]!,
      className: c.kClassNames.value[type]!, scannerImage: c.kScannerImages.value[type]!, radarColour: c.kRadarColours.value[type]!,
      effects: {
        phaserSprite: has(SHIP_FLAGS.phasers) ? raceFile(race, bits.phaser, 'phaser.spr', archive) : null,
        phaserSound: has(SHIP_FLAGS.phasers) ? raceFile(race, bits.phaserSound, 'phaser.mac', archive) : null,
        photonSprite: has(SHIP_FLAGS.torpedoes) ? raceFile(race, bits.photon, 'photon.spr', archive) : null,
        photonSound: has(SHIP_FLAGS.torpedoes) ? raceFile(race, bits.photonSound, 'photon.mac', archive) : null,
        shieldSprite: raceFile(race, bits.shield, 'shield.spr', archive),
      },
      tactics: d.tactics && tactics[d.tactics] ? d.tactics : null,
      models: {
        detail: present(d.detail, d.where), reduced: present(d.reduced, d.where), damaged: present(d.damaged, d.where),
        debris: d.debris.map(p => present(p, d.where)),
      },
    };
  });
  const effects: CombatData['effects'] = {
    phaser: present(effectWants.phaser, 'effects'), photon: present(effectWants.photon, 'effects'), billboard: present(effectWants.billboard, 'effects'),
    shields: effectWants.shields.map(s => present(s, 'effects')), genericDebris: effectWants.genericDebris.map(p => present(p, 'effects')),
    booms: ['__boom.spr', '1_boom.spr', '2_boom.spr', '3_boom.spr'],
  };

  const shipDef = (o: GameObjectT, slug: string, type: number, where: string): CombatShipDef => {
    const p = o.phaser_data;
    const threshold = p ? p.threshold & 0xff : 0;
    const expected = overrides.get(o.id) ?? drafts[type]!.tactics;
    const file = expected !== null && tactics[expected] ? expected : null;
    if (expected !== null && file === null) gaps.push(`${where} (${slug}): no tactics ${expected}`);
    return {
      object: slug, type,
      // (combat.cpp:305, 307-309, 321-325, 347-354)
      position: [o.x * 10, o.y * 10, o.z * 10],
      heading: o.sprite_id === 0xffff ? null : (o.sprite_id << 16) >> 16,
      decloak: o.y_adjust !== -1 && o.y_adjust !== 0 ? o.y_adjust : 0,
      strength: p ? p.max_health & 0xff : 100,
      hullLow: p ? Math.trunc((threshold * threshold) / 100) : 50,
      tactics: file,
    };
  };
  const battles: Record<number, CombatBattle> = {};
  const missing = (id: string, where: string) => gaps.push(`${where}: the object list names ${id}, which isn't in the export: left out of the battle`);
  for (const b of spaceBattles(raw, ctx, kinds.map(k => k.name), missing)) {
    battles[b.screen] = {
      screen: b.slug, enter: b.enter, exit: b.exit, warp: b.warp,
      // (combat.cpp:197-199: any listed object, Enter and the inactive included)
      quietContacts: b.screen === surprise.screen && b.objects.some(o => surprise.ids.includes(parseInt(o.id.slice(4), 16))),
      ships: b.ships.map((s, i) => shipDef(s.object, s.slug, s.type, `battles.${b.screen}.ships[${i}]`)),
    };
  }

  // what combat plays and shows: tactical.cpp:264-265, 287, 526, 818-827; damage.cpp:223, 418, 429
  const sounds = new Set(['0_explo.mac', '1_explo.mac', '2_explo.mac', '3_explo.mac', 'hullhit1.mac', 'hullhit2.mac', 'sheldht2.mac', 'beep7.mac']);
  const sprites = new Set([...effects.booms, 'viewscan.spr', 'viewscr.spr', 'vwwarped.spr']);
  for (const k of kinds) {
    for (const f of [k.effects.phaserSound, k.effects.photonSound]) if (f) sounds.add(f);
    for (const f of [k.effects.phaserSprite, k.effects.photonSprite, k.effects.shieldSprite]) if (f) sprites.add(f);
  }
  const media = { music: 'enterpri.rac', pictures: ['cheap.pic', 'spc00a.pic', 'space.mrg'], sprites: [...sprites].sort(), sounds: [...sounds].sort() };
  for (const f of [media.music, ...media.pictures, ...media.sprites, ...media.sounds]) {
    if (!archive.has(f)) gaps.push(`combat media: ${f} isn't in the archive`);
  }

  // the effects' frame counts (SpaceResources::animation, space3d.cpp:482-517): the booms and each kind's own sprites
  const effectSprites = new Set<string>(effects.booms);
  for (const k of kinds) for (const f of [k.effects.phaserSprite, k.effects.photonSprite, k.effects.shieldSprite]) if (f) effectSprites.add(f);
  let animations: Record<string, number> | undefined;
  if (frames) {
    animations = {};
    for (const f of [...effectSprites].sort()) {
      const n = frames(f);
      if (n) animations[f] = n;
      else gaps.push(`combat animations: ${f} has no frames in the images export`);
    }
  } else {
    gaps.push('combat animations: no --images, so combat.yaml has no frame counts (the combat sim refuses it)');
  }
  // each kind's damage materials (createShip, combat.cpp:380-382)
  const damageMaterials = liftDamageMaterials(files, kinds.filter(k => k.flags & SHIP_FLAGS.damageTextures && k.base !== '').map(k => `${k.base}.dmg`), gaps);

  const unit = (u: ExecutableT['_enemyShip'][number]): CombatUnit => ({
    name: u.name, type: u.type, current: u.current, target: u.target, max: u.max, chargeTicks: u.chargeTicks, dischargeTicks: u.dischargeTicks,
    damage: u.damage, repair: u.repair, baseDamage: u.baseDamage, maxDamage: u.maxDamage, efficiency: u.efficiency, hitWeight: u.hitWeight,
    depth: u.depth,
  });
  // (each cue id's line is its own source, `kCueIds.<name>`: Plan 23 R1)
  const cueIds = Object.fromEntries(COMBAT_CUE_NAMES.map(n => [n, c.kCueIds[n].value])) as CombatData['cueIds'];
  // (the console's own words, each by its line, `kConsoleText.<name>`: Plan 27 R15; an older export has none, and the console draws without them)
  const text = c.kConsoleText;
  const consoleText = text ? Object.fromEntries(CONSOLE_TEXT_NAMES.map(n => [n, text[n].value])) as NonNullable<CombatData['consoleText']> : undefined;
  if (!text) gaps.push('combat.json has no kConsoleText (Plan 27): the console draws without its own words; re-export (sh tools/rawcheck/run-harness.sh export 300)');
  const sources = {
    ...Object.fromEntries(CONSTANTS.map(key => [key, c[key].source])),
    ...Object.fromEntries(COMBAT_CUE_NAMES.map(n => [`kCueIds.${n}`, c.kCueIds[n].source])),
    ...(text ? Object.fromEntries(CONSOLE_TEXT_NAMES.map(n => [`kConsoleText.${n}`, text[n].source])) : {}),
  };
  for (const g of gaps) ctx.problems.warn('combat', g);
  // (ScummVM's sinf and cosf of each whole angle, which the sim reads in place of Math's: Plan 22's R1)
  const trig = raw.trig ? { sin: float32Base64(raw.trig.sin), cos: float32Base64(raw.trig.cos) } : undefined;
  if (!trig) ctx.problems.warn('trig.json', 'the export has no trig.json (Plan 22 Task 1): the sim uses Math\'s sinf and cosf, which differ from ScummVM\'s on some angles');
  return {
    data: {
      kinds,
      enemyUnits: e._enemyShip.map(unit),
      // (float32 values: the export prints nine digits, which Math.fround reads back exactly)
      flight: { turns: [...e._flightTurns], speeds: e._flightSpeeds.map(x => Math.fround(x)), turnScales: e._flightTurnScales.map(x => Math.fround(x)) },
      powerLevels: c._powerLevels.map(level => [...level]),
      hitLists: { enterprise: c.kEnterpriseHitLists.value.map(untilEnd), other: c.kOtherHitLists.value.map(untilEnd) },
      phasers: { enterprise: c.kEnterprisePhasers.value.map(vec3), other: c.kOtherPhasers.value.map(vec3), units },
      scanner: { enterprise: c.kEnterpriseAreas.value.map(untilEnd), other: c.kOtherAreas.value.map(untilEnd) },
      // (kBearing's rows keep their -1s: updateLamps skips them, weapons.cpp:744-745)
      bearing: c.kBearing.value.map(row => [...row]),
      shieldNames: [...c.kShieldNames.value],
      cueIds,
      ...(consoleText ? { consoleText } : {}),
      cues: e._cues.map(q => ({ speaker: q.speaker, file: q.filename === '' ? null : q.filename.toLowerCase(), gap: q.gap })),
      effects, models, tactics, battles, media, sources,
      ...(animations ? { animations } : {}), damageMaterials, ...(trig ? { trig } : {}),
    },
    gaps,
  };
}

/** Float32 values (the export prints nine digits, which Math.fround reads back exactly) as little-endian bytes in base64, as combat.yaml's `trig` holds them. */
export function float32Base64(values: readonly number[]): string {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((v, i) => view.setFloat32(i * 4, v, true));
  return encodeBase64(bytes);
}
