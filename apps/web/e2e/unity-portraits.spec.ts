// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { expect, test, type Page } from '@playwright/test';
// (for its `window.__au` declaration; Playwright erases the import)
import type {} from '../src/debug';
import { act, button, portraitsPresent, settled, watchConsole } from './helpers';

// The away team's bar shows the crew's portraits and the kit's icons, and the subtitles show the speaker's portrait, or the combadge for a
// speaker with none. The art is local (Paramount's): the file is skipped unless `art publish-kit` has run. With `&art=0` the bar is text.

const TEAM = ['picard', 'riker', 'data', 'troi'];
const ITEMS = ['tricorder', 'phaser', 'med_kit', 'med_tricorder', 'communicator'];
const kit = portraitsPresent(TEAM, ITEMS);
test.skip(!kit.present, `needs ${kit.why}`);

const shots = `${homedir()}/pcode/unity-raw/runs/ui-portraits`;
// (the HUD's own bar: the original's panel, where it is published, is unity-panel.spec's)
const START = `/play/afu/?game=unity&dev&start=lab.s01&team=${TEAM.join(',')}&mute&speed=8&panel=0`;

async function open(page: Page, query = ''): Promise<string[]> {
  const errors = watchConsole(page);
  await page.goto(`${START}${query}`);
  await page.waitForFunction(() => window.__au?.ready === true);
  await settled(page);
  return errors;
}

/** Every image of the bar has loaded and has pixels. */
const imagesLoaded = (page: Page) => page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('.au-bar img')].every(i => i.complete && i.naturalWidth > 0));

/** The bar sits inside the game's frame and none of its controls spills out of it. */
async function expectBarFits(page: Page): Promise<void> {
  const r = await page.evaluate(() => {
    const game = document.querySelector('#game')!.getBoundingClientRect();
    const bar = document.querySelector('.au-bar')!;
    const b = bar.getBoundingClientRect();
    const spill = [...bar.querySelectorAll('button, select')].filter(e => {
      const c = e.getBoundingClientRect();
      return c.right > b.right + 1 || c.left < b.left - 1 || c.bottom > b.bottom + 1;
    }).map(e => e.getAttribute('aria-label') ?? e.textContent);
    return { game: [game.left, game.top, game.right, game.bottom], bar: [b.left, b.top, b.right, b.bottom], scrolls: bar.scrollWidth > bar.clientWidth + 1, spill, height: b.height };
  });
  expect(r.bar[0]).toBeGreaterThanOrEqual(r.game[0]! - 1);
  expect(r.bar[2]).toBeLessThanOrEqual(r.game[2]! + 1);
  expect(r.bar[3]).toBeLessThanOrEqual(r.game[3]! + 1);
  expect(r.scrolls).toBe(false);
  expect(r.spill).toEqual([]);
  // (it covers less than a third of the room)
  expect(r.height).toBeLessThan((r.game[3]! - r.game[1]!) / 3);
}

for (const [label, size] of [['desktop', { width: 1280, height: 720 }], ['phone landscape', { width: 667, height: 375 }]] as const) {
  test(`${label}: the bar shows portraits and icons, named for a screen reader, and fits`, async ({ page }) => {
    await page.setViewportSize(size);
    const errors = await open(page);
    await imagesLoaded(page);
    for (const id of TEAM) {
      const b = page.locator(`.au-team button[data-member="${id}"]`);
      await expect(b.locator('img.au-portrait')).toHaveCount(1);
      await expect(b).toHaveAttribute('aria-label', /.+/);
      await expect(b).toHaveAttribute('title', /.+/);
      expect(await b.evaluate(e => getComputedStyle(e.querySelector('img')!).imageRendering)).toBe('pixelated');
    }
    // the accessible name is the character's name, so a button is still found by it
    await expect(button(page, 'Data')).toBeVisible();
    await expect(page.locator('.au-combadge img')).toHaveCount(1);
    await expect(button(page, 'Combadge')).toBeVisible();
    const items = page.locator('.au-inventory button.au-has-face');
    expect(await items.count()).toBeGreaterThan(0);
    await expect(page.locator('.au-inventory select[aria-label="Phaser setting"]')).toHaveCount(1);
    await expectBarFits(page);

    // selecting a member still works, and shows
    await act(page, () => button(page, 'Data').click(), async () => (await page.evaluate(() => window.__au!.state().currentActor)) === 'data');
    await expect(button(page, 'Data')).toHaveAttribute('aria-pressed', 'true');
    expect(errors).toEqual([]);
    if (label === 'desktop') {
      mkdirSync(shots, { recursive: true });
      await page.locator('#game').screenshot({ path: `${shots}/away-bar-lab-desktop.png` });
    } else {
      mkdirSync(shots, { recursive: true });
      await page.locator('#game').screenshot({ path: `${shots}/away-bar-lab-phone.png` });
    }
  });
}

test('a crew member who speaks shows their portrait beside the line, and anyone else the combadge', async ({ page }) => {
  const errors = await open(page);
  await imagesLoaded(page);
  // Look at an object: the leader speaks
  const id = 'lab.transporter';
  await act(page, async () => {
    await button(page, 'Look').click();
    const p = await page.evaluate(i => window.__au!.point(i), id);
    await page.mouse.click(p!.x, p!.y);
  });
  const line = page.locator('.au-subtitle');
  await line.waitFor();
  const who = (await line.getAttribute('data-speaker'))!;
  expect(TEAM).toContain(who);
  const face = line.locator('img.au-speaker');
  await expect(face).toHaveCount(1);
  expect(await face.getAttribute('data-placeholder')).toBeNull();
  const portrait = await face.getAttribute('src');
  expect(portrait).toContain('avatars');
  await page.waitForFunction(() => document.querySelector<HTMLImageElement>('.au-subtitle img')?.complete === true);
  await page.waitForTimeout(300);
  mkdirSync(shots, { recursive: true });
  await page.locator('#game').screenshot({ path: `${shots}/subtitle-crew.png` });
  // (the line's text is still the log's: name, then words)
  expect(await line.textContent()).toMatch(/^\S.*: .+/);

  // someone with no portrait, here the computer's voice and a caller the room doesn't have
  for (const [who2, name] of [['computer_voice', 'Computer'], ['lab.census_beverly', 'Technician']] as const) {
    await page.evaluate(([w, n]) => window.__au!.say(w, n, 'Working. Please stand by.'), [who2, name]);
    const placeholder = page.locator('.au-subtitle img.au-speaker');
    await expect(placeholder).toHaveAttribute('data-placeholder', '');
    expect(await placeholder.getAttribute('src')).toContain('icons');
    if (who2 === 'computer_voice') await page.locator('.au-subtitle img').evaluate(i => (i as HTMLImageElement).decode());
    await page.waitForTimeout(300);
    await page.locator('#game').screenshot({ path: `${shots}/subtitle-${who2 === 'computer_voice' ? 'computer' : 'npc'}.png` });
  }
  expect(errors).toEqual([]);
});

test('with art off the bar is text, as it was, and the subtitle has no picture', async ({ page }) => {
  const errors = await open(page, '&art=0');
  await expect(page.locator('.au-bar img')).toHaveCount(0);
  for (const name of ['Picard', 'Riker', 'Data', 'Troi', 'Combadge']) await expect(button(page, name)).toBeVisible();
  const items = page.locator('.au-inventory button');
  expect(await items.count()).toBeGreaterThan(0);
  for (const text of await items.allTextContents()) expect(text.trim()).not.toBe('');
  await expect(button(page, 'Data')).toHaveText('Data');
  await page.evaluate(() => window.__au!.say('computer_voice', 'Computer', 'Working.'));
  await expect(page.locator('.au-subtitle')).toHaveText('Computer: Working.');
  await expect(page.locator('.au-subtitle img')).toHaveCount(0);
  expect(errors).toEqual([]);
});
