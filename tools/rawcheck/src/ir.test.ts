// SPDX-License-Identifier: GPL-3.0-or-later
import { COMBAT_CUE_NAMES, CONSOLE_TEXT_NAMES } from '@another-unity/engine';
import { describe, expect, it } from 'vitest';
import { AstStatFile, CombatFile, ConversationFile, entryClasses, ExecutableFile, GameObject, IconMap, MovieMap, objectLists, PhaserMap, ScreenFile, SpriteList, TrigFile, TriggersFile, WorldFile } from './ir';

const hdr = { _order: 1, _stopHere: 0 };
const none = 'ffffff';
const condition = {
  class: 'ConditionBlock', _order: -1, _stopHere: 0, target: none, WhoCan: '000002',
  how_close_dist: 65535, how_close_x: 65535, how_close_y: 65535, skill_check: 65535,
  counter_value: 65535, counter_when: 255,
  condition: [none, none, none, none], check_x: [65535, 65535, 65535, 65535],
  check_y: [65535, 65535, 65535, 65535], check_unknown: [65535, 65535, 65535, 65535],
  check_univ_x: [65535, 65535, 65535, 65535], check_univ_y: [65535, 65535, 65535, 65535],
  check_univ_z: [65535, 65535, 65535, 65535], check_screen: [255, 255, 255, 255],
  check_status: [255, 255, 255, 255], check_state: [255, 255, 255, 255],
};
const alter = {
  class: 'AlterBlock', ...hdr, target: '070103', alter_flags: 255, alter_reset: 255, alter_state: 1,
  x_pos: 65535, y_pos: 65535, alter_name: '', alter_hail: '', alter_timer: 65535, alter_anim: 65535,
  play_description: 255, y_adjust: 65535, cursor_id: 255, cursor_flag: 255,
  universe_x: 65535, universe_y: 65535, universe_z: 65535,
  voice_id: 4294967295, voice_group: 4294967295, voice_subgroup: 65535,
};
const choice = {
  class: 'ChoiceBlock', ...hdr, _boxX: 100, _boxY: 100, _object: '000000',
  _questionstring: 'Clear the rubble?', _choicestring: ['Yes', 'No'],
  _choice: [[[alter]], []],
};
const object = {
  id: '070103', curr_screen: 1, width: 70, height: 70, x: 208, y: 336, z: -1,
  universe_x: -1, universe_y: -1, universe_z: -1, y_adjust: 255, anim_index: 0, sprite_id: 709,
  region_id: 0, flags: 0x22, state: 0, objwalktype: 0, name: 'rubble', transition: none,
  skills: 0, timer: 65535, talk_string: '', use_verb: '', use_preposition: '',
  voice_id: 4294967295, voice_group: 4294967295, voice_subgroup: 65535, cursor_id: 255, cursor_flag: 255,
  descriptions: [{ entry_id: 8, text: 'A heap of grey stones.', voice_id: 0x5c, voice_group: 0xfe, voice_subgroup: 2 }],
  use_entries: [[condition, choice]], get_entries: [], look_entries: [], timer_entries: [],
  phaser_data: { max_health: 2, threshold: 2, damage_setting: 1, gtp_setting: 1, gtp_min_setting: 1,
    stun_entries: [[alter]], gtp_entries: [], kill_entries: [] },
};

describe('the object schema', () => {
  it('accepts an object with nested choices and phaser lists', () => {
    expect(GameObject.safeParse(object).success).toBe(true);
  });

  it('rejects an unknown key in an entry', () => {
    const bad = { ...object, use_entries: [[{ ...condition, extra: 1 }]] };
    expect(GameObject.safeParse(bad).success).toBe(false);
  });

  it('rejects a choice without both branches', () => {
    const bad = { ...object, use_entries: [[{ ...choice, _choice: [[]] }]] };
    expect(GameObject.safeParse(bad).success).toBe(false);
  });

  it('rejects a signed field out of int16 range', () => {
    expect(GameObject.safeParse({ ...object, x: 65535 }).success).toBe(false);
  });

  it('collects every class, inside choices and phaser lists too', () => {
    const parsed = GameObject.parse(object);
    expect([...entryClasses(objectLists(parsed))].sort()).toEqual(['AlterBlock', 'ChoiceBlock', 'ConditionBlock']);
  });
});

const response = {
  id: 1, state: 0,
  text: 'The scanner shows the stones are very old. Something lies past them.',
  voice_tags: '', response_state: 2, next_situation: 65535, target: 'ffffff',
  voice_id: 0xe7, voice_group: 0xfe, voice_subgroup: 0,
  whocansayblocks: [{ whocansay: '000002' }],
  textblocks: [{ text: 'Fascinating.', continued: false, voice_id: 1, voice_group: 0xfe, voice_subgroup: 0 }],
  changeactions: [{ type: 0x30, response_id: 1, state_id: 0 }],
  results: [[[alter]]],
};

describe('the conversation schema', () => {
  it('accepts a conversation', () => {
    const conv = { id: 'w007c000', our_world: 7, our_id: 0, responses: [response] };
    expect(ConversationFile.safeParse(conv).success).toBe(true);
  });

  it('rejects a response state outside 1-4, and a change type outside 0x30-0x33', () => {
    const bad1 = { id: 'w007c000', our_world: 7, our_id: 0, responses: [{ ...response, response_state: 5 }] };
    const bad2 = { id: 'w007c000', our_world: 7, our_id: 0, responses: [{ ...response, changeactions: [{ type: 0x34, response_id: 1, state_id: 0 }] }] };
    expect(ConversationFile.safeParse(bad1).success).toBe(false);
    expect(ConversationFile.safeParse(bad2).success).toBe(false);
  });
});

describe('the screen and world schemas', () => {
  it('accepts a located screen, and one with only an object list', () => {
    const located = {
      id: 's_0701', world: 7, screen: 1, objects: ['070100'],
      location: { background: 'sb007001.scr\u0000', polygons: 'st007001.scr\u0000',
        entrypoints: [[{ x: 312, y: 332 }, { x: 339, y: 332 }, { x: 322, y: 326 }, { x: 332, y: 327 }]] },
      polygons: [{ id: 23, type: 0, points: [{ x: 176, y: 321 }], distances: [130] }],
    };
    const unlocated = { id: 's_0705', world: 7, screen: 5, objects: ['070500'], location: null, polygons: [] };
    expect(ScreenFile.safeParse(located).success).toBe(true);
    expect(ScreenFile.safeParse(unlocated).success).toBe(true);
  });

  it('rejects an entrance without four points', () => {
    const bad = { id: 's_0701', world: 7, screen: 1, objects: null,
      location: { background: 'a', polygons: 'b', entrypoints: [[{ x: 1, y: 1 }]] }, polygons: [] };
    expect(ScreenFile.safeParse(bad).success).toBe(false);
  });

  it('accepts a world with startups and advice', () => {
    const startup = { advice_id: 1, advice_timer: 65535, closeup: 0, combadge: 1, input_blocked: 0,
      screen: 1, target: '070100', who: '070100', other: 'ffffff', action: 6, x: 65535, y: 65535 };
    const world = { id: 'w_07', world: 7, startups: [startup],
      advice: { '1': { easy: [{ name: 'Picard', text: '@10,1' }], hard: [] } } };
    expect(WorldFile.safeParse(world).success).toBe(true);
    expect(WorldFile.safeParse({ ...world, advice: null }).success).toBe(true);
  });
});

describe('the table schemas', () => {
  it('accepts triggers, with proximity fields only on proximity triggers', () => {
    const timer = { id: 3, type: 1, target: '5f0102', enabled: true, context: 0, timer_start: 30,
      dist: null, from: null, to: null, reversed: null, instant: null };
    const near = { id: 4, type: 2, target: '5f0102', enabled: false, context: 0, timer_start: 0,
      dist: 5, from: '5f0100', to: '5f0101', reversed: false, instant: true };
    expect(TriggersFile.safeParse([timer, near]).success).toBe(true);
    expect(TriggersFile.safeParse([{ ...timer, type: 4 }]).success).toBe(false);
  });

  it('accepts the maps', () => {
    expect(PhaserMap.safeParse({ file: 'phaser.map', _phaserableObjects: ['070103'] }).success).toBe(true);
    expect(IconMap.safeParse({ file: 'icon.map', _iconSprites: { '000000': 'smhdpcrd.spr' } }).success).toBe(true);
    expect(MovieMap.safeParse({ file: 'movie.map', movies: [{ id: 55, filename: 'arrive.fvf', description: 'Synthetic arrival' }] }).success).toBe(true);
    expect(SpriteList.safeParse({ file: 'sprite.lst', _spriteFilenames: ['picard'] }).success).toBe(true);
    expect(AstStatFile.safeParse({ file: 'ast_stat.dat', offset: 1762, count: 1, _flags: [1] }).success).toBe(true);
  });

  const exe = {
      file: 'sttng.ovl', _presetSounds: { '1': 'beep7.mac' }, _adviceNames: { '0': 'Picard' },
      _crewVoices: [1], _leaderOrder: [0],
      _awayTeamScreenData: [{ defaultMembers: ['000000'], inventoryItems: ['007001'] }],
      _failHailEntries: [{ actionId: 1, source: '5f0100', failFlag: 2, hail: '@1,2' }],
      _actionStrings: ['Look at'], _transporterTargets: [{ x: 1, y: 2 }],
      _tricorderReadings: [{ key: 70001, parent: 1, entry: 2 }], _computerEntryIds: [-1, 5],
      _backgroundSoundDefaults: [{ formatString: 'adint%02d.rac', first: 1, last: 4 }],
      _phaserMuzzles: [{ x: 10, y: 60, frame: 2 }],
      _scriptedWarps: [{ code: 90090090, sector: 1, star: 0, planet: 2, type: 0, index: -1 }], _planetOrbits: [100, 200],
      _transporterPads: [{ rect: { left: 1, top: 2, right: 52, bottom: 148 }, stand: { x: 20, y: 140 }, scale: 200 }],
      _transporterSpriteNames: ['tpad1.spr'], _transporterWalkOn: [{ x: 1, y: 2, direction: 3, scale: 4 }],
      _transporterWalkOff: [], _arrowCursor: { width: 1, height: 1, hotspotX: 0, hotspotY: 0, pixels: [13] },
      _bridgeItems: [{ id: '000001', x: 1, y: 2, width: 3, height: 4, action: 5, depth: 6, description: '-Zap-' }],
      _bridgeObjects: [{ id: '000001', x: 1, y: 2, depth: 3, filename: '-Zap-' }],
      _bridgeScreenEntries: [{ code: 1, text: '-Zap-' }], _transporterExits: [{ code: 2, text: '-Zap-' }],
      _warpSpeeds: [1, 2], _impulseSpeeds: [3], _sectorRegions: [0, -1], _regionChatter: [4],
      _astroReveals: [7], _warpMovies: ['warpout1.fvf'], _encounterThresholds: [10, 5], _hazardDamage: [-1, 20], _hazardVoices: ['', 'x.vac'],
      _shipUnits: [{ name: '-Zap-', type: 1, depth: 0, paletteIndex: 2, current: 3, target: 4, max: 5, chargeTicks: 6, dischargeTicks: 7, damage: 0, repair: 1, baseDamage: 2, maxDamage: 3, efficiency: 95, hitWeight: 4 }],
      _enemyShip: [], _combatShips: [], _flightTurns: [], _flightSpeeds: [], _flightTurnScales: [], _cues: [],
    };

  it('accepts the executable tables', () => {
    expect(ExecutableFile.safeParse(exe).success).toBe(true);
    const extra = { ...exe, _shipUnits: [{ ...exe._shipUnits[0], extra: 1 }] };
    expect(ExecutableFile.safeParse(extra).success).toBe(false);
  });

  it('accepts the combat tables, and refuses a null float or a unit without its hit weight (Plan 18 Task 1)', () => {
    const unit = {
      name: '-Zap-', type: 1, depth: 0, paletteIndex: 2, current: 3, target: 4, max: 5, chargeTicks: 6, dischargeTicks: 7,
      damage: 0, repair: 1, baseDamage: 2, maxDamage: 3, efficiency: 95, hitWeight: 4,
    };
    const combat = {
      _shipUnits: [unit], _enemyShip: [unit],
      _combatShips: [{ base: 'zap', maxSpeed: 300, detailDistance: 20000, reducedDistance: 60000 }],
      _flightTurns: [0, -3, 7], _flightSpeeds: [0.100000001, 1.5], _flightTurnScales: [0.333333343],
      _cues: [{ speaker: 2, filename: 'zap.vac', gap: 291 }, { speaker: -1, filename: '', gap: 0 }],
    };
    expect(ExecutableFile.safeParse({ ...exe, ...combat }).success).toBe(true);
    expect(ExecutableFile.safeParse({ ...exe, ...combat, _flightSpeeds: [null] }).success).toBe(false);
    const { hitWeight: _, ...noWeight } = unit;
    expect(ExecutableFile.safeParse({ ...exe, ...combat, _enemyShip: [noWeight] }).success).toBe(false);
  });
});

describe('the combat constants (Plan 18 Task 2)', () => {
  const ten = <T>(f: (i: number) => T): T[] => Array.from({ length: 10 }, (_, i) => f(i));
  const grid = (rows: number, cols: number) => Array.from({ length: rows }, () => Array.from({ length: cols }, () => 0));
  const c = (source: string, value: unknown) => ({ source, value });
  const combat = {
    file: 'scummvm',
    _powerLevels: [[1, 2], [3], [4], [5], [6]],
    archive: ['__boom.spr', 'enterpri.rac'],
    kShipKinds: c('combat.cpp:35-49', ten(i => ({ name: `kind${i}`, flags: 0xfe00 }))),
    kContactCues: c('combat.cpp:245', ten(() => -1)),
    kDestroyedCues: c('damage.cpp:607-609', ten(() => -1)),
    kTargetCues: c('ai.cpp:138', ten(() => 0x46)),
    kSurpriseObjects: c('combat.cpp:197-199', { screen: 0x34, ids: [1, 5, 6] }),
    kEnterpriseHitLists: c('damage.cpp:36-45', grid(8, 14)),
    kOtherHitLists: c('damage.cpp:46-53', grid(6, 14)),
    kRaceBits: c('weapons.cpp:35-41', { shield: 1, phaser: 2, photon: 4, phaserSound: 8, photonSound: 0x10 }),
    kRaces: c('weapons.cpp:42-48', ten(() => ({ letter: 'z', mask: 0x3f }))),
    kEnterprisePhasers: c('weapons.cpp:51-53', grid(6, 3)),
    kOtherPhasers: c('weapons.cpp:54', grid(2, 3)),
    kWeaponUnits: c('weapons.cpp:55-58', { enterprisePhaser: 13, otherPhaser: 8, enterpriseTube: 19, otherTube: 10 }),
    kTacticOverrides: c('tactics.cpp:95-106', [{ object: 0x101001, file: 'zap.bin' }]),
    kClassNames: c('tactical.cpp:213-216', ten(() => '-Zap-')),
    kScannerImages: c('tactical.cpp:217', ten(() => 85)),
    kEnterpriseAreas: c('tactical.cpp:219-222', grid(11, 4)),
    kOtherAreas: c('tactical.cpp:223-226', grid(11, 4)),
    kRadarColours: c('tactical.cpp:232', ten(() => 0x98)),
    kBearing: c('weapons.cpp:738-740', grid(8, 3)),
    kShieldNames: c('damage.cpp:55-58', ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7']),
    kCueIds: Object.fromEntries(COMBAT_CUE_NAMES.map((n, i) => [n, c('weapons.cpp:612', i)])),
    kConsoleText: Object.fromEntries(CONSOLE_TEXT_NAMES.map((n, i) => [n, c(`tactical.cpp:${1050 + i}`, `-T${i}-`)])),
  };

  it('accepts the constants, each with its source', () => {
    expect(CombatFile.safeParse(combat).success).toBe(true);
  });

  it('refuses a constant without its source, a source that is not file:line, or a table of the wrong size', () => {
    expect(CombatFile.safeParse({ ...combat, kRadarColours: { value: ten(() => 0) } }).success).toBe(false);
    expect(CombatFile.safeParse({ ...combat, kShipKinds: c('combat.cpp', combat.kShipKinds.value) }).success).toBe(false);
    expect(CombatFile.safeParse({ ...combat, kOtherHitLists: c('damage.cpp:46-53', grid(5, 14)) }).success).toBe(false);
    expect(CombatFile.safeParse({ ...combat, _powerLevels: [[1]] }).success).toBe(false);
  });

  it('refuses a cue id table that lacks a name, has one more, or an id without its line (Plan 23 R1)', () => {
    const { lockOn: _lockOn, ...short } = combat.kCueIds;
    expect(CombatFile.safeParse({ ...combat, kCueIds: short }).success).toBe(false);
    expect(CombatFile.safeParse({ ...combat, kCueIds: { ...combat.kCueIds, zap: c('weapons.cpp:612', 1) } }).success).toBe(false);
    expect(CombatFile.safeParse({ ...combat, kCueIds: { ...combat.kCueIds, lockOn: { value: 0x1b } } }).success).toBe(false);
    expect(CombatFile.safeParse({ ...combat, kBearing: c('weapons.cpp:738-740', grid(8, 2)) }).success).toBe(false);
  });

  it('takes the console\'s text when the export has it, each by its line, and refuses a short or uncited table (Plan 27 R15)', () => {
    const { kConsoleText: _text, ...older } = combat;
    expect(CombatFile.safeParse(older).success).toBe(true);
    const { mark: _mark, ...short } = combat.kConsoleText;
    expect(CombatFile.safeParse({ ...combat, kConsoleText: short }).success).toBe(false);
    expect(CombatFile.safeParse({ ...combat, kConsoleText: { ...combat.kConsoleText, mark: { value: '-T5-' } } }).success).toBe(false);
    expect(CombatFile.safeParse({ ...combat, kConsoleText: { ...combat.kConsoleText, mark: c('tactical.cpp:1230', 4) } }).success).toBe(false);
  });
});

describe('the trig table (Plan 22 Task 1)', () => {
  it('accepts sinf and cosf of the 16384 whole angles, and refuses a column of any other length or a non-float', () => {
    const column = (n: number) => Array.from({ length: n }, (_, i) => Math.fround(i / n));
    const trig = { file: 'scummvm', sin: column(0x4000), cos: column(0x4000) };
    expect(TrigFile.safeParse(trig).success).toBe(true);
    expect(TrigFile.safeParse({ ...trig, sin: column(0x3fff) }).success).toBe(false);
    expect(TrigFile.safeParse({ ...trig, cos: column(0x4001) }).success).toBe(false);
    expect(TrigFile.safeParse({ ...trig, cos: [...column(0x3fff), null] }).success).toBe(false);
    expect(TrigFile.safeParse({ ...trig, file: 'math' }).success).toBe(false);
  });
});
