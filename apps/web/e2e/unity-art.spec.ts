// SPDX-License-Identifier: GPL-3.0-or-later
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
// (for its `window.__au` declaration; Playwright erases the import)
import type {} from '../src/debug';
import { act, artPresent, button, expectFrames, settled, state, watchConsole } from './helpers';

// Plan 14 Task 10: the repainted plate changes nothing the game does. Art on and off pick the same objects and walk to the same point.

const SCREEN = 'lab.s01';
const art = artPresent(SCREEN);
test.skip(!art.present, `needs ${art.why}`);

const shots = `${homedir()}/pcode/unity-raw/runs/art-lab-s01`;

interface Run {
  art: { screen: string | null; plate: boolean; on: boolean };
  picks: Record<string, string | null>;
  floor: { x: number; y: number };
  end: { actor: string; pos: { x: number; z: number } };
  errors: string[];
}

async function play(page: Page, query: string, name: string): Promise<Run> {
  const errors = watchConsole(page);
  await page.goto(`/play/afu/?game=unity&dev&start=${SCREEN}&mute${query}`);
  await page.waitForFunction(() => window.__au?.ready === true);
  await settled(page);
  // (the plate loads after the room is up: read what is shown once it is, with the art on; with it off there is nothing to wait for)
  if (!query.includes('art=0')) await page.waitForFunction(() => window.__au!.art().plate === true, undefined, { timeout: 60_000 });
  await expectFrames(page);
  const shown = await page.evaluate(() => window.__au!.art());

  // (every active object on the screen, at the point where it is drawn: what a click there picks)
  const ids = await page.evaluate(s => {
    const w = window.__au!.state();
    return Object.entries(w.objects).filter(([, o]) => o.active && o.screen === s && !o.inventory).map(([id]) => id).sort();
  }, await page.evaluate(() => window.__au!.state().screen));
  const picks: Record<string, string | null> = {};
  for (const id of ids) {
    const p = await page.evaluate(i => window.__au!.point(i), id);
    if (p) picks[id] = await page.evaluate(([x, y]) => window.__au!.objectAt(x, y), [p.x, p.y]);
  }

  // (a floor point low in the middle of the view, free of objects, the same in both loads)
  const floor = await page.evaluate(() => {
    const c = document.querySelector('canvas')!.getBoundingClientRect();
    return { x: c.left + c.width * 0.5, y: c.top + c.height * 0.8 };
  });
  expect(await page.evaluate(([x, y]) => window.__au!.objectAt(x, y), [floor.x, floor.y])).toBeNull();
  await act(page, async () => {
    await button(page, 'Walk').click();
    await page.mouse.click(floor.x, floor.y);
  });
  await settled(page);
  const w = await state(page);
  const actor = w.currentActor as string;
  const pos = { x: w.objects[actor].pos.x, z: w.objects[actor].pos.z };

  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: `${shots}/${name}.png` });
  return { art: { screen: shown.screen, plate: shown.plate, on: shown.on }, picks, floor, end: { actor, pos }, errors };
}

test('lab.s01: art on and off pick the same objects and walk to the same point, with no console errors', async ({ page }) => {
  const on = await play(page, '', 'art-on');
  expect(on.art).toEqual({ screen: SCREEN, plate: true, on: true });
  expect(Object.keys(on.picks).length).toBeGreaterThan(0);
  expect(on.errors).toEqual([]);

  const off = await play(page, '&art=0', 'art-off');
  expect(off.art.plate).toBe(false);
  expect(off.art.on).toBe(false);
  expect(off.errors).toEqual([]);

  expect(off.picks).toEqual(on.picks);
  expect(off.floor).toEqual(on.floor);
  expect(off.end).toEqual(on.end);
});
