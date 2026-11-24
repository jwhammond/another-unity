// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
// (for its `window.__au` declaration; Playwright erases the import)
import type {} from '../src/debug';
import { quiet, watchConsole } from './helpers';

/** tools/combatshots/shots.sh's run: each battle's directory, with the states its shots show (M8 spec §9.3). Local only. */
const DIR = process.env.COMBATSHOTS_DIR;
test.skip(!DIR || !existsSync(DIR), 'the screenshot check\'s port side: run by tools/combatshots/shots.sh (COMBATSHOTS_DIR)');
test.setTimeout(600_000);

test('draws each shot\'s battle in the parity mode under its console, as ScummVM\'s 640 x 480 screen has them (M8 spec §9.3; Plan 27)', async ({ page }) => {
  const errors = watchConsole(page);
  // (the game frame is min(100vw, 133.333vh) wide: 481 high makes it exactly 640 x 480, where 480 would make it 639.98)
  await page.setViewportSize({ width: 640, height: 481 });
  // (COMBATSHOTS_ART=1, Plan 30 R17: the console with the art on; the view's set takes the art's textures, whose silhouettes are the original's)
  await page.goto(`/play/afu/?game=unity&dev&mute${process.env.COMBATSHOTS_ART ? '' : '&art=0'}&start=lab.s01`);
  await page.waitForFunction(() => window.__au?.ready === true);
  await quiet(page);
  await page.evaluate(() => window.__au!.combatParity(true));
  let shot = 0;
  for (const b of readdirSync(DIR!).filter(d => /^b\d+$/.test(d))) {
    const shots = existsSync(join(DIR!, b, 'shots.json')) ? JSON.parse(readFileSync(join(DIR!, b, 'shots.json'), 'utf8')) as { name: string; state: string }[] : [];
    for (const s of shots) {
      const state = JSON.parse(readFileSync(join(DIR!, b, s.state), 'utf8')) as unknown;
      await page.evaluate(st => window.__au!.previewState(st as Parameters<NonNullable<typeof window.__au>['previewState']>[0]), state);
      await expect.poll(() => page.evaluate(() => window.__au!.combatView().drawing)).toBe(true);
      // (a few frames: the scene is made, then drawn)
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
      // (the canvas's own pixels, not a screenshot of the page: no label or text over it, and no resampling)
      // (and the console over it, from the state's own console, once the game's fonts are in: Plan 27 R17)
      await expect.poll(() => page.evaluate(async () => (await window.__au!.combatShot({ console: true })).console), { timeout: 20_000 }).toBe(true);
      // (with the art on, the console drawn with its repaint, as the game draws it; one drawn without it fails here, not in compare --art: Plan 30 R17)
      if (process.env.COMBATSHOTS_ART) await expect.poll(() => page.evaluate(async () => (await window.__au!.combatShot({ console: true })).repaint), { timeout: 60_000, message: 'the port side drew no repaint' }).toBe(true);
      const canvas = await page.evaluate(() => window.__au!.combatShot({ console: true }));
      expect([canvas.width, canvas.height]).toEqual([640, 480]);
      if (process.env.COMBATSHOTS_ART) expect(canvas.repaint, 'the port side drew no repaint').toBe(true);
      writeFileSync(join(DIR!, b, `port-${s.name}.png`), Buffer.from(canvas.png.replace(/^data:image\/png;base64,/, ''), 'base64'));
      shot++;
    }
  }
  await page.evaluate(() => window.__au!.endPreview());
  console.log(`[combatshots] ${shot} shots drawn`);
  expect(errors).toEqual([]);
});
