// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { decodePng, encodePng, type Rgba } from './image';
import { aimPoint, animEntries, cutMask, findMasks, findProps, maskRect, publishMasks, scaledRect } from './masks';
import { stripLayout } from './layer';
import type { SpriteJson } from './sprites';

let tmp = '';
afterEach(() => rm(tmp, { recursive: true, force: true }));

function solid(width: number, height: number, rgba: [number, number, number, number]): Rgba {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4);
  return { width, height, data };
}

describe('cutMask', () => {
  it('copies plate pixels where the mask is opaque and leaves the rest clear', () => {
    const plate = solid(2560, 1920, [10, 20, 30, 255]);
    // a 4x2 mask: the left half opaque
    const mask = solid(4, 2, [0, 0, 0, 0]);
    for (const y of [0, 1]) for (const x of [0, 1]) mask.data[(y * 4 + x) * 4 + 3] = 255;
    // (a mark in the plate at the rect's origin ×4: where the cut must start)
    plate.data.set([200, 100, 50, 255], (40 * 2560 + 80) * 4);
    const cut = cutMask(plate, mask, [20, 10, 4, 2]);
    expect([cut.width, cut.height]).toEqual([16, 8]);
    expect([...cut.data.slice(0, 4)]).toEqual([200, 100, 50, 255]);
    expect([...cut.data.slice(4 * 4, 4 * 4 + 4)].slice(0, 3)).toEqual([10, 20, 30]);
    // opaque inside, clear at the far side, soft between (smoothstep over the upscaled edge)
    expect(cut.data[(2 * 16 + 1) * 4 + 3]).toBe(255);
    expect(cut.data[(2 * 16 + 14) * 4 + 3]).toBe(0);
    const edge = [4, 5, 6, 7].map(x => cut.data[(2 * 16 + x) * 4 + 3]!);
    expect(edge.some(a => a > 0 && a < 255)).toBe(true);
    expect(edge).toEqual([...edge].sort((a, b) => b - a));
  });

  it('leaves what is outside the plate clear', () => {
    const cut = cutMask(solid(2560, 1920, [1, 2, 3, 255]), solid(2, 2, [0, 0, 0, 255]), [-1, 0, 2, 2]);
    expect(cut.data[3]).toBe(0);
    expect(cut.data[(0 * 8 + 7) * 4 + 3]).toBe(255);
  });
});

describe('maskRect', () => {
  it('stands the frame where the original draws it: the sprite position replaces the object\'s, left is the middle less half the width', () => {
    expect(maskRect({ x: 104, y: 324 }, { x: 60, y: 324 }, 92, 22)).toEqual([14, 302, 92, 22]);
    expect(maskRect({ x: 207, y: 283 }, undefined, 108, 70)).toEqual([153, 213, 108, 70]);
    // (a zero axis keeps the object's)
    expect(maskRect({ x: 100, y: 50 }, { x: 0, y: 90 }, 10, 10)).toEqual([95, 80, 10, 10]);
    // (an odd width: the half is an integer division)
    expect(maskRect({ x: 50, y: 50 }, undefined, 15, 4)).toEqual([43, 46, 15, 4]);
  });
});

async function fixture() {
  tmp = await mkdtemp(join(tmpdir(), 'masks-'));
  const raw = join(tmp, 'raw');
  const images = join(tmp, 'images');
  const game = join(tmp, 'game');
  const object = (id: string, over: object) => writeFile(join(raw, 'objects', `o_${id}.json`), JSON.stringify({ id, curr_screen: 2, x: 104, y: 324, y_adjust: -1, sprite_id: 1, flags: 32, objwalktype: 0, ...over }));
  await mkdir(join(raw, 'objects'), { recursive: true });
  await mkdir(join(raw, 'maps'), { recursive: true });
  await mkdir(join(images, 'images', 'sprites', 'w4s2msk.spr'), { recursive: true });
  await mkdir(join(images, 'images', 'sprites', 'w4s2plain.spr'), { recursive: true });
  await mkdir(join(game, 'rooms'), { recursive: true });
  await writeFile(join(raw, 'maps', 'sprite.json'), JSON.stringify({ _spriteFilenames: ['PICARD', 'W4S2MSK', 'W4S2PLAIN'] }));
  await writeFile(join(images, 'images', 'sprites', 'w4s2msk.spr', 'sprite.json'), JSON.stringify({ entries: [{ type: 'mask' }, { type: 'sprite', width: 4, height: 2, png: 'images/sprites/w4s2msk.spr/0001.png' }, { type: 'position', x: 60, y: 324 }, { type: 'exit' }] }));
  await writeFile(join(images, 'images', 'sprites', 'w4s2msk.spr', '0001.png'), encodePng(solid(4, 2, [0, 0, 0, 255])));
  await writeFile(join(images, 'images', 'sprites', 'w4s2plain.spr', 'sprite.json'), JSON.stringify({ entries: [{ type: 'sprite', width: 4, height: 2, png: 'x.png' }, { type: 'exit' }] }));
  await writeFile(join(game, 'ids.yaml'), 'objects:\n  "04020d": lab.mask.020d\n  "04020e": lab.mask_1.020e\n  "04020f": lab.plain.020f\n  "040303": lab.other_room.0303\n');
  await object('04020d', { sprite_id: 1, y_adjust: 330 });
  await object('04020e', { sprite_id: 1, x: 100, y: 200 });
  await object('04020f', { sprite_id: 2 });
  await object('040303', { sprite_id: 1, curr_screen: 3 });
  await object('040200', { sprite_id: 0xffff });
  return { raw, images, game };
}

describe('findMasks', () => {
  it('finds the screen\'s objects whose sprite is a mask, with the rect the original draws and the row it is sorted by', async () => {
    const { raw, images, game } = await fixture();
    const found = await findMasks({ rawDir: raw, imagesDir: images, gameDir: game }, 'lab.s02');
    expect(found.map(m => m.object)).toEqual(['lab.mask.020d', 'lab.mask_1.020e']);
    // (y_adjust when the object has one, else its y)
    expect(found.map(m => m.depth)).toEqual([330, 200]);
    expect(found[0]!.rect).toEqual([58, 322, 4, 2]);
    expect(found[0]!.frame).toBe(join(images, 'images/sprites/w4s2msk.spr/0001.png'));
  });

  it('also takes an unmarked still named for a mask (Mertens\' cable masks) unless another object on the screen draws the same sprite', async () => {
    const { raw, images, game } = await fixture();
    const sprite = async (name: string, entries: object[]) => {
      await mkdir(join(images, 'images', 'sprites', `${name}.spr`), { recursive: true });
      await writeFile(join(images, 'images', 'sprites', `${name}.spr`, 'sprite.json'), JSON.stringify({ entries }));
    };
    const still = [{ type: 'sprite', width: 4, height: 2, png: 'x.png' }, { type: 'position', x: 60, y: 324 }, { type: 'wait' }, { type: 'pause' }];
    await sprite('w4s2cmk', still);
    // (a mask that plays: two frames before its pause)
    await sprite('w4s2amk', [{ type: 'sprite', width: 4, height: 2, png: 'x.png' }, { type: 'wait' }, { type: 'sprite', width: 4, height: 2, png: 'y.png' }, { type: 'pause' }]);
    await writeFile(join(raw, 'maps', 'sprite.json'), JSON.stringify({ _spriteFilenames: ['PICARD', 'W4S2MSK', 'W4S2PLAIN', 'W4S2CMK', 'W4S2AMK'] }));
    await writeFile(join(game, 'ids.yaml'), 'objects:\n  "04020d": lab.mask.020d\n  "040216": lab.cable_mask.0216\n  "040217": lab.anim_mask\n  "040218": lab.cable.0218\n  "040219": lab.also_mask\n');
    const o = (id: string, sprite_id: number) => writeFile(join(raw, 'objects', `o_${id}.json`), JSON.stringify({ id, curr_screen: 2, x: 104, y: 324, y_adjust: -1, sprite_id, flags: 32 }));
    await o('04020d', 1);
    await o('040216', 3);
    await o('040217', 4);
    // (an object that is no mask draws the same sprite as another named one: neither is taken)
    await o('040218', 3);
    await o('040219', 3);
    const found = await findMasks({ rawDir: raw, imagesDir: images, gameDir: game }, 'lab.s02');
    expect(found.map(m => m.object)).toEqual(['lab.mask.020d']);
    await writeFile(join(game, 'ids.yaml'), 'objects:\n  "04020d": lab.mask.020d\n  "040216": lab.cable_mask.0216\n  "040217": lab.anim_mask\n');
    expect((await findMasks({ rawDir: raw, imagesDir: images, gameDir: game }, 'lab.s02')).map(m => m.object)).toEqual(['lab.mask.020d', 'lab.cable_mask.0216']);
  });
});

describe('findProps', () => {
  // Mertens' cable: a sprite of two animations, the whole cable (146x60) and the cut one (144x58) that o_040307 plays after the phaser
  const cable = {
    anims: [0, 3],
    entries: [
      { type: 'sprite', width: 146, height: 60, png: 'images/sprites/w4s2cab.spr/0001.png' }, { type: 'position', x: 495, y: 293 }, { type: 'pause' },
      { type: 'sprite', width: 144, height: 58, png: 'images/sprites/w4s2cab.spr/0005.png' }, { type: 'position', x: 497, y: 294 }, { type: 'pause' }, { type: 'exit' },
    ],
  };

  it('stands the frame of the animation a prop shows: its own size and position, not animation 0\'s', async () => {
    const { raw, images, game } = await fixture();
    await mkdir(join(images, 'images', 'sprites', 'w4s2cab.spr'), { recursive: true });
    await writeFile(join(images, 'images', 'sprites', 'w4s2cab.spr', 'sprite.json'), JSON.stringify(cable));
    await writeFile(join(raw, 'maps', 'sprite.json'), JSON.stringify({ _spriteFilenames: ['PICARD', 'W4S2MSK', 'W4S2PLAIN', 'W4S2CAB'] }));
    await writeFile(join(game, 'ids.yaml'), 'objects:\n  "040210": lab.cable.0210\n');
    await writeFile(join(raw, 'objects', 'o_040210.json'), JSON.stringify({ id: '040210', curr_screen: 2, x: 550, y: 310, y_adjust: -1, sprite_id: 3, flags: 32 }));
    const dirs = { rawDir: raw, imagesDir: images, gameDir: game };
    expect((await findProps(dirs, 'lab.s02', ['lab.cable.0210']))[0]!.rect).toEqual([422, 233, 146, 60]);
    const cut = (await findProps(dirs, 'lab.s02', ['lab.cable.0210'], 1))[0]!;
    expect(cut.rect).toEqual([425, 236, 144, 58]);
    expect(cut.frame).toBe(join(images, 'images/sprites/w4s2cab.spr/0005.png'));
    // (the origin an animation's frames are placed from: the sprite's own position where it has one, else the object's)
    expect(cut.origin).toEqual([497, 294]);
    expect((await findProps(dirs, 'lab.s02', ['lab.cable.0210']))[0]!.origin).toEqual([495, 293]);
  });

  it("reads the phaser's aim point from the animation's mouthPos entry, and none where it is 0, 0 or missing", async () => {
    const { raw, images, game } = await fixture();
    await mkdir(join(images, 'images', 'sprites', 'w4s2cab.spr'), { recursive: true });
    const sprite = { anims: [0, 4], entries: [{ type: 'mouthPos', x: -66, y: -57 }, ...cable.entries.slice(0, 3), { type: 'mouthPos', x: 0, y: 0 }, ...cable.entries.slice(3)] };
    await writeFile(join(images, 'images', 'sprites', 'w4s2cab.spr', 'sprite.json'), JSON.stringify(sprite));
    await writeFile(join(raw, 'maps', 'sprite.json'), JSON.stringify({ _spriteFilenames: ['PICARD', 'W4S2MSK', 'W4S2PLAIN', 'W4S2CAB'] }));
    await writeFile(join(game, 'ids.yaml'), 'objects:\n  "040210": lab.cable.0210\n');
    await writeFile(join(raw, 'objects', 'o_040210.json'), JSON.stringify({ id: '040210', curr_screen: 2, x: 550, y: 310, y_adjust: -1, sprite_id: 3, flags: 32 }));
    const dirs = { rawDir: raw, imagesDir: images, gameDir: game };
    const whole = (await findProps(dirs, 'lab.s02', ['lab.cable.0210']))[0]!;
    expect(whole.mouth).toEqual([-66, -57]);
    // (this sprite sets its own position, so a move of the object changes nothing it draws)
    expect(whole.home).toEqual([null, null]);
    // ((-66 * 256 + 0x80) / 256 is -65.5, truncated toward zero as the original's integer division does)
    expect(aimPoint(whole.origin, whole.mouth!)).toEqual([430, 237]);
    expect((await findProps(dirs, 'lab.s02', ['lab.cable.0210'], 1))[0]!.mouth).toBeUndefined();
  });

  it("scales the aim point with the object as the original does: (point * scale + 0x80) / 256, truncated", () => {
    expect(aimPoint([440, 263], [-66, -57], 256)).toEqual([375, 207]);
    expect(aimPoint([440, 263], [-66, -57], 70)).toEqual([440 + Math.trunc((-66 * 70 + 128) / 256), 263 + Math.trunc((-57 * 70 + 128) / 256)]);
    expect(aimPoint([440, 263], [30, 40], 128)).toEqual([455, 283]);
  });

  it('names an object the screen lacks as missing, unless the recipe is shared by several rooms', async () => {
    const { raw, images, game } = await fixture();
    await mkdir(join(images, 'images', 'sprites', 'w4s2cab.spr'), { recursive: true });
    await writeFile(join(images, 'images', 'sprites', 'w4s2cab.spr', 'sprite.json'), JSON.stringify(cable));
    await writeFile(join(raw, 'maps', 'sprite.json'), JSON.stringify({ _spriteFilenames: ['PICARD', 'W4S2MSK', 'W4S2PLAIN', 'W4S2CAB'] }));
    await writeFile(join(game, 'ids.yaml'), 'objects:\n  "040210": lab.cable.0210\n  "040310": lab.cable.0310\n');
    await writeFile(join(raw, 'objects', 'o_040210.json'), JSON.stringify({ id: '040210', curr_screen: 2, x: 550, y: 310, y_adjust: -1, sprite_id: 3, flags: 32 }));
    await writeFile(join(raw, 'objects', 'o_040310.json'), JSON.stringify({ id: '040310', curr_screen: 3, x: 550, y: 310, y_adjust: -1, sprite_id: 3, flags: 32 }));
    const dirs = { rawDir: raw, imagesDir: images, gameDir: game };
    await expect(findProps(dirs, 'lab.s02', ['lab.cable.0210', 'lab.cable.0310'])).rejects.toThrow('no sprite object lab.cable.0310');
    expect((await findProps(dirs, 'lab.s02', ['lab.cable.0210', 'lab.cable.0310'], 0, true)).map(o => o.object)).toEqual(['lab.cable.0210']);
  });

  it('reads an animation up to its first pause, and the whole file for animation 0 or a sprite with no list', () => {
    expect(animEntries(cable, 1).map(e => e.type)).toEqual(['sprite', 'position']);
    expect(animEntries(cable, 0)).toBe(cable.entries);
    expect(animEntries({ entries: cable.entries }, 1)).toBe(cable.entries);
  });
});

describe('publishMasks', () => {
  it('writes mask.<object>.webp beside the plate and sets art.rooms[screen].masks, keeping the plate and other keys', async () => {
    const { game } = await fixture();
    await writeFile(join(game, 'presentation.yaml'), '# header\nart:\n  rooms:\n    lab.s02:\n      plate: art/rooms/lab/s02/plate.webp\n');
    const plate = solid(2560, 1920, [9, 9, 9, 255]);
    const encoded: string[] = [];
    const masks = [{ object: 'lab.mask.020d', sprite: 'w4s2msk', frame: join(tmp, 'f.png'), rect: [58, 322, 4, 2] as [number, number, number, number], origin: [60, 324] as [number, number], depth: 330, walkType: 0 }];
    await writeFile(masks[0]!.frame, encodePng(solid(4, 2, [0, 0, 0, 255])));
    const files = await publishMasks(game, 'lab.s02', plate, masks, { encode: async (png, out) => { encoded.push(out); await writeFile(out, await readFile(png)); } });
    expect(files).toEqual(['art/rooms/lab/s02/mask.lab.mask.020d.webp']);
    expect(encoded).toEqual([join(game, 'art/rooms/lab/s02/mask.lab.mask.020d.webp')]);
    const text = await readFile(join(game, 'presentation.yaml'), 'utf8');
    expect(text.startsWith('# header')).toBe(true);
    expect(parse(text).art.rooms['lab.s02']).toEqual({
      plate: 'art/rooms/lab/s02/plate.webp',
      masks: [{ object: 'lab.mask.020d', image: files[0], rect: [58, 322, 4, 2], depth: 330 }],
    });
  });

  it('puts a prop\'s card in a mask\'s place, copied as mask.<object>.webp, and keeps it when the masks are cut again', async () => {
    const { game } = await fixture();
    await writeFile(join(game, 'presentation.yaml'), 'art:\n  rooms:\n    lab.s03:\n      plate: art/rooms/lab/s03/plate.webp\n');
    const source = join(tmp, 'card.webp');
    await writeFile(source, 'webp bytes');
    const props = [{ object: 'lab.big_cable.0308', source, rect: [422, 233, 146, 60] as [number, number, number, number], depth: 285, origin: [495, 293] as [number, number], mouth: [-66, -57] as [number, number], home: [100, null] as [number | null, number | null] }];
    const files = await publishMasks(game, 'lab.s03', solid(2560, 1920, [9, 9, 9, 255]), [], {}, props);
    expect(files).toEqual(['art/rooms/lab/s03/mask.lab.big_cable.0308.webp']);
    expect(await readFile(join(game, files[0]!), 'utf8')).toBe('webp bytes');
    // (and where a phaser aims at it)
    expect(parse(await readFile(join(game, 'presentation.yaml'), 'utf8')).art.rooms['lab.s03'].masks).toEqual([{ object: 'lab.big_cable.0308', image: files[0], rect: [422, 233, 146, 60], depth: 285, card: true, aim: [430, 237], home: [100, null] }]);
  });

  it('publishes one entry for an object that is both a mask and a prop: the prop, since both would be written to the same file', async () => {
    // (Mertens' cable masks: sprites named for a mask that are the cable, with cards. Two entries for one object left the stage a
    // second quad it did not track, drawn in every room after)
    const { game } = await fixture();
    await writeFile(join(game, 'presentation.yaml'), 'art:\n  rooms:\n    lab.s03:\n      plate: art/rooms/lab/s03/plate.webp\n');
    const frame = join(tmp, 'f.png');
    await writeFile(frame, encodePng(solid(4, 2, [0, 0, 0, 255])));
    const masks = [
      { object: 'lab.cable_mask.031c', sprite: 'w4s3msk3', frame, rect: [58, 322, 4, 2] as [number, number, number, number], origin: [60, 324] as [number, number], depth: 330, walkType: 0 },
      { object: 'lab.mask_for_ramp', sprite: 'w4s3msk1', frame, rect: [10, 10, 4, 2] as [number, number, number, number], origin: [12, 12] as [number, number], depth: 300, walkType: 0 },
    ];
    const source = join(tmp, 'card.webp');
    await writeFile(source, 'webp bytes');
    const props = [{ object: 'lab.cable_mask.031c', source, rect: [58, 322, 4, 2] as [number, number, number, number], depth: 330 }];
    const encoded: string[] = [];
    const files = await publishMasks(game, 'lab.s03', solid(2560, 1920, [9, 9, 9, 255]), masks, { encode: async (png, out) => { encoded.push(out); await writeFile(out, await readFile(png)); } }, props);
    expect(files).toEqual(['art/rooms/lab/s03/mask.lab.mask_for_ramp.webp', 'art/rooms/lab/s03/mask.lab.cable_mask.031c.webp']);
    // (the plate is not cut for it: the card is its picture)
    expect(encoded).toEqual([join(game, 'art/rooms/lab/s03/mask.lab.mask_for_ramp.webp')]);
    expect(await readFile(join(game, files[1]!), 'utf8')).toBe('webp bytes');
    const entries = parse(await readFile(join(game, 'presentation.yaml'), 'utf8')).art.rooms['lab.s03'].masks as { object: string; card?: boolean }[];
    expect(entries.map(e => [e.object, e.card ?? false])).toEqual([['lab.mask_for_ramp', false], ['lab.cable_mask.031c', true]]);
  });

  it('publishes an animated prop as a layer: its still for a fallback, and a strip for each animation, with every frame\'s rectangle', async () => {
    const { game } = await fixture();
    await writeFile(join(game, 'presentation.yaml'), 'art:\n  rooms:\n    allanor.s01:\n      plate: art/rooms/allanor/s01/plate.webp\n');
    // a door: animation 0 one closed frame, animation 1 opens it over two frames, the second narrower
    const door: SpriteJson = { anims: [0, 2], entries: [{ type: 'sprite', width: 4, height: 8, png: 'a' }, { type: 'pause' }, { type: 'sprite', width: 4, height: 8, png: 'b' }, { type: 'wait', wait: 160 }, { type: 'sprite', width: 2, height: 8, png: 'c' }, { type: 'pause' }] };
    const origin = { x: 20, y: 50 };
    const closed = stripLayout(door, 0, origin)!;
    const opening = stripLayout(door, 1, origin)!;
    expect([closed.frames, opening.frames, opening.cell]).toEqual([1, 2, [16, 32]]);
    // (the strips as the pipeline publishes them: cells of the layout's size, one colour a frame)
    const strip = (layout: typeof opening, colours: number[]): Rgba => {
      const img = solid(layout.cell[0] * layout.columns, layout.cell[1] * Math.ceil(layout.frames / layout.columns), [0, 0, 0, 0]);
      colours.forEach((c, i) => {
        for (let y = 0; y < layout.cell[1]; y++) for (let x = 0; x < layout.cell[0]; x++) img.data.set([c, c, c, 255], (y * img.width + i * layout.cell[0] + x) * 4);
      });
      return img;
    };
    const sources: Record<string, Rgba> = {};
    const cards = join(game, 'art', 'cards', 'allanor_door_011b');
    await mkdir(cards, { recursive: true });
    sources[join(cards, '0.webp')] = strip(closed, [10]);
    sources[join(cards, '1.webp')] = strip(opening, [20, 30]);
    for (const f of Object.keys(sources)) await writeFile(f, 'x');
    const written: Record<string, Rgba> = {};
    const props = [{ object: 'allanor.door.011b', source: join(cards, '0.webp'), rect: closed.rects[0]!, depth: 215, anim: 0, strips: [{ anim: 0, source: join(cards, '0.webp'), layout: closed }, { anim: 1, source: join(cards, '1.webp'), layout: opening }] }];
    const files = await publishMasks(game, 'allanor.s01', solid(2560, 1920, [9, 9, 9, 255]), [], {
      read: async path => sources[path]!,
      encode: async (png, out) => { written[out] = decodePng(new Uint8Array(await readFile(png))); await writeFile(out, 'x'); },
    }, props);
    expect(files).toEqual(['art/rooms/allanor/s01/mask.allanor.door.011b.webp']);
    // the still, the fallback, is the first frame of the animation it starts on
    const still = written[join(game, files[0]!)]!;
    expect([still.width, still.height, still.data[0]]).toEqual([16, 32, 10]);
    const entry = parse(await readFile(join(game, 'presentation.yaml'), 'utf8')).art.rooms['allanor.s01'].masks[0];
    expect(entry).toMatchObject({ object: 'allanor.door.011b', rect: [18, 42, 4, 8], depth: 215, card: true, anim: 0 });
    expect(Object.keys(entry.strips)).toEqual(['0', '1']);
    expect(entry.strips['1']).toEqual({
      image: 'art/cards/allanor_door_011b/1.webp', frames: 2, cell: [16, 32], rect: [18, 42, 4, 8],
      rects: [[18, 42, 4, 8], [19, 42, 2, 8]], delays: opening.delays, loop: false,
    });
    // (no talk animation named: none published)
    expect(entry.talk).toBeUndefined();
    // a character that replies publishes its talk animation and the one it goes back to, if the strip of the talk animation exists
    await publishMasks(game, 'allanor.s01', solid(2560, 1920, [9, 9, 9, 255]), [], {
      read: async path => sources[path]!,
      encode: async (png, out) => { await writeFile(out, 'x'); },
    }, [{ ...props[0]!, talk: { anim: 1, idle: 0 } }]);
    expect(parse(await readFile(join(game, 'presentation.yaml'), 'utf8')).art.rooms['allanor.s01'].masks[0].talk).toEqual({ anim: 1, idle: 0 });
    await publishMasks(game, 'allanor.s01', solid(2560, 1920, [9, 9, 9, 255]), [], {
      read: async path => sources[path]!,
      encode: async (png, out) => { await writeFile(out, 'x'); },
    }, [{ ...props[0]!, talk: { anim: 5, idle: 0 } }]);
    expect(parse(await readFile(join(game, 'presentation.yaml'), 'utf8')).art.rooms['allanor.s01'].masks[0].talk).toBeUndefined();
  });

  it("draws an animated walker-type prop at the floor's scale: every rectangle shrinks about the sprite's origin, the pictures stay as they are", async () => {
    const { game } = await fixture();
    await writeFile(join(game, 'presentation.yaml'), 'art:\n  rooms:\n    lab.s03:\n      plate: art/rooms/lab/s03/plate.webp\n');
    const door: SpriteJson = { anims: [0, 2], entries: [{ type: 'sprite', width: 4, height: 8, png: 'a' }, { type: 'pause' }, { type: 'sprite', width: 4, height: 8, png: 'b' }, { type: 'wait', wait: 160 }, { type: 'sprite', width: 2, height: 8, png: 'c' }, { type: 'pause' }] };
    const origin = { x: 20, y: 50 };
    const closed = stripLayout(door, 0, origin)!;
    const opening = stripLayout(door, 1, origin)!;
    const cards = join(game, 'art', 'cards', 'woman');
    await mkdir(cards, { recursive: true });
    const grid = (layout: typeof opening): Rgba => solid(layout.cell[0] * layout.columns, layout.cell[1] * Math.ceil(layout.frames / layout.columns), [5, 5, 5, 255]);
    const sources: Record<string, Rgba> = { [join(cards, '0.webp')]: grid(closed), [join(cards, '1.webp')]: grid(opening) };
    for (const f of Object.keys(sources)) await writeFile(f, 'x');
    const props = [{ object: 'lab.woman', source: join(cards, '0.webp'), rect: closed.rects[0]!, depth: 280, anim: 0, scale: 128, origin: [20, 50] as [number, number], mouth: [-8, -16] as [number, number], strips: [{ anim: 0, source: join(cards, '0.webp'), layout: closed }, { anim: 1, source: join(cards, '1.webp'), layout: opening }] }];
    await publishMasks(game, 'lab.s03', solid(2560, 1920, [9, 9, 9, 255]), [], { read: async path => sources[path]!, encode: async (_png, out) => { await writeFile(out, 'x'); } }, props);
    const entry = parse(await readFile(join(game, 'presentation.yaml'), 'utf8')).art.rooms['lab.s03'].masks[0];
    // (the frame [18, 42, 4, 8] about the origin (20, 50) at half size: [19, 46, 2, 4]; the cell and each frame's own, likewise; the cell in card pixels is not touched)
    expect(entry.rect).toEqual([19, 46, 2, 4]);
    expect(entry.strips['1'].rect).toEqual([19, 46, 2, 4]);
    expect(entry.strips['1'].rects).toEqual([[19, 46, 2, 4], [19.5, 46, 1, 4]]);
    expect(entry.strips['1'].cell).toEqual([16, 32]);
    // (the aim point goes by the same scale: (-8 * 128 + 0x80) / 256 = -3.5, truncated to -3, and (-16 * 128 + 0x80) / 256 is -7.5, to -7)
    expect(entry.aim).toEqual([17, 43]);
    // (at the floor's vanishing end, 2/256: under a pixel, the original shows nothing of it, so there is no layer)
    await publishMasks(game, 'lab.s03', solid(2560, 1920, [9, 9, 9, 255]), [], { read: async path => sources[path]!, encode: async (_png, out) => { await writeFile(out, 'x'); } }, [{ ...props[0]!, scale: 2 }]);
    expect(parse(await readFile(join(game, 'presentation.yaml'), 'utf8')).art.rooms['lab.s03'].masks ?? []).toEqual([]);
  });

  it('publishes a strip that holds each distinct frame once, with the cell each frame is', async () => {
    const { game } = await fixture();
    const f = (png: string) => ({ type: 'sprite', width: 4, height: 8, png });
    const blink: SpriteJson = { anims: [0], entries: [f('a'), { type: 'wait', wait: 160 }, f('b'), { type: 'wait', wait: 160 }, f('a'), { type: 'wait', wait: 160 }, f('b'), { type: 'wait', wait: 160 }, { type: 'jump', target: 0 }] };
    const layout = stripLayout(blink, 0, { x: 20, y: 50 }, { of: [0, 1, 0, 1], columns: 2 })!;
    const source = join(game, 'art', 'cards', 'x', '0.webp');
    await mkdir(join(game, 'art', 'cards', 'x'), { recursive: true });
    await writeFile(source, 'x');
    const props = [{ object: 'lab.light', source, rect: layout.rects[0]!, depth: 60, anim: 0, strips: [{ anim: 0, source, layout }] }];
    // (two cells, not four: the file the pipeline published is 2 cells of 16x32)
    await publishMasks(game, 'lab.s01', solid(2560, 1920, [9, 9, 9, 255]), [], { read: async () => solid(32, 32, [5, 5, 5, 255]), encode: async () => {} }, props);
    const strip = parse(await readFile(join(game, 'presentation.yaml'), 'utf8')).art.rooms['lab.s01'].masks[0].strips['0'];
    expect(strip).toMatchObject({ frames: 4, of: [0, 1, 0, 1], loop: true });
    // (the strip fits its cells in one row: there is no `columns` to say)
    expect(strip.columns).toBeUndefined();
    await expect(publishMasks(game, 'lab.s01', solid(2560, 1920, [9, 9, 9, 255]), [], { read: async () => solid(64, 32, [5, 5, 5, 255]), encode: async () => {} }, props)).rejects.toThrow(/2 cells/);
  });

  it('streams an atlas strip whose pages cost more whole: its pages, the cells and where they lie, the still cut from the first frame, and the room\'s decoded strip bytes against the budget', async () => {
    const { game } = await fixture();
    const f = (png: string, width = 4) => ({ type: 'sprite', width, height: 8, png });
    const blink: SpriteJson = { anims: [0], entries: [f('a'), { type: 'wait', wait: 160 }, f('b', 2), { type: 'wait', wait: 160 }, f('a'), { type: 'wait', wait: 160 }, { type: 'jump', target: 0 }] };
    const origin = { x: 20, y: 50 };
    // (frame b is narrower: the union cell is 16x32 and cell 1 is 8x32 of it, from x = 4)
    const atlas = { images: ['art/cards/x/0.0.webp'], pages: [[64, 64]] as [number, number][], cells: [[0, 0, 0, 16, 32, 0, 0], [0, 17, 0, 6, 32, 5, 0]] as [number, number, number, number, number, number, number][] };
    const layout = stripLayout(blink, 0, origin, { of: [0, 1, 0], columns: 2, atlas })!;
    expect(layout.atlas).toBe(atlas);
    await mkdir(join(game, 'art', 'cards', 'x'), { recursive: true });
    await writeFile(join(game, atlas.images[0]!), 'x');
    const page = solid(64, 64, [0, 0, 0, 0]);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 16; x++) page.data.set([10, 10, 10, 255], (y * 64 + x) * 4);
    const props = [{ object: 'lab.light', source: join(game, atlas.images[0]!), rect: layout.rects[0]!, depth: 60, anim: 0, strips: [{ anim: 0, source: join(game, atlas.images[0]!), layout }] }];
    const reports: { bytes: number; over: boolean }[] = [];
    const written: Rgba[] = [];
    // (resident: the page's encoded bytes (the test file is 1), the layer's texture and its canvas (16x32, twice: 4096) and a ring of its two cells (the larger twice: 4096), against a budget of 2000)
    await publishMasks(game, 'lab.s01', solid(2560, 1920, [9, 9, 9, 255]), [], {
      read: async () => page,
      encode: async png => { written.push(decodePng(new Uint8Array(await readFile(png)))); },
      report: r => reports.push(r),
      budget: 2000,
    }, props);
    const strip = parse(await readFile(join(game, 'presentation.yaml'), 'utf8')).art.rooms['lab.s01'].masks[0].strips['0'];
    expect(strip).toMatchObject({ images: ['art/cards/x/0.0.webp'], pages: [[64, 64]], cells: atlas.cells, frames: 3, of: [0, 1, 0], cell: [16, 32], loop: true });
    expect(strip.image).toBeUndefined();
    expect(strip.columns).toBeUndefined();
    // the still is frame 0 (all of the cell), cut out of the page
    expect([written[0]!.width, written[0]!.height, written[0]!.data[0]]).toEqual([16, 32, 10]);
    expect(reports).toEqual([expect.objectContaining({ bytes: 1 + 2 * 16 * 32 * 4 + 2 * 16 * 32 * 4, encoded: 1, budget: 2000, over: true, objects: [{ object: 'lab.light', bytes: 1 + 2 * 16 * 32 * 4 + 2 * 16 * 32 * 4, mode: 'stream' }] })]);
    // a page that is not the size the pack says is refused
    await expect(publishMasks(game, 'lab.s01', solid(2560, 1920, [9, 9, 9, 255]), [], { read: async () => page, encode: async () => {} }, [{ ...props[0]!, strips: [{ anim: 0, source: props[0]!.source, layout: { ...layout, atlas: { ...atlas, pages: [[32, 32]] } } }] }])).rejects.toThrow(/64x64, but its atlas says 32x32/);
  });

  it('publishes an atlas strip that is cheaper whole: its pages, the cells and where they lie, the still cut from the first frame, and the room\'s decoded strip bytes against the budget', async () => {
    const { game } = await fixture();
    const f = (png: string, width = 4) => ({ type: 'sprite', width, height: 8, png });
    const blink: SpriteJson = { anims: [0], entries: [f('a'), { type: 'wait', wait: 160 }, f('b', 2), { type: 'wait', wait: 160 }, f('a'), { type: 'wait', wait: 160 }, { type: 'jump', target: 0 }] };
    const origin = { x: 20, y: 50 };
    // (frame b is narrower: the union cell is 16x32 and cell 1 is 8x32 of it, from x = 4)
    const atlas = { images: ['art/cards/x/0.0.webp'], pages: [[24, 32]] as [number, number][], cells: [[0, 0, 0, 16, 32, 0, 0], [0, 17, 0, 6, 32, 5, 0]] as [number, number, number, number, number, number, number][] };
    const layout = stripLayout(blink, 0, origin, { of: [0, 1, 0], columns: 2, atlas })!;
    expect(layout.atlas).toBe(atlas);
    await mkdir(join(game, 'art', 'cards', 'x'), { recursive: true });
    await writeFile(join(game, atlas.images[0]!), 'x');
    const page = solid(24, 32, [0, 0, 0, 0]);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 16; x++) page.data.set([10, 10, 10, 255], (y * 24 + x) * 4);
    const props = [{ object: 'lab.light', source: join(game, atlas.images[0]!), rect: layout.rects[0]!, depth: 60, anim: 0, strips: [{ anim: 0, source: join(game, atlas.images[0]!), layout }] }];
    const reports: { bytes: number; over: boolean }[] = [];
    const written: Rgba[] = [];
    // (the page, 24x32, is 3072 bytes uploaded whole against 8192 streamed: the layer is whole, the room holds the page decoded and nothing encoded)
    await publishMasks(game, 'lab.s01', solid(2560, 1920, [9, 9, 9, 255]), [], {
      read: async () => page,
      encode: async png => { written.push(decodePng(new Uint8Array(await readFile(png)))); },
      report: r => reports.push(r),
      budget: 2000,
    }, props);
    const strip = parse(await readFile(join(game, 'presentation.yaml'), 'utf8')).art.rooms['lab.s01'].masks[0].strips['0'];
    expect(strip).toMatchObject({ images: ['art/cards/x/0.0.webp'], pages: [[24, 32]], cells: atlas.cells, frames: 3, of: [0, 1, 0], cell: [16, 32], loop: true });
    expect(strip.image).toBeUndefined();
    expect(strip.columns).toBeUndefined();
    // the still is frame 0 (all of the cell), cut out of the page
    expect([written[0]!.width, written[0]!.height, written[0]!.data[0]]).toEqual([16, 32, 10]);
    expect(reports).toEqual([expect.objectContaining({ bytes: 24 * 32 * 4, encoded: 0, budget: 2000, over: true, objects: [{ object: 'lab.light', bytes: 24 * 32 * 4, mode: 'whole' }] })]);
    // a page that is not the size the pack says is refused
    await expect(publishMasks(game, 'lab.s01', solid(2560, 1920, [9, 9, 9, 255]), [], { read: async () => page, encode: async () => {} }, [{ ...props[0]!, strips: [{ anim: 0, source: props[0]!.source, layout: { ...layout, atlas: { ...atlas, pages: [[32, 32]] } } }] }])).rejects.toThrow(/24x32, but its atlas says 32x32/);
  });

  it('refuses a strip whose file is not the size of its cells (the card was published from another sprite or animation)', async () => {
    const { game } = await fixture();
    const door: SpriteJson = { anims: [0], entries: [{ type: 'sprite', width: 4, height: 8, png: 'a' }, { type: 'wait', wait: 160 }, { type: 'sprite', width: 4, height: 8, png: 'b' }, { type: 'pause' }] };
    const layout = stripLayout(door, 0, { x: 20, y: 50 })!;
    const source = join(game, 'c.webp');
    await writeFile(source, 'x');
    const props = [{ object: 'a.b', source, rect: layout.rects[0]!, depth: 1, anim: 0, strips: [{ anim: 0, source, layout }] }];
    await expect(publishMasks(game, 'lab.s01', solid(2560, 1920, [9, 9, 9, 255]), [], { read: async () => solid(16, 32, [0, 0, 0, 0]), encode: async () => {} }, props)).rejects.toThrow(/32x32/);
  });

  it('draws a walker-type object at the floor\'s scale, standing on the same row and column (Graphics::drawSprite)', () => {
    // the trapped woman: a 156x60 frame at 347,220 (stands at 425,280), floor scale 162
    expect(scaledRect([347, 220, 156, 60], 162)).toEqual([376, 243, 98, 37]);
    expect(scaledRect([347, 220, 156, 60], 256)).toEqual([347, 220, 156, 60]);
  });
});
