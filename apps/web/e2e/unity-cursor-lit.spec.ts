// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test, type Page } from '@playwright/test';
// (for its `window.__au` declaration; Playwright erases the import)
import type {} from '../src/debug';
import { artSpritesPresent, gameLifted, NEEDS_GAME, button, panelPresent, portraitsPresent, settled, watchConsole } from './helpers';

test.skip(!gameLifted, NEEDS_GAME);

// The pointer lights up over what a click would act on, as the original's does (updateAwayTeamCursor, handleAwayTeamMouseMove): over any object
// in every verb, and in Walk over floor to walk on; plain elsewhere. The lit frames are cursor.dat's odd ones (art cursors publish); without them
// the panel's selected sprites are lit, and with the art off the drawn ring is thicker. The art is local, so the first two skip without it.

const TEAM = ['picard', 'riker', 'data', 'troi'];
const ITEMS = ['tricorder', 'phaser', 'med_kit', 'med_tricorder', 'communicator'];
const START = `/play/afu/?game=unity&dev&start=lab.s01&team=${TEAM.join(',')}&mute&speed=8`;
const cursors = artSpritesPresent('cursors', 'cursors publish');
const panel = panelPresent();
const kit = portraitsPresent(TEAM, ITEMS);
const artOn = cursors.present && panel.present && kit.present;

async function open(page: Page, query: string): Promise<string[]> {
  const errors = watchConsole(page);
  await page.goto(`${START}${query}`);
  await page.waitForFunction(() => window.__au?.ready === true);
  await settled(page);
  return errors;
}

const pointer = (page: Page) => page.evaluate(() => {
  const g = document.querySelector<HTMLElement>('#game')!;
  return { lit: g.dataset.lit !== undefined, kind: g.dataset.cursor, css: g.style.getPropertyValue('--au-cursor-room') };
});

/** Moves over a fraction of the canvas and waits for the pointer to settle. */
async function moveTo(page: Page, x: number, y: number): Promise<void> {
  const c = (await page.locator('canvas').boundingBox())!;
  await page.mouse.move(c.x + c.width * x, c.y + c.height * y, { steps: 3 });
}

/** A point of the room that is no object and, for `floor`, is (or is not) open floor to walk on: found by asking the stage, as a click would. */
async function emptySpot(page: Page): Promise<{ x: number; y: number }> {
  const spot = await page.evaluate(() => {
    const c = document.querySelector('canvas')!.getBoundingClientRect();
    for (let fy = 0.03; fy < 0.7; fy += 0.04) {
      for (let fx = 0.05; fx < 0.95; fx += 0.05) {
        if (window.__au!.objectAt(c.left + c.width * fx, c.top + c.height * fy) === null) return { x: fx, y: fy };
      }
    }
    return null;
  });
  if (!spot) throw new Error('the room has no empty spot');
  return spot;
}

/** An object of the room that is clickable and not a transition or action square, where it is drawn. */
async function objectSpot(page: Page): Promise<{ x: number; y: number }> {
  const p = await page.evaluate(() => window.__au!.point('lab.power_monitor.0115'));
  if (!p) throw new Error('the power monitor is not on the screen');
  const c = (await page.locator('canvas').boundingBox())!;
  return { x: (p.x - c.x) / c.width, y: (p.y - c.y) / c.height };
}

test.describe('with the original\'s pointers', () => {
  test.skip(!artOn, `needs ${cursors.why || panel.why || kit.why}`);

  test('Look: lit over an object and plain off it, going back when the pointer leaves', async ({ page }) => {
    const errors = await open(page, '');
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('.au-awaypanel img')].every(i => i.complete && i.naturalWidth > 0));
    await button(page, 'Look').click();
    const empty = await emptySpot(page);
    await moveTo(page, empty.x, empty.y);
    await expect.poll(async () => (await pointer(page)).kind).toBe('sprite');
    const plain = await pointer(page);
    expect(plain.lit).toBe(false);
    const on = await objectSpot(page);
    await moveTo(page, on.x, on.y);
    await expect.poll(async () => (await pointer(page)).lit).toBe(true);
    const lit = await pointer(page);
    expect(lit.css).toMatch(/^url\("data:image\/png;base64,/);
    expect(lit.css).not.toBe(plain.css);
    // (the click point is the same on both frames: 18, 11 of the original's pixels, drawn at twice their size)
    expect(lit.css).toContain('") 36 22, ');
    await moveTo(page, empty.x, empty.y);
    await expect.poll(async () => (await pointer(page)).lit).toBe(false);
    expect((await pointer(page)).css).toBe(plain.css);
    // (leaving the room for the panel)
    await moveTo(page, on.x, on.y);
    await expect.poll(async () => (await pointer(page)).lit).toBe(true);
    await page.locator('.au-awaypanel').hover();
    await expect.poll(async () => (await pointer(page)).lit).toBe(false);
    expect(errors).toEqual([]);
  });

  test('Walk: lit over floor to walk on, plain over what is not (and in every verb over an object)', async ({ page }) => {
    const errors = await open(page, '');
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('.au-awaypanel img')].every(i => i.complete && i.naturalWidth > 0));
    await button(page, 'Walk').click();
    // (the floor: somewhere free of objects, above the panel, where the pointer lights; the wall above it is neither floor nor an object)
    const candidates = await page.evaluate(() => {
      const c = document.querySelector('canvas')!.getBoundingClientRect();
      const out: { x: number; y: number }[] = [];
      for (const fy of [0.75, 0.68, 0.6, 0.52]) for (const fx of [0.5, 0.35, 0.65, 0.2, 0.8]) if (window.__au!.objectAt(c.left + c.width * fx, c.top + c.height * fy) === null) out.push({ x: fx, y: fy });
      return out;
    });
    let floor: { x: number; y: number } | null = null;
    for (const c of candidates) {
      await moveTo(page, c.x, c.y);
      await page.waitForTimeout(200);
      if ((await pointer(page)).lit) { floor = c; break; }
    }
    expect(floor, 'Walk lights over some free point of the floor').not.toBeNull();
    const walkLit = await pointer(page);
    expect(walkLit.css).toContain('") 66 44, ');
    const wall = await emptySpot(page);
    await moveTo(page, wall.x, wall.y);
    await expect.poll(async () => (await pointer(page)).lit).toBe(false);
    expect((await pointer(page)).css).not.toBe(walkLit.css);
    // (Talk is lit only over an object, not over floor)
    await button(page, 'Talk').click();
    await moveTo(page, floor!.x, floor!.y);
    await expect.poll(async () => (await pointer(page)).lit).toBe(false);
    expect(errors).toEqual([]);
  });
});

test('with the art off the drawn ring lights too', async ({ page }) => {
  const errors = await open(page, '&art=0');
  await button(page, 'Look').click();
  const empty = await emptySpot(page);
  await moveTo(page, empty.x, empty.y);
  await expect.poll(async () => (await pointer(page)).kind).toBe('drawn');
  const plain = await pointer(page);
  expect(plain.lit).toBe(false);
  const on = await objectSpot(page);
  await moveTo(page, on.x, on.y);
  await expect.poll(async () => (await pointer(page)).lit).toBe(true);
  const lit = await pointer(page);
  expect(lit.css).toMatch(/^url\("data:image\/svg\+xml/);
  expect(lit.css).not.toBe(plain.css);
  await moveTo(page, empty.x, empty.y);
  await expect.poll(async () => (await pointer(page)).css).toBe(plain.css);
  expect(errors).toEqual([]);
});
