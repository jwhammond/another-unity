// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { SITE_PAGES } from '../../src/swRules';
import type { Manifest } from '../../src/swRules';
import { checkLiftedText, checkManifest, checkHeadersFile, checkLimits, checkNames, checkRequired, checkSealed, checkText, MAX_FILE_BYTES, MAX_FILES, summarize } from './check';

const f = (path: string, size = 10) => ({ path, size });
const fails = <T extends { level: string }>(x: T[]) => x.filter(i => i.level === 'fail');

describe('deploy checks: limits', () => {
  it('passes a build within Pages limits', () => {
    expect(checkLimits([f('a.js', 1000)])).toEqual([]);
    expect(fails(checkLimits([f('a.js', MAX_FILE_BYTES)]))).toEqual([]);
  });
  it('fails over 20,000 files, and warns near it', () => {
    const many = Array.from({ length: MAX_FILES + 1 }, (_, i) => f(`a/${i}.opus`));
    expect(fails(checkLimits(many))[0]?.message).toMatch(/20000.*bundle|limit of 20000/i);
    expect(checkLimits(many.slice(0, 19_000)).map(i => i.level)).toEqual(['warn']);
  });
  it('fails a file over 25 MiB with a suggestion, and warns near it', () => {
    const out = checkLimits([f('assets/big.js', MAX_FILE_BYTES + 1), f('assets/near.js', MAX_FILE_BYTES * 0.95)]);
    expect(fails(out)).toHaveLength(1);
    expect(fails(out)[0]!.message).toMatch(/big\.js.*Split|recompress/);
    expect(out.filter(i => i.level === 'warn')).toHaveLength(1);
  });
});

describe('deploy checks: what must not ship', () => {
  it('fails source maps, env files, traces, jellyfin config, keys and raw sources', () => {
    const bad = ['assets/a.js.map', '.env', 'jellyfin.env', 'x/.env.local', 'trace.jsonl', 'traces/a.json', 'walk/a.walk', 'a/key.pem', 'game.yaml', 'src/main.ts', '.git/config', '.dev.vars', 'functions/_middleware.ts', 'notes.md'];
    for (const p of bad) expect(fails(checkNames([f(p)])).length, p).toBeGreaterThan(0);
  });
  it('lets the build through', () => {
    for (const p of ['index.html', 'sw.js', '_headers', 'au-manifest.json', 'assets/index-AbC.js', 'assets/x.webp', 'assets/v.opus', 'assets/engineering-X.pack', 'manifest.webmanifest']) {
      expect(checkNames([f(p)]), p).toEqual([]);
    }
  });
  it('fails dev hooks, secrets and source-map references inside code', () => {
    for (const t of ['window.__au={ready:1}', 'x.astroKnow(1,2)', '//# sourceMappingURL=a.js.map', 'process.env.JELLYFIN_API_KEY', 'SITE_PASSWORD', 'const p="/Us' + 'ers/me/pcode/x"', 'exposeDebug(a)', '"Dev tools"']) {
      expect(fails(checkText('a.js', t)), t).toHaveLength(1);
    }
  });
  it('does not mistake the player-facing offline handle for the test handle', () => {
    expect(checkText('a.js', 'window.__auCache={}')).toEqual([]);
  });
});

describe('deploy checks: the rest', () => {
  const REQUIRED = [...SITE_PAGES.map(p => `${p.slice(1)}index.html`), 'play/afu/index.html', 'sw.js', 'au-manifest.json', '_headers'];
  it('needs every site page, the game, the worker, manifest and headers', () => {
    expect(checkRequired(REQUIRED.map(p => f(p)))).toEqual([]);
    expect(checkRequired([f('index.html')]).map(i => i.message).join()).toMatch(/engineering\/index\.html.*sw\.js.*au-manifest.*_headers/);
    expect(checkRequired(REQUIRED.filter(p => p !== 'play/afu/index.html').map(p => f(p))).map(i => i.message).join()).toMatch(/play\/afu\/index\.html/);
  });
  it('fails a build that lacks one site page', () => {
    const msgs = checkRequired(REQUIRED.filter(p => p !== 'engineering/afu/missions/zoo/index.html').map(p => f(p)));
    expect(msgs).toEqual([{ level: 'fail', message: 'engineering/afu/missions/zoo/index.html is missing from the output.' }]);
  });
  it('fails a leftover site-media.tmp folder', () => {
    expect(fails(checkNames([f('site-media.tmp/a.webp')])).length).toBeGreaterThan(0);
    expect(fails(checkNames([f('.site-media.tmp/manifest.json')])).length).toBeGreaterThan(0);
  });
  it('lets the site media through', () => {
    expect(checkNames([f('site-media/room-frigis-s0d.webp'), f('site-media/manifest.json')])).toEqual([]);
  });
  it('fails a precache entry that is not in the output, and a site page the manifest leaves out', () => {
    const pages = SITE_PAGES.map(p => `${p}index.html`);
    const files = [...pages.map(p => f(p.slice(1))), f('assets/a.js')];
    expect(checkManifest(files, JSON.stringify({ shell: [...pages, '/assets/a.js'], data: [] }))).toEqual([]);
    expect(checkManifest(files, JSON.stringify({ shell: [...pages, '/assets/engineering-X.js'], data: [] })).map(i => i.message).join()).toMatch(/engineering-X\.js/);
    expect(checkManifest(files, JSON.stringify({ shell: pages.filter(p => !p.includes('zoo')), data: [] })).map(i => i.message)).toEqual(['au-manifest.json does not precache /engineering/afu/missions/zoo/index.html.']);
  });
  it('holds _headers to Pages limits', () => {
    expect(checkHeadersFile('/*\n  X: 1\n')).toEqual([]);
    expect(fails(checkHeadersFile(Array.from({ length: 101 }, (_, i) => `/p${i}\n  X: 1`).join('\n')))).toHaveLength(1);
    expect(fails(checkHeadersFile(`/*\n  X: ${'a'.repeat(2000)}`))).toHaveLength(1);
  });
  it('summarizes totals, largest and types', () => {
    const r = summarize([f('a.js', 5), f('b.opus', 50), f('c.opus', 20)], 2);
    expect(r).toMatchObject({ count: 3, total: 75 });
    expect(r.largest.map(x => x.path)).toEqual(['b.opus', 'c.opus']);
    expect(r.byExt[0]).toEqual({ ext: 'opus', count: 2, bytes: 70 });
  });
});

describe('deploy checks: the gate', () => {
  const SEALED_HEAD = new Uint8Array([0x41, 0x55, 0x47, 0x54, 1, ...new Array<number>(12).fill(7)]);
  const manifest = (sealed: string[]): Manifest => ({ version: 'x', shell: [], data: [], assets: [], sealed });
  // (made-up files: what each starts with, and its hash)
  const heads: Record<string, Uint8Array> = {
    'assets/room-A.webp': SEALED_HEAD,
    'assets/line-B.opus': new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    'assets/main-C.js': new TextEncoder().encode('(function(){var a=1'),
    'site-media/before.webp': new TextEncoder().encode('RIFF....WEBPVP8 ..'),
  };
  const hashes: Record<string, string> = { 'assets/room-A.webp': 'h-sealed', 'assets/line-B.opus': 'h-b', 'assets/main-C.js': 'h-js', 'site-media/before.webp': 'h-site' };
  const files = Object.keys(heads).map(p => f(p));
  const head = (p: string) => heads[p]!;
  const hash = (p: string) => hashes[p]!;

  it('passes sealed files with the header and plain files that match no game file', () => {
    expect(checkSealed(files, manifest(['/assets/room-A.webp']), head, new Set(['h-other']), hash)).toEqual([]);
  });

  it('checkSealed fails on a plain file and on a missing header', () => {
    // (a sealed URL whose file is a plain one: no header)
    const noHeader = checkSealed(files, manifest(['/assets/room-A.webp', '/assets/line-B.opus']), head, new Set(), hash);
    expect(fails(noHeader).map(i => i.message)).toEqual(['assets/line-B.opus: listed as sealed, but has no sealed header.']);
    // (a shipped file that is a byte-for-byte copy of a file under games/unity)
    const plain = checkSealed(files, manifest(['/assets/room-A.webp']), head, new Set(['h-b']), hash);
    expect(fails(plain).map(i => i.message)).toEqual(['assets/line-B.opus: a plain copy of a file from games/unity.']);
    // (a sealed URL that isn't in the output at all)
    const gone = checkSealed(files, manifest(['/assets/room-A.webp', '/assets/gone-D.webm']), head, new Set(), hash);
    expect(fails(gone).map(i => i.message)).toEqual(['assets/gone-D.webm: listed as sealed, but not in the output.']);
  });

  it('checkLiftedText fails without quoting', () => {
    const sample = ['A purple teapot argues with the lighthouse keeper.', 'Seven "paper" boats sail across the table.'];
    expect(checkLiftedText('assets/main-C.js', 'var a="nothing of the game here";', sample)).toEqual([]);
    const out = checkLiftedText('assets/main-C.js', 'var a="A purple teapot argues with the lighthouse keeper.";', sample);
    expect(out).toEqual([{ level: 'fail', message: 'assets/main-C.js: holds lifted game text (1 sampled string).' }]);
    expect(out[0]!.message).not.toContain('teapot');
    // (as a JS or JSON string literal escapes it, too)
    expect(fails(checkLiftedText('a.json', '{"t":"Seven \\"paper\\" boats sail across the table."}', sample))).toHaveLength(1);
  });
});
