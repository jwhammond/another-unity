// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as build from './build';
import { buildDirs, musicAudio, unityBuild, wantedAudio, wantedMovies } from './build';

const RUNS = '/runs';
const RAW = '/runs/export/raw';
const all = (paths: string[]) => (p: string) => paths.includes(p);

const made: string[] = [];
afterEach(async () => {
  await Promise.all(made.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function liftedGame(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'unitybuild-'));
  made.push(dir);
  await mkdir(join(dir, 'objects/horst3'), { recursive: true });
  await writeFile(join(dir, 'voices.yaml'), 'speakers: { picard: "00" }\nother: ff\nlines:\n  fe@00e6: "…"\n  0701@10: "…"\n');
  await writeFile(join(dir, 'presentation.yaml'), 'music: { horst3: h3amb01 }\nambience: {}\nintro: { horst3: [h3int01, h3int02] }\narrival: { horst3: ho3arriv }\nsounds: { combadge: combadge, tricorderChirp: tricordr, phaserCrew: hphaser, phaserOther: c_phaser, beamIn: beamin, beamOut: beamout, beamChodak: acid }\n');
  await writeFile(join(dir, 'objects/horst3/rubble.yaml'), 'id: horst3.rubble\non:\n  use:\n    - do:\n        - play: { sound: beep7 }\n');
  return dir;
}

describe('buildDirs', () => {
  it('needs RAW_DIR, and an export there', () => {
    expect(buildDirs({})).toMatch(/^set RAW_DIR to Plan 3's export/);
    expect(buildDirs({ RAW_DIR: RAW }, all([]))).toBe(`${RAW} has no manifest.json: is it Plan 3's export?`);
  });

  it('finds the media exports beside the raw export, or leaves them out', () => {
    const exists = all([`${RAW}/manifest.json`, `${RUNS}/audio/media`, `${RUNS}/images/media`]);
    expect(buildDirs({ RAW_DIR: RAW, GAME_DIR: '/g' }, exists)).toEqual({
      raw: RAW, audio: `${RUNS}/audio/media`, images: `${RUNS}/images/media`, movies: null, game: '/g',
    });
    expect(buildDirs({ RAW_DIR: RAW, GAME_DIR: '/g', AUDIO_DIR: '/a' }, all([`${RAW}/manifest.json`, '/a']))).toMatchObject({ audio: '/a', images: null });
  });
});

describe('wantedAudio', () => {
  it('matches every lifted voice for any speaker, every play.sound, music loop and beam-down piece, and the engine\'s own sounds', async () => {
    const re = await wantedAudio(await liftedGame());
    for (const name of ['fe0000e6.vac', 'fe0300e6.vac', '07010010.vac', 'beep7.mac', 'h3amb01.rac', 'h3int02.rac', 'combadge.rac', 'tricordr.rac', 'hphaser.rac', 'c_phaser.mac', 'beamin.rac', 'beamout.rac', 'acid.rac']) {
      expect(name).toMatch(re);
    }
    for (const name of ['fe0000e7.vac', 'h3amb02.rac', 'xbeep7.mac', 'fe0000e6.vacx']) expect(name).not.toMatch(re);
  });

  it('takes a stem YAML reads as a number as its text, and skips one that isn\'t a name', async () => {
    const game = await liftedGame();
    await writeFile(join(game, 'presentation.yaml'), 'music: { horst3: 1234 }\nambience: { horst3: null }\nintro: { horst3: [h3int01, 99, { a: 1 }] }\n');
    const re = await wantedAudio(game);
    for (const name of ['1234.rac', '99.rac', 'h3int01.rac']) expect(name).toMatch(re);
    for (const name of ['null.rac', '.rac']) expect(name).not.toMatch(re);
  });

  it('takes the engine\'s own sounds from presentation.yaml\'s sounds, not a list of its own', async () => {
    const game = await liftedGame();
    await writeFile(join(game, 'presentation.yaml'), 'sounds: { combadge: badge2, tricorderChirp: chirp9 }\n');
    const re = await wantedAudio(game);
    for (const name of ['badge2.rac', 'chirp9.mac']) expect(name).toMatch(re);
    for (const name of ['combadge.rac', 'tricordr.rac']) expect(name).not.toMatch(re);
    expect('UI_SOUNDS' in build).toBe(false);
  });

  it('takes the ship screens\' sounds and music from presentation.yaml, and the computer\'s voice for each crew member from ship.yaml', async () => {
    const game = await liftedGame();
    await writeFile(join(game, 'presentation.yaml'), 'shipSounds: { shipBeep: beep7, computerOnline: fe090081 }\nshipMusic: { bridge: bridgamb, astrogation: astro }\n');
    await writeFile(join(game, 'ship.yaml'), 'crew:\n  leaderOrder: [picard]\n  voices: [180, 181, 15]\n');
    const re = await wantedAudio(game);
    for (const name of ['beep7.mac', 'fe090081.vac', 'bridgamb.rac', 'astro.rac', 'fe0900b4.vac', 'fe0900b5.vac', 'fe09000f.vac']) expect(name).toMatch(re);
    for (const name of ['fe0900b6.vac', 'compute.rac']) expect(name).not.toMatch(re);
  });

  it('matches the loop a screen plays while an object is inactive', async () => {
    const game = await liftedGame();
    await writeFile(join(game, 'presentation.yaml'), 'music: { lab: hum1 }\nmusicWhenInactive: { lab.s06: { object: lab.thing, music: hum2 } }\n');
    const re = await wantedAudio(game);
    for (const name of ['hum1.rac', 'hum2.rac']) expect(name).toMatch(re);
  });
  it('takes space combat\'s music, effects and cues from combat.yaml (Plan 18)', async () => {
    const game = await liftedGame();
    await writeFile(join(game, 'combat.yaml'), 'media: { music: enterpri.rac, sounds: [0_explo.mac, __phaser.mac] }\ncues: [{ speaker: 2, file: fe1a0001.vac, gap: 0 }, { speaker: 0, file: null, gap: 0 }]\n');
    const re = await wantedAudio(game);
    for (const name of ['enterpri.rac', '0_explo.mac', '__phaser.mac', 'fe1a0001.vac']) expect(name).toMatch(re);
    expect('1_explo.mac').not.toMatch(re);
  });
});

describe('musicAudio', () => {
  it('matches what the game plays as music (its loops, beam-down pieces, ship music and combat music), not its effects, stereo or not', async () => {
    const game = await liftedGame();
    await writeFile(join(game, 'presentation.yaml'), 'music: { horst3: h3amb01 }\nambience: { lab: hum1 }\nintro: { horst3: [h3int01, h3int02] }\n'
      + 'shipMusic: { bridge: bridgamb }\nmusicWhenInactive: { lab.s06: { object: lab.thing, music: hum2 } }\nsounds: { beamIn: beamin, tricorderChirp: tricordr }\n');
    await writeFile(join(game, 'combat.yaml'), 'media: { music: enterpri.rac, sounds: [0_explo.mac] }\n');
    const re = await musicAudio(game);
    for (const name of ['h3amb01.rac', 'hum1.rac', 'h3int02.rac', 'bridgamb.rac', 'hum2.rac', 'enterpri.rac']) expect(name).toMatch(re);
    for (const name of ['beamin.rac', 'tricordr.rac', '0_explo.mac', 'h3amb01.vac']) expect(name).not.toMatch(re);
  });
});

describe('wantedMovies', () => {
  it('names each arrival movie and each play.movie, not a missing movie\'s number', async () => {
    const game = await liftedGame();
    await writeFile(join(game, 'objects/horst3/screen.yaml'),
      'id: horst3.screen\non:\n  use:\n    - do:\n        - play: { movie: Film7 }\n        - missing: { kind: movie, id: "42" }\n');
    expect(await wantedMovies(game)).toEqual(['film7', 'ho3arriv']);
  });

  it('names the opening and the warp movies, but not a warp movie with no file', async () => {
    const game = await liftedGame();
    await writeFile(join(game, 'presentation.yaml'), 'arrival: { horst3: ho3arriv }\nopening: [teaser, title]\nwarpMovies: [null, warpout1, null]\n');
    expect(await wantedMovies(game)).toEqual(['ho3arriv', 'teaser', 'title', 'warpout1']);
  });
});

describe('unityBuild', () => {
  it('says which named movies have no WebM, and still finishes', async () => {
    const game = await liftedGame();
    const log: string[] = [];
    const exists = (p: string) => [`${RAW}/manifest.json`, `${RUNS}/audio/media`, `${RUNS}/movies/media`].includes(p);
    const code = await unityBuild({ RAW_DIR: RAW, GAME_DIR: game }, async () => 0, l => log.push(l), exists);
    expect(code).toBe(0);
    expect(log).toContain('unity:build: 1 movie the game names has no WebM (ho3arriv): export it with sh tools/rawcheck/run-harness.sh movies 1800, then build again');
    expect(log.at(-1)).toBe('unity:build: done');
  });

  it('lifts, transcodes what the lift names, and builds the rooms, in that order', async () => {
    const game = await liftedGame();
    const runs: string[][] = [];
    const log: string[] = [];
    const exists = (p: string) => [`${RAW}/manifest.json`, `${RUNS}/audio/media`, `${RUNS}/images/media`, `${RUNS}/movies/media`].includes(p);
    const code = await unityBuild({ RAW_DIR: RAW, GAME_DIR: game }, async argv => { runs.push(argv); return 0; }, l => log.push(l), exists);
    expect(code).toBe(0);
    expect(runs.map(r => r.slice(0, 3).join(' '))).toEqual([
      'npx tsx tools/lift/src/cli.ts', 'ffmpeg -version', 'npx tsx tools/media/src/cli.ts', 'npx tsx tools/greybox/src/cli.ts',
    ]);
    expect(runs[0]).toEqual(['npx', 'tsx', 'tools/lift/src/cli.ts', '--raw', RAW, '--world', 'all-away', '--out', game,
      '--images', `${RUNS}/images/media`, '--audio', `${RUNS}/audio/media`]);
    const media = runs[2];
    expect(media.slice(3, 9)).toEqual(['--audio', `${RUNS}/audio/media`, '--movies', `${RUNS}/movies/media`, '--out', game]);
    expect('h3amb01.rac').toMatch(new RegExp(media[media.indexOf('--filter') + 1]));
    const music = new RegExp(media[media.indexOf('--music') + 1]);
    expect('h3amb01.rac').toMatch(music);
    expect('beamin.rac').not.toMatch(music);
    expect(runs[3]).toEqual(['npx', 'tsx', 'tools/greybox/src/cli.ts', '--rooms', join(game, 'rooms'),
      '--images', `${RUNS}/images/media`, '--out', join(game, 'models', 'rooms')]);
    expect(log.at(-1)).toBe('unity:build: done');
  });

  it('skips the transcode without an audio export, and says the game plays silent', async () => {
    const game = await liftedGame();
    const runs: string[][] = [];
    const log: string[] = [];
    await unityBuild({ RAW_DIR: RAW, GAME_DIR: game }, async argv => { runs.push(argv); return 0; }, l => log.push(l), all([`${RAW}/manifest.json`]));
    expect(runs.map(r => r[2])).toEqual(['tools/lift/src/cli.ts', 'tools/greybox/src/cli.ts']);
    expect(log).toContain('unity:build: no audio export (set AUDIO_DIR, or make …/runs/audio/media with Plan 3\'s export_audio): the game plays silent');
  });

  it('skips the transcode without ffmpeg but still builds the rooms, then fails; and stops at the first step that fails', async () => {
    const game = await liftedGame();
    const exists = all([`${RAW}/manifest.json`, `${RUNS}/audio/media`]);
    const log: string[] = [];
    const ran: string[][] = [];
    expect(await unityBuild({ RAW_DIR: RAW, GAME_DIR: game }, async argv => { ran.push(argv); return argv[0] === 'ffmpeg' ? 127 : 0; }, l => log.push(l), exists)).toBe(1);
    expect(ran.map(r => r[2] ?? r[0])).toEqual(['tools/lift/src/cli.ts', 'ffmpeg', 'tools/greybox/src/cli.ts']);
    expect(log).toContain('unity:build: ffmpeg isn\'t installed (brew install ffmpeg): skipping the audio transcode');
    expect(log.at(-1)).toBe('unity:build: built without audio, as ffmpeg isn\'t installed (brew install ffmpeg)');
    const runs: string[][] = [];
    expect(await unityBuild({ RAW_DIR: RAW, GAME_DIR: game }, async argv => { runs.push(argv); return 1; }, () => {}, exists)).toBe(1);
    expect(runs).toHaveLength(1);
  });

  it('builds space combat\'s models last, when the lift wrote combat.yaml', async () => {
    const game = await liftedGame();
    const runs: string[][] = [];
    const exists = all([`${RAW}/manifest.json`, join(game, 'combat.yaml')]);
    expect(await unityBuild({ RAW_DIR: RAW, GAME_DIR: game }, async argv => { runs.push(argv); return 0; }, () => {}, exists)).toBe(0);
    expect(runs.at(-1)).toEqual(['npx', 'tsx', 'tools/space/src/cli.ts', '--raw', RAW, '--game', game]);
  });

  it('gives the space build the images export, for combat\'s sprites (Plan 24)', async () => {
    const game = await liftedGame();
    const runs: string[][] = [];
    const exists = all([`${RAW}/manifest.json`, `${RUNS}/images/media`, join(game, 'combat.yaml')]);
    expect(await unityBuild({ RAW_DIR: RAW, GAME_DIR: game }, async argv => { runs.push(argv); return 0; }, () => {}, exists)).toBe(0);
    expect(runs.at(-1)).toEqual(['npx', 'tsx', 'tools/space/src/cli.ts', '--raw', RAW, '--game', game, '--images', `${RUNS}/images/media`]);
  });

  it('won\'t start without RAW_DIR', async () => {
    const log: string[] = [];
    expect(await unityBuild({}, async () => 0, l => log.push(l))).toBe(2);
    expect(log[0]).toMatch(/^unity:build: set RAW_DIR/);
  });
});
