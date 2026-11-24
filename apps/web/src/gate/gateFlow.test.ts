// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHECK_PLAINTEXT, deriveGateKey, deriveIvKey, seal } from './crypto';
import { folderSource, rangeDigests } from './disc';
import { askWorkerVersion, ensureCurrentWorker, ensureUnlocked, isLocked, loadUnlocked, pageVersion, waitForControl, waitForWaiting, workerDecision,
  type KeyPort, type RegistrationLike, type ServiceWorkerLike, type WorkerPort, type WorkerUpdater, WORKER_DID_NOT_START, WORKER_OUT_OF_DATE } from './gateFlow';
import type { GateParams } from './params';
import { fakeFiles } from './testDisc';

// (made-up files, ranges and salt: no real gate parameters)
const bytes = (n: number, k: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * k + 7) & 255);
const params: GateParams = {
  version: 1, salt: Uint8Array.from({ length: 32 }, (_, i) => 100 + i),
  ranges: [{ path: 'A.DAT', offset: 5000, length: 65536 }, { path: 'B.DAT', offset: 5001, length: 65536 }, { path: 'C.DAT', offset: 5002, length: 65536 }],
};
const disc = { 'a.dat': bytes(75000, 3), 'b.dat': bytes(75000, 7), 'c.dat': bytes(75000, 9) };

async function sealedCheck(): Promise<Uint8Array> {
  const d = await rangeDigests(folderSource(fakeFiles(disc)), params);
  return seal(await deriveGateKey(d, params.salt), await deriveIvKey(d, params.salt), 'check', new TextEncoder().encode(CHECK_PLAINTEXT));
}

function fakes(saved?: CryptoKey) {
  const calls: string[] = [];
  let stored = saved;
  const keys: KeyPort = {
    load: async () => stored,
    save: async k => { calls.push('save'); stored = k; },
    clear: async () => { calls.push('clear'); stored = undefined; },
  };
  const worker: WorkerPort = {
    supported: true,
    ensureControlling: async () => { calls.push('control'); },
    keyChanged: () => { calls.push('keyChanged'); },
  };
  return { calls, keys, worker, stored: () => stored };
}

describe('ensureUnlocked', () => {
  let ui: HTMLElement;
  afterEach(() => ui?.remove());

  it('with a saved key it resolves at once after ensureControlling', async () => {
    ui = document.body.appendChild(document.createElement('div'));
    const key = await deriveGateKey([new Uint8Array(32)], new Uint8Array(32));
    const f = fakes(key);
    const fetchCheck = vi.fn();
    await ensureUnlocked({ ui, params, checkUrl: '/check.bin', worker: f.worker, keys: f.keys, fetch: fetchCheck as unknown as typeof fetch, persist: async () => {} });
    expect(f.calls).toEqual(['control']);
    expect(fetchCheck).not.toHaveBeenCalled();
    expect(ui.querySelector('[data-gate=screen]')).toBeNull();
  });

  it('without one it shows the screen, then saves the key, tells the worker and waits for control', async () => {
    ui = document.body.appendChild(document.createElement('div'));
    const f = fakes();
    const check = await sealedCheck();
    const fetchCheck = vi.fn(async () => new Response(check as BlobPart));
    const persist = vi.fn(async () => { f.calls.push('persist'); });
    let settled = false;
    const done = ensureUnlocked({ ui, params, checkUrl: '/check.bin', worker: f.worker, keys: f.keys, fetch: fetchCheck as unknown as typeof fetch, persist })
      .then(() => { settled = true; });
    await vi.waitFor(() => expect(ui.querySelector('[data-gate=folder]')).not.toBeNull());
    expect(fetchCheck).toHaveBeenCalledWith('/check.bin');
    expect(settled).toBe(false);
    const input = ui.querySelector<HTMLInputElement>('[data-gate=folder]')!;
    Object.defineProperty(input, 'files', { value: fakeFiles(disc), configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await done;
    expect(f.calls).toEqual(['save', 'keyChanged', 'persist', 'control']);
    expect(f.stored()).toBeDefined();
    // (the screen is gone once the game may load)
    expect(ui.querySelector('[data-gate=screen]')).toBeNull();
  });

  it('a check file that cannot be fetched is an error, not a screen that can never unlock', async () => {
    ui = document.body.appendChild(document.createElement('div'));
    const f = fakes();
    const fetchCheck = async () => new Response('gone', { status: 404 });
    await expect(ensureUnlocked({ ui, params, checkUrl: '/check.bin', worker: f.worker, keys: f.keys, fetch: fetchCheck as unknown as typeof fetch, persist: async () => {} }))
      .rejects.toThrow(/404/);
  });
});

describe('loadUnlocked', () => {
  afterEach(() => vi.restoreAllMocks());
  it('a 403 load clears the key', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = fakes();
    const reload = vi.fn();
    const locked = Object.assign(new Error('unity: 403 for a sealed file'), { status: 403 });
    expect(isLocked(locked)).toBe(true);
    const pending = loadUnlocked(async () => { throw locked; }, { keys: f.keys, reload });
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(f.calls).toEqual(['clear']);
    // (the page is going: the load never settles, so nothing starts on the way out)
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await new Promise(r => setTimeout(r, 10));
    expect(settled).toBe(false);
  });

  it('any other failure is passed on, and the key is kept', async () => {
    const f = fakes();
    const reload = vi.fn();
    await expect(loadUnlocked(async () => { throw Object.assign(new Error('unity: 500'), { status: 500 }); }, { keys: f.keys, reload })).rejects.toThrow('unity: 500');
    expect(isLocked(new Error('x'))).toBe(false);
    expect(f.calls).toEqual([]);
    expect(reload).not.toHaveBeenCalled();
    await expect(loadUnlocked(async () => 'pkg', { keys: f.keys, reload })).resolves.toBe('pkg');
  });
});

/** A fake navigator.serviceWorker: `activate()` settles `ready`, `claim()` takes control and fires controllerchange. */
function fakeSw(controlled = false) {
  const listeners: (() => void)[] = [];
  let activate!: () => void;
  const sw = {
    controller: controlled ? {} : null as unknown,
    ready: new Promise<void>(r => { activate = r; }),
    addEventListener(_type: 'controllerchange', l: () => void) { listeners.push(l); },
    removeEventListener(_type: 'controllerchange', l: () => void) { const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); },
  };
  return {
    sw: sw as ServiceWorkerLike,
    activate: () => activate(),
    claim: () => { sw.controller = {}; for (const l of listeners.splice(0)) l(); },
    listening: () => listeners.length,
  };
}

function fakeSession(entries: Record<string, string> = {}) {
  const m = new Map(Object.entries(entries));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, has: (k: string) => m.has(k) };
}

describe('waitForControl', () => {
  it('a slow first install is not a missing claim: the wait starts when the worker is active', async () => {
    const f = fakeSw();
    const session = fakeSession();
    const reload = vi.fn();
    let settled = false;
    const done = waitForControl(f.sw, { session, reload, waitMs: 20 }).then(() => { settled = true; });
    // (installing for longer than the wait: no reload yet)
    await new Promise(r => setTimeout(r, 60));
    expect(reload).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    f.activate();
    await new Promise(r => setTimeout(r, 5));
    f.claim();
    await done;
    expect(reload).not.toHaveBeenCalled();
  });

  it('a mark from an earlier reload is cleared once the page is controlled, so a later hard reload reloads again', async () => {
    const session = fakeSession({ 'au-gate-reloaded': '1' });
    const reload = vi.fn();
    const controlled = fakeSw(true);
    await expect(waitForControl(controlled.sw, { session, reload, waitMs: 10 })).resolves.toBeUndefined();
    expect(session.has('au-gate-reloaded')).toBe(false);
    // (a hard reload: active, not in control, no claim coming)
    const hard = fakeSw();
    hard.activate();
    void waitForControl(hard.sw, { session, reload, waitMs: 10 });
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(session.has('au-gate-reloaded')).toBe(true);
  });

  it('a claim that came while ready settled counts, and clears the mark', async () => {
    const session = fakeSession({ 'au-gate-reloaded': '1' });
    const f = fakeSw();
    const done = waitForControl(f.sw, { session, waitMs: 10 });
    f.claim();
    f.activate();
    await done;
    expect(session.has('au-gate-reloaded')).toBe(false);
  });

  it('a worker that never starts is an error after 30 s, not a wait for ever', async () => {
    vi.useFakeTimers();
    try {
      const f = fakeSw();
      const reload = vi.fn();
      const done = waitForControl(f.sw, { session: fakeSession(), reload });
      const failed = expect(done).rejects.toThrow(WORKER_DID_NOT_START);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(f.listening()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await failed;
      expect(WORKER_DID_NOT_START).toBe("The game's offline worker didn't start. Reload to try again.");
      expect(reload).not.toHaveBeenCalled();
      expect(f.listening()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a second reload in a row still not in control is an error', async () => {
    const session = fakeSession({ 'au-gate-reloaded': '1' });
    const reload = vi.fn();
    const f = fakeSw();
    f.activate();
    await expect(waitForControl(f.sw, { session, reload, waitMs: 10 })).rejects.toThrow(/did not take over/);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('the worker of this build', () => {
  it("reads the page's build from its meta tag", () => {
    const doc = new DOMParser().parseFromString('<html><head><meta name="au-version" content="abc123def456"></head></html>', 'text/html');
    expect(pageVersion(doc)).toBe('abc123def456');
    expect(pageVersion(new DOMParser().parseFromString('<html><head></head></html>', 'text/html'))).toBeUndefined();
  });

  it('a worker of the same build goes on; another build, or one that does not say, is replaced', () => {
    expect(workerDecision('aaa', 'aaa')).toBe('current');
    expect(workerDecision('bbb', 'aaa')).toBe('update');
    // (a worker from before it could answer)
    expect(workerDecision('bbb', undefined)).toBe('update');
    // (a page with no build named: nothing to compare)
    expect(workerDecision(undefined, 'aaa')).toBe('current');
  });

  it("asks the worker over a message port, and takes no answer as none", async () => {
    const answering = { postMessage: (m: { type: string }, [port]: MessagePort[]) => { if (m.type === 'version') port!.postMessage({ type: 'version', version: 'v1' }); } };
    expect(await askWorkerVersion(answering as unknown as ServiceWorker, 500)).toBe('v1');
    const silent = { postMessage: () => undefined };
    expect(await askWorkerVersion(silent as unknown as ServiceWorker, 20)).toBeUndefined();
    expect(await askWorkerVersion(null)).toBeUndefined();
  });

  function updater(o: { page?: string; versions: (string | undefined)[]; takesOver?: boolean }) {
    const calls: string[] = [];
    const versions = [...o.versions];
    const u: WorkerUpdater = {
      page: o.page,
      workerVersion: async () => { calls.push('ask'); return versions.shift(); },
      takeOver: async () => { calls.push('takeOver'); return o.takesOver ?? true; },
    };
    return { u, calls };
  }

  it('the same build: no update', async () => {
    const { u, calls } = updater({ page: 'b', versions: ['b'] });
    await ensureCurrentWorker(u);
    expect(calls).toEqual(['ask']);
  });

  it('the old build in control: the new worker takes over, and the load goes on under it', async () => {
    const { u, calls } = updater({ page: 'b', versions: ['a', 'b'] });
    await ensureCurrentWorker(u);
    expect(calls).toEqual(['ask', 'takeOver', 'ask']);
  });

  it('no worker of this build takes over: an error that says Reload, never a load through the old one', async () => {
    const stuck = updater({ page: 'b', versions: ['a', 'a'], takesOver: false });
    await expect(ensureCurrentWorker(stuck.u)).rejects.toThrow(WORKER_OUT_OF_DATE);
    expect(WORKER_OUT_OF_DATE).toMatch(/Reload/);
    // (the one that took over is of yet another build)
    await expect(ensureCurrentWorker(updater({ page: 'b', versions: [undefined, 'c'] }).u)).rejects.toThrow(WORKER_OUT_OF_DATE);
    // (a slow answer the first time: asked again, and it was this build after all)
    await expect(ensureCurrentWorker(updater({ page: 'b', versions: [undefined, 'b'], takesOver: false }).u)).resolves.toBeUndefined();
  });
});

describe('waitForWaiting', () => {
  function fakeReg(o: { waiting?: boolean; installing?: boolean; found?: 'installed' | 'redundant' | 'never' } = {}) {
    type W = { state: string; listeners: (() => void)[]; addEventListener(t: 'statechange', l: () => void): void };
    const worker = (): W => ({ state: 'installing', listeners: [], addEventListener(_t, l) { this.listeners.push(l); } });
    let found: (() => void) | undefined;
    const reg = {
      waiting: o.waiting ? {} : null as unknown,
      installing: o.installing ? worker() : null as W | null,
      update: vi.fn(async () => {
        if (o.found === undefined || o.found === 'never') return;
        reg.installing = worker();
        found?.();
        setTimeout(() => finish(o.found === 'installed' ? 'installed' : 'redundant'), 5);
      }),
      addEventListener: (_t: 'updatefound', l: () => void) => { found = l; },
    };
    const finish = (state: 'installed' | 'redundant'): void => {
      const w = reg.installing!;
      w.state = state;
      if (state === 'installed') { reg.waiting = {}; reg.installing = null; } else reg.installing = null;
      for (const l of w.listeners) l();
    };
    return { reg: reg as RegistrationLike & typeof reg, finish };
  }

  it('a worker already waiting', async () => {
    expect(await waitForWaiting(fakeReg({ waiting: true }).reg, 50)).toBe(true);
  });

  it('one installing, waited on until it is installed', async () => {
    const f = fakeReg({ installing: true });
    const done = waitForWaiting(f.reg, 500);
    setTimeout(() => f.finish('installed'), 5);
    expect(await done).toBe(true);
    expect(f.reg.update).not.toHaveBeenCalled();
  });

  it('none yet: an update check finds it', async () => {
    const f = fakeReg({ found: 'installed' });
    expect(await waitForWaiting(f.reg, 500)).toBe(true);
    expect(f.reg.update).toHaveBeenCalledTimes(1);
  });

  it('an install that fails, or no new worker at all, is false', async () => {
    expect(await waitForWaiting(fakeReg({ found: 'redundant' }).reg, 500)).toBe(false);
    expect(await waitForWaiting(fakeReg({ found: 'never' }).reg, 30)).toBe(false);
  });
});
