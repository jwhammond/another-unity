// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { expect, test, type Page } from '@playwright/test';
// (for its `window.__au` declaration; Playwright erases the import)
import type {} from '../src/debug';
import { act, artSpritesPresent, button, panelPresent, portraitsPresent, settled, watchConsole } from './helpers';

// The away team's panel as the original draws it (awayteam.mrg, `art panel publish`): the verbs, the member's black box, the combadge, the
// six slots and their scroll buttons, and the phaser's power bar, each a control over the original's rectangle. The art is local
// (Paramount's): the file is skipped unless the panel, the portraits and the icons are published. With `&art=0` the HUD keeps its own bar.

const TEAM = ['picard', 'riker', 'data', 'troi'];
const ITEMS = ['tricorder', 'phaser', 'med_kit', 'med_tricorder', 'communicator'];
const panel = panelPresent();
const kit = portraitsPresent(TEAM, ITEMS);
test.skip(!panel.present || !kit.present, `needs ${panel.why || kit.why}`);

const shots = `${homedir()}/pcode/unity-raw/runs/ui-panel`;
const START = `/play/afu/?game=unity&dev&start=lab.s01&team=${TEAM.join(',')}&mute&speed=8`;

async function open(page: Page, query = ''): Promise<string[]> {
  const errors = watchConsole(page);
  await page.goto(`${START}${query}`);
  await page.waitForFunction(() => window.__au?.ready === true);
  await settled(page);
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('.au-awaypanel img')].every(i => i.complete && i.naturalWidth > 0));
  return errors;
}

const actor = (page: Page) => page.evaluate(() => window.__au!.state().currentActor);

/** The panel is the 640 by 80 strip at the frame's foot: the frame's width, a sixth of its height, flush with its bottom. */
async function expectPanelBox(page: Page): Promise<number> {
  const r = await page.evaluate(() => {
    const g = document.querySelector('#game')!.getBoundingClientRect();
    const p = document.querySelector('.au-awaypanel')!.getBoundingClientRect();
    return { g: [g.left, g.width, g.bottom, g.height], p: [p.left, p.width, p.bottom, p.height] };
  });
  expect(Math.abs(r.p[0]! - r.g[0]!)).toBeLessThan(1);
  expect(Math.abs(r.p[1]! - r.g[1]!)).toBeLessThan(1);
  expect(Math.abs(r.p[2]! - r.g[2]!)).toBeLessThan(1);
  expect(Math.abs(r.p[3]! - r.g[3]! / 6)).toBeLessThan(1);
  return r.p[1]! / 640;
}

for (const [label, size, file] of [['desktop', { width: 1280, height: 720 }, 'desktop'], ['phone landscape', { width: 667, height: 375 }, 'phone']] as const) {
  test(`${label}: the panel replaces the bar, its controls over the original's rectangles`, async ({ page }) => {
    await page.setViewportSize(size);
    const errors = await open(page);
    await expect(page.locator('.au-bar')).toHaveCount(0);
    const scale = await expectPanelBox(page);
    // the verbs, over their sprites: the selected one lit
    for (const v of ['Look', 'Use', 'Talk', 'Walk']) await expect(button(page, v)).toBeVisible();
    await button(page, 'Look').click();
    await expect(button(page, 'Look')).toHaveAttribute('aria-pressed', 'true');
    expect(await button(page, 'Look').locator('img').getAttribute('src')).toContain('look_on');
    // every control is at least the original's size, scaled: a touch target as big as the original's
    const small = await page.evaluate(min => [...document.querySelectorAll('.au-awaypanel button, .au-awaypanel [role=slider]')].map(e => ({ n: e.getAttribute('aria-label'), r: e.getBoundingClientRect() })).filter(({ r }) => r.width < 20 * min || r.height < 17 * min).map(x => x.n), scale);
    expect(small).toEqual([]);
    mkdirSync(shots, { recursive: true });
    await page.locator('#game').screenshot({ path: `${shots}/panel-lab-${file}.png` });
    await page.locator('.au-awaypanel').screenshot({ path: `${shots}/panel-only-${file}.png` });
    expect(errors).toEqual([]);
  });
}

test('the black box shows the current member and a click there moves to the next, as the original\'s does', async ({ page }) => {
  const errors = await open(page);
  const box = page.locator('.au-member');
  const first = await actor(page);
  await expect(box).toHaveAttribute('data-member', first);
  expect(await box.locator('img').getAttribute('src')).toContain(`avatars/${first}`);
  const seen = [first];
  for (let i = 1; i < TEAM.length; i++) {
    await act(page, () => box.click(), async () => (await actor(page)) !== seen.at(-1));
    seen.push(await actor(page));
    await expect(box).toHaveAttribute('data-member', seen.at(-1)!);
    await expect(box).toHaveAttribute('aria-label', /: next team member$/);
  }
  expect(new Set(seen).size).toBe(TEAM.length);
  await act(page, () => box.click(), async () => (await actor(page)) === first);
  expect(errors).toEqual([]);
});

test('the admin button opens the admin console (R2), Esc closes it; Shift+L shows the log and H the hotspots', async ({ page }) => {
  const errors = await open(page);
  const padd = page.getByRole('dialog', { name: 'Admin console' });
  await button(page, 'Admin').click();
  await expect(padd).toBeVisible();
  await page.locator('#game').screenshot({ path: `${shots}/panel-admin.png` });
  await page.keyboard.press('Escape');
  await expect(padd).toHaveCount(0);
  // (away, L is Look: the log is Shift+L)
  await page.keyboard.press('Shift+L');
  await expect(page.locator('.au-panel.au-transcript')).toBeVisible();
  await page.keyboard.press('Shift+L');
  await expect(page.locator('.au-panel.au-transcript')).toHaveCount(0);
  await page.keyboard.press('h');
  await expect(page.locator('.au-hotspot').first()).toBeVisible();
  await page.keyboard.press('h');
  // Escape with nothing else to answer opens the console, as the original's does away
  await page.keyboard.press('Escape');
  await expect(padd).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(padd).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the inventory pages with the scroll buttons when it holds more than six; an item is held from its slot', async ({ page }) => {
  const errors = await open(page);
  await expect(button(page, 'Previous items')).toBeDisabled();
  await button(page, 'Use').click();
  // (five in the kit: give the team three more, any of the room's objects)
  const extra = await page.evaluate(() => {
    const objects = window.__au!.state().objects;
    return Object.keys(objects).filter(id => id.startsWith('lab.') && !objects[id]!.inventory).slice(0, 3);
  });
  for (const id of extra) await page.evaluate(i => window.__au!.give(i), id);
  const shown = () => page.locator('.au-strip button[data-item]').evaluateAll(bs => bs.map(b => (b as HTMLElement).dataset.item));
  await expect(page.locator('.au-strip button[data-item]')).toHaveCount(6);
  const before = await shown();
  await expect(button(page, 'More items')).toBeEnabled();
  await button(page, 'More items').click();
  expect((await shown())[0]).toBe(before[1]);
  // one item a step, to the last six
  const total = await page.locator('.au-strip').evaluate(() => {
    const objects = window.__au!.state().objects;
    return Object.values(objects).filter(o => o.inventory && o.active).length;
  });
  for (let i = 1; i < total - 6; i++) await button(page, 'More items').click();
  await expect(button(page, 'More items')).toBeDisabled();
  await page.locator('.au-awaypanel').screenshot({ path: `${shots}/panel-paged.png` });
  for (let i = 0; i < total - 6; i++) await button(page, 'Previous items').click();
  await expect(button(page, 'Previous items')).toBeDisabled();
  expect(await shown()).toEqual(before);
  // hold the tricorder: Use mode, pressed in its slot (this game's names are its own: found by id)
  await page.locator('.au-strip button[data-item="tricorder"]').click();
  await expect(page.locator('.au-strip button[data-item="tricorder"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(button(page, 'Use')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.au-strip button[data-item="tricorder"]').click();
  await expect(page.locator('.au-strip button[data-item="tricorder"]')).toHaveAttribute('aria-pressed', 'false');
  expect(errors).toEqual([]);
});

test('the phaser is set on its power bar, by a click or the keyboard', async ({ page }) => {
  const errors = await open(page);
  const gauge = page.getByRole('slider', { name: 'Phaser setting' });
  const box = (await gauge.boundingBox())!;
  const setting = () => page.evaluate(() => window.__au!.state().phaserSetting);
  // screen x 414 + 14 * position: position 13 is high
  const xAt = (screenX: number) => box.x + ((screenX - 410) / 230) * box.width;
  await page.mouse.click(xAt(414 + 14 * 13 + 7), box.y + box.height / 2);
  expect(await setting()).toBe(3);
  await expect(gauge).toHaveAttribute('aria-valuetext', 'High');
  await page.mouse.click(xAt(414 + 14 * 5 + 7), box.y + box.height / 2);
  expect(await setting()).toBe(1);
  await page.locator('.au-awaypanel').screenshot({ path: `${shots}/panel-phaser-low.png` });
  // (the squares are filled up to the marker: position 5 lights five of the 15, the rest dimmed)
  const lit = () => page.locator('.au-gauge-square[data-lit]').count();
  expect(await lit()).toBe(5);
  await page.mouse.click(xAt(414 + 14 * 13 + 7), box.y + box.height / 2);
  expect(await lit()).toBe(13);
  await gauge.focus();
  await page.keyboard.press('Home');
  expect(await lit()).toBe(0);
  await page.keyboard.press('ArrowRight');
  expect(await lit()).toBe(4);
  // (while the pointer is over the gauge, the status line names the setting under it, and the verb's line returns when it leaves)
  const status = page.locator('.au-status');
  await page.mouse.move(box.x + 20, box.y - 200);
  await expect(status).toHaveText(/^Walk to/);
  for (const [position, label] of [[5, 'Low phaser setting'], [9, 'Medium phaser setting'], [14, 'High phaser setting'], [2, 'Phaser off']] as const) {
    await page.mouse.move(xAt(414 + 14 * position + 7), box.y + box.height / 2);
    await expect(status).toHaveText(label);
  }
  await page.mouse.move(box.x + 20, box.y - 200);
  await expect(status).toHaveText(/^Walk to/);
  await page.mouse.click(xAt(414 + 14 * 5 + 7), box.y + box.height / 2);
  await page.mouse.move(box.x + 20, box.y - 200);
  await page.locator('.au-awaypanel').screenshot({ path: `${shots}/panel-phaser-low.png` });
  await gauge.focus();
  await gauge.focus();
  await page.keyboard.press('ArrowRight');
  expect(await setting()).toBe(2);
  await page.keyboard.press('Home');
  expect(await setting()).toBe(0);
  expect(errors).toEqual([]);
});

test('the combadge asks before it hails, as the bar\'s did', async ({ page }) => {
  const errors = await open(page);
  await expect(button(page, 'Combadge')).toBeEnabled();
  const ask = page.getByRole('dialog');
  // (a timer's action can take the moment: act tries again)
  await act(page, () => button(page, 'Combadge').click(), async () => (await ask.count()) > 0);
  await expect(ask).toBeVisible();
  await page.locator('#game').screenshot({ path: `${shots}/panel-combadge.png` });
  await ask.getByRole('button').last().click();
  await expect(ask).toHaveCount(0);
  expect(errors).toEqual([]);
});

// (the original's own pointers when cursor.dat is published, 37 by 23 drawn at twice that, clicking at setCursor's points; else the panel's sprites)
const originals = artSpritesPresent('cursors', 'cursors publish').present;
test('the room\'s pointer is the original\'s eye, hand, balloon and boot (the panel\'s own sprites without them), and the drawn ones with the art off', async ({ page }) => {
  const errors = await open(page);
  const cursor = () => page.evaluate(() => {
    const g = document.querySelector<HTMLElement>('#game')!;
    return { kind: g.dataset.cursor, css: g.style.getPropertyValue('--au-cursor-room'), room: getComputedStyle(document.querySelector('#view')!).cursor };
  });
  const seen = new Set<string>();
  for (const [verb, hotspot] of (originals ? [['Look', '36 22'], ['Use', '66 22'], ['Talk', '8 8'], ['Walk', '66 44']] : [['Look', '24 16'], ['Use', '38 10'], ['Talk', '24 16'], ['Walk', '41 20']]) as [string, string][]) {
    await button(page, verb).click();
    await expect.poll(async () => (await cursor()).css).toContain(`") ${hotspot}, `);
    const c = await cursor();
    expect(c.css).toMatch(/^url\("data:image\/png;base64,/);
    expect(c.css).toContain(`") ${hotspot}, `);
    expect(c.room).toContain('data:image/png');
    seen.add(c.css);
  }
  expect(seen.size).toBe(4);
  expect(errors).toEqual([]);
  const off = watchConsole(page);
  await page.goto(`${START}&art=0`);
  await page.waitForFunction(() => window.__au?.ready === true);
  await settled(page);
  await button(page, 'Look').click();
  expect(await cursor()).toMatchObject({ kind: 'drawn' });
  expect((await cursor()).css).toMatch(/^url\("data:image\/svg\+xml/);
  expect(off).toEqual([]);
});

test('with art off, or ?panel=0, the HUD keeps its own bar', async ({ page }) => {
  for (const q of ['&art=0', '&panel=0']) {
    const errors = watchConsole(page);
    await page.goto(`${START}${q}`);
    await page.waitForFunction(() => window.__au?.ready === true);
    await settled(page);
    await expect(page.locator('.au-awaypanel')).toHaveCount(0);
    await expect(page.locator('.au-bar')).toBeVisible();
    await expect(button(page, 'Combadge')).toBeVisible();
    expect(errors).toEqual([]);
  }
});
