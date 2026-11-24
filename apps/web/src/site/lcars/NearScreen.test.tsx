// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment happy-dom
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NearScreen } from './NearScreen';

afterEach(() => vi.unstubAllGlobals());

async function setup() {
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
  const root = document.createElement('div');
  document.body.append(root);
  await act(async () => { render(<div>{[1, 2, 3].map(i => <NearScreen key={i} ratio="4 / 3"><input type="range" aria-label={`room ${i}`} /></NearScreen>)}</div>, root); });
  return root;
}

describe('NearScreen', () => {
  it('holds a place until it is near, then Tab renders every room so the keyboard reaches each slider', async () => {
    const root = await setup();
    expect(root.querySelectorAll('input')).toHaveLength(0);
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' })); });
    expect(root.querySelectorAll('input')).toHaveLength(0);
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' })); });
    expect([...root.querySelectorAll('input')].map(i => i.getAttribute('aria-label'))).toEqual(['room 1', 'room 2', 'room 3']);
  });
  it('renders everything before printing', async () => {
    const root = await setup();
    await act(async () => { window.dispatchEvent(new Event('beforeprint')); });
    expect(root.querySelectorAll('input')).toHaveLength(3);
  });
});
