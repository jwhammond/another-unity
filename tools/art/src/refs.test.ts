// SPDX-License-Identifier: GPL-3.0-or-later
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { decodePng, encodePng } from './image';
import { Jellyfin } from './jellyfin';
import { ffmpegArgs, grabRefs, makeGrabber, manifestSchema, recordHashes, refFile, scan, type FrameGrabber, type Manifest } from './refs';
import { fakeJellyfin } from './testing/fakeJellyfin';

const KEY = 'SENTINEL-KEY-0f9e';
const ITEM = 'a'.repeat(32);
const ITEM2 = 'b'.repeat(32);
const ref = (over: object = {}) => ({ item: ITEM, season: 6, episode: 10, ms: 5000, crop: [2, 1, 4, 3], tags: ['crew:riker', 'view:face'], sha256: 'pending', ...over });

/** A frame whose pixel (x, y) is (x, y, ms/100) so crops are checkable. */
function frame(ms: number, w = 16, h = 12): Uint8Array {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set([x, y, Math.round(ms / 100) & 255, 255], (y * w + x) * 4);
  return encodePng({ width: w, height: h, data });
}

/** Writes `<ms>.png` for each ms, as the real grabber does, and counts how often it streamed. */
function fakeGrabber(): FrameGrabber & { calls: number[][] } {
  const calls: number[][] = [];
  return {
    calls,
    async grab(input, ms, outDir) {
      await input.cancel();
      calls.push([...ms]);
      mkdirSync(outDir, { recursive: true });
      return ms.map(t => {
        const f = join(outDir, `${t}.png`);
        writeFileSync(f, frame(t));
        return f;
      });
    },
  };
}

describe('manifestSchema', () => {
  const ok = { series: 'c'.repeat(32), refs: { 'crew.riker.face.1': ref() } };
  it('accepts a well-formed manifest and the empty one', () => {
    expect(manifestSchema.parse(ok).refs['crew.riker.face.1']!.crop).toEqual([2, 1, 4, 3]);
    expect(manifestSchema.parse({ series: 'c'.repeat(32), refs: {} }).refs).toEqual({});
  });
  it('refuses unknown fields, titles, and tags outside the vocabulary', () => {
    expect(() => manifestSchema.parse({ ...ok, refs: { a: ref({ title: 'x' }) } })).toThrow();
    expect(() => manifestSchema.parse({ ...ok, name: 'x' })).toThrow();
    for (const tag of ['crew:Riker', 'view:selfie', 'set:ten-forward', 'material:velvet', 'light:dim', 'actor:someone', 'Riker']) {
      expect(() => manifestSchema.parse({ ...ok, refs: { a: ref({ tags: [tag] }) } }), tag).toThrow();
    }
    for (const tag of ['set:lab', 'material:conduit', 'light:alarm', 'view:profile-left', 'crew:laforge']) {
      expect(() => manifestSchema.parse({ ...ok, refs: { a: ref({ tags: [tag] }) } }), tag).not.toThrow();
    }
    expect(() => manifestSchema.parse({ ...ok, refs: { a: ref({ sha256: 'abc' }) } })).toThrow();
    expect(() => manifestSchema.parse({ ...ok, refs: { '../x': ref() } })).toThrow();
  });
});

describe('ship manifest additions', () => {
  const m = (refs: object) => manifestSchema.parse({ series: 'c'.repeat(32), refs });
  it('accepts the new set and material tags and still refuses unknown ones', () => {
    for (const tag of ['set:bridge', 'set:observation-lounge', 'set:transporter-room', 'set:astrogation', 'material:carpet', 'material:wood-rail', 'material:ceiling-panel', 'material:pad']) {
      expect(() => m({ a: ref({ tags: [tag] }) }), tag).not.toThrow();
    }
    for (const tag of ['set:ten-forward', 'material:velvet', 'set:Bridge']) expect(() => m({ a: ref({ tags: [tag] }) }), tag).toThrow();
  });
  it('refFile finds an id in ship.yaml and throws on an id present in both manifests', () => {
    const cache = mkdtempSync(join(tmpdir(), 'refs-'));
    mkdirSync(join(cache, 'crops'));
    writeFileSync(join(cache, 'crops', 'set.bridge.1.png'), 'x');
    writeFileSync(join(cache, 'crops', 'dup.png'), 'x');
    const show = m({ dup: ref() });
    const ship = m({ 'set.bridge.1': ref({ tags: ['set:bridge'] }), dup: ref() });
    expect(refFile(cache, 'set.bridge.1', [show, ship])).toBe(join(cache, 'crops', 'set.bridge.1.png'));
    expect(() => refFile(cache, 'dup', [show, ship])).toThrow(/2 manifests/);
    expect(() => refFile(cache, 'nope', [show, ship])).toThrow(/no ref "nope"/);
  });
  it('grab on the ship manifest writes crops under crops/ and recordHashes fills only that manifest', async () => {
    const fake = await fakeJellyfin({ key: KEY, video: new Uint8Array([9]) });
    const j = new Jellyfin({ url: fake.url, key: KEY });
    const cache = mkdtempSync(join(tmpdir(), 'refs-'));
    const ship = m({ 'set.bridge.1': ref({ tags: ['set:bridge'] }) });
    const text = `series: ${'c'.repeat(32)}\nrefs:\n  set.bridge.1: { item: ${ITEM}, season: 6, episode: 10, ms: 5000, crop: [ 2, 1, 4, 3 ], tags: [ set:bridge ], sha256: pending }\n`;
    const res = await grabRefs(j, fakeGrabber(), ship, cache, { record: true });
    await fake.close();
    expect(existsSync(join(cache, 'crops', 'set.bridge.1.png'))).toBe(true);
    const out = recordHashes(text, res);
    expect(out).toContain(res[0]!.sha256);
    expect(out).not.toContain('pending');
    expect(manifestSchema.parse(parseYaml(out)).refs['set.bridge.1']!.sha256).toBe(res[0]!.sha256);
  });
});

describe('ffmpeg grabber', () => {
  it('reads pipe:0 and selects every timestamp in one process; argv and env carry no key', async () => {
    const spawned: { cmd: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const spawnFn = ((cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      spawned.push({ cmd, args, env: opts.env });
      const p = new EventEmitter() as EventEmitter & { stdin: PassThrough; stderr: PassThrough };
      p.stdin = new PassThrough();
      p.stderr = new PassThrough();
      p.stdin.resume();
      const pattern = args[args.length - 1]!;
      setImmediate(() => {
        // two targets, in time order
        for (let i = 0; i < 2; i++) writeFileSync(pattern.replace('%06d', String(i).padStart(6, '0')), frame(i));
        p.emit('close', 0);
      });
      return p;
    }) as never;
    const out = mkdtempSync(join(tmpdir(), 'grab-'));
    process.env.JELLYFIN_KEY = KEY; // even with the key in this process's env, the child must not get it
    try {
      const files = await makeGrabber(spawnFn).grab(new Response(new Uint8Array([1, 2, 3])).body!, [9000, 1000], out);
      expect(files).toEqual([join(out, '9000.png'), join(out, '1000.png')]);
      expect(readdirSync(out).sort()).toEqual(['1000.png', '9000.png']);
    } finally {
      delete process.env.JELLYFIN_KEY;
    }
    expect(spawned).toHaveLength(1);
    const { cmd, args, env } = spawned[0]!;
    expect(cmd).toBe('ffmpeg');
    expect(args[args.indexOf('-i') + 1]).toBe('pipe:0');
    expect(args[args.indexOf('-frames:v') + 1]).toBe('2');
    const vf = args[args.indexOf('-vf') + 1]!;
    expect(vf).toContain('1.000');
    expect(vf).toContain('9.000');
    expect(JSON.stringify(args)).not.toContain(KEY);
    expect(JSON.stringify(env)).not.toContain(KEY);
    expect(Object.keys(env).sort()).toEqual(['HOME', 'PATH']);
  });

  it('ffmpegArgs puts times in ascending-friendly select terms', () => {
    const a = ffmpegArgs([1500], '/x/%06d.png');
    expect(a).toContain('pipe:0');
    expect(a.join(' ')).toContain('gte(t,1.500)');
  });

  it('fails when ffmpeg wrote fewer frames than asked for', async () => {
    const spawnFn = (() => {
      const p = new EventEmitter() as EventEmitter & { stdin: PassThrough; stderr: PassThrough };
      p.stdin = new PassThrough();
      p.stderr = new PassThrough();
      p.stdin.resume();
      setImmediate(() => p.emit('close', 0));
      return p;
    }) as never;
    const out = mkdtempSync(join(tmpdir(), 'grab-'));
    await expect(makeGrabber(spawnFn).grab(new Response('x').body!, [1000], out)).rejects.toThrow(/0 of 1/);
  });
});

describe('grabRefs', () => {
  const manifest = (): Manifest =>
    manifestSchema.parse({
      series: 'c'.repeat(32),
      refs: {
        'crew.riker.face.1': ref({ ms: 5000 }),
        'crew.riker.face.2': ref({ ms: 7000, crop: [0, 0, 2, 2] }),
        'crew.troi.face.1': ref({ item: ITEM2, ms: 3000, tags: ['crew:troi', 'view:face'] }),
      },
    });
  const jf = async () => {
    const fake = await fakeJellyfin({ key: KEY, video: new Uint8Array([9]) });
    return { fake, j: new Jellyfin({ url: fake.url, key: KEY }) };
  };

  it('groups by item (one pass each), crops, and records sha256 with record', async () => {
    const { fake, j } = await jf();
    const g = fakeGrabber();
    const cache = mkdtempSync(join(tmpdir(), 'refs-'));
    const res = await grabRefs(j, g, manifest(), cache, { record: true });
    await fake.close();
    expect(g.calls.map(c => c.sort())).toEqual([[5000, 7000], [3000]]);
    expect(res.every(r => r.matched && /^[0-9a-f]{64}$/.test(r.sha256))).toBe(true);
    const crop = decodePng(new Uint8Array(readFileSync(refFile(cache, 'crew.riker.face.1'))));
    expect([crop.width, crop.height]).toEqual([4, 3]);
    expect([...crop.data.subarray(0, 4)]).toEqual([2, 1, 50, 255]);
    expect(existsSync(join(cache, 'frames', ITEM, '5000.png'))).toBe(true);
  });

  it('checks a recorded hash: a match passes, a mismatch is re-grabbed once and then flagged', async () => {
    const { fake, j } = await jf();
    const cache = mkdtempSync(join(tmpdir(), 'refs-'));
    const g1 = fakeGrabber();
    const recorded = await grabRefs(j, g1, manifest(), cache, { record: true });
    const m = manifest();
    for (const r of recorded) m.refs[r.id]!.sha256 = r.sha256;
    const g2 = fakeGrabber();
    expect((await grabRefs(j, g2, m, cache)).every(r => r.matched)).toBe(true);
    expect(g2.calls).toEqual([]); // frames were cached
    m.refs['crew.troi.face.1']!.sha256 = 'f'.repeat(64);
    const g3 = fakeGrabber();
    const res = await grabRefs(j, g3, m, cache);
    await fake.close();
    expect(res.find(r => r.id === 'crew.troi.face.1')!.matched).toBe(false);
    expect(res.filter(r => r.matched)).toHaveLength(2);
    expect(g3.calls).toEqual([[3000]]); // the one re-grab
  });

  it('honours only, and names an unknown id', async () => {
    const { fake, j } = await jf();
    const g = fakeGrabber();
    const cache = mkdtempSync(join(tmpdir(), 'refs-'));
    const res = await grabRefs(j, g, manifest(), cache, { only: ['crew.troi.face.1'] });
    expect(res.map(r => r.id)).toEqual(['crew.troi.face.1']);
    await expect(grabRefs(j, g, manifest(), cache, { only: ['nope'] })).rejects.toThrow(/nope/);
    await fake.close();
  });

  it('refFile names the command that makes a missing crop', () => {
    expect(() => refFile(mkdtempSync(join(tmpdir(), 'refs-')), 'x.y')).toThrow(/refs grab --only x\.y/);
  });

  it('rejects a crop outside the frame', async () => {
    const { fake, j } = await jf();
    const m = manifestSchema.parse({ series: 'c'.repeat(32), refs: { a: ref({ crop: [10, 10, 20, 20] }) } });
    await expect(grabRefs(j, fakeGrabber(), m, mkdtempSync(join(tmpdir(), 'refs-')))).rejects.toThrow(/outside/);
    await fake.close();
  });

  it('no file written under the cache contains the sentinel', async () => {
    const { fake, j } = await jf();
    const cache = mkdtempSync(join(tmpdir(), 'refs-'));
    await grabRefs(j, fakeGrabber(), manifest(), cache, { record: true });
    await fake.close();
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    const files = walk(cache);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(readFileSync(f).includes(KEY), f).toBe(false);
  });
});

describe('scan', () => {
  it('writes 6x5 contact sheets of 240 px thumbnails and a labelled html, with full frames in frames/<item>', async () => {
    const { fake, j } = await (async () => {
      const f = await fakeJellyfin({ key: KEY, video: new Uint8Array([9]) });
      return { fake: f, j: new Jellyfin({ url: f.url, key: KEY }) };
    })();
    const root = mkdtempSync(join(tmpdir(), 'scan-'));
    const g = fakeGrabber();
    // 70 s at one frame per second apart from the start: 69 frames -> 3 sheets
    const sheets = await scan(j, g, { item: ITEM, season: 1, episode: 2, ms: 70_000 }, 1, join(root, 'sheets'));
    await fake.close();
    expect(sheets.map(s => s.split('/').pop())).toEqual(['s1e2-1.png', 's1e2-2.png', 's1e2-3.png']);
    const first = decodePng(new Uint8Array(readFileSync(sheets[0]!)));
    expect([first.width, first.height]).toEqual([6 * 240, 5 * 180]);
    expect(g.calls).toHaveLength(1);
    expect(g.calls[0]).toHaveLength(69);
    const html = readFileSync(join(root, 'sheets', 's1e2-1.html'), 'utf8');
    expect(html).toContain('0:01 (1000 ms)');
    expect(html).toContain('0:30 (30000 ms)');
    expect(existsSync(join(root, 'frames', ITEM, '1000.png'))).toBe(true);
  });
});
