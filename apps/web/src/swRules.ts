// SPDX-License-Identifier: GPL-3.0-or-later
// The service worker's decisions, kept free of the worker's globals so the unit tests can run them:
// which cache a URL belongs to, which caches a new version deletes, and how a cached full response answers a Range request.

/** shell: the app's code and index (precached per build). data: the game's yaml/json (cache-first per build). assets: art, audio, movies (kept as first used). */
export type Bucket = 'shell' | 'data' | 'assets';

/** The big media (and the original's fonts and the engineering pack, which the build hashes into /assets/ too). In a production build they are the hashed files under /assets/; under the dev server, any URL with these extensions. */
export const BIG_EXT = /\.(webp|png|jpe?g|ogg|opus|mp3|wav|webm|mp4|glb|gltf|ktx2|fon|pack)$/i;
const DATA_EXT = /\.(ya?ml|json)$/i;
// (a game's package chunk (yaml and rules bundled by games/*.ts), and the unity game's combat.yaml, its own chunk (M8 spec §8):
// data, stored when the game is first opened, not with the shell. Each is its name, a dash and Rollup's eight-character hash and
// nothing else, so a code chunk whose name only starts so (the space view's, spaceScene-*.js, or any combat-view-*.js) stays shell)
const GAME_CHUNK = /^\/assets\/(unity|demo|combat)-[\w-]{8}\.js$/;
const CODE_EXT = /\.(m?js|css|woff2?|svg)$/i;

/** Files of the shell that sit outside /assets/ (the index, and what public/ holds). */
export const GAME_PAGE = '/play/afu/';
export const SITE_PAGES = ['/', '/engineering/', '/engineering/engine/', '/engineering/afu/', '/engineering/afu/characters/', '/engineering/afu/enterprise/',
  ...['horst3', 'mertens', 'allanor', 'zoo', 'frigis', 'unity'].map(w => `/engineering/afu/missions/${w}/`)];
export const SHELL_ROOT = ['/index.html', `${GAME_PAGE}index.html`, '/icon.svg', '/manifest.webmanifest', ...SITE_PAGES.filter(p => p !== '/').map(p => `${p}index.html`)];

/** The manifest's own name: always fetched from the network, so a new build is seen. */
export const MANIFEST_PATH = '/au-manifest.json';

/** The meta tag that carries the build's version into each of its pages (swPlugin.ts): the gate asks the worker for its own, and a worker
 * of another build (an update the page met before its worker did) is replaced before any sealed file is asked for (gateFlow.ts). */
export const VERSION_META = 'au-version';

/** `html` with `version` in its VERSION_META tag, at the start of its head (a tag already there is replaced). */
export function withVersionMeta(html: string, version: string): string {
  const tag = `<meta name="${VERSION_META}" content="${version}">`;
  const old = new RegExp(`<meta name="${VERSION_META}" content="[^"]*">`);
  if (old.test(html)) return html.replace(old, tag);
  return html.replace(/<head(\s[^>]*)?>/i, m => `${m}${tag}`);
}

/** Which cache a request for `path` goes to, or null if the worker leaves it alone (the network handles it). */
export function classify(path: string, opts: { dev: boolean; navigate?: boolean; search?: string }): Bucket | null {
  if (opts.dev) {
    // (the dev server: only the media files themselves. Code, HMR and the module proxies for an import (`x.png?import`, `?url`, `?raw`) are never touched)
    if (/[?&](import|url|raw|inline|worker)\b/.test(opts.search ?? '')) return null;
    return BIG_EXT.test(path) && !path.startsWith('/node_modules/') ? 'assets' : null;
  }
  if (opts.navigate) return 'shell';
  if (path === '/' || path.endsWith('/') || SHELL_ROOT.includes(path)) return 'shell';
  if (!path.startsWith('/assets/')) return null;
  if (BIG_EXT.test(path)) return 'assets';
  if (DATA_EXT.test(path) || GAME_CHUNK.test(path)) return 'data';
  if (CODE_EXT.test(path)) return 'shell';
  return null;
}

export interface CacheNames { shell: string; data: string; assets: string }

/** The caches of one build. The assets cache has no version: its files are named by their content hash, so an entry never goes stale (it is pruned instead: `staleAssetKeys`). */
export function cacheNames(version: string, dev: boolean): CacheNames {
  if (dev) return { shell: 'au-dev-unused-shell', data: 'au-dev-unused-data', assets: 'au-dev-assets' };
  return { shell: `au-shell-${version}`, data: `au-data-${version}`, assets: 'au-assets' };
}

/** The caches a new worker deletes on activation: ours (the au- prefix) that aren't this build's. Other caches are left alone. */
export function staleCaches(existing: readonly string[], version: string, dev: boolean): string[] {
  const names = cacheNames(version, dev);
  const keep = new Set<string>(dev ? [names.assets] : [names.shell, names.data, names.assets]);
  return existing.filter(n => n.startsWith('au-') && !keep.has(n));
}

/** The assets-cache entries (by URL) that the build's manifest no longer lists: an older build's media. */
export function staleAssetKeys(cached: readonly string[], listed: readonly string[]): string[] {
  const live = new Set(listed);
  return cached.filter(u => !live.has(new URL(u, 'http://x').pathname));
}

/** A byte range of a body of `size` bytes: null if the header isn't a single range (the full body is then served), 'unsatisfiable' for a 416. */
export function parseRange(header: string, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start: number;
  let end: number;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0) return 'unsatisfiable';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

/** Answers a Range request from a cached full (200) response. */
export async function rangeResponse(full: Response, header: string): Promise<Response> {
  const blob = await full.blob();
  const r = parseRange(header, blob.size);
  if (r === null) return new Response(blob, { status: 200, headers: full.headers });
  if (r === 'unsatisfiable') return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${blob.size}` } });
  const headers = new Headers();
  const type = full.headers.get('Content-Type');
  if (type) headers.set('Content-Type', type);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Content-Range', `bytes ${r.start}-${r.end}/${blob.size}`);
  headers.set('Content-Length', String(r.end - r.start + 1));
  return new Response(blob.slice(r.start, r.end + 1), { status: 206, headers });
}

/** The types `deploy/_headers` gives the media under /assets/ (a sealed file's plaintext is answered by the worker, not the host, so it says the same). */
const CONTENT_TYPES: Record<string, string> = {
  webp: 'image/webp', opus: 'audio/ogg', ogg: 'audio/ogg', wav: 'audio/wav', webm: 'video/webm', glb: 'model/gltf-binary',
  wasm: 'application/wasm', fon: 'application/octet-stream', pack: 'application/octet-stream', json: 'application/json',
};

export function contentTypeFor(path: string): string {
  const ext = /\.(\w+)$/.exec(path)?.[1]?.toLowerCase();
  return (ext && CONTENT_TYPES[ext]) || 'application/octet-stream';
}

/** A sealed file's opened bytes as the answer to its request: the whole file (200), or the part a Range asks for (rangeResponse). */
export async function sealedResponse(plain: Uint8Array, path: string, range: string | null): Promise<Response> {
  const full = new Response(plain as BodyInit, { status: 200, headers: { 'Content-Type': contentTypeFor(path) } });
  return range ? rangeResponse(full, range) : full;
}

/** What the worker answers for a sealed file it can't open (no key on this machine, or the wrong one). */
export const LOCKED_STATUS = 403;

export function lockedResponse(): Response {
  return new Response('locked', { status: LOCKED_STATUS });
}

/** How opening a sealed file went: 'not-sealed' is a plain file in its place (the host's, not ours). */
export type SealedOutcome = 'opened' | 'no-key' | 'wrong-key' | 'not-sealed';

/**
 * What the worker does with a sealed file's answer (`res`: the network's, or null for the cached copy, which was checked when stored) and,
 * once it has tried, how opening it went. 'passthrough': anything but our own plain file (a sign-in page, a redirect, a 401, a 404, or a
 * file that isn't sealed) goes to the page as it is, unstored, so a login is seen and never read as a lost key. 'locked': only a sealed
 * file this machine has no key for, or the wrong one (the page takes the 403 to mean the key must be checked again). 'decrypt' otherwise.
 */
export function sealedVerdict(path: string, res: ResponseInfo | null, outcome?: SealedOutcome): 'decrypt' | 'passthrough' | 'locked' {
  if (res && !isCacheable(path, res)) return 'passthrough';
  if (outcome === 'not-sealed') return 'passthrough';
  if (outcome === 'no-key' || outcome === 'wrong-key') return 'locked';
  return 'decrypt';
}

/** What the build writes as au-manifest.json (swPlugin.ts) and the page's "Download for offline" reads. */
export interface Manifest {
  version: string;
  /** URLs precached on install. */
  shell: string[];
  data: string[];
  assets: { url: string; size: number }[];
  /** The deploy's sealed files (sources under games/unity/.sealed/): the worker opens each with the gate's key. check.bin isn't one (the page reads it to test a key). */
  sealed: string[];
}

/**
 * Whether a path (absolute, or relative as Rollup's originalFileNames give it) is under games/unity/.sealed. The build never inlines such
 * a file as a data: URL (vite.config.ts): one would bypass the worker, so it could never be opened.
 */
export function inSealedDir(path: string): boolean {
  return /(^|\/)games\/unity\/\.sealed\//.test(path.replace(/\\/g, '/'));
}

/** Whether a bundle file's source is one of the gate's sealed files, other than check.bin. */
export function isSealedSource(source: string): boolean {
  return inSealedDir(source) && !source.replace(/\\/g, '/').endsWith('/.sealed/check.bin');
}

/** Sorts a build's emitted files (paths relative to the output, no leading slash; `sources`, an asset's original files) into the manifest's lists. */
export function buildManifest(version: string, files: readonly { path: string; size: number; sources?: readonly string[] }[]): Manifest {
  // (a page of the site is precached only once the build has it: the install fails on a missing file)
  const built = new Set(files.map(f => `/${f.path}`));
  const m: Manifest = { version, shell: SHELL_ROOT.filter(u => !u.endsWith('/index.html') || built.has(u) || u === '/index.html'), data: [], assets: [], sealed: [] };
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const url = `/${f.path}`;
    if (url === MANIFEST_PATH || url === '/sw.js' || SHELL_ROOT.includes(url)) continue;
    if (f.sources?.some(isSealedSource)) m.sealed.push(url);
    const bucket = classify(url, { dev: false });
    if (bucket === 'shell') m.shell.push(url);
    else if (bucket === 'data') m.data.push(url);
    else if (bucket === 'assets') m.assets.push({ url, size: f.size });
  }
  return m;
}

/** The part of a Response that decides whether it may be kept (so the tests need no real fetch). */
export interface ResponseInfo { status: number; type: string; redirected: boolean; headers: { get(name: string): string | null } }

const PAGE_PATH = /\/(index\.html)?$/;

/**
 * The URL to fetch a precached file from. A page is kept under its `index.html` name, but asked for by its folder: Cloudflare Pages (and
 * `wrangler pages dev`) answers `/x/index.html` with a 308 to `/x/`, and a response reached through a redirect is never cached, so asking
 * for the file by name failed every install.
 */
export function precacheFetchUrl(url: string): string {
  return url.endsWith('/index.html') ? url.slice(0, -'index.html'.length) : url;
}

/**
 * Whether a response may go into a cache. Only a plain 200 from our own origin that was not reached through a redirect: the host's
 * gate (Cloudflare Access redirects to its sign-in page when a session expires, Basic Auth answers 401) must never be stored as the
 * game's file, and an HTML page in place of a script, image or data file is a sign-in page whatever its status says.
 */
export function isCacheable(path: string, res: ResponseInfo): boolean {
  if (res.status !== 200 || res.type !== 'basic' || res.redirected) return false;
  const type = (res.headers.get('Content-Type') ?? '').toLowerCase();
  if (!PAGE_PATH.test(path) && type.startsWith('text/html')) return false;
  return true;
}

/**
 * What a navigation does with the network's answer while online. 'serve': the page itself (the network's copy is shown). 'passthrough': the
 * host wants something else (a redirect to a sign-in page, a 401 or 403): the browser gets it as it is, so the login appears.
 * 'fallback': a server error, a non-page, or anything odd: the cached index is used.
 */
export function navigationVerdict(res: ResponseInfo): 'serve' | 'passthrough' | 'fallback' {
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400) || res.status === 401 || res.status === 403) return 'passthrough';
  if (res.redirected || res.status !== 200) return 'fallback';
  return (res.headers.get('Content-Type') ?? '').toLowerCase().startsWith('text/html') ? 'serve' : 'fallback';
}

/** How long a navigation waits for the network before it uses the cached index (a bad connection must not hold the game up). */
export const NAVIGATION_TIMEOUT_MS = 4000;
