// SPDX-License-Identifier: GPL-3.0-or-later
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
// (for its `window.__au` declaration; Playwright erases the import)
import type {} from '../src/debug';
import { act, artMasks, gameLifted, NEEDS_GAME, clickObject, hold, poll, settled, state, watchConsole } from './helpers';

test.skip(!gameLifted, NEEDS_GAME);

// Mertens s03: a phaser shot on the big cable cuts it. The original (ScummVM trace) turns o_040308 off and o_040307 on, which draws
// the same sprite's second animation where the first stood, so the cable stays on the screen, cut.

const shots = `${homedir()}/pcode/unity-raw/runs/placement`;

async function open(page: Page, query: string): Promise<void> {
  await page.goto(`/play/afu/?game=unity&dev&start=lab.s03&team=picard,riker,data,troi&mute${query}`);
  await page.waitForFunction(() => window.__au?.ready === true);
  await settled(page);
}

/** The phaser at its low setting on the whole cable, as a player does it. */
async function shoot(page: Page): Promise<void> {
  const gauge = page.getByRole('slider', { name: 'Phaser setting' });
  if (await gauge.count() > 0) {
    const box = (await gauge.boundingBox())!;
    // (screen x 414 + 14 * 5 + 7: position 5, the low setting that stuns)
    await page.mouse.click(box.x + ((414 + 14 * 5 + 7 - 410) / 230) * box.width, box.y + box.height / 2);
  } else {
    // (the plain panel of a room with no art has a select)
    await page.getByLabel('Phaser setting').selectOption('1');
  }
  expect((await state(page)).phaserSetting).toBe(1);
  await act(page, async () => {
    await hold(page, 'phaser');
    await clickObject(page, 'lab.big_cable.0308');
  });
  await settled(page);
}

test('lab.s03: a low phaser shot cuts the big cable: the whole one is off and the cut one on, as in the original', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = watchConsole(page);
  await open(page, '&art=0');
  await shoot(page);
  const w = await state(page);
  expect(w.objects['lab.big_cable.0308']).toMatchObject({ active: false, state: 1 });
  expect(w.objects['lab.big_cable.0307']).toMatchObject({ active: true });
  expect(errors).toEqual([]);
});

// The cable is a sprite the plate lacks, drawn from the cards `art masks` stands in a mask's place (card.lab_big_cable, card.lab_cut_cable):
// the whole cable's card goes with its object, so the cut one's must show, or the cable vanishes when shot. Skipped until both are published.
test('lab.s03: after the shot the cut cable is drawn where the whole one stood', async ({ page }) => {
  const published = artMasks('lab.s03');
  test.skip(!['lab.big_cable.0308', 'lab.big_cable.0307'].every(o => published.includes(o)), 'the cable props of lab.s03 are not published (art batch card.lab_big_cable.yaml card.lab_cut_cable.yaml, then art masks lab.s03)');
  test.setTimeout(180_000);
  const errors = watchConsole(page);
  await open(page, '');
  await poll(() => page.evaluate(() => window.__au!.art().shown.includes('lab.big_cable.0308')), 20_000);
  expect((await page.evaluate(() => window.__au!.art())).shown).not.toContain('lab.big_cable.0307');
  await shoot(page);
  await poll(() => page.evaluate(() => window.__au!.art().shown.includes('lab.big_cable.0307')), 20_000);
  const art = await page.evaluate(() => window.__au!.art());
  expect(art.shown).toContain('lab.big_cable.0307');
  expect(art.shown).not.toContain('lab.big_cable.0308');
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: `${shots}/cable-cut.png` });
  expect(errors).toEqual([]);
});
