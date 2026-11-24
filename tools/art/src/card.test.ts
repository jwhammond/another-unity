// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createHash } from 'node:crypto';
import { artCache } from './cache';
import { alphaAt, makeCard, upscaledAlphaKey, publishCard, publishStrips, writeCardMeta, type MadeStrips } from './card';
import { decodePng, encodePng, type Rgba } from './image';
import type { Generator, Job } from './generator';
import { FakeGenerator } from './testing/fakeGenerator';

let tmp = '';
afterEach(() => rm(tmp, { recursive: true, force: true }));

// a 6x8 frame: an opaque 4x6 block on a clear ground, ground pixels carrying junk colour
const frame = (): Uint8Array => {
  const data = new Uint8Array(6 * 8 * 4);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 6; x++) {
      const solid = x >= 1 && x < 5 && y >= 1 && y < 7;
      data.set(solid ? [200, 50, 50, 255] : [0, 255, 0, 0], (y * 6 + x) * 4);
    }
  }
  return encodePng({ width: 6, height: 8, data });
};

describe('makeCard', () => {
  it('upscales the colours 4x through the upscaler, gives clear pixels no junk colour, and keeps a crisp alpha', async () => {
    const g = new FakeGenerator([10, 20, 30, 255]);
    const out = decodePng(await makeCard(g, { upscaler: 'up.pth' }, frame()));
    expect(out).toMatchObject({ width: 24, height: 32 });
    expect(g.jobs).toHaveLength(1);
    const sent = decodePng(g.jobs[0]!.inputs['card-in']!);
    expect([...sent.data.slice(0, 4)]).toEqual([200, 50, 50, 255]);
    const at = (x: number, y: number) => out.data[(y * 24 + x) * 4 + 3]!;
    expect(at(12, 16)).toBe(255);
    expect(at(0, 0)).toBe(0);
    expect(at(23, 31)).toBe(0);
    // (colour comes from the upscaler)
    expect([...out.data.slice(12 * 4 + 16 * 24 * 4, 12 * 4 + 16 * 24 * 4 + 3)]).toEqual([10, 20, 30]);
  });
});

/** An upscaler that repeats each pixel 4x4 (the worst case: it keeps every 1x step), recording what it was sent. */
class NearestUpscaler implements Generator {
  readonly sent: string[] = [];
  async run(job: Job): Promise<Record<string, Uint8Array>> {
    const [name, bytes] = Object.entries(job.inputs)[0]!;
    this.sent.push(name);
    const f = decodePng(bytes);
    const out: Rgba = { width: f.width * 4, height: f.height * 4, data: new Uint8Array(f.width * 16 * f.height * 4) };
    for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) out.data.set(f.data.subarray((Math.floor(y / 4) * f.width + Math.floor(x / 4)) * 4, (Math.floor(y / 4) * f.width + Math.floor(x / 4)) * 4 + 4), (y * out.width + x) * 4);
    return { image: encodePng(out) };
  }
  async info() { return { comfyui: 'fake', torch: 'fake', device: 'fake', vramTotal: 0 }; }
  async nodeTypes() { return new Set<string>(); }
}

/**
 * Edge smoothness: along each card row, where the alpha crosses half (interpolated), then how far those crossings stray from the straight
 * line through them. A 1x staircase drawn at 4x strays by up to 1.5 card pixels (a 4-pixel step); a smooth edge by a fraction of one.
 */
function edgeStray(alpha: (x: number, y: number) => number, width: number, rows: number[]): number {
  const xs = rows.map(y => {
    for (let x = 1; x < width; x++) {
      const a = alpha(x - 1, y);
      const b = alpha(x, y);
      if (a >= 128 && b < 128) return x - 1 + (a - 128) / (a - b);
    }
    throw new Error(`row ${y} has no edge`);
  });
  const n = rows.length;
  const my = rows.reduce((s, v) => s + v, 0) / n;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const slope = rows.reduce((s, y, i) => s + (y - my) * (xs[i]! - mx), 0) / rows.reduce((s, y) => s + (y - my) ** 2, 0);
  return Math.max(...rows.map((y, i) => Math.abs(xs[i]! - (mx + slope * (y - my)))));
}

describe('makeCard, alpha upscaled', () => {
  // (a 24x24 frame: opaque left of a shallow staircase, x < 6 + y / 2, the steps of a sleeve's edge at 1x)
  const stairs = (): Rgba => {
    const img: Rgba = { width: 24, height: 24, data: new Uint8Array(24 * 24 * 4) };
    for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) if (x < 6 + Math.floor(y / 2)) img.data.set([200, 50, 50, 255], (y * 24 + x) * 4);
    return img;
  };
  const rows = Array.from({ length: 48 }, (_, i) => 24 + i);

  it('the 4x alpha has no 1x stair-steps', async () => {
    const g = new NearestUpscaler();
    const out = decodePng(await makeCard(g, { upscaler: 'up.pth' }, encodePng(stairs()), 'in', { alpha: 'upscaled' }));
    expect(g.sent).toEqual(['in']);                             // (one job: the frame and its mask side by side)
    const a = (x: number, y: number): number => out.data[(y * out.width + x) * 4 + 3]!;
    expect(edgeStray(a, out.width, rows)).toBeLessThan(0.5);
    // (the measure sees the steps the 1x mask resampled leaves)
    const src = stairs();
    expect(edgeStray((x, y) => alphaAt(src, (x + 0.5) / 4 - 0.5, (y + 0.5) / 4 - 0.5), 96, rows)).toBeGreaterThan(1);
    // (inside and outside stay whole)
    expect(a(4, 50)).toBe(255);
    expect(a(90, 50)).toBe(0);
  });

  it('puts a vertical edge exactly where the 1x edge is, at 4x', async () => {
    // (opaque left of x = 6 at 1x: at 4x the alpha crosses half at x = 24, between card pixels 23 and 24, whose centres are 23.5 and 24.5)
    const img: Rgba = { width: 12, height: 12, data: new Uint8Array(12 * 12 * 4) };
    for (let y = 0; y < 12; y++) for (let x = 0; x < 6; x++) img.data.set([200, 50, 50, 255], (y * 12 + x) * 4);
    const out = decodePng(await makeCard(new NearestUpscaler(), { upscaler: 'up.pth' }, encodePng(img), 'in', { alpha: 'upscaled' }));
    for (const y of [4, 24, 43]) {
      const a = (x: number): number => out.data[(y * 48 + x) * 4 + 3]!;
      let x = 1;
      while (!(a(x - 1) >= 127.5 && a(x) < 127.5)) x++;
      const crossing = x - 1 + 0.5 + (a(x - 1) - 127.5) / (a(x - 1) - a(x));
      expect(crossing).toBeCloseTo(24, 1);
    }
  });

  it('names what shapes the edge in the cache key', () => {
    expect(upscaledAlphaKey()).toMatch(/sigma2\.5.*feather0\.15/);
  });

  it('keeps a one-pixel line', async () => {
    const img: Rgba = { width: 12, height: 12, data: new Uint8Array(12 * 12 * 4) };
    for (let y = 0; y < 12; y++) img.data.set([200, 50, 50, 255], (y * 12 + 6) * 4);
    const out = decodePng(await makeCard(new NearestUpscaler(), { upscaler: 'up.pth' }, encodePng(img), 'in', { alpha: 'upscaled' }));
    expect(out.data[(24 * 48 + 26) * 4 + 3]).toBeGreaterThan(128);
    expect(out.data[(24 * 48 + 20) * 4 + 3]).toBe(0);
  });

  it('keeps the colour a clear pixel was given, and the mean only for one given none', async () => {
    const g = new NearestUpscaler();
    const img: Rgba = { width: 6, height: 2, data: new Uint8Array(6 * 2 * 4) };
    for (let y = 0; y < 2; y++) (img.data.set([200, 50, 50, 255], (y * 6) * 4), img.data.set([190, 60, 60, 0], (y * 6 + 1) * 4));
    const out = decodePng(await makeCard(g, { upscaler: 'up.pth' }, encodePng(img), 'in', { alpha: 'upscaled' }));
    expect([...out.data.slice(4 * 4, 4 * 4 + 3)]).toEqual([190, 60, 60]);
    expect([...out.data.slice(20 * 4, 20 * 4 + 3)]).toEqual([200, 50, 50]);
  });
});

describe('publishCard', () => {
  it('writes art/cards/<object>.png and sets art.cards, keeping the header and other keys', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'card-'));
    await writeFile(join(tmp, 'presentation.yaml'), '# header\nmusic:\n  w: a\nart:\n  rooms:\n    w.s01:\n      plate: art/p.png\n');
    const { file } = await publishCard(tmp, 'la_forge', new Uint8Array([1, 2, 3]));
    expect(file).toBe('art/cards/la_forge.png');
    expect([...(await readFile(join(tmp, file)))]).toEqual([1, 2, 3]);
    const text = await readFile(join(tmp, 'presentation.yaml'), 'utf8');
    expect(text.startsWith('# header')).toBe(true);
    expect(parse(text)).toEqual({
      music: { w: 'a' },
      art: { rooms: { 'w.s01': { plate: 'art/p.png' } }, cards: { la_forge: { image: file, frames: 1, anchor: [0.5, 1] } } },
    });
    await expect(publishCard(tmp, '../x', new Uint8Array())).rejects.toThrow(/object id/);
  });
});

describe('writeCardMeta', () => {
  it("writes work/cards/<object>/<stamp>/meta.json with the model hashes, the frame's sha256 and the versions", async () => {
    tmp = await mkdtemp(join(tmpdir(), 'card-meta-'));
    const cache = artCache({ ART_CACHE: tmp });
    const f = frame();
    const dir = await writeCardMeta(cache, 'obj', { models: { up: { file: 'upscale_models/up.pth', sha256: 'abc' } }, frame: f, card: new Uint8Array([1]), comfyui: '0.41.3', torch: '2.x', now: 1_700_000_000_000 });
    expect(dir).toBe(join(cache.work, 'cards', 'obj', '2023-11-14T22-13-20-000Z'));
    const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
    expect(meta).toMatchObject({ object: 'obj', models: { up: { sha256: 'abc' } }, comfyui: '0.41.3', frameSha256: createHash('sha256').update(f).digest('hex') });
  });
});

describe('makeStrips', () => {
  it('uploads each frame under a name of its own, not the shared card-in', async () => {
    const { makeStrips, STRIP_INPUT } = await import('./card');
    const g = new FakeGenerator([10, 20, 30, 255]);
    const sprite = { anims: [0], entries: [{ type: 'sprite', width: 6, height: 8, png: 'f.png' }, { type: 'exit' }] };
    await makeStrips(g, { upscaler: 'up.pth' }, sprite, async () => frame(), { shadowColours: [], roots: [0] });
    expect(STRIP_INPUT).toMatch(/^card-in-\d+-/);
    expect(g.jobs.length).toBeGreaterThan(0);
    for (const j of g.jobs) expect(Object.keys(j.inputs)).toEqual([STRIP_INPUT]);
  });
});

describe('publishStrips', () => {
  const made = (pixelHeight: number): MadeStrips => {
    const strip = { width: 8, height: 4, data: new Uint8Array(8 * 4 * 4) };
    return {
      anims: new Map([[0, { strip, original: strip, frames: 2, columns: 2, cell: [4, 4] as [number, number], anchor: [0.5, 1] as [number, number], delays: [100, 100], loop: false }]]),
      alias: new Map([[0, 0]]), pixelHeight, shadowPixels: 0, frames: 2,
    };
  };
  const enc = async (_png: string, out: string): Promise<void> => { await writeFile(out, new Uint8Array([1])); };

  it("writes each animation's strip and its entry; an effect's sprite has no standing frame, so no pixelHeight (the schema takes a positive one or none)", async () => {
    tmp = await mkdtemp(join(tmpdir(), 'strips-'));
    await writeFile(join(tmp, 'presentation.yaml'), 'art:\n  cards: {}\n');
    expect(await publishStrips(tmp, 'beam_effect', made(0), enc)).toEqual(['art/cards/beam_effect/0.webp']);
    const card = parse(await readFile(join(tmp, 'presentation.yaml'), 'utf8')).art.cards.beam_effect;
    expect(card).not.toHaveProperty('pixelHeight');
    expect(card.anims['0']).toMatchObject({ image: 'art/cards/beam_effect/0.webp', frames: 2, cell: [4, 4], delays: [100, 100], loop: false });
    await publishStrips(tmp, 'picard', made(168), enc);
    expect(parse(await readFile(join(tmp, 'presentation.yaml'), 'utf8')).art.cards.picard.pixelHeight).toBe(168);
    // (published again with none: a height the card had stays)
    await publishStrips(tmp, 'picard', made(0), enc);
    expect(parse(await readFile(join(tmp, 'presentation.yaml'), 'utf8')).art.cards.picard.pixelHeight).toBe(168);
  });
});
