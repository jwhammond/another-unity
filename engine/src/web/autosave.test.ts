// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { Autosave, autosaveEnabled, type AutosaveEnv, type AutosaveTarget } from './autosave';
import { WakeLockKeeper, type WakeLockEnv, type WakeLockSentinelLike } from './wakeLock';

/** A page that can be hidden and closed, and a clock that is stepped by hand. */
function page() {
  const handlers = new Map<string, Set<() => void>>();
  const listen = (kind: string) => ({
    addEventListener: (type: string, h: () => void) => { (handlers.get(`${kind}:${type}`) ?? handlers.set(`${kind}:${type}`, new Set()).get(`${kind}:${type}`)!).add(h); },
    removeEventListener: (type: string, h: () => void) => { handlers.get(`${kind}:${type}`)?.delete(h); },
  });
  const state = { visibilityState: 'visible' as DocumentVisibilityState };
  const timers: { handler: () => void; ms: number }[] = [];
  const env: AutosaveEnv = {
    document: Object.defineProperty(listen('document'), 'visibilityState', { get: () => state.visibilityState }) as unknown as AutosaveEnv['document'],
    window: listen('window') as unknown as AutosaveEnv['window'],
    setInterval: handler => { timers.push({ handler, ms: 0 }); return timers.length; },
    clearInterval: () => { timers.length = 0; },
  };
  const fire = (kind: string, type: string) => handlers.get(`${kind}:${type}`)?.forEach(h => h());
  return {
    env,
    hide: () => { state.visibilityState = 'hidden'; fire('document', 'visibilitychange'); },
    show: () => { state.visibilityState = 'visible'; fire('document', 'visibilitychange'); },
    pagehide: () => fire('window', 'pagehide'),
    tickTimers: () => timers.forEach(t => t.handler()),
    listening: () => [...handlers.values()].reduce((n, s) => n + s.size, 0),
  };
}

function target(over: Partial<{ canAutosave: boolean; whereabouts: string }> = {}) {
  const t = { canAutosave: true, whereabouts: 'bridge|bridge', saves: 0, ...over, autosave: async () => { if (!t.canAutosave) return false; t.saves++; return true; } };
  return t satisfies AutosaveTarget & { saves: number };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('Autosave', () => {
  it('writes when the page is hidden, and when it is going away', async () => {
    const p = page();
    const t = target();
    const a = new Autosave(t, { env: p.env });
    a.start();
    p.hide();
    await settle();
    expect(t.saves).toBe(1);
    // (shown again: nothing to write)
    p.show();
    await settle();
    expect(t.saves).toBe(1);
    p.pagehide();
    await settle();
    expect(t.saves).toBe(2);
  });

  it('writes at each screen change, and not while the screen stays', async () => {
    const p = page();
    const t = target();
    const a = new Autosave(t, { env: p.env });
    a.start();
    p.tickTimers();
    await settle();
    // (the first look writes: nothing has been written yet)
    expect(t.saves).toBe(1);
    p.tickTimers();
    await settle();
    expect(t.saves).toBe(1);
    t.whereabouts = 'lab.s01|';
    p.tickTimers();
    await settle();
    expect(t.saves).toBe(2);
    // (a ship station is a screen too)
    t.whereabouts = 'lab.s01|astrogation';
    p.tickTimers();
    await settle();
    expect(t.saves).toBe(3);
  });

  it('writes every minute', async () => {
    const p = page();
    const t = target();
    const a = new Autosave(t, { env: p.env, every: 60_000 });
    a.start();
    const now = Date.now();
    a.step(now);
    await settle();
    expect(t.saves).toBe(1);
    a.step(now + 30_000);
    await settle();
    expect(t.saves).toBe(1);
    a.step(now + 61_000);
    await settle();
    expect(t.saves).toBe(2);
  });

  it('waits for the game to be idle: a write due in the middle of a scene is made when the scene ends', async () => {
    const p = page();
    const t = target({ canAutosave: false });
    const a = new Autosave(t, { env: p.env });
    a.start();
    p.hide();
    t.whereabouts = 'lab.s01|';
    p.tickTimers();
    await settle();
    expect(t.saves).toBe(0);
    t.canAutosave = true;
    p.tickTimers();
    await settle();
    expect(t.saves).toBe(1);
    p.tickTimers();
    await settle();
    expect(t.saves).toBe(1);
  });

  it('does not write twice at once, and reports a failed write', async () => {
    const p = page();
    const errors: unknown[] = [];
    let release: () => void = () => {};
    let calls = 0;
    const slow: AutosaveTarget = { canAutosave: true, whereabouts: 'a', autosave: () => { calls++; return new Promise<boolean>(resolve => { release = () => resolve(true); }); } };
    const a = new Autosave(slow, { env: p.env, onError: e => errors.push(e) });
    a.start();
    a.flush();
    a.flush();
    expect(calls).toBe(1);
    release();
    await settle();
    const broken: AutosaveTarget = { canAutosave: true, whereabouts: 'a', autosave: () => Promise.reject(new Error('full')) };
    const b = new Autosave(broken, { env: p.env, onError: e => errors.push(e) });
    b.flush();
    await settle();
    expect(errors).toHaveLength(1);
  });

  it('takes its listeners and timer off when stopped', () => {
    const p = page();
    const a = new Autosave(target(), { env: p.env });
    a.start();
    expect(p.listening()).toBe(2);
    a.stop();
    expect(p.listening()).toBe(0);
  });
});

describe('autosaveEnabled', () => {
  it('is on for a player (the dev server too), and off for the dev tools, a test browser and the dev mission select', () => {
    expect(autosaveEnabled('?game=unity', false)).toBe(true);
    expect(autosaveEnabled('', false)).toBe(true);
    expect(autosaveEnabled('?dev', false)).toBe(false);
    expect(autosaveEnabled('?autostart', false)).toBe(false);
    expect(autosaveEnabled('?missions', false)).toBe(false);
    expect(autosaveEnabled('', true)).toBe(false);
  });

  it('is on with ?autosave whatever else is', () => {
    expect(autosaveEnabled('?dev&autosave', true)).toBe(true);
  });
});

describe('WakeLockKeeper', () => {
  function env() {
    const handlers = new Set<() => void>();
    const doc = { visibilityState: 'visible' as DocumentVisibilityState, addEventListener: (_: string, h: () => void) => handlers.add(h), removeEventListener: (_: string, h: () => void) => handlers.delete(h) };
    const sentinels: (WakeLockSentinelLike & { fire(): void })[] = [];
    const request = vi.fn(async (): Promise<WakeLockSentinelLike> => {
      const listeners: (() => void)[] = [];
      const s = {
        released: false,
        release: async () => { s.released = true; },
        addEventListener: (_: 'release', l: () => void) => { listeners.push(l); },
        fire: () => { s.released = true; listeners.forEach(l => l()); },
      };
      sentinels.push(s);
      return s;
    });
    const e: WakeLockEnv = { nav: { wakeLock: { request } }, document: doc as unknown as WakeLockEnv['document'] };
    return { e, doc, request, sentinels, visibility: (v: DocumentVisibilityState) => { doc.visibilityState = v; handlers.forEach(h => h()); } };
  }

  it('asks for a screen lock while playing, and again when the page comes back from hidden (the browser drops the lock then)', async () => {
    const w = env();
    const keeper = new WakeLockKeeper(w.e);
    keeper.acquire();
    await settle();
    expect(w.request).toHaveBeenCalledTimes(1);
    w.sentinels[0]!.fire();
    w.visibility('hidden');
    await settle();
    expect(w.request).toHaveBeenCalledTimes(1);
    w.visibility('visible');
    await settle();
    expect(w.request).toHaveBeenCalledTimes(2);
    // (still held: no second ask)
    w.visibility('visible');
    await settle();
    expect(w.request).toHaveBeenCalledTimes(2);
    keeper.release();
    await settle();
    expect(w.sentinels[1]!.released).toBe(true);
  });

  it('is quiet where there is no Wake Lock, and where it is refused', async () => {
    const none = new WakeLockKeeper({ nav: {}, document: env().doc as unknown as WakeLockEnv['document'] });
    expect(() => none.acquire()).not.toThrow();
    const refused = env();
    refused.request.mockRejectedValue(new DOMException('no', 'NotAllowedError'));
    const keeper = new WakeLockKeeper(refused.e);
    keeper.acquire();
    await settle();
    expect(keeper.granted).toBe(0);
  });
});
