// SPDX-License-Identifier: GPL-3.0-or-later
// The page's side of the offline cache: registers the worker, asks for persistent storage, and offers "Download for offline".
import { MANIFEST_PATH, type Manifest } from './swRules';

type Listener = () => void;
const updating: Listener[] = [];
let isUpdating = false;
const RELOAD_KEY = 'au-sw-reloaded';

/** Calls back when a new version has been found waiting and is being switched to (the page then reloads once): the loading screen shows "Updating…". Also an `au:updating` event on window. */
export function onUpdating(cb: Listener): void {
  updating.push(cb);
  if (isUpdating) cb();
}

function announceUpdating(): void {
  isUpdating = true;
  for (const cb of updating) cb();
  window.dispatchEvent(new CustomEvent('au:updating'));
}

/** Switches to the worker waiting in `reg`: "Updating…" shows, and once it takes over the page reloads once (registerServiceWorker's
 * listener, which never reloads twice within ten seconds). */
export function activateWaiting(reg: Pick<ServiceWorkerRegistration, 'waiting'>): boolean {
  if (!reg.waiting) return false;
  announceUpdating();
  reg.waiting.postMessage({ type: 'skip' });
  return true;
}

/** Whether to register for this page: HTTPS or localhost, a browser with workers, and no `?sw=0`. */
export function wantsWorker(search: string, secure: boolean, supported: boolean): boolean {
  return secure && supported && new URLSearchParams(search).get('sw') !== '0';
}

/** Asks the browser not to evict the cache. It may refuse (it often does until the site is used or installed): the cache then works as it can be evicted, and nothing else changes. */
export async function requestPersistence(storage: Pick<StorageManager, 'persist' | 'persisted'> | undefined): Promise<'granted' | 'denied' | 'unsupported' | 'error'> {
  if (!storage?.persist) return 'unsupported';
  try {
    if (await storage.persisted?.()) return 'granted';
    return (await storage.persist()) ? 'granted' : 'denied';
  } catch {
    return 'error';
  }
}

/** Removes the worker and every cache of ours (`?sw=0`, and `clearOfflineCache`). */
export async function clearOfflineCache(): Promise<void> {
  const regs = await navigator.serviceWorker?.getRegistrations?.();
  for (const r of regs ?? []) await r.unregister();
  for (const name of await caches.keys()) if (name.startsWith('au-')) await caches.delete(name);
}

export interface CacheProgress { done: number; total: number; bytes: number; totalBytes: number }

/**
 * "Download for offline": fetches every file of the build's manifest (the game data and the media; the shell is already there).
 * The worker keeps each as it goes by, so this is only requests. Not available under the dev server (no manifest).
 */
export async function cacheAll(onProgress?: (p: CacheProgress) => void): Promise<CacheProgress> {
  const res = await fetch(MANIFEST_PATH, { cache: 'no-store' });
  if (!res.ok) throw new Error('no manifest: only a production build can download for offline');
  const manifest = (await res.json()) as Manifest;
  if (!navigator.serviceWorker?.controller) {
    await navigator.serviceWorker?.ready;
    if (!navigator.serviceWorker?.controller) throw new Error('the offline cache is not running yet: reload once, and try again');
  }
  // (a sealed file that no bucket takes, such as a .rgb, is in the sealed list only; the worker keeps it with the assets)
  const listed = new Set([...manifest.data, ...manifest.assets.map(a => a.url)]);
  const sealed = (manifest.sealed ?? []).filter(url => !listed.has(url)).map(url => ({ url, size: 0 }));
  const list = [...manifest.data.map(url => ({ url, size: 0 })), ...manifest.assets, ...sealed];
  const p: CacheProgress = { done: 0, total: list.length, bytes: 0, totalBytes: list.reduce((n, a) => n + a.size, 0) };
  let next = 0;
  const lane = async (): Promise<void> => {
    for (let i = next++; i < list.length; i = next++) {
      const item = list[i]!;
      try {
        const r = await fetch(item.url);
        await r.arrayBuffer();
      } catch {
        // (one file failing doesn't stop the rest; run it again to retry)
      }
      p.done++;
      p.bytes += item.size;
      onProgress?.({ ...p });
    }
  };
  await Promise.all([lane(), lane(), lane(), lane()]);
  return { ...p };
}

declare global {
  interface Window {
    /** The offline cache's controls (also usable from the console): `cacheAll(cb)` downloads the whole game, `clear()` removes the cache and the worker. */
    __auCache?: { cacheAll: typeof cacheAll; clear: typeof clearOfflineCache; persist: () => ReturnType<typeof requestPersistence> };
  }
}

/** Registers the worker (see docs/web.md, "Offline cache"). Never throws: the game runs without it. */
export async function registerServiceWorker(opts: { activate?: boolean } = {}): Promise<void> {
  // (only the game page switches to a waiting worker: skipWaiting reloads every tab, and browsing the site must not reload a running game in another tab)
  const activate = opts.activate ?? true;
  const supported = 'serviceWorker' in navigator;
  if (supported && new URLSearchParams(location.search).get('sw') === '0') {
    await clearOfflineCache().catch(() => undefined);
    return;
  }
  if (!wantsWorker(location.search, window.isSecureContext, supported)) return;
  window.__auCache = { cacheAll, clear: clearOfflineCache, persist: () => requestPersistence(navigator.storage) };
  try {
    const controlled = Boolean(navigator.serviceWorker.controller);
    // (a new worker takes over, and the page reloads once to run on it; a reload the page itself made a moment ago isn't repeated)
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!controlled) return;
      try {
        if (Date.now() - Number(sessionStorage.getItem(RELOAD_KEY) ?? 0) < 10_000) return;
        sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
      } catch {
        // (no session storage: reload anyway, once, as this listener only fires on the change)
      }
      location.reload();
    });
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    // (the next load after an update was found: a worker is waiting)
    if (activate && controlled) activateWaiting(reg);
    if (!controlled) {
      // (the first visit: the worker claims this page when it activates, and is then told what the page has already loaded)
      await navigator.serviceWorker.ready;
      const urls = performance.getEntriesByType('resource').map(r => r.name);
      reg.active?.postMessage({ type: 'warm', urls });
    }
    const persisted = await requestPersistence(navigator.storage);
    if (persisted !== 'granted') console.info(`offline cache: persistent storage ${persisted}; the browser may clear it when space is short`);
  } catch (err) {
    console.warn('offline cache unavailable', err);
  }
}
