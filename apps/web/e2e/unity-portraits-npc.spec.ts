// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { expect, test, type Page } from '@playwright/test';
import { parse } from 'yaml';
// (for its `window.__au` declaration; Playwright erases the import)
import type {} from '../src/debug';
import { answer, button, GAME_DIR, importSave, lounge, portraitsPresent, quiet, settled, watchConsole } from './helpers';

// The people the player talks to, who are not the crew, show their own portrait beside their lines (the speaker's picture in the subtitle,
// where the original draws icon.map's head in the dialog box), and Picard, who answers, his. The art is local (Paramount's): each test
// is skipped unless `art publish-kit` has published the portraits. The lounge conversation plays from the after-mertens checkpoint.

const GARIDIANS = [['5f0401', 't_bak'], ['5f0400', 'lucana'], ['5f0402', 'avakar']] as const;
const kit = portraitsPresent(['picard', ...GARIDIANS.map(([, id]) => id)], []);
const checkpoint = `${homedir()}/pcode/unity-raw/runs/plan12-route/after-mertens.json`;
const shots = `${homedir()}/pcode/unity-raw/runs/ui-portraits`;
const ids = () => parse(readFileSync(`${GAME_DIR}ids.yaml`, 'utf8')) as { objects: Record<string, string> };

test.setTimeout(240_000);

/** The speaker, name and picture of the subtitle on screen now. */
const subtitle = (page: Page) => page.locator('.au-subtitle').evaluate(e => {
  const img = e.querySelector('img');
  return { who: e.getAttribute('data-speaker'), src: img?.getAttribute('src') ?? null, placeholder: img?.hasAttribute('data-placeholder') ?? false, loaded: img ? img.complete && img.naturalWidth > 0 : false };
});

/** Plays the open conversation, line by line, until `done` says so (picking the first option of each menu): the lines' speakers and pictures, first of each speaker. */
async function listen(page: Page, wanted: string[], shot: (who: string) => Promise<void>): Promise<Map<string, Awaited<ReturnType<typeof subtitle>>>> {
  const seen = new Map<string, Awaited<ReturnType<typeof subtitle>>>();
  for (let i = 0; i < 600 && !wanted.every(w => seen.has(w)); i++) {
    if (await page.locator('.au-subtitle').isVisible()) {
      const s = await subtitle(page);
      if (s.who && !seen.has(s.who) && s.loaded) {
        seen.set(s.who, s);
        await shot(s.who);
      }
      await page.evaluate(() => window.__au!.skipLine());
    } else if (await page.locator('.au-menu').isVisible()) await page.locator('.au-menu').getByRole('button').nth(0).click().catch(() => {});
    else if (await page.evaluate(() => window.__au!.idle())) break;
    await page.waitForTimeout(100);
  }
  return seen;
}

test.describe('the conference lounge', () => {
  test.skip(!kit.present, `needs ${kit.why}`);
  test.skip(!existsSync(checkpoint), 'needs plan12-route/after-mertens.json (RAW_DIR=... npx vitest run tools/play/src/live-route.test.ts)');

  for (const [object, name] of GARIDIANS) {
    test(`${name}'s lines show their own portrait, and Picard's his`, async ({ page }) => {
      const errors = watchConsole(page);
      await page.goto('/play/afu/?game=unity&speed=8&mute&dev');
      await page.waitForFunction(() => window.__au?.ready === true);
      await quiet(page);
      await importSave(page, checkpoint);
      // (the ship's own hail first, answered as the route does)
      await answer(page, 0, 'ship.c022@4');
      const who = ids().objects[object];
      expect(who, `no object name for ${object}`).toBeDefined();
      await lounge(page, who!);
      mkdirSync(shots, { recursive: true });
      const seen = await listen(page, [who!, 'picard'], async w => {
        await page.locator('#game').screenshot({ path: `${shots}/lounge-${w === 'picard' ? `${name}-picard` : name}.png` });
      });
      const guest = seen.get(who!)!;
      expect(guest, 'the guest speaks').toBeDefined();
      expect(guest.placeholder).toBe(false);
      expect(guest.src).toContain(`avatars/${name}`);
      const picard = seen.get('picard');
      if (picard) {
        expect(picard.placeholder).toBe(false);
        expect(picard.src).toContain('avatars/picard');
      }
      expect(errors).toEqual([]);
    });
  }

  test('with art off the lounge guest\'s line is text only', async ({ page }) => {
    await page.goto('/play/afu/?game=unity&speed=8&mute&dev&art=0');
    await page.waitForFunction(() => window.__au?.ready === true);
    await quiet(page);
    await importSave(page, checkpoint);
    await answer(page, 0, 'ship.c022@4');
    await lounge(page, ids().objects['5f0401']!);
    await page.locator('.au-subtitle').waitFor();
    await expect(page.locator('.au-subtitle')).toContainText("T'Bak:");
    await expect(page.locator('.au-subtitle img')).toHaveCount(0);
  });
});

// An away mission's conversation: Dr. Griems (world 4, screen 8) answers the leader, who talks to him.
const AWAY = [
  ['lab.s08', 'lab.dr_griems', 'griems'],
  // Frigis: the Gatekeeper's head is a machine face in the original (the non-face path: the game head repainted, no grab)
  ['frigis.s0a', 'frigis.gatekeeper.0a13', 'gatekeeper'],
] as const;
const awayKit = portraitsPresent(['picard', ...AWAY.map(([, , id]) => id)], []);

test.describe('an away mission', () => {
  test.skip(!awayKit.present, `needs ${awayKit.why}`);

  for (const [room, who, name] of AWAY) {
    test(`${who} speaks with their own portrait, the leader with his`, async ({ page }) => {
      const errors = watchConsole(page);
      await page.goto(`/play/afu/?game=unity&dev&start=${room}&team=picard,riker,data,troi&mute&speed=8&panel=0`);
      await page.waitForFunction(() => window.__au?.ready === true);
      await settled(page);
      await button(page, 'Talk').click();
      const p = await page.evaluate(i => window.__au!.point(i), who);
      expect(p, `${who} is on screen`).not.toBeNull();
      await page.mouse.click(p!.x, p!.y);
      mkdirSync(shots, { recursive: true });
      const seen = await listen(page, [who], async w => {
        await page.locator('#game').screenshot({ path: `${shots}/away-${w === who ? name : 'leader'}.png` });
      });
      const npc = seen.get(who);
      expect(npc, `${who} speaks (heard: ${[...seen.keys()].join(', ')})`).toBeDefined();
      expect(npc!.placeholder).toBe(false);
      expect(npc!.src).toContain(`avatars/${name}`);
      expect(errors).toEqual([]);
    });
  }
});
