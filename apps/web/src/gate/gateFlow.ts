// SPDX-License-Identifier: GPL-3.0-or-later
// The gate before the protected game loads: a key on this device, or the import screen until the player's CD gives one; then the
// service worker, which opens the sealed files with it, must control the page. Only the deploy build's unity comes here (main.ts).
import { h, render } from 'preact';
import { LOCKED_STATUS, VERSION_META } from '../swRules';
import { activateWaiting, registerServiceWorker, requestPersistence, wantsWorker } from '../swRegister';
import { ImportScreen } from './importScreen';
import { clearKey, loadKey, saveKey } from './keyStore';
import type { GateParams } from './params';

/** The page's side of the service worker, as the gate needs it. */
export interface WorkerPort {
  /** Whether this page can have a worker at all (no: `?sw=0`, plain HTTP, or a browser without one). */
  supported: boolean;
  /** Settles once the worker controls the page, so the sealed files' requests go through it. */
  ensureControlling(): Promise<void>;
  /** Tells the worker the stored key changed, so it drops the one it holds and reads it again. */
  keyChanged(): void;
}

/** The key in IndexedDB (keyStore.ts); a test's stand-in otherwise. */
export interface KeyPort {
  load(): Promise<CryptoKey | undefined>;
  save(key: CryptoKey): Promise<void>;
  clear(): Promise<void>;
}

export const browserKeys: KeyPort = { load: () => loadKey(), save: key => saveKey(key), clear: () => clearKey() };

/** A failed load's error carries the response's status (unitySealed.ts): a 403 is the worker saying it has no key, or the wrong one. */
export function isLocked(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { status?: unknown }).status === LOCKED_STATUS;
}

/** How long, once the worker is active, a page waits for it to take control before reloading into it once. */
const CONTROL_WAIT_MS = 4000;
const RELOAD_KEY = 'au-gate-reloaded';

/** The parts of `navigator.serviceWorker` that waiting for control needs. */
export interface ServiceWorkerLike {
  readonly controller: unknown;
  readonly ready: Promise<unknown>;
  addEventListener(type: 'controllerchange', listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: 'controllerchange', listener: () => void): void;
}

/** How long the worker may take to install and activate. registerServiceWorker never throws, so a worker that fails to start (sw.js
 * missing, a script error) shows only as `ready` never settling: past this, the page says so rather than waiting for ever. */
const READY_CAP_MS = 30_000;
/** What the page shows when the worker never starts. */
export const WORKER_DID_NOT_START = "The game's offline worker didn't start. Reload to try again.";

/** `p`'s value, or `undefined` once `ms` have passed. */
async function within<T>(p: Promise<T>, ms: number): Promise<{ value: T } | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p.then(value => ({ value })), new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Settles once the worker controls the page. The wait for control starts only when the worker is active (`ready`), so a slow first
 * install is never taken for a missing claim; a worker that is not active in `readyMs` is an error. A hard reload leaves an active
 * worker not in control, and no claim comes: one ordinary reload, and the page is controlled. The mark of that reload is cleared as soon
 * as the page is controlled, so a later hard reload in the same tab gets its reload too; only a second reload in a row that still isn't
 * controlled is an error.
 */
export async function waitForControl(sw: ServiceWorkerLike, o: {
  session?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  reload?: () => void;
  waitMs?: number;
  readyMs?: number;
} = {}): Promise<void> {
  const session = o.session ?? globalThis.sessionStorage;
  const controlled = (): void => {
    try { session?.removeItem(RELOAD_KEY); } catch { /* (no session storage: nothing to clear) */ }
  };
  if (sw.controller) return controlled();
  // (listening from the start: the claim can come while `ready` is still settling)
  let changed = false;
  let onChange = (): void => {};
  const change = new Promise<true>(resolve => { onChange = () => { changed = true; resolve(true); }; });
  sw.addEventListener('controllerchange', onChange, { once: true });
  const giveUp = (message: string): never => {
    sw.removeEventListener('controllerchange', onChange);
    throw new Error(message);
  };
  if (!(await within(sw.ready, o.readyMs ?? READY_CAP_MS))) giveUp(WORKER_DID_NOT_START);
  if (changed || sw.controller) return controlled();
  if ((await within(change, o.waitMs ?? CONTROL_WAIT_MS)) || sw.controller) return controlled();
  sw.removeEventListener('controllerchange', onChange);
  let reloaded = false;
  try {
    reloaded = session.getItem(RELOAD_KEY) !== null;
    session.setItem(RELOAD_KEY, '1');
  } catch {
    reloaded = true;
  }
  if (reloaded) giveUp('the offline worker did not take over this page: reload it to play');
  (o.reload ?? (() => location.reload()))();
  await new Promise<never>(() => {});
}

/** How long a worker has to say which build it is. One that doesn't answer is taken for an older build (from before it could). */
const VERSION_WAIT_MS = 3000;
/** How long the new build's worker may take to be found, to install (the shell's precache), and to take over. */
const UPDATE_CAP_MS = 60_000;
/** What the page shows when the worker in control is of another build and no worker of this one takes over. */
export const WORKER_OUT_OF_DATE = 'The game was updated, but its offline worker is still the old one. Reload to try again.';

/** This page's build, from the meta tag the build writes into each page (swPlugin.ts); undefined for a page without one. */
export function pageVersion(doc: Pick<Document, 'querySelector'> = document): string | undefined {
  return doc.querySelector<HTMLMetaElement>(`meta[name="${VERSION_META}"]`)?.content || undefined;
}

/** Asks a worker which build it is (a message with a port to answer on); undefined if it doesn't answer within `ms`. */
export async function askWorkerVersion(worker: Pick<ServiceWorker, 'postMessage'> | null | undefined, ms = VERSION_WAIT_MS): Promise<string | undefined> {
  if (!worker) return undefined;
  const channel = new MessageChannel();
  const answer = new Promise<string | undefined>(resolve => {
    channel.port1.onmessage = (e: MessageEvent<{ type?: string; version?: unknown }>) => {
      resolve(e.data?.type === 'version' && typeof e.data.version === 'string' ? e.data.version : undefined);
    };
  });
  try {
    worker.postMessage({ type: 'version' }, [channel.port2]);
    return (await within(answer, ms))?.value;
  } finally {
    channel.port1.close();
  }
}

/**
 * Whether the worker in control may open this page's sealed files: only one of the page's own build knows their names (its manifest's
 * `sealed` list); one of another build passes a file it doesn't list through as ciphertext. A page that names no build has nothing to
 * compare (only a build writes the tag), and goes on.
 */
export function workerDecision(page: string | undefined, worker: string | undefined): 'current' | 'update' {
  return page === undefined || page === worker ? 'current' : 'update';
}

/** The page's side of a worker update, as ensureCurrentWorker needs it. */
export interface WorkerUpdater {
  /** This page's build (pageVersion). */
  page: string | undefined;
  /** The controlling worker's build, or undefined if it doesn't say. */
  workerVersion(): Promise<string | undefined>;
  /** Brings in the worker of the newest build (waiting for its install), tells it to take over, and settles once it controls the page
   * (the page then reloads once into it); false if no new worker comes. */
  takeOver(): Promise<boolean>;
}

/**
 * Settles once the worker in control is of this page's build. After a deploy, a returning player's page is the new build's (pages come
 * from the network first) while the old build's worker still controls it: that one is replaced first (Updating…, then one reload), so
 * no sealed file is asked of a worker that doesn't know it. If no worker of this build takes over, the page says so (Reload).
 */
export async function ensureCurrentWorker(u: WorkerUpdater): Promise<void> {
  if (workerDecision(u.page, await u.workerVersion()) === 'current') return;
  await u.takeOver();
  // (taken over or not, it is asked again: a worker slow to answer the first time is not replaced for that)
  if (workerDecision(u.page, await u.workerVersion()) === 'current') return;
  throw new Error(WORKER_OUT_OF_DATE);
}

/** The parts of a registration that finding the new worker needs. */
export interface RegistrationLike {
  readonly waiting: unknown;
  readonly installing: { readonly state: string; addEventListener(type: 'statechange', l: () => void): void } | null;
  update(): Promise<unknown>;
  addEventListener(type: 'updatefound', l: () => void, options?: { once?: boolean }): void;
}

/**
 * Settles true once `reg` has a worker waiting: one there already, one installing, or one an update check finds (the browser checks on
 * each navigation, so it is often installing already). False if none comes, or its install fails, within `ms`.
 */
export async function waitForWaiting(reg: RegistrationLike, ms = UPDATE_CAP_MS): Promise<boolean> {
  const deadline = Date.now() + ms;
  const left = (): number => Math.max(0, deadline - Date.now());
  if (reg.waiting) return true;
  if (!reg.installing) {
    const found = new Promise<true>(resolve => reg.addEventListener('updatefound', () => resolve(true), { once: true }));
    void reg.update().catch(() => undefined);
    if (!(await within(found, left())) && !reg.installing && !reg.waiting) return false;
  }
  if (reg.waiting) return true;
  const installing = reg.installing;
  if (!installing) return false;
  const settled = new Promise<boolean>(resolve => {
    const check = (): void => {
      if (installing.state === 'installed' || installing.state === 'activating' || installing.state === 'activated') resolve(true);
      else if (installing.state === 'redundant') resolve(false);
    };
    installing.addEventListener('statechange', check);
    check();
  });
  return (await within(settled, left()))?.value === true && !!reg.waiting;
}

/** The real updater: the worker in control is asked its build, and a newer one is switched to through swRegister's update path. */
export function browserUpdater(sw: ServiceWorkerContainer = navigator.serviceWorker, doc: Pick<Document, 'querySelector'> = document): WorkerUpdater {
  return {
    page: pageVersion(doc),
    workerVersion: () => askWorkerVersion(sw.controller),
    async takeOver() {
      const reg = await sw.getRegistration();
      if (!reg || !(await waitForWaiting(reg))) return false;
      const change = new Promise<true>(resolve => sw.addEventListener('controllerchange', () => resolve(true), { once: true }));
      if (!activateWaiting(reg)) return false;
      return (await within(change, UPDATE_CAP_MS)) !== undefined;
    },
  };
}

/** The real port: the registration boot.ts began, then the worker's control of this page, by a worker of this page's build. */
export function browserWorker(): WorkerPort {
  const supported = wantsWorker(location.search, window.isSecureContext, 'serviceWorker' in navigator);
  return {
    supported,
    async ensureControlling() {
      if (!supported) throw new Error('this browser has no service worker to open the game with');
      await registerServiceWorker();
      await waitForControl(navigator.serviceWorker);
      await ensureCurrentWorker(browserUpdater());
    },
    keyChanged() {
      const message = { type: 'gate-key-changed' };
      navigator.serviceWorker?.controller?.postMessage(message);
      // (and the worker about to take over, which may not control this page yet)
      void navigator.serviceWorker?.ready.then(reg => reg.active?.postMessage(message), () => undefined);
    },
  };
}

async function fetchCheck(url: string, fetchFn: typeof fetch): Promise<Uint8Array> {
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`the gate's check file: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Settles once this device has the key and the worker controls the page. With no key the import screen shows (rendered into `ui`,
 * over the loading screen) until the player's CD gives one; the key is then stored, the worker told, persistent storage asked for, and
 * control waited on, so the first play needs no reload. Without a worker the screen says so, and this never settles.
 */
export async function ensureUnlocked(o: {
  ui: HTMLElement;
  params: GateParams;
  checkUrl: string;
  worker: WorkerPort;
  keys?: KeyPort;
  fetch?: typeof fetch;
  persist?: () => Promise<unknown>;
}): Promise<void> {
  const keys = o.keys ?? browserKeys;
  const persist = o.persist ?? (() => requestPersistence(navigator.storage));
  const saved = await keys.load().catch(() => undefined);
  if (saved && o.worker.supported) {
    await o.worker.ensureControlling();
    return;
  }
  const check = await fetchCheck(o.checkUrl, o.fetch ?? fetch.bind(globalThis));
  const host = o.ui.appendChild(document.createElement('div'));
  try {
    const key = await new Promise<CryptoKey>(resolve => {
      render(h(ImportScreen, { params: o.params, check, onUnlocked: resolve, workerSupported: o.worker.supported }), host);
    });
    await keys.save(key);
    o.worker.keyChanged();
    await persist();
    await o.worker.ensureControlling();
  } finally {
    render(null, host);
    host.remove();
  }
}

/**
 * The package's load, but a 403 from a sealed file (the worker has no key: storage cleared, or Safari's eviction) clears the stored key
 * and reloads, which brings the import screen back rather than a game with no art (Review Focus 4). The page is going then: the
 * promise never settles.
 */
export async function loadUnlocked<T>(load: () => Promise<T>, o: { keys?: KeyPort; reload?: () => void } = {}): Promise<T> {
  try {
    return await load();
  } catch (err) {
    if (!isLocked(err)) throw err;
    console.warn('The game files are locked on this device: checking the CD again.');
    await (o.keys ?? browserKeys).clear().catch(() => undefined);
    (o.reload ?? (() => location.reload()))();
    return new Promise<never>(() => {});
  }
}
