// SPDX-License-Identifier: GPL-3.0-or-later
import { checkTactics, encodeBase64, TACTIC, TOKEN } from '../content/tactics';
import { SHIP_FLAGS, type CombatBattle, type CombatCueName, type CombatData, type CombatKind, type CombatModel, type CombatUnit, type ShipKind, type ShipUnit, type Vec3 } from '../content/types';
import { newSystems, type SystemsState } from '../sim/shipSystems';
import { NUM_QUEUES } from '../sim/combat/script';
import { setupBattle } from '../sim/combat/setup';
import { ASTROGATION_EXIT } from '../sim/combat/warp';
import { GAME_OVER_EXIT, NO_SEAMS, type BattleContext, type BattleState, type CombatSeams, type TacticScript } from '../sim/combat/types';
import { assembleTactics, makeTacticsBin, type TacticItem } from './tactics';
import { miniShipData } from './ship';

/** kShipKinds' names and flags (combat.cpp:35-49): ScummVM's code, not game text. */
const KINDS: [ShipKind, number][] = [
  ['chodak', 0xfe00], ['romulan', 0xfe00], ['enterprise', 0xde00], ['klingon', 0x0800fe00], ['probe', 0x8600],
  ['ferengi', 0x0800de00], ['starbase', 0x08008000], ['garidian', 0xfe00], ['shuttle', 0x08008000], ['mother', 0x08007e00],
];

/**
 * A small synthetic combat.yaml: ten kinds sharing the model "mini" and the tactics file mini.bin (as their flags ask),
 * and battle 3 with the Enterprise and one chodak. For parse tests, and for the sim's (Plans 19-21).
 */
export function miniCombat(o: { screen?: string; enterprise?: string; enemy?: string } = {}): CombatData {
  const model = (key: string, materials: string | null = null, geometry = key): CombatModel =>
    ({ url: `space/${key}.glb`, geometry, materials, size: [100, 50, 200], centre: [0, 0, 0], parts: 1, vertices: [3] });
  const debris = [1, 2, 3, 4, 5, 6].map(n => `generic.pc${n}`);
  const shields = [1, 2, 3, 4, 5, 6, 7, 8].map(n => `shield_${n}.3dv`);
  const models: Record<string, CombatModel> = {
    'mini.3dv': model('mini.3dv', 'mini.mtl'), 'mini.3dr': model('mini.3dr', 'mini.mtr'), 'mini.dmg': model('mini.dmg', 'mini.dmg', 'mini.3dv'),
    'phaser.3dv': model('phaser.3dv', 'phaser.mtl'), 'photon.3dv': model('photon.3dv', 'photon.mtl'), 'bboard.3dv': model('bboard.3dv', 'bboard.mtl'),
  };
  for (const d of debris) models[d] = model(d);
  for (const s of shields) models[s] = model(s, s.replace('.3dv', '.mtl'));
  // MAIN at 7, an IDLE at 0x6b, KERNEL at 0x7b pointing at 0x6b
  const code = makeTacticsBin([{ cls: 3, opcode: 0x1f, page: 'MAIN' }, { cls: 1, opcode: 0x2b, args: [0] }, { cls: 3, opcode: 0x1f, page: 'KERNEL', args: [0x6b] }]);
  const kinds: CombatKind[] = KINDS.map(([name, flags]) => {
    const has = (f: number) => (flags & f) !== 0;
    return {
      name, flags, base: 'mini', maxSpeed: 300, detailDistance: 20000, reducedDistance: 60000,
      contactCue: -1, destroyedCue: -1, targetCue: 0x46, className: '-Zap-', scannerImage: 85, radarColour: 0x98,
      effects: {
        phaserSprite: has(SHIP_FLAGS.phasers) ? '__phaser.spr' : null, phaserSound: has(SHIP_FLAGS.phasers) ? '__phaser.mac' : null,
        photonSprite: has(SHIP_FLAGS.torpedoes) ? '__photon.spr' : null, photonSound: has(SHIP_FLAGS.torpedoes) ? '__photon.mac' : null,
        shieldSprite: '__shield.spr',
      },
      tactics: has(SHIP_FLAGS.tactics) ? 'mini.bin' : null,
      models: { detail: 'mini.3dv', reduced: has(SHIP_FLAGS.reduced) ? 'mini.3dr' : null, damaged: has(SHIP_FLAGS.damageTextures) ? 'mini.dmg' : null, debris },
    };
  });
  return {
    kinds,
    enemyUnits: miniEnemyUnits(),
    flight: miniFlight(),
    powerLevels: Array.from({ length: 5 }, (_, level) => Array.from({ length: 35 }, () => level * 10)),
    hitLists: { enterprise: HIT_LISTS.enterprise.map(l => [...l]), other: HIT_LISTS.other.map(l => [...l]) },
    phasers: {
      enterprise: PHASERS.enterprise.map(p => [...p] as Vec3), other: PHASERS.other.map(p => [...p] as Vec3),
      units: { enterprisePhaser: 13, otherPhaser: 8, enterpriseTube: 19, otherTube: 10 },
    },
    scanner: { enterprise: [[7, 1, 2]], other: [[1, 2]] },
    bearing: BEARING.map(r => [...r]),
    shieldNames: [...MINI_SHIELD_NAMES],
    cueIds: { ...CUE_IDS },
    cues: [{ speaker: 2, file: 'mini.vac', gap: 291 }, { speaker: 0, file: null, gap: 0 }],
    effects: { phaser: 'phaser.3dv', photon: 'photon.3dv', billboard: 'bboard.3dv', shields, genericDebris: debris, booms: ['__boom.spr', '1_boom.spr', '2_boom.spr', '3_boom.spr'] },
    models,
    tactics: { 'mini.bin': { file: 'mini.bin', size: code.length, kernel: 0x6b, pages: [{ name: 'MAIN', offset: 7 }, { name: 'KERNEL', offset: 0x7b }], code: encodeBase64(code) } },
    battles: {
      3: {
        screen: o.screen ?? 'space.s03', enter: null, exit: null, warp: null, quietContacts: false,
        ships: [
          { object: o.enterprise ?? 'space.enterprise', type: 2, position: [0, 0, 0], heading: null, decloak: 0, strength: 100, hullLow: 50, tactics: 'mini.bin' },
          { object: o.enemy ?? 'space.chodak', type: 0, position: [1000, 0, 5000], heading: 180, decloak: 0, strength: 100, hullLow: 50, tactics: 'mini.bin' },
        ],
      },
    },
    media: { music: 'enterpri.rac', pictures: ['cheap.pic', 'spc00a.pic', 'space.mrg'], sprites: ['__boom.spr'], sounds: ['beep7.mac'] },
    sources: { kShipKinds: 'combat.cpp:35-49' },
    // (made-up frame counts and damage materials)
    animations: { '__phaser.spr': 7, '__photon.spr': 4, '__shield.spr': 5, '__boom.spr': 8, '1_boom.spr': 8, '2_boom.spr': 8, '3_boom.spr': 8 },
    damageMaterials: { 'mini.dmg': [false, true, true, false] },
  };
}

/** kBearing (weapons.cpp:738-740): ScummVM's constant, not game data. */
export const BEARING = [[0, 2, 6], [1, 2, 6], [4, -1, -1], [1, 3, 7], [5, -1, -1], [1, 3, 7], [0, 3, 7], [1, 3, 7]] as const;
/** Made-up names for the Enterprise's eight shields (combat.yaml's are kShieldNames, damage.cpp:55-58). */
export const MINI_SHIELD_NAMES = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7'] as const;
/** The cue ids ScummVM's combat plays by a literal (each name's line: Plan 23's export, `kCueIds`): ScummVM's numbers, not game data. */
export const CUE_IDS: Readonly<Record<CombatCueName, number>> = Object.freeze({
  decloak: 0x3f, handFlight: 0xb,
  unitPowerGrid: 0x2a, unitImpulse: 0x2b, unitComputer: 0x2d, unitSensor: 0x2e, unitTorpedo: 0x2f, unitWarp: 0x30, unitShield: 0x32, unitPhaser: 0x47,
  phaserHitOdd: 0x12, phaserHitEven: 0x13, shieldHolds: 0x7e, shieldHoldsUnshaken: 0x31, torpedoStrikes: 0x12, criticalShields: 0x32,
  criticalShieldsOther: 0x37, criticalPhasers: 0x29, systemsOffline: 0x33, systemsOfflineAfter: 0x34, systemsOfflineOther: 0x36, reactorDown: 0x49,
  destroyed: 0x70, destroyedLater1: 0x6c, destroyedLater2: 0x6d, destroyedLater3: 0x6e, destroyedLater4: 0x6f, debrisBoom: 0x6e,
  phasersOutOfRange: 0x28, phasersMissed: 0x1c, phasersFired: 0x1e, enemyFired: 0x1a, enemyTorpedoes: 0x1a, torpedoesUnloaded: 0x20,
  torpedoesTooClose: 0x27, torpedoesAway: 0x22, torpedoHit: 0x21, torpedoLost: 0x1f, torpedoHoming: 0x25, torpedoRetargeted: 0x26,
  lockRefused: 0x6b, lockOn: 0x1b, shieldsLowered: 0x61, shieldsRaising: 0x18, shieldsRaised: 0x60, powerLevelFull: 4, spreadNarrow: 0x24,
  spreadWide: 0x23, selfDestructArmed: 0x55, selfDestructDisarmed: 0x56, selfDestruct15: 0x58, selfDestruct10: 0x57, selfDestruct5: 0x59,
  cloak: 0x3e, disengage: 0xf, engage: 0xe,
  warpFailed: 0x81, warpFailedAfter: 0x82, warp: 0x71, enemySelfDestruct: 0x80, delegateOn: 5, delegateOnAfter: 7,
  hailing: 0x5a, noAnswer: 0x5b, allStop: 0xa,
});

/** A made-up battle for the world's tests: its Enter, Exit and Warp objects, and its ships by kind name, each at the origin. */
export function miniBattleDef(o: { screen?: string; enter?: string | null; exit?: string | null; warp?: string | null; ships: [string, ShipKind][] }): CombatBattle {
  return {
    screen: o.screen ?? 'room', enter: o.enter ?? null, exit: o.exit ?? null, warp: o.warp ?? null, quietContacts: false,
    ships: o.ships.map(([object, kind]) => ({
      object, type: KINDS.findIndex(k => k[0] === kind), position: [0, 0, 0], heading: null, decloak: 0, strength: 100, hullLow: 50, tactics: null,
    })),
  };
}

/** kEnterpriseHitLists and kOtherHitLists (damage.cpp:36-53), -1 trimmed: ScummVM's constants, not game data. */
export const HIT_LISTS = {
  enterprise: [
    [22, 8, 13, 15, 19, 0, 25, 26, 32, 33, 34, 23], [1, 21, 9, 14, 15, 19, 25, 26, 32, 33, 34, 23], [2, 27, 17, 25, 24, 10], [3, 8, 12, 16, 20, 32],
    [4, 28, 18, 26, 24, 10], [5, 10, 11, 12, 21, 24, 33, 34, 23], [8, 29, 30, 31, 13, 16, 20, 25, 26, 32, 33, 34, 23], [7, 9, 20, 16, 25, 26, 32, 33, 34, 23],
  ],
  other: [
    [8, 10, 7, 13, 14, 17, 12], [8, 9, 13, 14, 17, 12, 6, 18, 19, 15, 16], [12, 6, 18, 19, 15, 16, 13, 14, 17], [18, 15, 16, 13, 14, 17],
    [10, 13, 14, 17, 12, 6], [9, 11, 6, 12, 18, 19, 15, 16, 13, 14, 17],
  ],
} as const;
/** kEnterprisePhasers and kOtherPhasers (weapons.cpp:51-54): ScummVM's constants. */
export const PHASERS = {
  enterprise: [[0, -20, 210], [0, -1, 200], [0, 40, 30], [0, 45, -230], [-100, 50, -230], [100, 50, -230]],
  other: [[0, -20, 210], [0, -1, 200]],
} as const;

/**
 * The made-up enemy template's unit types by index, laid out as ScummVM's code reads the template: shields 0-5,
 * sensors 6-7, phasers 8-9 (kOtherPhaserUnit, weapons.cpp:56), tubes 10-11 (kOtherTubeUnit, :58), a tractor 12,
 * life support 13, a computer 14, warp 15, impulse 16, the grid 17, fusion 18 and matter/antimatter 19 (critical,
 * damage.cpp:400).
 */
export const MINI_ENEMY_TYPES = [7, 7, 7, 7, 7, 7, 8, 8, 1, 1, 2, 2, 9, 10, 11, 4, 3, 13, 5, 6];

/** 20 made-up enemy units, every one full: depth i % 3, hit weight 10 + i, base damage 2, max damage 20 + i. */
export function miniEnemyUnits(): CombatUnit[] {
  return MINI_ENEMY_TYPES.map((type, i) => ({
    name: `-Unit ${i}-`, type, current: 100, target: 100, max: 100, chargeTicks: 1, dischargeTicks: 1,
    damage: 0, repair: 0, baseDamage: 2, maxDamage: 20 + i, efficiency: type === 5 || type === 6 ? 90 : 0, hitWeight: 10 + i, depth: i % 3,
  }));
}

/**
 * Made-up flight tables the size of the real ones (data.cpp:838-846: 84 turns, 40 speeds, 24 turn scales), with
 * values a test can work out by hand: turn i is 4i, speed i is 12.5i, turn scale i is 1 - i/32 (all exact in float32).
 */
export function miniFlight(): CombatData['flight'] {
  return {
    turns: Array.from({ length: 84 }, (_, i) => 4 * i),
    speeds: Array.from({ length: 40 }, (_, i) => 12.5 * i),
    turnScales: Array.from({ length: 24 }, (_, i) => 1 - i / 32),
  };
}

/** The made-up Enterprise's unit types by index, the way combat reads them (NUM_SHIP_UNITS, 35): shields 0-7, sensors 8-12, phasers 13-18, tubes 19-20, tractors 21-22, computers 23-24, life support 25-26, warp 27-28, impulse 29-31, the grid 32, fusion 33, matter/antimatter 34. */
export const MINI_ENTERPRISE_TYPES = [
  7, 7, 7, 7, 7, 7, 7, 7, 8, 8, 8, 8, 8, 1, 1, 1, 1, 1, 1, 2, 2, 9, 9, 11, 11, 10, 10, 4, 4, 3, 3, 3, 13, 5, 6,
];

/** 35 made-up units for the Enterprise, every one full: the grid holds 3000, the reactors run at 95% efficiency; depth i % 3, hit weight 5 + i, base damage 3. */
export function miniEnterpriseUnits(): ShipUnit[] {
  return MINI_ENTERPRISE_TYPES.map((type, i) => ({
    name: `-Unit ${i}-`, type, current: type === 13 ? 0 : 100, target: type === 13 ? 0 : 100, max: type === 13 ? 3000 : 100,
    chargeTicks: 10, dischargeTicks: 10, damage: 0, repair: 0, baseDamage: 3, maxDamage: 100, efficiency: type === 5 || type === 6 ? 95 : 0,
    hitWeight: 5 + i, depth: i % 3,
  }));
}

/** The made-up Enterprise's systems, as a new game has them (newSystems). */
export function miniEnterpriseSystems(units = miniEnterpriseUnits()): SystemsState {
  const data = miniShipData();
  return newSystems({ ...data, data: { ...data.data, units } });
}

/** A battle context over `combat` (miniCombat's by default) and the made-up Enterprise, with these seams over NO_SEAMS. */
export function miniBattleContext(seams: Partial<CombatSeams> = {}, combat: CombatData = miniCombat()): BattleContext {
  return { combat, enterpriseUnits: miniEnterpriseUnits(), seams: { ...NO_SEAMS, ...seams } };
}

/** miniCombat's battle 3 set up at 10 s on the battle clock (seed 1234, Lieutenant, every object active), or with these. */
export function miniBattle(o: {
  ctx?: BattleContext; scenario?: number; seed?: number; now?: number; difficulty?: 0 | 1 | 2; active?: (object: string) => boolean; previous?: BattleState;
} = {}): { ctx: BattleContext; b: BattleState } {
  const ctx = o.ctx ?? miniBattleContext();
  const { battle, warnings } = setupBattle(ctx, {
    scenario: o.scenario ?? 3, seed: o.seed ?? 1234, now: o.now ?? 10000, difficulty: o.difficulty ?? 1,
    active: o.active ?? (() => true), enterprise: miniEnterpriseSystems(), ...(o.previous ? { previous: o.previous } : {}),
  });
  if (!battle) throw new Error(warnings.join('; '));
  return { ctx, b: battle };
}

/** Seams that write their names (and the ship's index, `name:1`) to `log` as they are called, then do what `also` says (or NO_SEAMS does), returning its answer. */
export function recordingSeams(log: string[], also: Partial<CombatSeams> = {}): CombatSeams {
  const seams: Record<string, (...args: unknown[]) => unknown> = {};
  const fallback = NO_SEAMS as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const name of Object.keys(NO_SEAMS)) {
    seams[name] = (...args: unknown[]) => {
      const ship = args[2];
      log.push(typeof ship === 'object' && ship !== null && 'index' in ship ? `${name}:${(ship as { index: number }).index}` : name);
      return ((also as Record<string, ((...a: unknown[]) => unknown) | undefined>)[name] ?? fallback[name]!)(...args);
    };
  }
  return seams as unknown as CombatSeams;
}

/** Puts a synthetic tactics file into `combat` as the lift does (TacticsScript: the code as base64, the kernel and the pages), for ships whose `tactics` name it. */
export function addTactics(combat: CombatData, file: string, bin: Uint8Array): void {
  const check = checkTactics(bin);
  combat.tactics[file] = { file, size: bin.length, kernel: check.kernel, pages: check.pages, code: encodeBase64(bin) };
}

/** A tactics script over a copy of `bin`, as loadScript starts one (tactics.cpp:135-155), its kernel 0: for the VM's tests. */
export function tacticScript(bin: Uint8Array, file = 'test.bin'): TacticScript {
  return { file, data: bin.slice(), pc: 0x6b, idle: 0, kernel: 0, trace: 0, queues: Array.from({ length: NUM_QUEUES }, () => []), depth: 0, buffer: true, returns: [] };
}

const { page: PAGE, when: WHEN, do: DO, branch: BRANCH } = TOKEN;
const T = TACTIC;
const page = (name: string): TacticItem[] => [{ cls: PAGE, opcode: 0x1f, page: name, args: [{ label: name }] }, { label: name }];
const toTarget: TacticItem[] = [1, 2, 3].map(k => ({ cls: DO, opcode: T.way, args: [k, T.target, { float: 0 }, 10] }));
const after = (ticks: number, then: TacticItem): TacticItem[] => [{ cls: WHEN, opcode: T.delta, args: [ticks, 0] }, then];
const goTo = (name: string): TacticItem => ({ cls: BRANCH, opcode: T.goto, args: [T.goto, { label: name }, 0] });

/**
 * A made-up Enterprise script laid out as the game's is (Plan 21 read their token layout, not their text): MAIN locks
 * the menu, builds a "-Menu-" heading with two maneuvers, sets the idle page, makes the kernel ready and disengages;
 * KERNEL picks RUSH or WEAVE at random; RUSH makes for the target and fires within 6000; WEAVE turns away for a while.
 * (Its page names and labels are checked against the real files': none matches but MAIN and KERNEL.)
 */
export function worfTactics(): Uint8Array {
  return assembleTactics([
    ...page('MAIN'),
    { cls: DO, opcode: T.engage, args: [2] },
    { cls: BRANCH, opcode: T.gosub, args: [T.gosub, { label: 'MENU' }, 0, 0] },
    { cls: BRANCH, opcode: T.idle, args: [2, { label: 'KERNEL' }] },
    { cls: DO, opcode: T.engage, args: [3] },
    { cls: DO, opcode: T.engage, args: [0] },
    ...after(0, { cls: BRANCH, opcode: T.once, args: [T.once, { label: 'KERNEL' }, 0] }),
    ...page('MENU'),
    { cls: DO, opcode: T.menu, args: [0, 1, 0], text: '-Menu-' },
    { cls: BRANCH, opcode: T.button, args: [T.gosub, 0, { label: 'RUSH' }], text: '-Close-' },
    { cls: BRANCH, opcode: T.button, args: [T.goto, 0, { label: 'WEAVE' }], text: '-Weave-' },
    { cls: DO, opcode: T.return },
    ...page('KERNEL'),
    { cls: DO, opcode: T.flush, args: [T.all] },
    { cls: BRANCH, opcode: T.random, args: [T.random, 0, T.goto, 2, { label: 'RUSH' }, { label: 'WEAVE' }] },
    ...page('RUSH'),
    { cls: DO, opcode: T.flush, args: [T.all] },
    ...toTarget,
    { cls: DO, opcode: T.speed, args: [500, 0, 10] },
    { cls: WHEN, opcode: T.proximity, args: [4, { float: 6000 }] }, { cls: DO, opcode: T.fire, args: [T.phaser] },
    { cls: WHEN, opcode: T.proximity, args: [4, { float: 6000 }] }, { cls: DO, opcode: T.fire, args: [T.photon] },
    ...after(0x5af, goTo('KERNEL')),
    ...page('WEAVE'),
    { cls: DO, opcode: T.flush, args: [T.all] },
    { cls: DO, opcode: T.clear },
    { cls: DO, opcode: T.heading, args: [10, T.heading, 0, 100] },
    { cls: DO, opcode: T.speed, args: [300, 0, 10] },
    ...after(0x246, goTo('KERNEL')),
    ...page('END'),
  ]).bin;
}

/**
 * A made-up enemy script in the game's layout: IDLE waits, or a roll of 1 in rnd(2), then STRIKE makes for the target,
 * firing phasers within 6000 and torpedoes every 5 s; once fired on, DODGE banks and climbs away for 3 s.
 */
export function zapTactics(): Uint8Array {
  return assembleTactics([
    ...page('MAIN'),
    { cls: BRANCH, opcode: T.idle, args: [2, { label: 'IDLE' }] },
    { cls: DO, opcode: T.message, text: 'Zap ready' },
    ...after(0x123, goTo('IDLE')),
    ...page('IDLE'),
    { cls: DO, opcode: T.flush, args: [T.all] },
    { cls: WHEN, opcode: T.random, args: [2] }, goTo('STRIKE'),
    ...after(0x246, goTo('STRIKE')),
    ...page('STRIKE'),
    { cls: DO, opcode: T.flush, args: [T.all] },
    ...toTarget,
    { cls: DO, opcode: T.speed, args: [400, 0, 10] },
    { cls: WHEN, opcode: T.proximity, args: [4, { float: 6000 }] }, { cls: DO, opcode: T.fire, args: [T.phaser] },
    ...after(0x5af, { cls: DO, opcode: T.fire, args: [T.photon] }),
    { cls: WHEN, opcode: T.fired }, { cls: BRANCH, opcode: T.once, args: [T.once, { label: 'DODGE' }, 0] },
    ...after(0x16bc, goTo('IDLE')),
    ...page('DODGE'),
    { cls: DO, opcode: T.flush, args: [T.all] },
    { cls: DO, opcode: T.clear },
    { cls: DO, opcode: T.bank, args: [10, T.bank, 0, 60] },
    { cls: DO, opcode: T.climb, args: [10, T.climb, 0, 40] },
    { cls: DO, opcode: T.speed, args: [600, 0, 10] },
    ...after(0x369, goTo('STRIKE')),
    ...page('END'),
  ]).bin;
}

/** miniCombat with worfTactics as the Enterprise's script (worf.bin) and zapTactics as every other ship's (zap.bin). */
export function miniTacticsCombat(): CombatData {
  const combat = miniCombat();
  addTactics(combat, 'worf.bin', worfTactics());
  addTactics(combat, 'zap.bin', zapTactics());
  for (const ship of combat.battles[3]!.ships) ship.tactics = ship.type === 2 ? 'worf.bin' : 'zap.bin';
  return combat;
}

/**
 * How a battle stands, for tests that fight one to its end (spec §4.6's ways out): lost with the Enterprise
 * destroyed or the exit code GAME_OVER_EXIT; fled once it has warped (warpAway or retreat) or the exit code is
 * ASTROGATION_EXIT; at peace when every other ship is a friend (nothing to fight); won once every ship that isn't a
 * friend is destroyed; else still fighting.
 *
 * Two readings to know: a battle with no other ships at all is 'peace' (every() of nothing), and `console.warped`
 * reads as 'flee' even when warpAway leaves enemies within range. ScummVM's battle goes on until it stands down,
 * which is Plan 22's; no flee was measured, so the counts are unaffected.
 */
export type BattleOutcome = 'win' | 'flee' | 'loss' | 'peace' | 'fighting';
export function battleOutcome(b: BattleState): BattleOutcome {
  const e = b.ships[0];
  const others = b.ships.slice(1);
  if (!e || e.destroyed || b.exitCode === GAME_OVER_EXIT) return 'loss';
  if (b.console.warped || b.exitCode === ASTROGATION_EXIT) return 'flee';
  if (others.every(s => s.flags & SHIP_FLAGS.friendly)) return 'peace';
  if (others.every(s => s.destroyed || (s.flags & SHIP_FLAGS.friendly))) return 'win';
  return 'fighting';
}
