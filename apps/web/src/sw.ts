// SPDX-License-Identifier: GPL-3.0-or-later
// The service worker (built by swPlugin.ts to /sw.js). Its rules are in swRules.ts; docs/web.md says what is cached.
import { GateError, isSealed, open } from './gate/crypto';
import { loadKey } from './gate/keyStore';
import { cacheNames, classify, isCacheable, lockedResponse, MANIFEST_PATH, NAVIGATION_TIMEOUT_MS, navigationVerdict, precacheFetchUrl,
  rangeResponse, sealedResponse, sealedVerdict, staleAssetKeys, staleCaches, type Manifest, type SealedOutcome } from './swRules';

declare const __AU_VERSION__: string;
declare const __AU_DEV__: boolean;

// (the DOM lib is what this project type-checks with, not the worker's: just the parts used)
interface Ev { waitUntil(p: Promise<unknown>): void }
interface FetchEv extends Ev { request: Request; respondWith(r: Promise<Response>): void }
interface MsgEv extends Ev { data: { type: string; urls?: string[] }; ports?: readonly MessagePort[] }
interface Scope {
  addEventListener(type: string, cb: (e: never) => void): void;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
  location: Location;
}
const sw = self as unknown as Scope;
const dev = __AU_DEV__;
const names = cacheNames(__AU_VERSION__, dev);
const filling = new Set<string>();

async function precache(): Promise<void> {
  const listing = await fetch(MANIFEST_PATH, { cache: 'no-store' });
  // (a sign-in page or a 401 in place of the manifest fails the install: the old worker stays)
  if (!isCacheable(MANIFEST_PATH, listing)) throw new Error(`${MANIFEST_PATH}: ${listing.status}`);
  const manifest = (await listing.clone().json()) as Manifest;
  const cache = await caches.open(names.shell);
  // (kept with the shell: the worker reads its list of sealed files from it, offline too)
  await cache.put(MANIFEST_PATH, listing);
  // (the whole shell or none of it: a failed fetch fails the install, and the old worker stays)
  await Promise.all(manifest.shell.map(async url => {
    const res = await fetch(precacheFetchUrl(url), { cache: 'reload' });
    if (!isCacheable(url, res)) throw new Error(`${url}: ${res.status}`);
    await cache.put(url, res);
  }));
}

async function cleanup(): Promise<void> {
  for (const name of staleCaches(await caches.keys(), __AU_VERSION__, dev)) await caches.delete(name);
  if (dev) return;
  // (hashed media of earlier builds that this build no longer lists)
  try {
    const manifest = (await (await fetch(MANIFEST_PATH, { cache: 'no-store' })).json()) as Manifest;
    const cache = await caches.open(names.assets);
    const keys = (await cache.keys()).map(r => r.url);
    // (the sealed files are kept here too, whatever their kind: see sealedFetch)
    for (const url of staleAssetKeys(keys, [...manifest.assets.map(a => a.url), ...(manifest.sealed ?? [])])) await cache.delete(url);
  } catch {
    // (offline at activation: the next one prunes)
  }
}

/** Fetches a whole file into its cache (for a Range request that missed: the media element asks for a part, the next play gets it all). */
async function fill(url: string, cacheName: string): Promise<void> {
  if (filling.has(url)) return;
  filling.add(url);
  try {
    const res = await fetch(url);
    if (isCacheable(new URL(url).pathname, res)) await (await caches.open(cacheName)).put(url, res);
  } catch {
    // (a full cache, or the network is gone: the part passes through)
  } finally {
    filling.delete(url);
  }
}

/**
 * A page load. Online, the network answers first, so a host that wants a sign-in (a redirect, 401 or 403: an expired session) is
 * heard and the login appears. Offline, on a bad connection (NAVIGATION_TIMEOUT_MS) or on a server error, the cached index starts the game.
 */
async function navigate(req: Request, cache: Cache): Promise<Response> {
  const cached = (await cache.match(new URL('index.html', req.url).pathname)) ?? (await cache.match('/index.html'));
  if (dev) return cached ?? fetch(req);
  try {
    const res = await Promise.race([
      fetch(req),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('slow')), NAVIGATION_TIMEOUT_MS)),
    ]);
    const verdict = navigationVerdict(res);
    if (verdict === 'serve' || verdict === 'passthrough' || !cached) return res;
  } catch {
    // (no network, or too slow)
  }
  return cached ?? fetch(req);
}

async function respond(e: FetchEv, bucket: 'shell' | 'data' | 'assets'): Promise<Response> {
  const req = e.request;
  const cache = await caches.open(names[bucket]);
  if (req.mode === 'navigate') return navigate(req, cache);
  const key = req.url;
  const range = req.headers.get('range');
  const hit = await cache.match(key);
  if (hit) {
    // (the dev server's media change under the same name: show what's cached, and refresh it for the next load)
    if (dev && !range) e.waitUntil(refresh(key, names.assets));
    return range ? rangeResponse(hit, range) : hit;
  }
  // (a Range request with nothing cached passes through; the whole file is fetched on the side)
  if (range) {
    if (bucket === 'assets') e.waitUntil(fill(key, names.assets));
    return fetch(req);
  }
  const res = await fetch(req);
  if (isCacheable(new URL(key).pathname, res)) {
    e.waitUntil(cache.put(key, res.clone()).catch(() => undefined));
  }
  return res;
}

// The gate (docs/web.md, "Offline cache"): the deploy's sealed files are kept as they came (ciphertext) in the assets cache, and opened
// here with the key the page stored in IndexedDB. The dev build seals nothing, so none of this runs there.
let sealed: Set<string> | null = null;
let sealedLoading: Promise<Set<string>> | null = null;
let key: CryptoKey | undefined;
const opening = new Map<string, Promise<Uint8Array | SealedOutcome>>();

/** The build's sealed URLs, from the manifest in the shell cache (read once; the network's copy if the cache has none). */
function sealedUrls(): Promise<Set<string>> {
  if (sealed) return Promise.resolve(sealed);
  sealedLoading ??= (async () => {
    try {
      const res = (await (await caches.open(names.shell)).match(MANIFEST_PATH)) ?? (await fetch(MANIFEST_PATH, { cache: 'no-store' }));
      const manifest = (await res.json()) as Manifest;
      sealed = new Set(manifest.sealed ?? []);
      return sealed;
    } catch {
      // (no manifest yet: nothing is treated as sealed, and the next request asks again)
      sealedLoading = null;
      return new Set<string>();
    }
  })();
  return sealedLoading;
}

/** Opens a sealed file with the stored key (loaded once; a key that fails is reloaded and tried again, as the page may have stored a new one). */
async function openSealed(body: Uint8Array): Promise<Uint8Array | SealedOutcome> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!key || attempt > 0) key = await loadKey().catch(() => undefined);
    if (!key) return 'no-key';
    try {
      return await open(key, body);
    } catch (err) {
      if (!(err instanceof GateError)) throw err;
      if (err.code !== 'wrong-key') return 'not-sealed';
      key = undefined;
    }
  }
  return 'wrong-key';
}

/**
 * A sealed file: its ciphertext from the assets cache, or the whole file from the network (never a part: AES-GCM opens the whole file
 * only), kept as it came once it is seen to be sealed; then opened, and the request (or its Range) answered from the plaintext.
 */
async function sealedFetch(e: FetchEv): Promise<Response> {
  const req = e.request;
  const url = req.url;
  const path = new URL(url).pathname;
  // (the same file asked for twice at once, as a media element does with its Ranges, is fetched and opened once)
  let pending = opening.get(url);
  if (!pending) {
    const cache = await caches.open(names.assets);
    const hit = await cache.match(url);
    let res = hit;
    if (!res) {
      // (the request as it was, its mode, credentials and redirect kept, less the Range)
      const headers = new Headers(req.headers);
      headers.delete('range');
      res = await fetch(new Request(req, { headers }));
      if (sealedVerdict(path, res) === 'passthrough') return res;
    }
    const body = new Uint8Array(await res.clone().arrayBuffer());
    // (a plain file in place of a sealed one is the host's: it goes to the page as it is, and isn't kept)
    if (!isSealed(body)) return res;
    if (!hit) e.waitUntil(cache.put(url, res).catch(() => undefined));
    pending = openSealed(body);
    opening.set(url, pending);
    void pending.catch(() => undefined).finally(() => opening.delete(url));
  }
  const plain = await pending;
  if (plain instanceof Uint8Array) return sealedResponse(plain, path, req.headers.get('range'));
  if (sealedVerdict(path, null, plain) === 'locked') return lockedResponse();
  // (sealed by its header, yet not openable as one: a damaged file. Not the key's fault, so not 403)
  return new Response('unreadable', { status: 502 });
}

async function refresh(url: string, cacheName: string): Promise<void> {
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (isCacheable(new URL(url).pathname, res)) await (await caches.open(cacheName)).put(url, res);
  } catch {
    // (offline: the cached copy stays)
  }
}

sw.addEventListener('install', ((e: Ev) => {
  // (a new production worker waits for the page to say go, so a game in play isn't swapped under it; the dev one has nothing to protect)
  if (dev) void sw.skipWaiting();
  else e.waitUntil(precache());
}) as (e: never) => void);

sw.addEventListener('activate', ((e: Ev) => {
  e.waitUntil(cleanup().then(() => sw.clients.claim()));
}) as (e: never) => void);

sw.addEventListener('message', ((e: MsgEv) => {
  if (e.data?.type === 'skip') void sw.skipWaiting();
  // (the gate asks which build this worker is: a page of a newer one has it replaced before it asks for a sealed file)
  if (e.data?.type === 'version') e.ports?.[0]?.postMessage({ type: 'version', version: __AU_VERSION__ });
  // (the page stored a new key, or cleared it: the next sealed file loads it again)
  if (e.data?.type === 'gate-key-changed') key = undefined;
  // (the first visit: the page's own requests went out before this worker controlled it; it names them so they are kept too)
  if (e.data?.type === 'warm') {
    e.waitUntil(Promise.all((e.data.urls ?? []).map(async u => {
      const url = new URL(u, sw.location.href);
      if (url.origin !== sw.location.origin) return;
      const bucket = !dev && (await sealedUrls()).has(url.pathname) ? 'assets' : classify(url.pathname, { dev });
      if (!bucket || bucket === 'shell') return;
      const cache = await caches.open(names[bucket]);
      if (!(await cache.match(url.href))) await fill(url.href, names[bucket]);
    })));
  }
}) as (e: never) => void);

sw.addEventListener('fetch', ((e: FetchEv) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== sw.location.origin) return;
  const bucket = classify(url.pathname, { dev, navigate: req.mode === 'navigate', search: url.search });
  // (a sealed file is decided by the manifest's list, whatever its bucket; all are under /assets/. Until the list is read, an /assets/
  // file the buckets don't take waits for it, so a sealed one isn't passed through to the network as ciphertext)
  if (!dev && req.mode !== 'navigate' && url.pathname.startsWith('/assets/')) {
    if (sealed) {
      if (sealed.has(url.pathname)) return e.respondWith(sealedFetch(e));
    } else {
      return e.respondWith(sealedUrls().then(s => s.has(url.pathname) ? sealedFetch(e) : bucket ? respond(e, bucket) : fetch(req)));
    }
  }
  if (bucket) e.respondWith(respond(e, bucket));
}) as (e: never) => void);

// (read the list at start-up, so the first requests needn't wait for it)
if (!dev) void sealedUrls();
