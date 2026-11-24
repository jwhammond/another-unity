// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { parse } from 'yaml';
// (for its `window.__au` declaration; Playwright erases the import)
import type {} from '../src/debug';
import { act, GAME_DIR, poll, settled, state, watchConsole } from './helpers';

// Mertens' hotspots are the original's: objectAt tests a pixel against each object's rectangle on the 640 by 480 screen, front first by y_adjust.
// Two kinds of object could not be clicked before, because the browser's 3D boxes had no ground to stand on above the picture's horizon:
// the shelf's pickups in lab.s07 (flux router and plasma shunt, whose rows are 207 to 223) and the conduit on the far wall of lab.s06
// (damaged conduit 0623, rows 5 to 115; its y_adjust 176 puts it in front of the power conduits 0606 that cover it).
// The game's text is local (Paramount's), so what the conduit says is read from the lifted object, and the test skips without it.

const have = existsSync(`${GAME_DIR}game.yaml`) && existsSync(`${GAME_DIR}objects/lab/s06/damaged_conduit.0623.yaml`);
test.skip(!have, 'needs the lifted game (npm run unity:build)');

const ITEMS = ['flux_router', 'inverter_coupling', 'pulse_negator', 'wave_converter', 'plasma_shunt', 'graviton_probe'].map(n => `lab.${n}`);

async function open(page: Page, room: string): Promise<void> {
  await page.goto(`/play/afu/?game=unity&dev&start=${room}&team=picard,riker,data,troi&mute&art=0`);
  await page.waitForFunction(() => window.__au?.ready === true);
  await settled(page);
}

/** What the lifted object says when looked at, by every crew member. */
function descriptions(file: string): string[] {
  const o = parse(readFileSync(`${GAME_DIR}objects/${file}`, 'utf8')) as { descriptions: Record<string, { text: string }> };
  return Object.values(o.descriptions).map(d => d.text);
}

for (const item of ITEMS) {
  test(`lab.s07: ${item} is picked up from where it is drawn: pressed in Use mode and let go on the inventory`, async ({ page }) => {
    test.setTimeout(120_000);
    const errors = watchConsole(page);
    await open(page, 'lab.s07');
    expect((await state(page)).objects[item]).toMatchObject({ active: true, inventory: false });
    const at = await page.evaluate(i => window.__au!.point(i), item);
    expect(at, 'the item is where the original draws it').not.toBeNull();
    // (what a click there picks: the item itself, not what stands behind it)
    expect(await page.evaluate(([x, y]) => window.__au!.objectAt(x!, y!), [at!.x, at!.y])).toBe(item);
    await act(page, async () => {
      await page.keyboard.press('u');
      const box = await page.locator('[data-drop="inventory"]').boundingBox();
      if (!box) throw new Error('the inventory is not on the page');
      await page.mouse.move(at!.x, at!.y);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
      await page.mouse.up();
    });
    expect(await poll(async () => (await state(page)).objects[item]?.inventory === true, 60_000)).toBe(true);
    expect(errors).toEqual([]);
  });
}

test('lab.s06: the damaged conduit on the far wall is clicked where it is drawn, in front of the power conduits that cover it', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = watchConsole(page);
  await open(page, 'lab.s06');
  const at = await page.evaluate(() => window.__au!.point('lab.damaged_conduit.0623'));
  expect(at).not.toBeNull();
  // (rows 5 to 115, inside the power conduits' 5 to 175: whichever the original checks first is under the pointer)
  expect(await page.evaluate(([x, y]) => window.__au!.objectAt(x!, y!), [at!.x, at!.y])).toBe('lab.damaged_conduit.0623');
  // (the rest of the conduit's rectangle and, below it, the power conduits' own)
  const rect = await page.evaluate(() => {
    const c = document.querySelector('canvas')!.getBoundingClientRect();
    const px = (x: number, y: number) => window.__au!.objectAt(c.left + (x / 640) * c.width, c.top + (y / 480) * c.height);
    return { top: px(320, 8), bottom: px(320, 114), below: px(320, 150), side: px(280, 60), edge: px(306, 60) };
  });
  expect(rect).toEqual({ top: 'lab.damaged_conduit.0623', bottom: 'lab.damaged_conduit.0623', below: 'lab.power_conduits.0606', side: 'lab.power_conduits.0606', edge: 'lab.damaged_conduit.0623' });
  // Look at it: the line is the conduit's own, not the power conduits'.
  await act(page, async () => {
    await page.keyboard.press('l');
    await page.mouse.click(at!.x, at!.y);
  });
  const own = descriptions('lab/s06/damaged_conduit.0623.yaml');
  const others = descriptions('lab/s06/power_conduits.0606.yaml');
  expect(await poll(async () => (await page.evaluate(() => window.__au!.heard())).some(l => own.includes(l)), 60_000)).toBe(true);
  expect((await page.evaluate(() => window.__au!.heard())).some(l => others.includes(l))).toBe(false);
  expect(errors).toEqual([]);
});
