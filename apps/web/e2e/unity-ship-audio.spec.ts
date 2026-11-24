// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
// (for its `window.__au` declaration; Playwright erases the import)
import type {} from '../src/debug';
import { bridgeItem, clickWhenIdle, drive, goTo, quiet, station, watchConsole } from './helpers';

// docs/unity-ship-buttons.md "The ship's audio": the bridge screens' music, the computer's voice and the console's sounds, through the
// mixer the page already has (muted: the sounds still start, and `window.__au.sounds()` reports them).

const lifted = existsSync(new URL('../../../games/unity/audio/music/bridgamb.ogg', import.meta.url));
test.skip(!lifted, 'needs the ship\'s audio under games/unity/audio (npm run unity:build, docs/unity-local.md)');
test.use({ actionTimeout: 30_000 });

const sounds = (page: Page) => page.evaluate(() => window.__au!.sounds());
/** The last music loop that started: its file's stem. */
async function music(page: Page): Promise<string | undefined> {
  const loops = (await sounds(page)).filter(s => s.loop && s.bus === 'music');
  return loops.at(-1)?.url.match(/([^/]+)\.ogg/)?.[1];
}
const heard = async (page: Page, stem: string, bus?: string): Promise<boolean> => (await sounds(page)).some(s => s.url.includes(`/${stem}.`) && (bus === undefined || s.bus === bus));

test('the bridge screens play their music, the computer says how it is, and the console clicks', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = watchConsole(page);
  await page.goto('/play/afu/?game=unity&speed=4&mute&dev&art=0');
  await page.waitForFunction(() => window.__au?.ready === true);
  await quiet(page);

  // the bridge's loop, from the start
  await expect.poll(() => music(page), { timeout: 30_000 }).toBe('bridgamb');

  // astrogation's own, and the console's beep on the way there
  await goTo(page, 'Astrogation', 'astrogation');
  await expect.poll(() => music(page), { timeout: 30_000 }).toBe('astro');
  expect(await heard(page, 'beep7', 'sfx')).toBe(true);
  await drive(page, async () => { await clickWhenIdle(page.locator('.au-astro').getByRole('button', { name: 'Bridge', exact: false }).first()); return (await station(page, 'bridge').count()) > 0; });
  await expect.poll(() => music(page), { timeout: 30_000 }).toBe('bridgamb');

  // the computer: "online", then its state (a new game's computer is at full strength), and only then its music
  const before = (await sounds(page)).length;
  await goTo(page, 'Computer', 'computer');
  await expect.poll(async () => (await sounds(page)).slice(before).filter(s => s.bus === 'voice').map(s => s.url.match(/(fe09[0-9a-f]{4})/)?.[1]), { timeout: 30_000 }).toEqual(['fe090081', 'fe090082']);
  await expect.poll(() => music(page), { timeout: 30_000 }).toBe('compute');
  await drive(page, async () => { await clickWhenIdle(page.locator('[data-station="computer"]').getByRole('button', { name: 'Bridge' }).first()); return (await station(page, 'bridge').count()) > 0; });

  // the holodeck: its door and projector, and no music
  await drive(page, async () => {
    if ((await station(page, 'holodeck').count()) > 0) return true;
    const lift = page.getByRole('list', { name: 'Turbolift' });
    if ((await lift.count()) > 0) await clickWhenIdle(lift.getByRole('button', { name: 'Holodeck', exact: true }));
    else await clickWhenIdle(bridgeItem(page, 'Turbolift'));
    return (await station(page, 'holodeck').count()) > 0;
  });
  await expect.poll(() => heard(page, 'holodoor'), { timeout: 30_000 }).toBe(true);
  expect(await heard(page, 'holoon')).toBe(true);
  expect(errors).toEqual([]);
});
