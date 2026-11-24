// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment happy-dom
import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Frame } from './Frame';
import { Pill } from './Pill';
import { setSound, soundOn } from './chirp';

// (a plain stand-in: the test runner's own localStorage is not always there)
beforeEach(() => {
  const memory = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => { memory.set(k, v); }, clear: () => memory.clear() });
});
afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals(); });

describe('Frame', () => {
  it('renders the title, the nav with the current page marked, and the footer notice', () => {
    const root = document.createElement('div'); document.body.append(root);
    render(<Frame section="home" title="Another Unity" code="01-1701" nav={[{ label: 'Home', href: '/', current: true }, { label: 'Engineering', href: '/engineering/' }]}><p>hi</p></Frame>, root);
    expect(root.querySelector('h1')!.textContent).toBe('Another Unity');
    expect(root.querySelector('[aria-current="page"]')!.textContent).toContain('Home');
    expect(root.querySelector('footer')!.textContent).toContain('James Hammond does not own this IP');
  });
  it('refuses more than six side blocks', () => {
    const root = document.createElement('div');
    const nav = Array.from({ length: 7 }, (_, i) => ({ label: `N${i}`, href: `/${i}` }));
    expect(() => render(<Frame section="home" title="T" code="0" nav={nav}><p /></Frame>, root)).toThrow(/six/);
  });
});

describe('sound', () => {
  it('is off by default and remembers being turned on', () => {
    expect(soundOn()).toBe(false);
    setSound(true);
    expect(localStorage.getItem('au-site-sound')).toBe('1');
    expect(soundOn()).toBe(true);
  });
});

describe('Pill', () => {
  it('does not call onClick when disabled, but stays focusable and marked aria-disabled', () => {
    const root = document.createElement('div'); document.body.append(root);
    let n = 0;
    render(<Pill disabled onClick={() => { n++; }}>Engage</Pill>, root);
    const b = root.querySelector('button')!;
    b.click();
    expect(n).toBe(0);
    expect(b.getAttribute('aria-disabled')).toBe('true');
    expect(b.hasAttribute('disabled')).toBe(false);
  });
});
