// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment happy-dom
import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { primeMedia, type MediaEntry } from '../media';
import { MISSIONS } from './missions';

// (every room is rendered at once where there is no IntersectionObserver)
beforeEach(() => { vi.stubGlobal('IntersectionObserver', undefined); });
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; delete document.body.dataset.world; });
const tick = () => new Promise<void>(r => setTimeout(r, 0));

function manifest(withMedia: boolean) {
  const items: Record<string, MediaEntry> = {};
  if (withMedia) {
    for (const m of MISSIONS) {
      for (const r of m.rooms) items[`room.${m.gameWorld}.${r}`] = { src: `/o-${r}.webp`, pairSrc: `/n-${r}.webp`, w: 960, h: 600, alt: r, kind: 'pair' };
      items[`hotspots.${m.gameWorld}.${m.rooms[0]}`] = { src: '/h.webp', w: 960, h: 720, alt: 'hot', kind: 'hotspots' };
      for (const c of m.cards) items[`sheet.${c}`] = { src: `/s-${c}.webp`, w: 960, h: 960, alt: c, kind: 'sheet' };
    }
  }
  primeMedia({ version: 1, built: 'x', items });
}

async function show(world: string) {
  document.body.dataset.world = world;
  const { default: Mission } = await import('./Mission');
  const root = document.createElement('div'); document.body.append(root);
  render(<Mission />, root);
  await tick(); await tick();
  return root;
}

describe('the mission pages', () => {
  it('lists the six worlds in the game order', () => {
    expect(MISSIONS.map(m => m.world)).toEqual(['horst3', 'mertens', 'allanor', 'zoo', 'frigis', 'unity']);
    expect(MISSIONS.map(m => m.gameWorld)).toEqual(['horst3', 'lab', 'allanor', 'zoo', 'frigis', 'unity']);
    for (const m of MISSIONS) expect(m.cards.length).toBeGreaterThan(0);
  });

  for (const m of MISSIONS) {
    it(`${m.world}: h1 is the name, one pair per room, a sprite sheet, the hotspots`, async () => {
      manifest(true);
      const root = await show(m.world);
      expect(root.querySelector('h1')!.textContent).toBe(m.name);
      expect(root.querySelectorAll('.lc-ba').length).toBe(m.rooms.length);
      expect(root.querySelectorAll('.lc-sheet').length).toBeGreaterThan(0);
      expect(root.querySelectorAll('.lc-hotspots img').length).toBe(1);
      expect(root.textContent).toContain('hotspots a player can click');
      expect(root.textContent).not.toContain('active at entry');
    });

    it(`${m.world}: with no media it shows placeholders, not a crash`, async () => {
      manifest(false);
      const root = await show(m.world);
      expect(root.querySelectorAll('h1').length).toBe(1);
      expect(root.querySelectorAll('img').length).toBe(0);
      expect(root.querySelectorAll('.lc-sheet').length).toBeGreaterThan(0);
    });
  }

  for (const m of MISSIONS) {
    it(`${m.world}: the worlds menu has six links, the current one marked`, async () => {
      manifest(false);
      const root = await show(m.world);
      const menu = root.querySelector('nav[aria-label="Worlds"]')!;
      const links = [...menu.querySelectorAll('a')];
      expect(links.map(a => a.getAttribute('href'))).toEqual(MISSIONS.map(x => `/engineering/afu/missions/${x.world}/`));
      expect(links.map(a => a.textContent)).toEqual(['Horst III', 'Mertens Station', 'Allanor', 'The zoo', 'Frigis', 'Unity']);
      const current = links.filter(a => a.getAttribute('aria-current') === 'page');
      expect(current.map(a => a.textContent)).toEqual([m.name]);
      // (at most three accents)
      expect(new Set(links.map(a => /tone-(a\d)/.exec(a.className)![1])).size).toBeLessThanOrEqual(3);
    });
  }

  it('the A Final Unity pill for Missions goes to the approach page\'s list of the worlds', async () => {
    manifest(false);
    const root = await show('zoo');
    const pill = [...root.querySelectorAll('nav[aria-label="A Final Unity"] a')].find(a => a.textContent === 'Missions')!;
    expect(pill.getAttribute('href')).toBe('/engineering/afu/#missions');
  });

  it('links to the previous and next mission', async () => {
    manifest(false);
    const root = await show('zoo');
    const hrefs = [...root.querySelectorAll('.lc-pager a')].map(a => a.getAttribute('href'));
    expect(hrefs).toEqual(['/engineering/afu/missions/allanor/', '/engineering/afu/missions/frigis/']);
  });

  it('an unknown world is a "No such mission" panel', async () => {
    manifest(false);
    const root = await show('nowhere');
    expect(root.textContent).toContain('No such mission');
    expect(root.querySelectorAll('h1').length).toBe(1);
  });
});

describe('splitProse', () => {
  it('sends The look to the top, room notes to the rooms and the rest to the sprites', async () => {
    const { splitProse } = await import('./Mission');
    const s = splitProse('<p>a</p><h2>The look</h2><p>b</p><h2>Not a room</h2><p>c</p><h2>What animates</h2><p>d</p>');
    expect(s.top).toContain('b');
    expect(s.rooms).toContain('c');
    expect(s.rooms).not.toContain('d');
    expect(s.sprites).toContain('What animates');
  });
  it('every world has text before its sheets: no "below" or "away team" stand-ins', async () => {
    const { splitProse } = await import('./Mission');
    const { default: md } = await import('../content/missions/mertens.md');
    expect(splitProse(md).sprites.length).toBeGreaterThan(0);
  });
});
