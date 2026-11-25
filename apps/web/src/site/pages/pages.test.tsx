// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment happy-dom
import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../media', () => ({ useMedia: () => undefined, useMediaCount: () => 0 }));
afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const tick = () => new Promise<void>(r => setTimeout(r, 0));

describe('the engineering pages', () => {
  for (const name of ['engine', 'afu', 'characters', 'enterprise', 'tactical', 'mission', 'missions']) {
    it(`${name}: renders in one frame with one h1`, async () => {
      const { pageFor } = await import('../loader');
      if (name === 'mission') document.body.dataset.world = 'horst3';
      const Page = await pageFor(name);
      const root = document.createElement('div'); document.body.append(root);
      render(<Page />, root);
      await tick();
      expect(root.querySelectorAll('.lc-frame').length).toBe(1);
      expect(root.querySelectorAll('h1').length).toBe(1);
      if (name === 'enterprise') {
        const heads = [...root.querySelectorAll('.lc-panel > h2')].map(h => h.textContent);
        expect(heads).toEqual(['Bridge', 'Astrogation', 'Transporter', 'Engineering', 'Holodeck']);
        expect(root.querySelectorAll('.lc-panel').length).toBe(5);
        // (the three screens with no single plate, as pictures of the screen as played; the placeholders name their ids)
        for (const id of ['ship.engineering', 'ship.holodeck', 'ship.astrogation.screen']) expect(root.textContent).toContain(id);
      }
      if (name === 'missions') {
        // (the six worlds as a menu at the top, before any panel, then a panel for each with a link to its page)
        const first = root.querySelector('.lc-content')!.children;
        expect(first[1]!.matches('nav[aria-label="Worlds"]')).toBe(true);
        expect(first[1]!.querySelectorAll('a').length).toBe(6);
        expect(root.querySelectorAll('.lc-hub > .lc-panel').length).toBe(6);
        expect(root.querySelector('.lc-hub .lc-panel p')!.textContent!.length).toBeGreaterThan(20);
      }
      if (name === 'afu') expect(root.querySelector('a[href="/engineering/afu/missions/"]')).not.toBeNull();
      if (name === 'engine') {
        expect(root.textContent).toContain('I am not interested in discussions on the topic of AI usage.');
        const svg = root.querySelector('svg[role="img"]')!;
        expect(svg.getAttribute('aria-label')).toBeTruthy();
      }
    });
  }
});

describe('the page loader', () => {
  it('shows "Page not found" only for an unknown page', async () => {
    const { showError, pageFor } = await import('../loader');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const root = document.createElement('div');
    showError(await pageFor('nope').catch(e => e), root);
    expect(root.textContent).toContain('Page not found');
    expect(root.querySelector('.lc-frame.lc-home h1')).not.toBeNull();
    expect(root.querySelector('.lc-side a[aria-current="page"]')?.textContent).toContain('Home');
    expect(err).not.toHaveBeenCalled();
  });
  it('logs any other error and says the page failed to load', async () => {
    const { showError } = await import('../loader');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const root = document.createElement('div');
    const boom = new Error('boom');
    showError(boom, root);
    expect(root.textContent).toContain('This page failed to load');
    expect(root.textContent).not.toContain('Page not found');
    expect(err).toHaveBeenCalledWith(boom);
  });
});
