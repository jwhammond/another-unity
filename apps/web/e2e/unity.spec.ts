// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { parse } from 'yaml';
// (for its `window.__au` declaration; Playwright erases the import)
import type {} from '../src/debug';
import { act, beamDown, button, clickObject, expectFrames, missionSelectUrl, settled, watchConsole } from './helpers';

const game = fileURLToPath(new URL('../../../games/unity/', import.meta.url));
const lifted = existsSync(`${game}game.yaml`) && existsSync(`${game}models/rooms`);

test.skip(!lifted, 'needs the lifted game under games/unity (npm run unity:build, docs/unity-local.md)');

test('Horst III: the first screen renders and answers a look, with no console errors', async ({ page }) => {
  const ids = parse(readFileSync(`${game}ids.yaml`, 'utf8')) as { objects: Record<string, string>; screens: Record<string, string> };
  const errors = watchConsole(page);
  await page.goto(missionSelectUrl());
  await page.waitForFunction(() => window.__au?.ready === true);
  await beamDown(page, 'horst3');
  await settled(page);
  await expectFrames(page);
  expect((await page.evaluate(() => window.__au!.state())).screen).toBe(ids.screens.s_0701);

  // (no game dialogue is quoted: the look must add a line to the transcript, whatever it says)
  const before = (await page.evaluate(() => window.__au!.heard())).length;
  await act(page, async () => {
    await button(page, 'Look').click();
    await clickObject(page, ids.objects['070103']);
  });
  await page.waitForFunction(n => window.__au!.heard().length > n, before, { timeout: 30_000 });
  await settled(page);
  await expectFrames(page);
  expect(errors).toEqual([]);
});

test('Horst III: every crew member on the second screen is drawn in front of the access shaft and takes the click', async ({ page }) => {
  const ids = parse(readFileSync(`${game}ids.yaml`, 'utf8')) as { objects: Record<string, string>; screens: Record<string, string> };
  const errors = watchConsole(page);
  await page.goto(missionSelectUrl());
  await page.waitForFunction(() => window.__au?.ready === true);
  await beamDown(page, 'horst3');
  await settled(page);

  // (the dev overlay's jump, to where the team comes in from the first screen)
  const s02 = ids.screens.s_0702;
  await page.keyboard.press('Backquote');
  await page.getByRole('button', { name: 'view', exact: true }).click();
  await page.getByLabel('Screen', { exact: true }).selectOption(s02);
  await page.getByLabel('Entrance').selectOption('entrance_0');
  await page.getByRole('button', { name: 'Jump', exact: true }).click();
  await page.keyboard.press('Backquote');
  await settled(page);
  const s = await page.evaluate(() => window.__au!.state());
  expect(s.screen).toBe(s02);

  // (they stand just in front of the access shaft, whose hotspot took their clicks)
  const crew = s.awayTeam.filter(id => s.objects[id].screen === s02);
  expect(crew.length).toBeGreaterThan(1);
  for (const id of crew) {
    const p = await page.evaluate(i => window.__au!.point(i), id);
    expect(p, id).not.toBeNull();
    expect(await page.evaluate(({ x, y }) => window.__au!.objectAt(x, y), p!), id).toBe(id);
  }
  // (and a real click on one looks at them)
  const before = (await page.evaluate(() => window.__au!.heard())).length;
  await act(page, async () => {
    await button(page, 'Look').click();
    await clickObject(page, crew[1]);
  });
  await page.waitForFunction(n => window.__au!.heard().length > n, before, { timeout: 30_000 });
  await settled(page);
  expect(errors).toEqual([]);
});
