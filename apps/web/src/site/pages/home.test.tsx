// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment happy-dom
import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Home from './Home';
import { launchGame } from './GameCard';
import { chirp } from '../lcars/chirp';

vi.mock('../lcars/chirp', async importOriginal => ({ ...(await importOriginal<typeof import('../lcars/chirp')>()), chirp: vi.fn() }));
const media = vi.hoisted(() => ({ count: 'loading' as number | 'loading' }));
vi.mock('../media', () => ({ useMedia: () => undefined, useMediaCount: () => media.count }));

// (a plain stand-in: the test runner's own localStorage is not always there)
beforeEach(() => {
  const memory = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => { memory.set(k, v); }, clear: () => memory.clear() });
});
afterEach(() => {
  media.count = 'loading'; vi.mocked(chirp).mockClear(); document.body.innerHTML = ''; vi.unstubAllGlobals(); });

// (preact batches state updates; let them land)
const tick = () => new Promise<void>(r => setTimeout(r, 0));

describe('launchGame', () => {
  it('opens the au-afu tab without a URL, loads the game into a blank one and focuses it', () => {
    const w = { location: { href: 'about:blank' }, focus: vi.fn() };
    const open = vi.fn(() => w as unknown as Window);
    launchGame(open, vi.fn());
    expect(open).toHaveBeenCalledWith('', 'au-afu');
    expect(w.location.href).toBe('/play/afu/');
    expect(w.focus).toHaveBeenCalled();
  });
  it('a second press only focuses the tab: a tab already on the game is not navigated', () => {
    const w = { location: { href: 'http://localhost/play/afu/' }, focus: vi.fn() };
    launchGame(vi.fn(() => w as unknown as Window), vi.fn());
    expect(w.location.href).toBe('http://localhost/play/afu/');
    expect(w.focus).toHaveBeenCalled();
  });
  it('navigates this tab when the pop-up is blocked', () => {
    const nav = vi.fn();
    launchGame(vi.fn(() => null), nav);
    expect(nav).toHaveBeenCalledWith('/play/afu/');
  });
});

describe('Home', () => {
  it('opens with A Final Unity expanded, collapses it on a press, and keeps Elite Force disabled', async () => {
    const root = document.createElement('div'); document.body.append(root);
    render(<Home />, root);
    const afu = root.querySelector<HTMLButtonElement>('[data-game="afu"]')!;
    expect(afu.getAttribute('aria-expanded')).toBe('true');
    expect(root.textContent).toContain('It is currently in beta playtests.');
    afu.click();
    await tick();
    expect(afu.getAttribute('aria-expanded')).toBe('false');
    afu.click();
    await tick();
    const ef = root.querySelector<HTMLButtonElement>('[data-game="ef"]')!;
    expect(ef.getAttribute('aria-disabled')).toBe('true');
    ef.click();
    await tick();
    expect(root.querySelectorAll('[aria-expanded="true"]').length).toBe(1);
  });
  it('plays the press chirp for A Final Unity and the deny chirp for Elite Force', async () => {
    const root = document.createElement('div'); document.body.append(root);
    render(<Home />, root);
    root.querySelector<HTMLButtonElement>('[data-game="afu"]')!.click();
    expect(chirp).toHaveBeenLastCalledWith('press');
    root.querySelector<HTMLButtonElement>('[data-game="ef"]')!.click();
    expect(chirp).toHaveBeenLastCalledWith('deny');
  });
  it('reads rooms with new art from the manifest: a dash while loading or with none, else the count', async () => {
    const root = document.createElement('div'); document.body.append(root);
    const rooms = () => [...root.querySelectorAll('.lc-readout > div')].find(r => r.textContent!.startsWith('Rooms with new art'))!.querySelector('dd')!.textContent;
    render(<Home />, root);
    await tick();
    expect(rooms()).toBe('—');
    expect(root.textContent).not.toContain('Saves');
    media.count = 75;
    render(<Home />, root);
    await tick();
    expect(rooms()).toBe('75');
    media.count = 0;
    render(<Home />, root);
    await tick();
    expect(rooms()).toBe('—');
  });
});
