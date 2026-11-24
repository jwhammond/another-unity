// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { COMBAT_CUE_NAMES, CONSOLE_TEXT_NAMES } from '@another-unity/engine';

/** A JSON object of the raw IR. */
export type J = Record<string, unknown>;

export const NONE = 'ffffff';
const F4 = [65535, 65535, 65535, 65535];
const B4 = [255, 255, 255, 255];
const hdr = { _order: 1, _stopHere: 0 };

// Every builder returns a block with every field "none", as ScummVM's parsers leave them; tests set what matters.
export const cond = (f: J = {}): J => ({
  class: 'ConditionBlock', _order: -1, _stopHere: 0, target: NONE, WhoCan: NONE,
  how_close_dist: 65535, how_close_x: 65535, how_close_y: 65535, skill_check: 65535,
  counter_value: 65535, counter_when: 255,
  condition: [NONE, NONE, NONE, NONE], check_x: F4, check_y: F4, check_unknown: F4,
  check_univ_x: F4, check_univ_y: F4, check_univ_z: F4, check_screen: B4, check_status: B4, check_state: B4,
  ...f,
});
export const alter = (f: J = {}): J => ({
  class: 'AlterBlock', ...hdr, target: NONE, alter_flags: 0, alter_reset: 0, alter_state: 255,
  x_pos: 65535, y_pos: 65535, alter_name: '', alter_hail: '', alter_timer: 65535, alter_anim: 65535,
  play_description: 0, y_adjust: 65535, cursor_id: 255, cursor_flag: 255,
  universe_x: 65535, universe_y: 65535, universe_z: 65535,
  voice_id: 4294967295, voice_group: 4294967295, voice_subgroup: 65535, ...f,
});
export const reaction = (f: J = {}): J => ({
  class: 'ReactionBlock', ...hdr, target: NONE, dest_world: 65535, dest_screen: 65535, dest_entrance: 65535,
  target_type: 255, action_type: 255, damage_amount: 0, beam_type: 0,
  dest_x: 65535, dest_y: 65535, dest_unknown: 65535, ...f,
});
export const command = (f: J = {}): J => ({
  class: 'CommandBlock', ...hdr, target: [NONE, NONE, NONE], target_x: 65535, target_y: 65535, command_id: 2, ...f,
});
export const screenBlock = (f: J = {}): J => ({
  class: 'ScreenBlock', ...hdr, new_world: 65535, new_screen: 255, new_entrance: 255, advice_screen: 255,
  new_advice_id: 65535, new_advice_timer: 65535, startup_screen: 65535, startup_target: NONE,
  startup_action: 255, startup_who: NONE, startup_other: NONE, startup_x: 65535, startup_y: 65535,
  flags_screen: 65535, combadge: 255, closeup: 255, input_blocked: 255, ...f,
});
export const pathBlock = (f: J = {}): J => ({ class: 'PathBlock', ...hdr, regions_on: B4, regions_off: B4, ...f });
export const general = (f: J = {}): J => ({
  class: 'GeneralBlock', ...hdr, movie_id: 65535, sound_id: 65535, command: 65535, ...f,
});
export const convBlock = (f: J = {}): J => ({
  class: 'ConversationBlock', ...hdr, world_id: 65535, conversation_id: 0, response_id: 0, state_id: 0, action_id: 2, ...f,
});
export const beam = (f: J = {}): J => ({
  class: 'BeamBlock', ...hdr, world_id: 65535, unknown1: 65535, unknown3: 65535, screen_id: 65535, ...f,
});
export const triggerBlock = (f: J = {}): J => ({ class: 'TriggerBlock', ...hdr, trigger_id: 0, enable_trigger: true, ...f });
export const communicate = (f: J = {}): J => ({
  class: 'CommunicateBlock', ...hdr, target: NONE, conversation_id: 0, situation_id: 0, hail_type: 255, ...f,
});
export const choice = (f: J = {}): J => ({
  class: 'ChoiceBlock', ...hdr, _boxX: 100, _boxY: 100, _object: '000000', _questionstring: '?',
  _choicestring: ['Yes', 'No'], _choice: [[], []], ...f,
});

/** An object; its screen is the one in its id unless `curr_screen` says otherwise. */
export const obj = (id: string, f: J = {}): J => ({
  id, curr_screen: parseInt(id.slice(2, 4), 16), width: -1, height: -1, x: -1, y: -1, z: -1,
  universe_x: -1, universe_y: -1, universe_z: -1, y_adjust: -1, anim_index: 65535, sprite_id: 65535,
  region_id: 0, flags: 0x20, state: 0, objwalktype: 0, name: '', transition: NONE, skills: 0, timer: 65535,
  talk_string: '', use_verb: '', use_preposition: '', voice_id: 4294967295, voice_group: 4294967295,
  voice_subgroup: 65535, cursor_id: 255, cursor_flag: 255, descriptions: [],
  use_entries: [], get_entries: [], look_entries: [], timer_entries: [], phaser_data: null, ...f,
});

export const response = (f: J = {}): J => ({
  id: 1, state: 0, text: '', voice_tags: '', response_state: 2, next_situation: 65535, target: NONE,
  voice_id: 4294967295, voice_group: 4294967295, voice_subgroup: 65535,
  whocansayblocks: [{ whocansay: '000010' }], textblocks: [], changeactions: [], results: [], ...f,
});

export const startup = (f: J = {}): J => ({
  advice_id: 65535, advice_timer: 65535, closeup: 0, combadge: 255, input_blocked: 255,
  screen: 65535, target: NONE, who: NONE, other: NONE, action: 255, x: 65535, y: 65535, ...f,
});

export const trig = (f: J = {}): J => ({
  id: 0, type: 0, target: NONE, enabled: true, context: 1, timer_start: 0,
  dist: null, from: null, to: null, reversed: null, instant: null, ...f,
});

const phaser = (f: J = {}): J => ({
  max_health: 10, threshold: 2, damage_setting: 1, gtp_setting: -1, gtp_min_setting: 4,
  stun_entries: [], gtp_entries: [], kill_entries: [], ...f,
});
const desc = (entry: number, text: string, id: number, sub = 0): J =>
  ({ entry_id: entry, text, voice_id: id, voice_group: 0xfe, voice_subgroup: sub });
const conversation = (world: number, id: number, responses: J[]): J => ({
  id: `w${world.toString(16).padStart(3, '0')}c${String(id).padStart(3, '0')}`, our_world: world, our_id: id, responses,
});

function objects(): J[] {
  const crew = (n: number, name: string, f: J = {}) =>
    obj(`0000${n.toString(16).padStart(2, '0')}`, { name, curr_screen: 1, x: 1, y: 1, flags: 0x24, objwalktype: 1, phaser_data: phaser(), ...f });
  // (as in the real export: active, but not in the inventory; the start's equipment is the lifter's business)
  const item = (n: number, name: string, f: J = {}) =>
    obj(`0070${n.toString(16).padStart(2, '0')}`, { name, curr_screen: 255, flags: 0x20, ...f });
  return [
    crew(0, 'Picard', {
      skills: 0x5444, talk_string: '!', descriptions: [desc(0, 'The captain stands ready.', 0x3d, 4)],
    }),
    crew(1, 'Riker'), crew(2, 'Data', { skills: 0x5555 }), crew(3, 'Troi'), crew(4, 'Worf'), crew(5, 'Crusher'),
    item(0, 'medical tricorder'), item(1, 'tricorder'),
    item(2, 'communicator', { flags: 0x22, use_entries: [[communicate({ hail_type: 6, conversation_id: 34, situation_id: 1 })]] }),
    item(3, 'phaser', { flags: 0x26 }), item(4, 'medkit'),
    obj('070100', {
      name: 'Setup World',
      use_entries: [[
        alter({ _order: 2, target: '070103', alter_state: 1 }),
        triggerBlock({ _order: 1, trigger_id: 3, enable_trigger: true }),
        general({ _order: 3, movie_id: 55 }),
        general({ _order: 4, command: 5012 }),
        command({ _order: 5, target: ['070103', '000020', NONE], command_id: 2 }),
      ]],
    }),
    obj('070103', {
      name: 'rubble', x: 208, y: 336, width: 70, height: 70, flags: 0x32,
      descriptions: [desc(0, 'A heap of grey stones.', 0x5c, 2), desc(2, 'Igneous rock.', 0xa8, 2)],
      use_entries: [
        [
          cond({ WhoCan: '000002', how_close_dist: 40, skill_check: 0x0300 }),
          choice({
            _stopHere: 1, _questionstring: 'Clear the rubble?',
            _choice: [[[alter({ target: '070103', alter_flags: 0x80 })]], []],
          }),
        ],
        [alter({ target: '000010', x_pos: 250, y_pos: 340 })],
      ],
      look_entries: [[cond({ target: 'fffffe' }), alter({ target: '070103', play_description: 1 })]],
      phaser_data: phaser({
        max_health: 2, threshold: 2, gtp_min_setting: 1,
        stun_entries: [[reaction({ target_type: 1, action_type: 0, beam_type: 1 })]],
      }),
    }),
    obj('070104', {
      name: 'door', x: 330, y: 300, width: 40, height: 80, flags: 0x23, objwalktype: 2,
      use_entries: [[
        cond({ condition: ['070103', NONE, NONE, NONE], check_state: [1, 255, 255, 255] }),
        screenBlock({ new_screen: 2, new_entrance: 0x81 }),
        pathBlock({ _order: 2, regions_on: [24, 255, 255, 255] }),
      ]],
      get_entries: [[
        convBlock({ conversation_id: 0, response_id: 1, state_id: 0, action_id: 3 }),
        beam({ _order: 2, world_id: 7, screen_id: 2 }),
        triggerBlock({ _order: 3, trigger_id: 4, enable_trigger: false }),
      ]],
    }),
    // the ship world: the Enterprise and a planet, with positions in space, and an object the ship's triggers act on
    obj('5f0100', { name: 'Enterprise', universe_x: 90, universe_y: 90, universe_z: 90 }),
    obj('5f0102', { name: 'Beacon', curr_screen: 255 }),
    obj('5f0104', { name: 'Planet', universe_x: 10, universe_y: 20, universe_z: 30 }),
    obj('070201', {
      name: 'guard', x: 300, y: 350, width: 30, height: 90, flags: 0x34, timer: 10,
      talk_string: 'Halt!', voice_id: 0x10, voice_group: 0x07, voice_subgroup: 1,
      timer_entries: [[reaction({ target_type: 3, damage_amount: 3, beam_type: 1, _stopHere: 1 })]],
      use_entries: [[
        communicate({ hail_type: 7, conversation_id: 34, situation_id: 3 }),
        screenBlock({
          _order: 2, new_world: 0, new_screen: 0xfe, new_entrance: 2, advice_screen: 1, new_advice_id: 1,
          new_advice_timer: 30, startup_screen: 2, startup_target: '070201', startup_action: 5,
          startup_who: '000010', combadge: 1, input_blocked: 0,
        }),
      ]],
      phaser_data: phaser({
        max_health: 5, threshold: 1, damage_setting: 2, gtp_setting: 1, gtp_min_setting: 3,
        stun_entries: [[alter({ target: '070201', alter_state: 2 })]],
      }),
    }),
  ];
}

function conversations(): J[] {
  const line = (id: number, text: string) => response({ id, text });
  return [
    conversation(7, 0, [
      response({
        id: 1, text: 'What are these rocks?', whocansayblocks: [{ whocansay: '000000' }],
        voice_id: 0xe7, voice_group: 0xfe, voice_subgroup: 0, target: '000022', next_situation: 2,
        textblocks: [{ text: 'Fascinating.', continued: false, voice_id: 1, voice_group: 0xfe, voice_subgroup: 0 }],
        changeactions: [{ type: 0x30, response_id: 1, state_id: 0 }],
        results: [[[alter({ target: '070103', alter_state: 3 })]]],
      }),
      response({
        id: 2, text: 'Anyone?', voice_tags: '0e702e71', voice_id: 0, voice_group: 0xfd, voice_subgroup: 0,
        response_state: 1, target: '070201',
        textblocks: [
          { text: 'Go ', continued: true, voice_id: 2, voice_group: 0x07, voice_subgroup: 1 },
          { text: 'away.', continued: false, voice_id: 3, voice_group: 0x07, voice_subgroup: 1 },
        ],
      }),
    ]),
    conversation(0x5f, 34, [
      line(1, 'Nothing to see.'), line(2, 'No answer.'), line(3, 'That does nothing.'), line(4, 'Not with that.'),
      line(5, 'The phaser does nothing.'), line(42, 'I have no advice.'),
    ]),
    conversation(5, 15, [line(23, 'The tricorder shows nothing.')]),
  ];
}

function screens(): J[] {
  const pt = (x: number, y: number) => ({ x, y });
  return [
    {
      id: 's_0701', world: 7, screen: 1, objects: ['070100', '070103', '070104'],
      location: {
        background: 'sb007001.scr\u0000', polygons: 'st007001.scr\u0000',
        entrypoints: [
          [pt(312, 332), pt(339, 332), pt(322, 326), pt(332, 327)],
          [pt(100, 380), pt(110, 380), pt(120, 380), pt(130, 380)],
        ],
      },
      polygons: [
        { id: 23, type: 1, points: [pt(100, 250), pt(540, 250), pt(600, 399), pt(40, 399)], distances: [128, 128, 256, 256] },
        { id: 24, type: 0, points: [pt(540, 250), pt(620, 250), pt(630, 300), pt(560, 300)], distances: [128, 128, 171, 171] },
        // (every real screen has one of these; the fit and the greybox floor leave type 3 and 4 out)
        { id: 22, type: 4, points: [pt(0, 0), pt(636, 0), pt(636, 400), pt(0, 400)], distances: [256, 256, 256, 256] },
      ],
    },
    {
      id: 's_0702', world: 7, screen: 2, objects: ['070201'],
      location: {
        background: 'sb007002.scr\u0000', polygons: 'st007002.scr\u0000',
        entrypoints: [[pt(300, 390), pt(320, 390), pt(340, 390), pt(360, 390)]],
      },
      polygons: [{ id: 5, type: 1, points: [pt(0, 300), pt(640, 300), pt(640, 399), pt(0, 399)], distances: [200, 200, 256, 256] }],
    },
    { id: 's_0703', world: 7, screen: 3, objects: null, location: null, polygons: [] },
    { id: 's_5f01', world: 0x5f, screen: 1, objects: ['5f0100', '5f0104'], location: null, polygons: [] },
  ];
}

/** Every file of the export but the manifest, by path. */
function files(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const o of objects()) out[`objects/o_${o.id}.json`] = o;
  for (const c of conversations()) out[`conversations/${c.id}.json`] = c;
  for (const s of screens()) out[`screens/${s.id}.json`] = s;
  out['worlds/w_07.json'] = {
    id: 'w_07', world: 7,
    startups: [
      startup(),
      startup({ advice_id: 1, combadge: 1, input_blocked: 0, screen: 1, target: '070100', who: '070100', action: 6 }),
      startup(),
      startup({ closeup: 1 }),
    ],
    advice: {
      '1': {
        easy: [{ name: 'Picard', text: '@0,1' }, { name: 'Anyone', text: 'Look around.' }],
        hard: [{ name: 'Data', text: '^1' }],
      },
    },
  };
  out['triggers.json'] = [
    trig({ id: 3, type: 1, target: '070100', enabled: false, timer_start: 30 }),
    trig({ id: 4, type: 0, target: '070201', enabled: true }),
    trig({ id: 9, type: 2, target: '5f0102', context: 0, dist: 5, from: '5f0100', to: '5f0104', reversed: false, instant: true }),
    // (the triggers astrogation turns on, which ship.astro names)
    ...[2, 8, 10, 21, 69, 71].map(id => trig({ id, type: 0, target: '5f0102', context: 0, enabled: false })),
    trig({ id: 12, type: 1, target: '5f0102', context: 0, enabled: false, timer_start: 25 }),
  ];
  out['maps/phaser.json'] = { file: 'phaser.map', _phaserableObjects: ['000000', '070103', '070201'] };
  out['maps/icon.json'] = { file: 'icon.map', _iconSprites: { '000000': 'smhdpcrd.spr' } };
  out['maps/movie.json'] = { file: 'movie.map', movies: [{ id: 55, filename: 'arrive.fvf', description: 'Synthetic arrival' }] };
  out['maps/sprite.json'] = { file: 'sprite.lst', _spriteFilenames: ['picard'] };
  out['executable.json'] = {
    file: 'sttng.ovl', _presetSounds: { '1': 'beep7.mac' },
    _adviceNames: { '0': 'Picard', '1': 'Riker', '2': 'Data', '3': 'Troi', '5': 'Crusher', '15': 'Anyone' },
    _crewVoices: [], _leaderOrder: [], _awayTeamScreenData: [], _failHailEntries: [], _actionStrings: [],
    _transporterTargets: [], _tricorderReadings: [], _computerEntryIds: [], _backgroundSoundDefaults: [],
    _phaserMuzzles: [], _scriptedWarps: [], _planetOrbits: [], _transporterPads: [], _transporterSpriteNames: [], _transporterWalkOn: [],
    _transporterWalkOff: [], _arrowCursor: { width: 1, height: 1, hotspotX: 0, hotspotY: 0, pixels: [13] },
    _bridgeItems: [], _bridgeObjects: [], _bridgeScreenEntries: [], _transporterExits: [], _warpSpeeds: [],
    _impulseSpeeds: [], _sectorRegions: [], _regionChatter: [], _astroReveals: [], _warpMovies: [], _encounterThresholds: [],
    _hazardDamage: [], _hazardVoices: [], _shipUnits: [],
    _enemyShip: [{
      name: '-Unit-', type: 7, depth: 0, paletteIndex: 0, current: 10, target: 10, max: 10, chargeTicks: 1, dischargeTicks: 1,
      damage: 0, repair: 0, baseDamage: 0, maxDamage: 10, efficiency: 95, hitWeight: 4,
    }],
    _combatShips: Array.from({ length: 11 }, (_, i) => ({ base: `KIND${i}`, maxSpeed: 300, detailDistance: 20000, reducedDistance: 60000 })),
    _flightTurns: [0, 5], _flightSpeeds: [0.100000001], _flightTurnScales: [0.333333343],
    _cues: [{ speaker: 2, filename: 'ZAP.VAC', gap: 291 }, { speaker: 0, filename: '', gap: 0 }],
  };
  out['ast_stat.json'] = { file: 'ast_stat.dat', offset: 1762, count: 0, _flags: [] };
  out['combat.json'] = miniCombatJson();
  return out;
}

/** kShipKinds (combat.cpp:35-49): ScummVM's code, its names and flags; 0x08000000 is friendly. */
const SHIP_KINDS = [
  { name: 'chodak', flags: 0xfe00 }, { name: 'romulan', flags: 0xfe00 }, { name: 'enterprise', flags: 0xde00 }, { name: 'klingon', flags: 0x0800fe00 },
  { name: 'probe', flags: 0x8600 }, { name: 'ferengi', flags: 0x0800de00 }, { name: 'starbase', flags: 0x08008000 }, { name: 'garidian', flags: 0xfe00 },
  { name: 'shuttle', flags: 0x08008000 }, { name: 'mother', flags: 0x08007e00 },
];

/** A synthetic combat.json (Plan 18 Task 2): kShipKinds' real names and flags (ScummVM's code), the rest made up. */
export function miniCombatJson(): J {
  const ten = <T>(f: (i: number) => T): T[] => Array.from({ length: 10 }, (_, i) => f(i));
  const c = (source: string, value: unknown) => ({ source, value });
  const grid = (rows: number, cols: number, row: number[]) => Array.from({ length: rows }, () => Array.from({ length: cols }, (_, i) => row[i] ?? 0));
  return {
    file: 'scummvm',
    _powerLevels: [0, 1, 2, 3, 4].map(level => [level, level, level]),
    archive: ['1_boom.spr', '2_boom.spr', '3_boom.spr', '__boom.spr', '__phaser.mac', '__phaser.spr', '__photon.mac', '__photon.spr', '__shield.spr', 'enterpri.rac', 'k_photon.mac', 'k_shield.spr'],
    kShipKinds: c('combat.cpp:35-49', SHIP_KINDS.map(k => ({ name: k.name, flags: k.flags }))),
    kContactCues: c('combat.cpp:245', ten(i => (i === 2 ? -1 : 0x39 + i))),
    kDestroyedCues: c('damage.cpp:607-609', ten(() => -1)),
    kTargetCues: c('ai.cpp:138', ten(() => 0x46)),
    kSurpriseObjects: c('combat.cpp:197-199', { screen: 0x34, ids: [1, 5, 6] }),
    kEnterpriseHitLists: c('damage.cpp:36-45', grid(8, 14, [22, 8, -1])),
    kOtherHitLists: c('damage.cpp:46-53', grid(6, 14, [8, 10, -1])),
    kRaceBits: c('weapons.cpp:35-41', { shield: 1, phaser: 2, photon: 4, phaserSound: 8, photonSound: 0x10 }),
    kRaces: c('weapons.cpp:42-48', ten(i => ({ letter: i === 3 ? 'k' : 'z', mask: 0x3f }))),
    kEnterprisePhasers: c('weapons.cpp:51-53', grid(6, 3, [0, -20, 210])),
    kOtherPhasers: c('weapons.cpp:54', grid(2, 3, [0, -1, 200])),
    kWeaponUnits: c('weapons.cpp:55-58', { enterprisePhaser: 13, otherPhaser: 8, enterpriseTube: 19, otherTube: 10 }),
    kTacticOverrides: c('tactics.cpp:95-106', [{ object: 0x103405, file: 'ZAP.BIN' }]),
    kClassNames: c('tactical.cpp:213-216', ten(() => '-Zap-')),
    kScannerImages: c('tactical.cpp:217', ten(() => 85)),
    kEnterpriseAreas: c('tactical.cpp:219-222', grid(11, 4, [7, 1, -1])),
    kOtherAreas: c('tactical.cpp:223-226', grid(11, 4, [1, -1])),
    kRadarColours: c('tactical.cpp:232', ten(() => 0x98)),
    kBearing: c('weapons.cpp:738-740', grid(8, 3, [0, 2, 6])),
    kShieldNames: c('damage.cpp:55-58', ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7']),
    // (made-up ids, each cited at a made-up line of its file)
    kCueIds: Object.fromEntries(COMBAT_CUE_NAMES.map((n, i) => [n, c(`weapons.cpp:${600 + i}`, 0x100 + i)])),
    // (made-up strings, each cited at a made-up line: Plan 27 R15)
    kConsoleText: Object.fromEntries(CONSOLE_TEXT_NAMES.map((n, i) => [n, c(`tactical.cpp:${1050 + i}`, `-T${i}-`)])),
  };
}

function manifest(all: Record<string, unknown>): J {
  const paths = Object.keys(all).sort();
  const ids = (dir: string, prefix: string) =>
    paths.filter(p => p.startsWith(dir)).map(p => p.slice(dir.length + prefix.length, -'.json'.length)).sort();
  return {
    format: 'another-unity/raw-ir', version: 1, generator: 'tools/lift mini',
    objects: ids('objects/', 'o_'), conversations: ids('conversations/', ''), screens: ids('screens/', ''),
    worlds: ids('worlds/', ''), files: paths,
  };
}

export function miniRaw(edit?: (files: Record<string, unknown>) => void): Record<string, unknown> {
  const all = files();
  edit?.(all);
  return { ...all, 'manifest.json': manifest(all) };
}

export async function writeMiniRaw(dir: string, edit?: (files: Record<string, unknown>) => void): Promise<void> {
  for (const [path, value] of Object.entries(miniRaw(edit))) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), `${JSON.stringify(value, null, 1)}\n`);
  }
}
