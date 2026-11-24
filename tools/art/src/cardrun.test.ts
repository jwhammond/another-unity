// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { publishAnimStrip, type MadeAnim } from './card';
import { readFileSync } from 'node:fs';
import { animCoreText, animKey, cells, propSprite, recipeAnims, seedFor, siblingEdge, stillOf, stripOf, uniqueCells } from './cardrun';
import { readStripPack } from './layer';
import { parseRecipe } from './recipe';
import { encodePng, type Rgba } from './image';
import type { SpriteJson } from './sprites';

let tmp = '';
afterEach(() => rm(tmp, { recursive: true, force: true }));

describe('cells and stripOf', () => {
  it('cut a wrapped strip into cells and put them back', () => {
    const strip: Rgba = { width: 6, height: 4, data: new Uint8Array(6 * 4 * 4).map((_, i) => i % 251) };
    const c = cells(strip, 5, [2, 2], 3);
    expect(c).toHaveLength(5);
    expect(c[3]!.data.slice(0, 4)).toEqual(strip.data.slice((2 * 6 + 0) * 4, (2 * 6 + 0) * 4 + 4));
    const back = stripOf(c, [2, 2], 3);
    expect(back.width).toBe(6);
    expect(back.height).toBe(4);
    // (the sixth cell is empty)
    expect([...back.data.slice(0, 12 * 4)]).toEqual([...strip.data.slice(0, 12 * 4)]);
  });
});

describe('animKey', () => {
  const parts = { models: ['a:1'], references: ['r:2'], sprite: 's', pins: 'p' };
  it('changes with the recipe, the animation, a reference, a model and the sprite, not with their order', () => {
    const k = animKey('recipe', 6, parts);
    expect(animKey('recipe', 6, { ...parts, models: ['a:1'] })).toBe(k);
    expect(animKey('recipe2', 6, parts)).not.toBe(k);
    expect(animKey('recipe', 7, parts)).not.toBe(k);
    expect(animKey('recipe', 6, { ...parts, references: ['r:3'] })).not.toBe(k);
    expect(animKey('recipe', 6, { ...parts, models: ['a:2'] })).not.toBe(k);
    expect(animKey('recipe', 6, { ...parts, sprite: 't' })).not.toBe(k);
  });
});

describe('seedOverrides', () => {
  const text = (over: string) => `id: card.x
kind: card
object: x
sprite: x.spr
sampling: { seed: 100, steps: 20, cfg: 5, sampler: dpmpp_2m, scheduler: karras }
prompt: a figure
denoise: 0.45
${over}`;
  it('gives an animation its own seed, in its key, and leaves the others\' keys as they were', () => {
    const plain = parseRecipe(text(''), 'card.x.yaml');
    const swept = parseRecipe(text('seedOverrides: { "6": 130 }\n'), 'card.x.yaml');
    if (plain.kind !== 'card' || swept.kind !== 'card') throw new Error('not a card');
    expect(seedFor(swept, 6)).toBe(130);
    expect(seedFor(swept, 7)).toBe(100);
    expect(seedFor(plain, 6)).toBe(100);
    // (the override line is not part of any animation's text; the overridden animation's seed is)
    expect(animCoreText(text('seedOverrides: { "6": 130 }\n'), swept, 7)).toBe(animCoreText(text(''), plain, 7));
    expect(animCoreText(text('seedOverrides: { "6": 130 }\n'), swept, 6)).not.toBe(animCoreText(text(''), plain, 6));
    expect(animCoreText(text('seedOverrides: { "6": 131 }\n'), { ...swept, seedOverrides: { '6': 131 } }, 6)).not.toBe(animCoreText(text('seedOverrides: { "6": 130 }\n'), swept, 6));
  });

  it('is accepted in the committed card recipes', () => {
    const crusher = parseRecipe(readFileSync(new URL('../../../art/recipes/card.crusher.yaml', import.meta.url), 'utf8'), 'card.crusher.yaml');
    expect(crusher.kind === 'card' && Object.keys(crusher.seedOverrides).sort()).toEqual(['10', '12', '16', '20', '33', '6', '8', '9']);
  });
});

describe('recipeAnims', () => {
  it('lists each real animation once, a jump-only one being another name', () => {
    const png = 'f.png';
    const sprite: SpriteJson = {
      anims: [0, 3, 2],
      entries: [{ type: 'sprite', width: 4, height: 8, png }, { type: 'wait', wait: 16 }, { type: 'jump', target: 0 }, { type: 'jump', target: 0 }],
    };
    expect(recipeAnims(sprite, { anims: [0, 1, 2] })).toEqual([0]);
  });
  it("a crew card's used set has the seven ways the crew fire a phaser, the ones the sprite has", () => {
    const frame = { type: 'sprite' as const, width: 4, height: 8, png: 'f.png' };
    // (a sprite of 24 animations, each its own frame and a pause)
    const entries = Array.from({ length: 24 }, () => [frame, { type: 'pause' as const }]).flat();
    const sprite: SpriteJson = { anims: Array.from({ length: 24 }, (_, i) => i * 2), entries };
    const got = recipeAnims(sprite, { anims: 'used' });
    expect(got.filter(a => a >= 12 && a <= 23)).toEqual([12, 14, 17, 18, 19, 21, 22]);
    // (one that has fewer animations asks for none it lacks)
    expect(recipeAnims({ anims: [0], entries: [frame, { type: 'pause' }] }, { anims: 'used' })).toEqual([0]);
  });
  it('refuses an animation the sprite does not have, rather than running nothing', () => {
    const sprite: SpriteJson = { anims: [0], entries: [{ type: 'sprite', width: 4, height: 8, png: 'f.png' }, { type: 'wait', wait: 16 }] };
    expect(() => recipeAnims(sprite, { anims: [33] })).toThrow(/animation 33, but the sprite has only 1/);
  });
});

describe('publishAnimStrip', () => {
  const anim: MadeAnim = { strip: { width: 2, height: 2, data: new Uint8Array(16) }, original: { width: 1, height: 1, data: new Uint8Array(4) }, frames: 2, columns: 2, cell: [1, 2], anchor: [0.5, 1], delays: [50, 50], loop: true };
  it('writes one animation and its aliases and leaves the other animations alone', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'pa-'));
    await writeFile(join(tmp, 'presentation.yaml'), '# h\nart:\n  cards:\n    riker:\n      image: art/cards/riker.png\n      anims:\n        "0": { image: art/cards/riker/0.webp, frames: 1 }\n        "6": { image: old, frames: 9 }\n');
    const encoded: string[] = [];
    const file = await publishAnimStrip(tmp, 'riker', 6, anim, [7], 168, async (png, out) => { encoded.push(out); });
    expect(file).toBe('art/cards/riker/6.webp');
    expect(encoded).toEqual([join(tmp, 'art/cards/riker/6.webp')]);
    const y = parse(await readFile(join(tmp, 'presentation.yaml'), 'utf8'));
    expect(y.art.cards.riker.anims['0']).toEqual({ image: 'art/cards/riker/0.webp', frames: 1 });
    expect(y.art.cards.riker.anims['6']).toMatchObject({ image: 'art/cards/riker/6.webp', frames: 2, loop: true });
    expect(y.art.cards.riker.anims['7']).toEqual(y.art.cards.riker.anims['6']);
    expect(y.art.cards.riker.pixelHeight).toBe(168);
    // a height of 0 (a run that never played the standing animation) leaves the recorded one alone
    await publishAnimStrip(tmp, 'riker', 6, anim, [], 0, async () => {});
    expect(parse(await readFile(join(tmp, 'presentation.yaml'), 'utf8')).art.cards.riker.pixelHeight).toBe(168);
    await expect(publishAnimStrip(tmp, '../x', 1, anim, [])).rejects.toThrow(/object id/);
  });
});

describe('a prop card\'s strip of distinct frames', () => {
  const anim: MadeAnim = { strip: { width: 2, height: 2, data: new Uint8Array(16) }, original: { width: 1, height: 1, data: new Uint8Array(4) }, frames: 2, columns: 2, cell: [1, 2], anchor: [0.5, 1], delays: [50, 50, 50, 50], loop: true };
  it('is published with a record of which cell each frame is, which `art masks` reads back; a card without one has none', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'pa-'));
    await publishAnimStrip(tmp, 'light', 0, anim, [], undefined, async () => {}, { presentation: false, of: [0, 1, 0, 1] });
    expect(JSON.parse(await readFile(join(tmp, 'art/cards/light/0.json'), 'utf8'))).toEqual({ frames: 4, of: [0, 1, 0, 1], columns: 2 });
    expect(await readStripPack(tmp, 'light', 0)).toEqual({ of: [0, 1, 0, 1], columns: 2 });
    expect(await readStripPack(tmp, 'light', 1)).toBeNull();
    // (a crew card's strip has no such record: its presentation entry says it)
    await publishAnimStrip(tmp, 'riker', 6, anim, [], undefined, async () => {});
    await expect(readFile(join(tmp, 'art/cards/riker/6.json'))).rejects.toThrow();
  });
});

describe('stillOf', () => {
  it('cuts an animation to its first frame, with its position, so a prop card repaints one canvas and not the whole loop', () => {
    const f = (png: string) => ({ type: 'sprite', width: 4, height: 8, png });
    const sprite: SpriteJson = { anims: [0, 4], entries: [f('a.png'), { type: 'position', x: 9, y: 9 }, { type: 'wait', wait: 16 }, { type: 'pause' }, f('b.png'), { type: 'position', x: 7, y: 8 }, { type: 'wait', wait: 16 }, f('c.png'), { type: 'wait', wait: 16 }, { type: 'jump', target: 1 }] };
    const still = stillOf(sprite, 1);
    expect(still.entries.slice(sprite.entries.length)).toEqual([f('b.png'), { type: 'position', x: 7, y: 8 }, { type: 'pause' }]);
    expect(still.anims).toEqual([0, sprite.entries.length]);
    // (the file's own entries are as they were, and an animation with no frame is left alone)
    expect(still.entries.slice(0, sprite.entries.length)).toEqual(sprite.entries);
    expect(stillOf({ anims: [0], entries: [{ type: 'exit' }] }, 0).entries).toHaveLength(1);
  });
});

describe('propSprite', () => {
  const f = (png: string) => ({ type: 'sprite', width: 4, height: 8, png });
  const sprite: SpriteJson = { anims: [0, 3], entries: [f('a.png'), f('b.png'), { type: 'jump', target: 0 }, f('c.png'), { type: 'wait', wait: 16 }, f('d.png'), { type: 'pause' }] };
  const prop = (animate: number[], anim = 0) => ({ screen: 'lab.s01', screens: [], objects: ['lab.x'], anim, animate });
  it('cuts the prop\'s animation to a still unless the recipe animates it', () => {
    expect(propSprite(sprite, prop([])).anims[0]).toBe(sprite.entries.length);
    expect(propSprite(sprite, prop([0]))).toBe(sprite);
    expect(propSprite(sprite, prop([1]))).not.toBe(sprite);
  });
  it('leaves the other animations whole, so an animated one plays all its frames', () => {
    expect(propSprite(sprite, prop([1])).anims[1]).toBe(3);
  });
});

describe('uniqueCells', () => {
  const cell = (v: number): Rgba => ({ width: 2, height: 1, data: new Uint8Array([v, v, v, 255, v, v, v, 255]) });
  it('finds the frames that repeat, so a blinking light repaints the two it has and not the forty it plays', () => {
    const { unique, of } = uniqueCells([cell(1), cell(2), cell(1), cell(2), cell(3), cell(1)]);
    expect(unique).toEqual([0, 1, 4]);
    expect(of).toEqual([0, 1, 0, 1, 2, 0]);
  });
  it('keeps frames that differ only in alpha apart, and an animation with no repeat as it was', () => {
    const a = cell(1);
    const b = cell(1);
    b.data[3] = 0;
    expect(uniqueCells([a, b]).of).toEqual([0, 1]);
    expect(uniqueCells([cell(1), cell(2)]).unique).toEqual([0, 1]);
  });
});

describe('siblingEdge', () => {
  const frame = (v: number): Rgba => ({ width: 2, height: 2, data: new Uint8Array(16).map((_, i) => (i % 4 === 3 ? 255 : v)) });
  async function run(stamp: string, meta: object, rep: Rgba[], up: Rgba[]): Promise<void> {
    const dir = join(tmp, '1', stamp);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'meta.json'), JSON.stringify(meta));
    await writeFile(join(dir, 'repainted.png'), encodePng(stripOf(rep, [2, 2], 3)));
    await writeFile(join(dir, 'upscaled.png'), encodePng(stripOf(up, [2, 2], 3)));
  }
  const meta = { cell: [2, 2], columns: 3, frames: 3, anchor: [0.5, 1], ok: true, flickerMedian: 3.4 };

  it('reads the first or the last frame of the newest run of an animation that passed', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'edge-'));
    await run('2026-01-01', meta, [frame(10), frame(11), frame(12)], [frame(1), frame(2), frame(3)]);
    await run('2026-01-02', { ...meta, ok: false }, [frame(90), frame(91), frame(92)], [frame(1), frame(2), frame(3)]);
    const first = siblingEdge(join(tmp, '1'), 'first')!;
    const last = siblingEdge(join(tmp, '1'), 'last')!;
    // (the failed run is not the one the engine plays)
    expect([first.rep.data[0], first.up.data[0]]).toEqual([10, 1]);
    expect([last.rep.data[0], last.up.data[0]]).toEqual([12, 3]);
    expect(last.anchor).toEqual([0.5, 1]);
    // (and the animation's own flicker, which a switch is measured against; an animation of one frame has none)
    expect(last.median).toBe(3.4);
  });

  it('is null when no run of it passed, or the run is from before the anchor was recorded', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'edge-'));
    expect(siblingEdge(join(tmp, 'none'), 'first')).toBeNull();
    await run('2026-01-01', { cell: [2, 2], columns: 3, frames: 3, ok: true }, [frame(1), frame(1), frame(1)], [frame(1), frame(1), frame(1)]);
    expect(siblingEdge(join(tmp, '1'), 'first')).toBeNull();
  });

  it('has no median for a run of one frame', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'edge-'));
    await run('2026-01-01', { ...meta, flickerMedian: null }, [frame(10), frame(11), frame(12)], [frame(1), frame(2), frame(3)]);
    expect(siblingEdge(join(tmp, '1'), 'first')!.median).toBeNull();
  });
});
