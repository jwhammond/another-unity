// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment happy-dom
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Figure } from './Figure';

afterEach(() => vi.unstubAllGlobals());

describe('Figure', () => {
  it('shows a placeholder, never an <img>, for an id the manifest lacks', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
    const root = document.createElement('div');
    await act(async () => { render(<Figure id="room.x.s01" alt="A room" ratio="4 / 3" />, root); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('.lc-noimg')?.getAttribute('aria-label')).toBe('A room');
  });
});
