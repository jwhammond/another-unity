// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildManifest, cacheNames, classify, contentTypeFor, inSealedDir, isCacheable, LOCKED_STATUS, lockedResponse, navigationVerdict, parseRange,
  precacheFetchUrl, type ResponseInfo, rangeResponse, sealedResponse, sealedVerdict, staleAssetKeys, staleCaches, withVersionMeta } from './swRules';
import { requestPersistence, wantsWorker } from './swRegister';

describe('classify (production)', () => {
  const prod = (path: string, navigate = false) => classify(path, { dev: false, navigate });
  it('sends the index and the code to the shell', () => {
    expect(prod('/')).toBe('shell');
    expect(prod('/index.html')).toBe('shell');
    expect(prod('/anything', true)).toBe('shell');
    expect(prod('/assets/boot-a1b2.js')).toBe('shell');
    expect(prod('/assets/unity-a1b2.css')).toBe('shell');
    expect(prod('/icon.svg')).toBe('shell');
    expect(prod('/play/afu/')).toBe('shell');
    expect(prod('/play/afu/index.html')).toBe('shell');
    expect(prod('/engineering/')).toBe('shell');
  });
  it('sends yaml and json to the game data', () => {
    expect(prod('/assets/presentation-ab12.yaml')).toBe('data');
    expect(prod('/assets/room-ab12.json')).toBe('data');
    expect(prod('/assets/unity-B2P0tHm7.js')).toBe('data');
    // (combat.yaml's own chunk, read when a battle needs it: Plan 24)
    expect(prod('/assets/combat-Bs-PVSpr.js')).toBe('data');
    expect(prod('/assets/three-CKDxT2sb.js')).toBe('shell');
  });
  it('tells combat.yaml\'s data chunk from the space view\'s code chunk (Plan 25): the view is shell, precached with the code', () => {
    expect(prod('/assets/combat-Bs-PVSpr.js')).toBe('data');
    expect(prod('/assets/spaceScene-Dk3_x9Qa.js')).toBe('shell');
    // (a code chunk named combat-<something>-<hash> is not the data chunk)
    expect(prod('/assets/combat-view-Dk3_x9Qa.js')).toBe('shell');
    expect(prod('/assets/unity-K09qQCIf.js')).toBe('data');
    const m = buildManifest('v1', [{ path: 'assets/combat-Bs-PVSpr.js', size: 1 }, { path: 'assets/spaceScene-Dk3_x9Qa.js', size: 1 }]);
    expect([m.data, m.shell.includes('/assets/spaceScene-Dk3_x9Qa.js')]).toEqual([['/assets/combat-Bs-PVSpr.js'], true]);
  });
  it('sends art, audio, movies and models to the assets cache', () => {
    for (const f of ['a.webp', 'a.png', 'a.opus', 'a.ogg', 'a.wav', 'a.webm', 'a.mp4', 'a.glb']) expect(prod(`/assets/${f}`)).toBe('assets');
  });
  it('leaves the manifest, the worker, other origins of path and unknown files to the network', () => {
    expect(prod('/au-manifest.json')).toBeNull();
    expect(prod('/sw.js')).toBeNull();
    expect(prod('/elsewhere/a.webp')).toBeNull();
    expect(prod('/assets/readme.txt')).toBeNull();
  });
});

describe('classify (dev server)', () => {
  const dev = (path: string, search = '') => classify(path, { dev: true, search });
  it('caches only media', () => {
    expect(dev('/@fs/home/x/games/unity/art/rooms/a.webp')).toBe('assets');
    expect(dev('/@fs/home/x/games/unity/audio/voice/a.opus')).toBe('assets');
    expect(dev('/@fs/home/x/games/unity/movies/a.webm')).toBe('assets');
  });
  it('never touches code, HMR, yaml, or an import of a media file as a module', () => {
    for (const p of ['/', '/src/boot.ts', '/@vite/client', '/@id/x', '/node_modules/.vite/deps/three.js', '/@fs/x/games/unity/game.yaml', '/index.html']) {
      expect(dev(p)).toBeNull();
    }
    expect(classify('/x/a.png', { dev: true, navigate: true })).toBe('assets');
    expect(dev('/x/a.png', '?import')).toBeNull();
    expect(dev('/x/a.png', '?url&import')).toBeNull();
    expect(dev('/x/a.png', '?raw')).toBeNull();
  });
});

describe('versioned caches', () => {
  it('names the caches by the build, the media cache without it', () => {
    expect(cacheNames('abc', false)).toEqual({ shell: 'au-shell-abc', data: 'au-data-abc', assets: 'au-assets' });
  });
  it('deletes the caches of other builds, and nothing that is not ours', () => {
    const existing = ['au-shell-old', 'au-data-old', 'au-shell-new', 'au-data-new', 'au-assets', 'au-dev-assets', 'workbox-x', 'other'];
    expect(staleCaches(existing, 'new', false)).toEqual(['au-shell-old', 'au-data-old', 'au-dev-assets']);
  });
  it('keeps only the dev media cache under the dev server', () => {
    expect(staleCaches(['au-dev-assets', 'au-shell-old', 'au-assets', 'x'], 'dev', true)).toEqual(['au-shell-old', 'au-assets']);
  });
  it('prunes media the new build does not list', () => {
    const cached = ['http://h/assets/a-1.webp', 'http://h/assets/b-1.opus', 'http://h/assets/c-2.webm'];
    expect(staleAssetKeys(cached, ['/assets/a-1.webp', '/assets/c-2.webm'])).toEqual(['http://h/assets/b-1.opus']);
  });
});

describe('Range requests from a cached full response', () => {
  const full = () => new Response(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), { headers: { 'Content-Type': 'audio/ogg' } });
  it('parses single ranges', () => {
    expect(parseRange('bytes=2-4', 10)).toEqual({ start: 2, end: 4 });
    expect(parseRange('bytes=6-', 10)).toEqual({ start: 6, end: 9 });
    expect(parseRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange('bytes=5-99', 10)).toEqual({ start: 5, end: 9 });
    expect(parseRange('bytes=10-', 10)).toBe('unsatisfiable');
    expect(parseRange('bytes=0-1,4-5', 10)).toBeNull();
  });
  it('answers 206 with the slice and its headers', async () => {
    const r = await rangeResponse(full(), 'bytes=2-4');
    expect(r.status).toBe(206);
    expect(r.headers.get('Content-Range')).toBe('bytes 2-4/10');
    expect(r.headers.get('Content-Length')).toBe('3');
    expect(r.headers.get('Content-Type')).toBe('audio/ogg');
    expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([2, 3, 4]);
  });
  it('answers an open-ended range to the end, and 416 past it', async () => {
    const open = await rangeResponse(full(), 'bytes=0-');
    expect(open.headers.get('Content-Range')).toBe('bytes 0-9/10');
    const past = await rangeResponse(full(), 'bytes=20-');
    expect(past.status).toBe(416);
    expect(past.headers.get('Content-Range')).toBe('bytes */10');
  });
  it('serves the whole file for a range it does not understand', async () => {
    expect((await rangeResponse(full(), 'bytes=0-1,4-5')).status).toBe(200);
  });
});

describe('the manifest', () => {
  it('sorts a build into shell, data and assets, and leaves out its own files', () => {
    const m = buildManifest('v1', [
      { path: 'assets/b.webp', size: 5 },
      { path: 'assets/a.js', size: 1 },
      { path: 'assets/a.css', size: 1 },
      { path: 'assets/g.yaml', size: 2 },
      { path: 'au-manifest.json', size: 9 },
      { path: 'sw.js', size: 9 },
      { path: 'index.html', size: 3 },
      { path: 'assets/m.webm', size: 50 },
    ]);
    expect(m.version).toBe('v1');
    expect(m.shell).toEqual(['/index.html', '/icon.svg', '/manifest.webmanifest', '/assets/a.css', '/assets/a.js']);
    expect(m.data).toEqual(['/assets/g.yaml']);
    const withPages = buildManifest('v1', [{ path: 'index.html', size: 3 }, { path: 'play/afu/index.html', size: 3 }, { path: 'engineering/index.html', size: 3 }]);
    expect(withPages.shell).toEqual(['/index.html', '/play/afu/index.html', '/icon.svg', '/manifest.webmanifest', '/engineering/index.html']);
    expect(m.assets).toEqual([{ url: '/assets/b.webp', size: 5 }, { url: '/assets/m.webm', size: 50 }]);
    expect(m.sealed).toEqual([]);
  });

  it('buildManifest lists the sealed files and not check.bin', () => {
    const m = buildManifest('v1', [
      { path: 'assets/r-Ab12.webp', size: 5, sources: ['../../games/unity/.sealed/art/rooms/r.webp'] },
      { path: 'assets/content-Cd34.pack', size: 7, sources: ['../../games/unity/.sealed/content.pack'] },
      { path: 'assets/v-Ef56.opus', size: 3, sources: ['..\\..\\games\\unity\\.sealed\\audio\\voice\\v.opus'] },
      { path: 'assets/check-Gh78.bin', size: 1, sources: ['../../games/unity/.sealed/check.bin'] },
      // (the plain game's files, and a file of the same name outside .sealed, are not sealed)
      { path: 'assets/p-Ij90.webp', size: 5, sources: ['../../games/unity/art/rooms/p.webp'] },
      { path: 'assets/q-Kl12.webp', size: 5, sources: ['../../games/other/.sealed/art/q.webp'] },
      { path: 'assets/a.js', size: 1 },
    ]);
    expect(m.sealed).toEqual(['/assets/content-Cd34.pack', '/assets/r-Ab12.webp', '/assets/v-Ef56.opus']);
    // (a sealed file is still in its bucket: the worker caches it as before and opens it as it serves it)
    expect(m.assets.map(a => a.url)).toContain('/assets/r-Ab12.webp');
  });

  it('never lets the build inline a file under .sealed, check.bin included (vite.config.ts assetsInlineLimit)', () => {
    expect(inSealedDir('/home/u/au/games/unity/.sealed/check.bin')).toBe(true);
    expect(inSealedDir('C:\\au\\games\\unity\\.sealed\\audio\\s.opus')).toBe(true);
    expect(inSealedDir('/home/u/au/games/unity/audio/s.opus')).toBe(false);
    expect(inSealedDir('/home/u/au/tools/play/fixtures/demo/audio/s.wav')).toBe(false);
  });
});

describe('precache', () => {
  it('asks for a page by its folder (Pages redirects /x/index.html to /x/), and for anything else by its name', () => {
    expect(precacheFetchUrl('/index.html')).toBe('/');
    expect(precacheFetchUrl('/play/afu/index.html')).toBe('/play/afu/');
    expect(precacheFetchUrl('/assets/main-AbC.js')).toBe('/assets/main-AbC.js');
    expect(precacheFetchUrl('/icon.svg')).toBe('/icon.svg');
  });
});

describe('registration', () => {
  it('is off with ?sw=0, insecure pages, or no worker support', () => {
    expect(wantsWorker('', true, true)).toBe(true);
    expect(wantsWorker('?game=unity&sw=0', true, true)).toBe(false);
    expect(wantsWorker('', false, true)).toBe(false);
    expect(wantsWorker('', true, false)).toBe(false);
  });
  it('handles persistent storage being refused, missing or throwing', async () => {
    expect(await requestPersistence({ persist: async () => true, persisted: async () => false })).toBe('granted');
    expect(await requestPersistence({ persist: async () => false, persisted: async () => false })).toBe('denied');
    expect(await requestPersistence({ persist: async () => { throw new Error('no'); }, persisted: async () => false })).toBe('error');
    expect(await requestPersistence(undefined)).toBe('unsupported');
  });
});

describe('the gate (Access, Basic Auth) and the cache', () => {
  const res = (o: Partial<{ status: number; type: string; redirected: boolean; ct: string }> = {}): ResponseInfo => ({
    status: o.status ?? 200,
    type: o.type ?? 'basic',
    redirected: o.redirected ?? false,
    headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? (o.ct ?? 'image/webp') : null) },
  });

  it('keeps a plain 200 from our own origin', () => {
    expect(isCacheable('/assets/a-1.webp', res())).toBe(true);
    expect(isCacheable('/assets/a-1.js', res({ ct: 'text/javascript' }))).toBe(true);
    expect(isCacheable('/au-manifest.json', res({ ct: 'application/json' }))).toBe(true);
    expect(isCacheable('/index.html', res({ ct: 'text/html; charset=utf-8' }))).toBe(true);
    expect(isCacheable('/play/afu/index.html', res({ ct: 'text/html; charset=utf-8' }))).toBe(true);
    expect(isCacheable('/engineering/', res({ ct: 'text/html; charset=utf-8' }))).toBe(true);
  });

  it('never keeps a redirect, an opaque response, a 401 or 403, an error or a partial answer', () => {
    for (const r of [res({ status: 302 }), res({ type: 'opaqueredirect', status: 0 }), res({ type: 'opaque', status: 0 }), res({ type: 'cors' }),
      res({ status: 401 }), res({ status: 403 }), res({ status: 404 }), res({ status: 500 }), res({ status: 206 })]) {
      expect(isCacheable('/assets/a-1.webp', r)).toBe(false);
    }
  });

  it("never keeps a response that went through a redirect (Access's sign-in page, fetched with the redirect followed)", () => {
    expect(isCacheable('/assets/a-1.webp', res({ redirected: true, ct: 'text/html' }))).toBe(false);
    expect(isCacheable('/assets/a-1.webp', res({ redirected: true }))).toBe(false);
  });

  it('never keeps an HTML page in place of a script, image or data file, whatever the status says', () => {
    for (const p of ['/assets/a-1.js', '/assets/a-1.webp', '/assets/a-1.opus', '/au-manifest.json', '/assets/unity-1.js']) {
      expect(isCacheable(p, res({ ct: 'text/html; charset=utf-8' })), p).toBe(false);
      expect(isCacheable(p, res({ ct: 'TEXT/HTML' })), p).toBe(false);
    }
  });

  it("serves a navigation the network's page, and lets the host's sign-in through", () => {
    expect(navigationVerdict(res({ ct: 'text/html; charset=utf-8' }))).toBe('serve');
    // (a redirect to the login: a navigation's redirect mode is manual, so the worker sees an opaque redirect and hands it to the browser)
    expect(navigationVerdict(res({ type: 'opaqueredirect', status: 0 }))).toBe('passthrough');
    expect(navigationVerdict(res({ status: 302 }))).toBe('passthrough');
    expect(navigationVerdict(res({ status: 401 }))).toBe('passthrough');
    expect(navigationVerdict(res({ status: 403 }))).toBe('passthrough');
  });

  it('falls back to the cached index on a server error, or a reply that is not a page', () => {
    expect(navigationVerdict(res({ status: 500, ct: 'text/html' }))).toBe('fallback');
    expect(navigationVerdict(res({ status: 503 }))).toBe('fallback');
    expect(navigationVerdict(res({ ct: 'application/json' }))).toBe('fallback');
    expect(navigationVerdict(res({ redirected: true, ct: 'text/html' }))).toBe('fallback');
  });
});

describe('sealed files (the gate)', () => {
  it('sealedResponse answers a Range with 206 and the right bytes', async () => {
    // (100 KB of made-up bytes)
    const plain = Uint8Array.from({ length: 100 * 1024 }, (_, i) => (i * 31 + 7) & 0xff);
    const res = await sealedResponse(plain, '/assets/movie-ab12.webm', 'bytes=1000-1999');
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Type')).toBe('video/webm');
    expect(res.headers.get('Content-Range')).toBe(`bytes 1000-1999/${plain.length}`);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(plain.slice(1000, 2000));
  });

  it('sealedResponse answers no Range with the whole file and its type', async () => {
    const plain = new TextEncoder().encode('{"a":1}');
    const res = await sealedResponse(plain, '/assets/room-ab12.json', null);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(plain);
  });

  it('contentTypeFor matches _headers', () => {
    const lines = readFileSync(new URL('../deploy/_headers', import.meta.url), 'utf8').split('\n');
    const rules: [string, string][] = [];
    lines.forEach((line, i) => {
      const m = /^\/assets\/\*\.(\w+)$/.exec(line.trim());
      const t = /^\s+Content-Type:\s*(\S+)/.exec(lines[i + 1] ?? '');
      if (m && t) rules.push([m[1], t[1]]);
    });
    for (const ext of ['webp', 'opus', 'ogg', 'wav', 'webm', 'glb', 'pack', 'fon']) expect(rules.map(r => r[0])).toContain(ext);
    for (const [ext, type] of rules) expect(contentTypeFor(`/assets/x-ab12.${ext}`)).toBe(type);
    expect(contentTypeFor('/assets/room-ab12.json')).toBe('application/json');
    expect(contentTypeFor('/assets/thing-ab12.rgb')).toBe('application/octet-stream');
  });

  it('a locked file is a 403 that says so', async () => {
    const res = lockedResponse();
    expect(res.status).toBe(LOCKED_STATUS);
    expect(LOCKED_STATUS).toBe(403);
    expect(await res.text()).toBe('locked');
  });
});

describe('sealedVerdict (what the worker does with a sealed file\'s answer)', () => {
  const path = '/assets/room-ab12.json';
  const res = (status: number, type = 'application/octet-stream', more: Partial<ResponseInfo> = {}): ResponseInfo =>
    ({ status, type: 'basic', redirected: false, headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? type : null) }, ...more });
  it('passes a sign-in page served as 200 to the page', () => {
    expect(sealedVerdict(path, res(200, 'text/html; charset=utf-8'))).toBe('passthrough');
  });
  it('passes a redirected answer to the page', () => {
    expect(sealedVerdict(path, res(200, 'application/octet-stream', { redirected: true }))).toBe('passthrough');
    expect(sealedVerdict(path, res(0, '', { type: 'opaqueredirect' }))).toBe('passthrough');
  });
  it('passes a 401 (and a 404) to the page', () => {
    expect(sealedVerdict(path, res(401))).toBe('passthrough');
    expect(sealedVerdict(path, res(404))).toBe('passthrough');
  });
  it('passes a plain 200 that isn\'t sealed to the page', () => {
    expect(sealedVerdict(path, res(200), 'not-sealed')).toBe('passthrough');
  });
  it('is locked with no key, or the wrong one', () => {
    expect(sealedVerdict(path, res(200), 'no-key')).toBe('locked');
    expect(sealedVerdict(path, res(200), 'wrong-key')).toBe('locked');
    expect(sealedVerdict(path, null, 'no-key')).toBe('locked');
  });
  it('decrypts a good answer, or a cached one', () => {
    expect(sealedVerdict(path, res(200))).toBe('decrypt');
    expect(sealedVerdict(path, res(200), 'opened')).toBe('decrypt');
    expect(sealedVerdict(path, null)).toBe('decrypt');
  });
});

describe("the page's build (withVersionMeta)", () => {
  it('goes at the start of the head, once, and replaces an older one', () => {
    const page = '<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n  </head><body></body></html>';
    const once = withVersionMeta(page, 'abc123def456');
    expect(once).toContain('<head><meta name="au-version" content="abc123def456">\n    <meta charset');
    const twice = withVersionMeta(once, '0123456789ab');
    expect(twice.match(/au-version/g)).toHaveLength(1);
    expect(twice).toContain('content="0123456789ab"');
    expect(withVersionMeta('<html><head lang="x"></head></html>', 'v')).toBe('<html><head lang="x"><meta name="au-version" content="v"></head></html>');
  });
});
