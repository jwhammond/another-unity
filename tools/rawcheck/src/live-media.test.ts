// SPDX-License-Identifier: GPL-3.0-or-later
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { pngInfo, readHead, wavInfo } from './media';
import { readJson } from './raw';

// AUDIO_DIR=$HOME/pcode/unity-raw/runs/audio/media
const AUDIO = process.env.AUDIO_DIR ?? '';

const AudioManifest = z.object({
  files: z.array(z.object({ name: z.string(), wav: z.string(), channels: z.number(), rate: z.number(), frames: z.number() }).strict()),
}).strict();

describe.skipIf(!AUDIO)('the decoded sounds', () => {
  it('decodes all 10354 sounds to WAVs that match the manifest', async () => {
    const files = AudioManifest.parse(await readJson(AUDIO, 'audio/manifest.json')).files;
    expect(files).toHaveLength(10354);
    for (const f of files) {
      const { head, size } = await readHead(join(AUDIO, f.wav), 44);
      expect(wavInfo(head, size)).toEqual({ channels: f.channels, rate: 22050, frames: f.frames });
      expect(f.frames).toBeGreaterThan(0);
    }
  }, 300_000);

  it('plays music in stereo and everything else in mono', async () => {
    const files = AudioManifest.parse(await readJson(AUDIO, 'audio/manifest.json')).files;
    const channels = (name: string) => files.find(f => f.name === name)?.channels;
    expect(channels('fe0000e6.vac')).toBe(1); // Picard on the rubble
    expect(channels('tricordr.rac')).toBe(1);
    expect(channels('h3amb01.rac')).toBe(2); // Horst III's ambience
  });
});

// IMAGES_DIR=$HOME/pcode/unity-raw/runs/images/media (export_images ... 7)
const IMAGES = process.env.IMAGES_DIR ?? '';

const ImagesManifest = z.object({
  backgrounds: z.array(z.object({ screen: z.string(), file: z.string(), png: z.string() }).strict()),
  sprites: z.array(z.object({ file: z.string(), json: z.string(), palette: z.string(), frames: z.number() }).strict()),
}).strict();
const SpriteJson = z.object({
  file: z.string(), palette: z.string(), anims: z.array(z.number()),
  entries: z.array(z.object({ type: z.string() }).passthrough()),
}).strict();

describe.skipIf(!IMAGES)('the Horst III images', () => {
  it('writes each located screen\'s background at 640x480', async () => {
    const m = ImagesManifest.parse(await readJson(IMAGES, 'images/manifest.json'));
    // (the export covers every world's screens now, Horst III's among them)
    expect(m.backgrounds.map(b => b.screen)).toEqual(expect.arrayContaining(['s_0701', 's_0702', 's_0703', 's_0704']));
    for (const b of m.backgrounds) {
      const { head } = await readHead(join(IMAGES, b.png), 24);
      expect(pngInfo(head)).toEqual({ width: 640, height: 480 });
    }
  });

  it('writes the screens\' sprites, every frame at its size, in the screen\'s palette', async () => {
    const m = ImagesManifest.parse(await readJson(IMAGES, 'images/manifest.json'));
    expect(m.sprites.length).toBeGreaterThan(0);
    expect(m.sprites.some(s => s.palette === 's_0701')).toBe(true);
    for (const s of m.sprites) {
      const sprite = SpriteJson.parse(await readJson(IMAGES, s.json));
      let frames = 0;
      for (const e of sprite.entries) {
        if (e.type !== 'sprite' && e.type !== 'speechSprite') continue;
        const { png, width, height } = e as unknown as { png?: string; width: number; height: number };
        if (!width || !height) {
          expect(png).toBeUndefined(); // (no file is written for an empty frame)
          continue;
        }
        frames++;
        const { head } = await readHead(join(IMAGES, png as string), 24);
        expect(pngInfo(head)).toEqual({ width, height });
      }
      expect(frames).toBe(s.frames);
    }
  }, 120_000);

  it('colours space combat\'s sprites in the space palette, and leaves the rest alone (Plan 18 Task 3)', async () => {
    const m = ImagesManifest.parse(await readJson(IMAGES, 'images/manifest.json'));
    const combat = m.sprites.filter(s => /^._(?:boom|phaser|photon|shield)\.spr$/i.test(s.file));
    expect(combat.map(s => s.file.toLowerCase())).toEqual(expect.arrayContaining(['__boom.spr', '1_boom.spr', '__phaser.spr', '__photon.spr', '__shield.spr', 'k_shield.spr']));
    for (const s of combat) expect(s.palette).toBe('space');
    // (the 3d* copies aren't loaded by combat, so they keep the standard palette)
    expect(m.sprites.find(s => s.file.toLowerCase() === '3dboom.spr')?.palette).toBe('standard');
  });

  it('colours the warp overlay\'s sprites in cheap.pic\'s palette, as showWarp draws them (Plan 24 Task 1)', async () => {
    const m = ImagesManifest.parse(await readJson(IMAGES, 'images/manifest.json'));
    const warp = m.sprites.filter(s => ['viewscan.spr', 'viewscr.spr', 'vwwarped.spr'].includes(s.file.toLowerCase()));
    expect(warp.map(s => [s.file.toLowerCase(), s.palette])).toEqual([['viewscan.spr', 'cheap'], ['viewscr.spr', 'cheap'], ['vwwarped.spr', 'cheap']]);
    // (another sprite no screen shows keeps the standard half)
    expect(m.sprites.find(s => s.file.toLowerCase() === '3dboom.spr')?.palette).toBe('standard');
  });
});

// IMAGES_STATE_LOGS=$HOME/pcode/unity-raw/runs/imagestate/out.log:$HOME/pcode/unity-raw/runs/imagesearly/out.log
// (each runs gfx_state, export_images 7, gfx_state)
const STATE_LOGS = (process.env.IMAGES_STATE_LOGS ?? '').split(':').filter(Boolean);

describe.skipIf(STATE_LOGS.length === 0)('export_images', () => {
  it.each(STATE_LOGS)('leaves the palette and background as they were (%s)', async (log) => {
    const states = (await readFile(log, 'utf8')).split('\n').filter(l => l.startsWith('gfx_state: '));
    expect(states).toHaveLength(2);
    expect(states[1]).toBe(states[0]);
    expect(states[0]).toMatch(/^gfx_state: palette=\w+ background=\S+ hardware=\w+$/);
  });
});

// MOVIES_DIR=$HOME/pcode/unity-raw/runs/movies/media (export_movies ... 55)
const MOVIES = process.env.MOVIES_DIR ?? '';

const MovieJson = z.object({
  id: z.number(), file: z.string(), description: z.string(), width: z.number(), height: z.number(),
  frameRate: z.tuple([z.number(), z.number()]), frames: z.number(), audioRate: z.number(), audioFrames: z.number(),
}).strict();

describe.skipIf(!MOVIES)('the Horst III arrival movie', () => {
  it('writes every frame, and the sound', async () => {
    const movie = MovieJson.parse(await readJson(MOVIES, 'movies/55/movie.json'));
    expect(movie.file).toBe('ho3arriv.fvf');
    expect(movie.frames).toBeGreaterThan(0);
    const frames = (await readdir(join(MOVIES, 'movies/55/frames'))).filter(f => f.endsWith('.png')).sort();
    expect(frames).toHaveLength(movie.frames);
    expect(frames[0]).toBe('00000.png');
    const { head } = await readHead(join(MOVIES, 'movies/55/frames', frames[0]), 24);
    expect(pngInfo(head)).toEqual({ width: movie.width, height: movie.height });
    const wav = await readHead(join(MOVIES, 'movies/55/audio.wav'), 44);
    expect(wavInfo(wav.head, wav.size)).toEqual({ channels: 1, rate: movie.audioRate, frames: movie.audioFrames });
    expect(movie.audioFrames).toBeGreaterThan(0);
  });
});
