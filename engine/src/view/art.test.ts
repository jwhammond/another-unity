// SPDX-License-Identifier: GPL-3.0-or-later
import { Object3D, Texture } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { AssetIndex } from './assets';
import { artFromPresentation, disposeRoomArt, leanLoaders, loadRoomArt, shipArtFromPresentation, type ArtLoaders } from './art';
import { parsePresentation } from './package';

describe('artFromPresentation', () => {
  it('resolves paths through the asset index and warns once for a missing file', () => {
    const config = parsePresentation([
      'art:', '  rooms:', '    w.s01: { plate: art/p.png, depth: art/d.png }', '    w.s02: { plate: art/p.png, normal: art/gone.png }',
      '  cards:', '    picard: { image: art/c.png, frames: 4 }', '    data: { image: art/missing.png }',
    ].join('\n'));
    const warnings: string[] = [];
    const source = artFromPresentation(config, new AssetIndex([['art/p.png', '/u/p'], ['art/d.png', '/u/d'], ['art/c.png', '/u/c']]), m => warnings.push(m));
    expect(source.room('w.s01')).toEqual({ plate: '/u/p', depth: '/u/d' });
    expect(source.room('w.s02')).toEqual({ plate: '/u/p' });
    expect(source.room('w.s03')).toBeUndefined();
    expect(source.card('picard')).toEqual({ url: '/u/c', frames: 4, anchor: [0.5, 1] });
    expect(source.card('data')).toBeUndefined();
    expect(warnings).toHaveLength(2);
    expect(warnings.join()).toContain('art/gone.png');
  });

  it('resolves a card\'s animations and pixel height, and leaves out a strip the index lacks', () => {
    const anim = (n: number) => `{ image: art/a${n}.webp, frames: 2, cell: [8, 16], anchor: [0.5, 0.9], delays: [10, 20], loop: false, next: 5 }`;
    const config = parsePresentation(`art:\n  cards:\n    picard: { image: art/c.png, pixelHeight: 166, anims: { '27': ${anim(27)}, '3': ${anim(3)} } }\n`);
    const warnings: string[] = [];
    const card = artFromPresentation(config, new AssetIndex([['art/c.png', '/u/c'], ['art/a27.webp', '/u/a27']]), m => warnings.push(m)).card('picard')!;
    expect(card.pixelHeight).toBe(166);
    expect(card.anims).toEqual({ 27: { url: '/u/a27', frames: 2, cell: [8, 16], anchor: [0.5, 0.9], delays: [10, 20], loop: false, next: 5 } });
    expect(warnings).toEqual(['art file art/a3.webp is not there: using greybox']);
  });
});

describe('animated layers in the room art', () => {
  const strip = (n: number, extra = '') => `{ image: art/cards/door/${n}.webp, frames: 3, cell: [16, 32], rect: [18, 42, 4, 8], rects: [[18, 42, 4, 8], [18, 42, 4, 8], [19, 42, 2, 8]], delays: [10, 20, 30], loop: false${extra} }`;
  const config = () => parsePresentation(`art:\n  rooms:\n    w.s01:\n      plate: art/p.png\n      masks:\n        - { object: w.door, image: art/m.webp, rect: [18, 42, 4, 8], depth: 50, card: true, anim: 0, strips: { '0': ${strip(0)}, '1': ${strip(1, ', next: 0, columns: 2, of: [0, 1, 1]')} } }\n`);

  it('resolves each animation\'s strip, keeping the cells, rectangles and timing, and the still it falls back to', () => {
    const urls = artFromPresentation(config(), new AssetIndex([['art/p.png', '/u/p'], ['art/m.webp', '/u/m'], ['art/cards/door/0.webp', '/u/0'], ['art/cards/door/1.webp', '/u/1']])).room('w.s01')!;
    expect(urls.masks).toHaveLength(1);
    const m = urls.masks![0]!;
    expect([m.url, m.anim, m.card]).toEqual(['/u/m', 0, true]);
    expect(Object.keys(m.strips!)).toEqual(['0', '1']);
    expect(m.strips![1]).toEqual({ url: '/u/1', frames: 3, columns: 2, of: [0, 1, 1], delays: [10, 20, 30], loop: false, next: 0, rect: [18, 42, 4, 8] });
  });

  it('keeps what a character plays while it replies', () => {
    const talking = parsePresentation(`art:\n  rooms:\n    w.s01:\n      plate: art/p.png\n      masks:\n        - { object: w.laraq, image: art/m.webp, rect: [18, 42, 4, 8], depth: 50, card: true, anim: 0, talk: { anim: 1, idle: 0 }, strips: { '0': ${strip(0)}, '1': ${strip(1)} } }\n`);
    const urls = artFromPresentation(talking, new AssetIndex([['art/p.png', '/u/p'], ['art/m.webp', '/u/m'], ['art/cards/door/0.webp', '/u/0'], ['art/cards/door/1.webp', '/u/1']])).room('w.s01')!;
    expect(urls.masks![0]!.talk).toEqual({ anim: 1, idle: 0 });
    expect(artFromPresentation(config(), new AssetIndex([['art/p.png', '/u/p'], ['art/m.webp', '/u/m'], ['art/cards/door/0.webp', '/u/0'], ['art/cards/door/1.webp', '/u/1']])).room('w.s01')!.masks![0]!.talk).toBeUndefined();
  });

  it('leaves out a strip the index lacks, warning once: the object plays that animation as its still', () => {
    const warnings: string[] = [];
    const urls = artFromPresentation(config(), new AssetIndex([['art/p.png', '/u/p'], ['art/m.webp', '/u/m'], ['art/cards/door/0.webp', '/u/0']]), m => warnings.push(m)).room('w.s01')!;
    expect(Object.keys(urls.masks![0]!.strips!)).toEqual(['0']);
    expect(warnings).toEqual(['art file art/cards/door/1.webp is not there: using greybox']);
  });

  it('keeps an atlas strip\'s pages as bytes, all of them or none, fetched once each, and uploads no texture for them', async () => {
    const fetched: string[] = [];
    const textures: string[] = [];
    const loaders: ArtLoaders = {
      texture: async url => {
        textures.push(url);
        return new Texture();
      },
      page: async url => {
        fetched.push(url);
        if (url === 'q1.webp') throw new Error('404');
        return { bytes: 100, crop: async () => ({ close() {} }) };
      },
      model: async () => new Object3D(),
    };
    const atlas = { frames: 2, delays: [10, 10], loop: true, rect: [0, 0, 1, 1] as [number, number, number, number], cell: [8, 8] as [number, number], pages: [[100, 100], [100, 100]] as [number, number][], cells: [[0, 0, 0, 8, 8, 0, 0], [1, 0, 0, 8, 8, 0, 0]] as [number, number, number, number, number, number, number][] };
    const warnings: string[] = [];
    const art = await loadRoomArt({ masks: [
      { object: 'a', url: 'a.webp', rect: [0, 0, 1, 1], depth: 1, card: true, anim: 0, strips: { 0: { url: 'p0.webp', urls: ['p0.webp', 'p1.webp'], ...atlas }, 1: { url: 'q0.webp', urls: ['q0.webp', 'q1.webp'], ...atlas } } },
      { object: 'b', url: 'b.webp', rect: [0, 0, 1, 1], depth: 1, card: true, anim: 0, strips: { 0: { url: 'p0.webp', urls: ['p0.webp', 'p1.webp'], ...atlas } } },
    ] }, loaders, m => warnings.push(m));
    // (animation 1 has a page that is missing: it is left out whole)
    expect(Object.keys(art.masks[0]!.strips!)).toEqual(['0']);
    expect(art.masks[0]!.strips![0]!.data).toHaveLength(2);
    expect(art.masks[0]!.strips![0]!.texture).toBeUndefined();
    expect(warnings).toHaveLength(1);
    // (the mask stills are the only textures; a page two layers share is fetched once)
    expect(textures).toEqual(['a.webp', 'b.webp']);
    expect(fetched.filter(u => u === 'p0.webp')).toHaveLength(1);
    expect(art.masks[1]!.strips![0]!.data![0]).toBe(art.masks[0]!.strips![0]!.data![0]);
    disposeRoomArt(art);
  });

  it('uploads an atlas layer\'s pages whole when that costs less than streaming them, and streams the rest', async () => {
    const fetched: string[] = [];
    const textures: string[] = [];
    const loaders: ArtLoaders = {
      texture: async url => {
        textures.push(url);
        return new Texture();
      },
      page: async url => {
        fetched.push(url);
        return { bytes: 100, crop: async () => ({ close() {} }) };
      },
      model: async () => new Object3D(),
    };
    const cellsOf = (w: number, h: number, n: number) => Array.from({ length: n }, (_, i) => [0, 0, i * h, w, h, 0, 0] as [number, number, number, number, number, number, number]);
    const strip = (url: string, w: number, h: number, n: number) => ({ url, urls: [url], frames: n, delays: Array(n).fill(10) as number[], loop: true, rect: [0, 0, 1, 1] as [number, number, number, number], cell: [w, h] as [number, number], pages: [[w, h * n]] as [number, number][], cells: cellsOf(w, h, n) });
    const art = await loadRoomArt({ masks: [
      // (4 big cells: 4 pages' worth uploaded against a ring of 3 and two surfaces)
      { object: 'glow', url: 'g.webp', rect: [0, 0, 1, 1], depth: 1, card: true, anim: 0, strips: { 0: strip('glow.0.webp', 100, 100, 4) } },
      // (many small cells)
      { object: 'holo', url: 'h.webp', rect: [0, 0, 1, 1], depth: 1, card: true, anim: 0, strips: { 0: strip('holo.0.webp', 100, 100, 40) } },
    ] }, loaders, () => {});
    expect(art.masks[0]!.strips![0]!.data).toBeUndefined();
    expect(art.masks[0]!.strips![0]!.textures).toHaveLength(1);
    expect(art.masks[0]!.strips![0]!.cells).toHaveLength(4);
    expect(art.masks[1]!.strips![0]!.data).toHaveLength(1);
    expect(art.masks[1]!.strips![0]!.texture).toBeUndefined();
    expect(textures).toContain('glow.0.webp');
    expect(textures).not.toContain('holo.0.webp');
    expect(fetched).toEqual(['holo.0.webp']);
    disposeRoomArt(art);
  });

  it('keeps an atlas strip of clear cells, which has no pages, and loads nothing for it', async () => {
    const cfg = parsePresentation("art:\n  rooms:\n    w.s01:\n      plate: art/p.png\n      masks:\n        - { object: w.door, image: art/m.webp, rect: [18, 42, 4, 8], depth: 50, card: true, anim: 0, strips: { '2': { images: [], pages: [], cells: [[0, 0, 0, 0, 0, 0, 0]], frames: 1, cell: [8, 8], rect: [18, 42, 4, 8], delays: [10], loop: false } } }\n");
    const urls = artFromPresentation(cfg, new AssetIndex([['art/m.webp', '/u/m'], ['art/p.png', '/u/p']])).room('w.s01')!;
    expect(urls.masks![0]!.strips![2]).toMatchObject({ urls: [], cells: [[0, 0, 0, 0, 0, 0, 0]] });
    const fetched: string[] = [];
    const art = await loadRoomArt(urls, { texture: async () => new Texture(), page: async u => { fetched.push(u); return { bytes: 1, crop: async () => ({ close() {} }) }; }, model: async () => new Object3D() }, () => {});
    expect(art.masks[0]!.strips![2]!.data).toEqual([]);
    expect(fetched).toEqual([]);
    disposeRoomArt(art);
  });

  it('reads an atlas strip from the presentation: every page through the asset index, and none of it when a page is not there', () => {
    const cfg = (pages: string) => parsePresentation(`art:\n  rooms:\n    w.s01:\n      plate: art/p.png\n      masks:\n        - { object: w.door, image: art/m.webp, rect: [18, 42, 4, 8], depth: 50, card: true, anim: 0, strips: { '0': { images: [${pages}], pages: [[8, 8], [8, 8]], cells: [[0, 0, 0, 8, 8, 0, 0], [1, 0, 0, 8, 8, 0, 0]], frames: 2, cell: [8, 8], rect: [18, 42, 4, 8], delays: [10, 10], loop: true } } }\n`);
    const assets = (have: string[]): AssetIndex => new AssetIndex([...have, 'art/m.webp', 'art/p.png'].map(path => [path, `/u/${path}`] as [string, string]));
    const ok = artFromPresentation(cfg('art/c/0.0.webp, art/c/0.1.webp'), assets(['art/c/0.0.webp', 'art/c/0.1.webp']), () => {}).room('w.s01')!;
    expect(ok.masks![0]!.strips![0]).toMatchObject({ url: '/u/art/c/0.0.webp', urls: ['/u/art/c/0.0.webp', '/u/art/c/0.1.webp'], cell: [8, 8], pages: [[8, 8], [8, 8]] });
    const bad = artFromPresentation(cfg('art/c/0.0.webp, art/c/0.1.webp'), assets(['art/c/0.0.webp']), () => {}).room('w.s01')!;
    expect(bad.masks![0]!.strips).toBeUndefined();
  });

  it('loads each strip as a texture, once for a file two layers share, and drops one that fails, keeping the layer and its still', async () => {
    const loaded: string[] = [];
    const loaders: ArtLoaders = {
      texture: async url => {
        loaded.push(url);
        if (url === 'bad') throw new Error('404');
        return new Texture();
      },
      model: async () => new Object3D(),
    };
    const strip = { frames: 2, delays: [10, 10], loop: true, rect: [0, 0, 1, 1] as [number, number, number, number] };
    const warnings: string[] = [];
    const seen: [number, number][] = [];
    const art = await loadRoomArt({ masks: [
      { object: 'a', url: 'a.webp', rect: [0, 0, 1, 1], depth: 1, card: true, anim: 0, strips: { 0: { url: 'shared', ...strip }, 1: { url: 'bad', ...strip } } },
      { object: 'b', url: 'b.webp', rect: [0, 0, 1, 1], depth: 1, card: true, anim: 0, strips: { 0: { url: 'shared', ...strip } } },
    ] }, loaders, m => warnings.push(m), (done, total) => seen.push([done, total]));
    expect(loaded.filter(u => u === 'shared')).toHaveLength(1);
    expect(art.masks.map(m => m.object)).toEqual(['a', 'b']);
    expect(Object.keys(art.masks[0]!.strips!)).toEqual(['0']);
    expect(art.masks[0]!.strips![0]!.texture).toBe(art.masks[1]!.strips![0]!.texture);
    expect(art.masks[0]!.anim).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('strip of a, animation 1');
    // (the strips are files to load too: the loading screen counts them)
    expect(seen.at(-1)).toEqual([5, 5]);
  });

  it('frees a strip once however many layers use it', async () => {
    const t = new Texture();
    let freed = 0;
    t.dispose = () => { freed++; };
    const loaders: ArtLoaders = { texture: async () => t, model: async () => new Object3D() };
    const strip = { frames: 1, delays: [10], loop: true, rect: [0, 0, 1, 1] as [number, number, number, number] };
    const art = await loadRoomArt({ masks: [
      { object: 'a', url: 'a.webp', rect: [0, 0, 1, 1], depth: 1, strips: { 0: { url: 's', ...strip } } },
      { object: 'b', url: 'b.webp', rect: [0, 0, 1, 1], depth: 1, strips: { 0: { url: 's', ...strip } } },
    ] }, loaders, () => {});
    freed = 0;
    disposeRoomArt(art);
    // (the two stills are one texture here, and one strip: three disposals is the stills' own two and the strip's one)
    expect(freed).toBe(3);
  });
});

describe('shipArtFromPresentation', () => {
  it('resolves a station\'s glb and camera only with set3d (a gltf-only entry is the flat panel without it, and loads no model), and warns once for a glb the index lacks', () => {
    const config = parsePresentation('art:\n  ship:\n    bridge: { gltf: art/ship/bridge.glb }\n    transporter: { gltf: art/ship/gone.glb, camera: camera:pads }\n');
    const warnings: string[] = [];
    const ship = shipArtFromPresentation(config, new AssetIndex([['art/ship/bridge.glb', '/u/b']]), m => warnings.push(m));
    expect(ship('bridge')).toBeUndefined();
    const dev = shipArtFromPresentation(config, new AssetIndex([['art/ship/bridge.glb', '/u/b']]), m => warnings.push(m), { set3d: true });
    expect(dev('bridge')).toEqual({ kind: 'set', gltf: '/u/b', camera: 'camera:main' });
    expect(ship('transporter')).toBeUndefined();
    expect(warnings).toHaveLength(0);
    expect(dev('transporter')).toBeUndefined();
    expect(dev('transporter')).toBeUndefined();
    expect(dev('computer')).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });
});

describe('shipArtFromPresentation, plates (R14)', () => {
  const config = () => parsePresentation([
    'art:', '  ship:',
    '    bridge: { plate: art/ship/bridge/plate.webp, gltf: art/ship/bridge.glb, areas: { bar: [1, 2, 3, 4] }, crew: [{ object: data, at: [10, 20], depth: 5 }] }',
    '    computer: { plate: art/ship/computer/plate.webp }',
    '    transporter: { plate: art/ship/gone.webp }',
  ].join('\n'));
  const assets = () => new AssetIndex([['art/ship/bridge/plate.webp', '/u/p'], ['art/ship/bridge.glb', '/u/g'], ['art/ship/computer/plate.webp', '/u/c']]);

  it('the plate wins by default; set3d with a gltf gives the set; set3d without a gltf gives the plate; a missing plate file warns once and gives undefined', () => {
    const warnings: string[] = [];
    const plain = shipArtFromPresentation(config(), assets(), m => warnings.push(m));
    expect(plain('bridge')).toEqual({ kind: 'plate', plate: '/u/p', areas: { bar: [1, 2, 3, 4] }, crew: [{ object: 'data', at: [10, 20], depth: 5 }] });
    const dev = shipArtFromPresentation(config(), assets(), m => warnings.push(m), { set3d: true });
    expect(dev('bridge')).toEqual({ kind: 'set', gltf: '/u/g', camera: 'camera:main' });
    expect(dev('computer')).toEqual({ kind: 'plate', plate: '/u/c', areas: {}, crew: [] });
    expect(plain('transporter')).toBeUndefined();
    expect(plain('transporter')).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });
});

describe('loadRoomArt', () => {
  it('loads plate, depth, normal and glTF; a failed layer warns and is null', async () => {
    const calls: string[] = [];
    const loaders: ArtLoaders = {
      texture: async (url, color) => {
        calls.push(`${url}:${color}`);
        if (url === 'bad') throw new Error('404');
        return new Texture();
      },
      model: async () => new Object3D(),
    };
    const warnings: string[] = [];
    const art = await loadRoomArt({ plate: 'p', depth: 'd', normal: 'bad', gltf: 'g' }, loaders, m => warnings.push(m));
    expect(art.plate).toBeInstanceOf(Texture);
    expect(art.depth).toBeInstanceOf(Texture);
    expect(art.normal).toBeNull();
    expect(art.model).toBeInstanceOf(Object3D);
    expect(calls.sort()).toEqual(['bad:false', 'd:false', 'p:true']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('normal map');
  });

  it("asks for every mask beside the plate at once, not one after another (B5), and keeps the masks' order", async () => {
    const asked: string[] = [];
    const gates: (() => void)[] = [];
    const loaders: ArtLoaders = {
      texture: url => {
        asked.push(url);
        return new Promise(resolve => gates.push(() => resolve(new Texture())));
      },
      model: async () => new Object3D(),
      alpha: () => null,
    };
    const mask = (o: string) => ({ object: o, url: `${o}.webp`, rect: [0, 0, 1, 1] as [number, number, number, number], depth: 1 });
    const loading = loadRoomArt({ plate: 'p', masks: [mask('a'), mask('b'), mask('c')] }, loaders, () => {});
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(asked).toEqual(['p', 'a.webp', 'b.webp', 'c.webp']);
    for (const g of gates.reverse()) g();
    expect((await loading).masks.map(m => m.object)).toEqual(['a', 'b', 'c']);
  });

  it('counts each file as it finishes, a failed one too, out of all there are', async () => {
    const loaders: ArtLoaders = {
      texture: async url => {
        if (url === 'bad') throw new Error('404');
        return new Texture();
      },
      model: async () => new Object3D(),
    };
    const seen: [number, number][] = [];
    await loadRoomArt({ plate: 'p', normal: 'bad', gltf: 'g', masks: [{ object: 'o', url: 'm', rect: [0, 0, 1, 1], depth: 1 }] }, loaders, () => {}, (done, total) => seen.push([done, total]));
    expect(seen).toEqual([[1, 4], [2, 4], [3, 4], [4, 4]]);
  });
});

describe('half-resolution plates', () => {
  const config = () => parsePresentation([
    'art:', '  rooms:', '    w.s01: { plate: art/rooms/w/s01/plate.webp, depth: art/rooms/w/s01/depth.png }', '    w.s02: { plate: art/rooms/w/s02/plate.webp }',
    '  ship:', '    bridge: { plate: art/ship/bridge/plate.webp, window: art/ship/bridge/window.webp, areas: { bar: [1, 2, 3, 4] }, crew: [] }',
  ].join('\n'));
  const assets = () => new AssetIndex([
    ['art/rooms/w/s01/plate.webp', '/u/s01'], ['art/rooms/w/s01/plate.half.webp', '/u/s01h'], ['art/rooms/w/s01/depth.png', '/u/d'],
    ['art/rooms/w/s02/plate.webp', '/u/s02'],
    ['art/ship/bridge/plate.webp', '/u/b'], ['art/ship/bridge/plate.half.webp', '/u/bh'], ['art/ship/bridge/window.webp', '/u/w'],
  ]);

  it('chooses the half-size plate where one is published, with lowRes, and only the plate', () => {
    const warnings: string[] = [];
    const low = artFromPresentation(config(), assets(), m => warnings.push(m), { lowRes: true });
    expect(low.room('w.s01')).toEqual({ plate: '/u/s01h', depth: '/u/d' });
    // (none published for this one: the full plate, with no warning)
    expect(low.room('w.s02')).toEqual({ plate: '/u/s02' });
    const full = artFromPresentation(config(), assets(), m => warnings.push(m));
    expect(full.room('w.s01')).toEqual({ plate: '/u/s01', depth: '/u/d' });
    expect(warnings).toEqual([]);
  });

  it('does the same for a ship station\'s plate, leaving its window layer', () => {
    const low = shipArtFromPresentation(config(), assets(), () => {}, { lowRes: true });
    expect(low('bridge')).toMatchObject({ kind: 'plate', plate: '/u/bh', window: '/u/w' });
    expect(shipArtFromPresentation(config(), assets())('bridge')).toMatchObject({ plate: '/u/b' });
  });
});

describe('leanLoaders', () => {
  const base: ArtLoaders = { texture: async () => new Texture(), model: async () => new Object3D() };

  it('takes the mip chain off a colour texture that is not a plate, and leaves plates and data textures alone', async () => {
    const lean = leanLoaders(base);
    expect((await lean.texture('art/ship/crew/brdgpica.3.webp', true)).generateMipmaps).toBe(false);
    expect((await lean.texture('art/cards/worf/78.webp', true)).generateMipmaps).toBe(false);
    expect((await lean.texture('art/rooms/lab/s01/plate.half.webp', true)).generateMipmaps).toBe(true);
    expect((await lean.texture('art/rooms/lab/s01/plate.webp', true)).generateMipmaps).toBe(true);
    expect((await lean.texture('art/rooms/lab/s01/depth.png', false)).generateMipmaps).toBe(true);
  });
});
