// SPDX-License-Identifier: GPL-3.0-or-later
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseGame } from '../content/parse';
import { AssetIndex } from './assets';
import { makeGame } from '../testing/fixture';
import type { GameContent } from '../content/types';
import { arrivalMovie, introPiece, loopFor, musicFor, packageFromGlobs, packageFromStrings, parsePresentation, screenAudio } from './package';
import { VoiceTable } from './voices';

const BASE = '../games/mini/';
const yaml: Record<string, string> = {
  [`${BASE}game.yaml`]: 'id: mini\nstart: { screen: room, entrance: door, awayTeam: [picard], leader: picard }\n',
  [`${BASE}screens/room.yaml`]: 'id: room\nworld: ship\nmarkers: { door: { x: 0, z: 0 } }\n',
  [`${BASE}objects/picard.yaml`]: 'id: picard\nname: Picard\nscreen: room\ncrew: true\n',
  [`${BASE}objects/panel.yaml`]: [
    'id: panel', 'name: Panel', 'screen: room', 'on:', '  use:', '    - do:',
    '        - play: { sound: chime }',
    '        - say: { who: picard, text: "Hm.", voice: "p@01" }',
    '        - say: { who: picard, text: "Lost.", voice: "zz" }', '',
  ].join('\n'),
  [`${BASE}voices.yaml`]: "speakers: { picard: '00' }\nother: ff\nlines: { p@01: Hm. }\n",
  [`${BASE}presentation.yaml`]: 'music: { ship: theme }\nambience: { room: hum }\n',
  '../elsewhere/game.yaml': 'not: this game\n',
};
const assets: Record<string, string> = {
  [`${BASE}audio/voice/p0001.wav`]: '/a/p0001.wav',
  [`${BASE}audio/voice/p0001.opus`]: '/a/p0001.opus',
  [`${BASE}audio/sfx/chime.opus`]: '/a/chime.opus',
  [`${BASE}audio/music/chime.ogg`]: '/a/chime-music.ogg',
  [`${BASE}audio/music/theme.ogg`]: '/a/theme.ogg',
  [`${BASE}models/rooms/room.glb`]: '/a/room.glb',
  [`${BASE}models/rooms/horst3/s01.glb`]: '/a/s01.glb',
  [`${BASE}movies/intro.webm`]: '/a/intro.webm',
};
const pkg = packageFromGlobs({ id: 'mini', base: BASE, yaml, assets });

describe('presentation.art.ship (R14)', () => {
  it('a plate-only entry parses with areas and crew defaulted; an entry with neither plate nor gltf fails; a glb-only entry still parses', () => {
    expect(parsePresentation('art:\n  ship:\n    bridge: { plate: art/p.webp }\n').art.ship.bridge).toEqual({ plate: 'art/p.webp', areas: {}, crew: [], camera: 'camera:main' });
    expect(() => parsePresentation('art:\n  ship:\n    bridge: { areas: {} }\n')).toThrow(/plate or a gltf/);
    expect(parsePresentation('art:\n  ship:\n    bridge: { gltf: art/b.glb }\n').art.ship.bridge).toEqual({ gltf: 'art/b.glb', areas: {}, crew: [], camera: 'camera:main' });
    expect(() => parsePresentation('art:\n  ship:\n    bridge: { plate: p, crew: [{ object: a, at: [1, 2] }] }\n')).toThrow();
  });
});

describe('presentation.art.space (Plan 30)', () => {
  it('reads the kinds\' packs, the effects\' pack, the console and the backdrops, and is absent until published', () => {
    const c = parsePresentation([
      'art:',
      '  space:',
      '    kinds: { "0": art/space/kind0.pack, "9": art/space/kind9.pack }',
      '    effects: art/space/effects.pack',
      '    console: { plate: art/space/console/plate.webp, pack: art/space/console.pack, scale: 4, areas: { view: [319, 23, 320, 220] } }',
      '    backdrops: [art/space/backdrop/plate0.webp]',
    ].join('\n'));
    expect(c.art.space).toEqual({
      kinds: { 0: 'art/space/kind0.pack', 9: 'art/space/kind9.pack' }, effects: 'art/space/effects.pack',
      console: { plate: 'art/space/console/plate.webp', pack: 'art/space/console.pack', scale: 4, areas: { view: [319, 23, 320, 220] } },
      backdrops: ['art/space/backdrop/plate0.webp'],
    });
    expect(parsePresentation('music: {}\n').art.space).toBeUndefined();
    expect(() => parsePresentation('art:\n  space:\n    kinds: { enterprise: a.pack }\n')).toThrow();
    expect(() => parsePresentation('art:\n  space:\n    console: { plate: p.webp, pack: c.pack, scale: 4, areas: { view: [0, 0, 0, 10] } }\n')).toThrow();
    expect(() => parsePresentation('art:\n  space:\n    backdrops: [a, b, c, d, e]\n')).toThrow();
  });
});

describe('presentation.art', () => {
  it('parses rooms and cards with defaults, and refuses unknown keys', () => {
    const c = parsePresentation('art:\n  rooms: { w.s01: { plate: art/p.png } }\n  cards: { picard: { image: art/c.png } }\n');
    expect(c.art.rooms['w.s01']).toEqual({ plate: 'art/p.png', masks: [] });
    expect(c.art.cards.picard).toEqual({ image: 'art/c.png', frames: 1, anchor: [0.5, 1], anims: {} });
    expect(parsePresentation('music: {}\n').art).toEqual({ rooms: {}, cards: {}, ship: {} });
    expect(() => parsePresentation('art:\n  rooms: { w.s01: { plat: x } }\n')).toThrow();
    const m = parsePresentation('art:\n  rooms:\n    w.s01:\n      masks:\n        - { object: w.m, image: art/m.webp, rect: [1, 2, 3, 4], depth: 5 }\n').art.rooms['w.s01']!.masks;
    expect(m).toEqual([{ object: 'w.m', image: 'art/m.webp', rect: [1, 2, 3, 4], depth: 5 }]);
    expect(() => parsePresentation('art:\n  rooms:\n    w.s01:\n      masks: [{ object: w.m, image: a, rect: [1, 2, 3], depth: 5 }]\n')).toThrow();
    expect(() => parsePresentation('art:\n  rooms:\n    w.s01:\n      masks: [{ object: w.m, image: a, rect: [1, 2, 3, 4], depth: 5, z: 1 }]\n')).toThrow();
    expect(() => parsePresentation('art: { extra: 1 }\n')).toThrow();
  });
  it('parses the admin console\'s pictures (art admin publish), and refuses one without SETTINGS', () => {
    const admin = 'art:\n  admin:\n    scale: 4\n    frames: [art/admin/frame0.webp]\n    buttons: { yes: art/admin/yes.webp }\n    final: art/admin/final.webp\n';
    const c = parsePresentation(`${admin}    settings: art/admin/settings.webp\n    settingsLit: art/admin/settingsLit.webp\n    tabs: { tabGame: art/admin/tabGame.webp }\n`);
    expect(c.art.admin?.buttons.yes).toBe('art/admin/yes.webp');
    expect(c.art.admin?.tabs?.tabGame).toBe('art/admin/tabGame.webp');
    expect(() => parsePresentation(admin)).toThrow();
  });

  it('parses a card\'s animations and pixel height (R8, R9), and refuses a loose one', () => {
    const anim = '{ image: art/cards/picard/27.webp, frames: 2, columns: 1, cell: [200, 700], anchor: [0.5, 0.9], delays: [58, 82], next: 78 }';
    const c = parsePresentation(`art:\n  cards:\n    picard: { image: art/c.png, pixelHeight: 166, anims: { '27': ${anim} } }\n`).art.cards.picard!;
    expect(c.pixelHeight).toBe(166);
    expect(c.anims['27']).toEqual({ image: 'art/cards/picard/27.webp', frames: 2, columns: 1, cell: [200, 700], anchor: [0.5, 0.9], delays: [58, 82], loop: true, next: 78 });
    expect(() => parsePresentation(`art:\n  cards:\n    picard: { image: a, anims: { walk: ${anim} } }\n`)).toThrow();
    expect(() => parsePresentation('art:\n  cards:\n    picard: { image: a, anims: { "1": { image: a, frames: 0, cell: [1, 1], anchor: [0, 0], delays: [] } } }\n')).toThrow();
    expect(() => parsePresentation('art:\n  cards:\n    picard: { image: a, pixelHeight: 0 }\n')).toThrow();
    expect(() => parsePresentation('art:\n  cards:\n    picard: { image: a, anims: { "1": { image: a, frames: 1, cell: [1, 1], anchor: [0, 0], delays: [1], z: 1 } } }\n')).toThrow();
  });
});

describe('game packages', () => {
  it('keeps combat.yaml out of the files, as a read for when a battle needs it (M8 spec §8, Plan 24 Task 4)', async () => {
    const lazy = packageFromGlobs({ id: 'mini', base: BASE, yaml, assets, lazyYaml: { [`${BASE}combat.yaml`]: async () => 'kinds: []\n', '../elsewhere/combat.yaml': async () => 'no' } });
    expect(lazy.files.map(f => f.path)).not.toContain('combat.yaml');
    expect(await lazy.combat!()).toBe('kinds: []\n');
    // (a game without one has none)
    expect(pkg.combat).toBeUndefined();
  });

  it('packageFromStrings and packageFromGlobs give equal packages for the demo', async () => {
    // (the demo's files as Vite's globs would key them, and the same text keyed by path within the game, as the deploy's content.pack holds it)
    const root = new URL('../../../tools/play/fixtures/demo/', import.meta.url);
    const base = '../../../../tools/play/fixtures/demo/';
    const paths = (readdirSync(root, { recursive: true }) as string[]).map(p => p.replace(/\\/g, '/')).sort();
    const globYaml: Record<string, string> = {};
    const plain: Record<string, string> = {};
    const media: Record<string, string> = {};
    for (const p of paths) {
      if (p.endsWith('.yaml')) {
        const text = readFileSync(new URL(p, root), 'utf8');
        globYaml[`${base}${p}`] = text;
        plain[p] = text;
      } else if (/^(audio|models|movies)\/.*\./.test(p)) media[`${base}${p}`] = `/assets/${p}`;
    }
    expect(Object.keys(plain)).toContain('game.yaml');
    const combat = async () => 'kinds: []\n';
    const fromGlobs = packageFromGlobs({ id: 'demo', base, yaml: globYaml, assets: media, lazyYaml: { [`${base}combat.yaml`]: combat } });
    const fromStrings = packageFromStrings({ id: 'demo', yaml: plain, assets: AssetIndex.fromGlob(base, media), combat });
    expect(fromStrings).toEqual(fromGlobs);
    expect(fromStrings.combat).toBe(combat);
    expect(parseGame(fromStrings.files).id).toBe('demo');
  });

  it("makes a package from Vite's globs, keeping only the game's directory", () => {
    expect(pkg.files.map(f => f.path).sort()).toEqual([
      'game.yaml', 'objects/panel.yaml', 'objects/picard.yaml', 'presentation.yaml', 'screens/room.yaml', 'voices.yaml',
    ]);
    expect(parseGame(pkg.files).id).toBe('mini');
    expect(pkg.presentation).toEqual({ music: { ship: 'theme' }, ambience: { room: 'hum' }, intro: {}, arrival: {}, sounds: {}, art: { rooms: {}, cards: {}, ship: {} } });
    expect(pkg.voices.resolve('p@01', 'picard')).toBe('p0001');
  });

  it("finds media by Plan 4's layout", () => {
    const a = pkg.assets;
    expect(a.voice('p0001')).toBe('/a/p0001.opus');
    expect(a.voice('nobody')).toBeUndefined();
    expect(a.sound('chime')).toEqual({ url: '/a/chime.opus', bus: 'sfx' });
    expect(a.sound('theme')).toEqual({ url: '/a/theme.ogg', bus: 'music' });
    expect(a.sound('silence')).toBeUndefined();
    expect(a.room('room')).toBe('/a/room.glb');
    expect(a.room('horst3.s01')).toBe('/a/s01.glb');
    expect(a.room('lab')).toBeUndefined();
    expect(a.movie('intro')).toBe('/a/intro.webm');
    expect(new AssetIndex().voice('p0001')).toBeUndefined();
  });

  it("puts the speaker's byte in a voice key, and anyone else's", () => {
    const v = new VoiceTable({ speakers: { picard: '00', data: '02' }, other: 'ff', lines: {} });
    expect(v.resolve('fe@00e7', 'data')).toBe('fe0200e7');
    expect(v.resolve('07t1@10', 'guard')).toBe('07t1ff10');
    expect(v.resolve('0701', 'picard')).toBe('0701');
    expect(VoiceTable.parse(undefined).resolve('a@b', 'picard')).toBe('affb');
  });

  it("picks a screen's own loop, else its world's", () => {
    const c = parseGame(pkg.files);
    expect(loopFor(pkg.presentation.ambience, c, 'room')).toBe('hum');
    expect(loopFor(pkg.presentation.music, c, 'room')).toBe('theme');
    expect(loopFor({}, c, 'room')).toBeUndefined();
  });

  it("lists the audio a screen's objects use, for preloading", () => {
    const c = parseGame(pkg.files);
    expect(screenAudio(c, 'room', pkg.assets, pkg.voices)).toEqual(['/a/chime.opus', '/a/p0001.opus']);
  });
});

describe('the beam-down pieces and the arrival movie', () => {
  it('reads them from presentation.yaml, by the screen\'s world, and defaults them to none', () => {
    const config = parsePresentation('music: { test: hum }\nintro: { test: [p1, p2] }\narrival: { test: arrive }\n');
    const content = makeGame([]);
    expect(introPiece(config, content, 'room')).toBe('p1');
    expect(arrivalMovie(config, content, 'room')).toBe('arrive');
    const plain = parsePresentation('music: { test: hum }\n');
    expect([plain.intro, plain.arrival, introPiece(plain, content, 'room')]).toEqual([{}, {}, undefined]);
  });
});

describe('the opening and the warp movies', () => {
  it('reads their stems from presentation.yaml, with null where a warp movie has no file, and defaults them to absent', () => {
    const config = parsePresentation('opening: [teaser, title]\nwarpMovies: [null, warp1]\n');
    expect(config.opening).toEqual(['teaser', 'title']);
    expect(config.warpMovies).toEqual([null, 'warp1']);
    expect(parsePresentation('music: {}\n').opening).toBeUndefined();
  });
});

describe('the engine\'s own sounds', () => {
  it('reads their stems from presentation.yaml, defaults them to none, and refuses a sound it doesn\'t know', () => {
    expect(parsePresentation('sounds: { combadge: badge, tricorderChirp: chirp }\n').sounds).toEqual({ combadge: 'badge', tricorderChirp: 'chirp' });
    const all = 'sounds: { phaserCrew: a, phaserOther: b, beamIn: c, beamOut: d, beamChodak: e }\n';
    expect(parsePresentation(all).sounds).toEqual({ phaserCrew: 'a', phaserOther: 'b', beamIn: 'c', beamOut: 'd', beamChodak: 'e' });
    expect(parsePresentation('music: {}\n').sounds).toEqual({});
    expect(() => parsePresentation('sounds: { doorbell: ding }\n')).toThrow();
  });
});

describe("the demo's presentation", () => {
  it('names a sound for the combadge, the tricorder, and the phaser Picard fires at the guard, each of which the demo writes', () => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
    const { sounds } = parsePresentation(read('../../../tools/play/fixtures/demo/presentation.yaml'));
    expect(Object.keys(sounds).sort()).toEqual(['combadge', 'phaserCrew', 'tricorderChirp']);
    const assets = read('../../../apps/web/scripts/demo-assets.ts');
    for (const stem of Object.values(sounds)) expect(assets).toContain(`'audio/sfx/${stem}.wav'`);
  });

  it('plays the other loop while the named object is inactive (updateMusic, lab s06), else the screen\'s or world\'s', () => {
    const content = { id: 'mini', screens: { room: { id: 'room', markers: {} } } } as unknown as GameContent;
    const config = parsePresentation('music: { room: theme }\nmusicWhenInactive: { room: { object: probe, music: quiet } }\nloops: { theme: { gain: 0.5, loopStart: 2 } }\n');
    expect(musicFor(config, content, 'room', () => true)).toBe('theme');
    expect(musicFor(config, content, 'room', () => false)).toBe('quiet');
    expect(config.loops?.theme).toEqual({ gain: 0.5, loopStart: 2 });
  });
});
