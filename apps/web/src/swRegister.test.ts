// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activateWaiting, cacheAll, onUpdating, registerServiceWorker } from './swRegister';

// A page already controlled by a worker, with a newer one waiting.
function stub() {
  const postMessage = vi.fn();
  const reg = { waiting: { postMessage }, active: null };
  vi.stubGlobal('navigator', {
    serviceWorker: { controller: {}, addEventListener: vi.fn(), register: vi.fn(async () => reg), ready: Promise.resolve(reg) },
    storage: { persist: async () => true, persisted: async () => true },
  });
  vi.stubGlobal('isSecureContext', true);
  return postMessage;
}
beforeEach(() => { vi.spyOn(console, 'info').mockImplementation(() => undefined); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('registerServiceWorker', () => {
  it('the game page tells a waiting worker to skip waiting', async () => {
    const post = stub();
    await registerServiceWorker();
    expect(post).toHaveBeenCalledWith({ type: 'skip' });
  });
  it('a site page registers without activating a waiting worker', async () => {
    const post = stub();
    await registerServiceWorker({ activate: false });
    expect(navigator.serviceWorker.register).toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });
});

describe('activateWaiting', () => {
  it('tells the waiting worker to take over and shows Updating…; with none waiting it does nothing', () => {
    const postMessage = vi.fn();
    const updating = vi.fn();
    onUpdating(updating);
    expect(activateWaiting({ waiting: null })).toBe(false);
    expect(activateWaiting({ waiting: { postMessage } as unknown as ServiceWorker })).toBe(true);
    expect(postMessage).toHaveBeenCalledWith({ type: 'skip' });
    expect(updating).toHaveBeenCalled();
  });
});

describe('cacheAll', () => {
  it('also downloads the sealed files no other list has, once each', async () => {
    stub();
    const manifest = {
      version: 'v', shell: [], data: ['/assets/a-ab12.json', '/assets/s-ab12.json'],
      assets: [{ url: '/assets/b-ab12.webp', size: 10 }], sealed: ['/assets/s-ab12.json', '/assets/c-ab12.rgb'],
    };
    const fetched: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/au-manifest.json') return new Response(JSON.stringify(manifest));
      fetched.push(url);
      return new Response('x');
    }));
    const p = await cacheAll();
    expect(fetched.sort()).toEqual(['/assets/a-ab12.json', '/assets/b-ab12.webp', '/assets/c-ab12.rgb', '/assets/s-ab12.json']);
    expect(p.total).toBe(4);
    expect(p.done).toBe(4);
  });
});
