// SPDX-License-Identifier: GPL-3.0-or-later
import { homedir } from 'node:os';
import { existsSync, mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
// (for its `window.__au` declaration; Playwright erases the import)
import type {} from '../src/debug';
import { bridgeItem, clickWhenIdle, drive, engageCourse, goTo, state, quiet, settled, shipArtPresent, station, stripButton, watchConsole } from './helpers';

// docs/unity-ship-buttons.md: every button the original paints on a ship screen is a working control over its painted place. With art on
// and the hotspot labels on, each screen's painted buttons are clicked and their effect looked at, and each screen is shot.

const STATIONS = ['bridge', 'viewscreen', 'transporter', 'astrogation', 'computer'];
const art = shipArtPresent(STATIONS);
test.skip(!art.present, `needs ${art.why}`);
test.use({ actionTimeout: 30_000 });

const shots = `${homedir()}/pcode/unity-raw/runs/ui-ship-buttons`;

const painted = (page: Page, id: string) => page.locator(`.au-ship [data-painted="${id}"]`);

/** Clicks a painted button once the game is idle, until it takes. */
async function press(page: Page, id: string): Promise<void> {
  await drive(page, () => clickWhenIdle(painted(page, id)));
}

/** The ship panel's box, shot with the hotspot labels on. */
async function shoot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(500);
  mkdirSync(shots, { recursive: true });
  await page.locator('.au-ship').first().screenshot({ path: `${shots}/${name}.png` });
}

/** Every painted button lies in the plate's box, its centre is itself (nothing covers it), and it is outlined with the hotspots on. */
async function expectPlaced(page: Page): Promise<number> {
  const bad = await page.evaluate(() => {
    const screen = document.querySelector('.au-ship-screen')!.getBoundingClientRect();
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('.au-ship [data-painted], .au-ship-strip-btn')) {
      const r = el.getBoundingClientRect();
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      if (r.width < 2 || r.height < 2) out.push(`${el.getAttribute('aria-label')} has no size`);
      if (r.left < screen.left - 1 || r.right > screen.right + 1 || r.top < screen.top - 1 || r.bottom > screen.bottom + 1) out.push(`${el.getAttribute('aria-label')} leaves the plate`);
      const hit = document.elementFromPoint(cx, cy);
      if (hit !== el && !el.contains(hit)) out.push(`${el.getAttribute('aria-label')} is covered by ${hit?.className}`);
    }
    return { out, n: document.querySelectorAll('.au-ship [data-painted], .au-ship-strip-btn').length };
  });
  expect(bad.out).toEqual([]);
  return bad.n;
}

test('every painted button on the ship screens is there, at its place, and does what the original does', async ({ page }) => {
  test.setTimeout(600_000);
  await page.setViewportSize({ width: 1280, height: 960 });
  const errors = watchConsole(page);
  await page.goto('/play/afu/?game=unity&speed=4&mute&dev');
  await page.waitForFunction(() => window.__au?.ready === true);
  await quiet(page);
  await page.waitForFunction(() => window.__au!.art().ship.set, undefined, { timeout: 60_000 });
  // (the hotspot labels on: every painted button outlined and named)
  await page.keyboard.press('h');
  await expect(page.locator('.au-ship.au-ship-hotspots')).toHaveCount(1);

  // the bridge: the strip's admin, viewscreen and sensor-record buttons
  await settled(page);
  expect(await expectPlaced(page)).toBe(2 + 2 + 3);
  await shoot(page, 'bridge');
  // (no course yet: no records, the arrows at their ends, the journey readouts empty, and the hover box names the item under the pointer)
  await expect(page.locator('[data-strip-readout="record-0"]')).toHaveCount(0);
  await expect(page.locator('[data-strip="sensor-up"]')).toHaveAttribute('data-end', '');
  await expect(page.locator('[data-strip-readout="speed"], [data-strip-readout="dest"]')).toHaveCount(0);
  await drive(page, () => clickWhenIdle(page.locator('.au-ship-strip-btn[data-strip="sensor-up"]')));
  for (const id of ['sensor-down', 'sensor-row-0']) await drive(page, () => clickWhenIdle(page.locator(`.au-ship-strip-btn[data-strip="${id}"]`)));
  await expect(page.locator('.au-ship-bridge')).toBeVisible();
  const item = bridgeItem(page, 'Astrogation');
  await item.hover();
  await expect(page.locator('[data-strip-readout="hover"]')).toHaveText('Astrogation');
  await page.mouse.move(2, 2);
  await expect(page.locator('[data-strip-readout="hover"]')).toHaveText('');
  await drive(page, async () => { await clickWhenIdle(stripButton(page, 'viewscreen')); return (await page.locator('.au-ship-bridge-up').count()) > 0; });
  await expect(stripButton(page, 'viewscreen')).toHaveAttribute('aria-pressed', 'true');
  await shoot(page, 'bridge-viewscreen-up');
  await drive(page, async () => { await clickWhenIdle(stripButton(page, 'viewscreen')); return (await page.locator('.au-ship-bridge-up').count()) === 0; });

  // the transporter room: lists, map, the round arrows and the door. It opens on the map (the lists' round arrow is drawn only with the lists up)
  await goTo(page, 'Transporter room', 'transporter');
  await settled(page);
  expect(await expectPlaced(page)).toBe(6);
  await expect(painted(page, 'sliders')).toHaveAttribute('aria-label', 'Energize');
  await shoot(page, 'transporter-map');
  await expect(painted(page, 'map')).toHaveAttribute('aria-pressed', 'true');
  await expect(painted(page, 'lists')).toHaveAttribute('aria-pressed', 'false');
  await press(page, 'lists');
  expect(await expectPlaced(page)).toBe(8);
  await shoot(page, 'transporter');
  await expect(painted(page, 'lists')).toHaveAttribute('aria-pressed', 'true');
  await press(page, 'map');
  await expect(painted(page, 'map')).toHaveAttribute('aria-pressed', 'true');
  await press(page, 'lists');
  for (const id of ['listUp', 'listDown', 'kitLeft', 'kitRight']) await press(page, id);
  await press(page, 'door');
  const door = page.getByRole('list', { name: 'Door' });
  await expect(door).toBeVisible();
  await shoot(page, 'transporter-door');
  await door.getByRole('button', { name: 'Cancel' }).click();
  await expect(door).toBeHidden();
  // (the door's first exit is the bridge)
  await press(page, 'door');
  await drive(page, async () => { await clickWhenIdle(door.locator('[data-door-code]').first()); return (await station(page, 'bridge').count()) > 0; });

  // astrogation: the exit block, the tabs, the pad, the views and the cursor arrows
  await goTo(page, 'Astrogation', 'astrogation');
  await settled(page);
  await page.waitForFunction(() => window.__au!.art().ship.station === 'astrogation');
  // (it opens on the Info tab, as the original's does: the course panel's six controls are on the Course tab)
  expect(await expectPlaced(page)).toBe(20);
  await shoot(page, 'astrogation');
  await expect(painted(page, 'tab-info')).toHaveAttribute('aria-pressed', 'true');
  await expect(painted(page, 'engage')).toHaveCount(0);
  await press(page, 'tab-course');
  await expect(painted(page, 'tab-course')).toHaveAttribute('aria-pressed', 'true');
  expect(await expectPlaced(page)).toBe(20 + 6);
  await shoot(page, 'astrogation-course');
  // (the map opens spinning, azimuth only, from the original's 6 and 3 degrees, until the pad is touched)
  {
    const turning = (k: string) => page.locator(`[data-readout="${k}"]`).textContent().then(t => Number(t!.slice(3)));
    const first = await turning('azimuth');
    await expect.poll(() => turning('azimuth'), { timeout: 5_000 }).not.toBe(first);
    expect(await turning('elevation')).toBe(3);
  }
  // (the course panel's own controls: Warp and Impulse choose the drive, Faster and Slower the speed, Stop is idle with no journey)
  const speedText = () => page.locator('[data-readout="speed"]').textContent();
  await expect(painted(page, 'warp')).toHaveAttribute('aria-pressed', 'true');
  const warpSpeed = Number(await speedText());
  await press(page, 'slower');
  await expect.poll(async () => Number(await speedText())).toBeCloseTo(warpSpeed - 0.1, 5);
  await press(page, 'faster');
  await expect.poll(async () => Number(await speedText())).toBeCloseTo(warpSpeed, 5);
  await press(page, 'impulse');
  await expect(painted(page, 'impulse')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-readout="speed"]')).toHaveText(/%$/);
  await press(page, 'warp');
  await expect(painted(page, 'stop')).toBeDisabled();
  // (the original's sprites for Faster, Slower, Engage and Stop, when published (art astro publish): at their rectangles, the pressed frame while held)
  const sprite = (id: string) => page.locator(`.au-ship [data-sprite="${id}"]`);
  if (existsSync(new URL('../../../games/unity/art/astro/engage.webp', import.meta.url))) {
    for (const id of ['faster', 'slower', 'engage', 'stop']) {
      await expect(sprite(id)).toHaveAttribute('data-frame', 'up');
      await expect(painted(page, id)).toHaveClass(/au-painted-art/);
      // (a sprite that really loaded, not a broken image)
      expect(await sprite(id).locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    }
    // (the sprite is at the original's corner of the 640 by 480 screen: Engage at 392, 161, 245 wide)
    const box = await page.locator('.au-ship-screen').boundingBox();
    const at = await sprite('engage').boundingBox();
    expect(Math.abs(at!.x - (box!.x + (392 / 640) * box!.width))).toBeLessThan(1.5);
    expect(Math.abs(at!.width - (245 / 640) * box!.width)).toBeLessThan(1.5);
    expect(Math.abs(at!.y - (box!.y + (161 / 480) * box!.height))).toBeLessThan(1.5);
    // (Faster's pressed frame shows while the pointer is down on it, and the speed steps; Warp and Impulse stay as they were)
    const faster = await painted(page, 'faster').boundingBox();
    await page.mouse.move(faster!.x + faster!.width / 2, faster!.y + faster!.height / 2);
    await page.mouse.down();
    await expect(sprite('faster')).toHaveAttribute('data-frame', 'down');
    await expect(sprite('faster').locator('img')).toHaveAttribute('src', /faster_warp_down/);
    await page.mouse.up();
    await expect(sprite('faster')).toHaveAttribute('data-frame', 'up');
    await page.mouse.move(box!.x + 2, box!.y + 2);
    await expect(sprite('warp')).toHaveCount(0);
    // (Warp and Impulse are clear over the course panel's own picture when that is published, CSS otherwise)
    if (existsSync(new URL('../../../games/unity/art/astro/course_warp.webp', import.meta.url))) await expect(painted(page, 'warp')).toHaveClass(/au-painted-art/);
    else await expect(painted(page, 'warp')).not.toHaveClass(/au-painted-art/);
    await shoot(page, 'astrogation-sprites');
  } else {
    await expect(sprite('engage')).toHaveCount(0);
    await expect(painted(page, 'engage')).not.toHaveClass(/au-painted-art/);
  }
  // (the pad turns the map by three degrees a click; the readouts show the angles)
  const readout = (k: string) => page.locator(`[data-readout="${k}"]`);
  const angle = async (k: string) => Number((await readout(k).textContent())!.slice(3));
  const elevation = await angle('elevation');
  await press(page, 'pad-up');
  await expect.poll(() => angle('elevation')).toBe((elevation + 3) % 360);
  // (a second pad click within a fifth of a second starts a spin, as the original's does)
  await page.waitForTimeout(400);
  const azimuth = await angle('azimuth');
  await press(page, 'pad-left');
  await expect.poll(() => angle('azimuth')).toBe((azimuth + 3) % 360);
  await page.waitForTimeout(400);
  await press(page, 'pad-stop');
  await expect.poll(() => angle('elevation')).toBe(6);
  await expect.poll(() => angle('azimuth')).toBe(3);
  // (the views)
  await press(page, 'view-sector');
  await expect(painted(page, 'view-sector')).toHaveAttribute('aria-pressed', 'true');
  await expect(painted(page, 'view-galaxy')).toHaveAttribute('aria-pressed', 'false');
  await press(page, 'view-system');
  await expect(painted(page, 'view-system')).toHaveAttribute('aria-pressed', 'true');
  await press(page, 'view-galaxy');
  await expect(painted(page, 'view-galaxy')).toHaveAttribute('aria-pressed', 'true');
  // (the cursor arrows choose the sector under the cursor in the galaxy view: it starts in the sector the ship is in, 4-4-4)
  const cursor = page.locator('.au-astro[data-cursor]');
  await expect(cursor).toHaveAttribute('data-cursor', '4,4,4,0,0,0');
  await press(page, 'cursor-x-up');
  await press(page, 'cursor-y-up');
  await expect(cursor).toHaveAttribute('data-cursor', '5,5,4,0,0,0');
  await press(page, 'cursor-z-down');
  await expect(cursor).toHaveAttribute('data-cursor', '5,5,3,0,0,0');
  // (in the sector view they move the place inside the sector)
  await press(page, 'view-sector');
  await press(page, 'cursor-x-down');
  await expect(cursor).toHaveAttribute('data-cursor', '5,5,3,19,0,0');
  await press(page, 'view-galaxy');
  // (the tabs: See info and Display show their own panels, Course the speed)
  await press(page, 'tab-info');
  await expect(painted(page, 'tab-info')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('region', { name: 'Info' })).toBeVisible();
  await expect(painted(page, 'engage')).toHaveCount(0);
  await press(page, 'tab-display');
  await expect(page.locator('[data-display]')).toHaveCount(9);
  // (each switch is a bar over a checkbox: clicking the bar switches it)
  await shoot(page, 'astrogation-display');
  await page.locator('[data-switch="1"]').click();
  await expect(page.locator('[data-display="1"]')).not.toBeChecked();
  await page.locator('[data-switch="1"]').click();
  await expect(page.locator('[data-display="1"]')).toBeChecked();
  await press(page, 'tab-course');
  await expect(painted(page, 'tab-course')).toHaveAttribute('aria-pressed', 'true');
  await drive(page, async () => { await clickWhenIdle(painted(page, 'exit-computer')); return (await station(page, 'computer').count()) > 0; });

  // the computer: the four scroll halves over the two round arrows, and the exits
  await settled(page);
  expect(await expectPlaced(page)).toBe(4 + 3);
  await shoot(page, 'computer');
  // (with the labels off the plate's own buttons, grid and pane show, with only the topics and the entry drawn over them)
  await page.keyboard.press('h');
  await expect(page.locator('.au-ship.au-ship-hotspots')).toHaveCount(0);
  await shoot(page, 'computer-hotspots-off');
  await page.keyboard.press('h');
  await expect(page.locator('.au-ship.au-ship-hotspots')).toHaveCount(1);
  // (each topic row sits in a painted row of the grid: 23 of the original's pixels from y 54)
  const rows = await page.evaluate(() => {
    const box = document.querySelector('.au-ship-screen')!.getBoundingClientRect();
    const k = box.height / 480;
    return [...document.querySelectorAll('[data-row]')].map(el => { const r = el.closest('li')!.getBoundingClientRect(); return [(r.top - box.top) / k, r.height / k]; });
  });
  rows.forEach(([top, height], i) => {
    expect(Math.abs(top! - (54 + 23 * i)), `row ${i} top`).toBeLessThan(1.5);
    expect(Math.abs(height! - 23), `row ${i} height`).toBeLessThan(1.5);
  });
  const first = () => page.locator('[data-row]').first().textContent();
  const before = await first();
  if (await painted(page, 'list-down').isEnabled()) {
    await press(page, 'list-down');
    await expect.poll(first).not.toBe(before);
    await press(page, 'list-up');
    await expect.poll(first).toBe(before);
  }
  const entry = page.locator('.au-ship-computer-entry');
  await press(page, 'text-down');
  const scrolled = await entry.evaluate(el => ({ top: el.scrollTop, room: el.scrollHeight - el.clientHeight }));
  if (scrolled.room > 0) expect(scrolled.top).toBeGreaterThan(0);
  await press(page, 'text-up');
  await expect.poll(() => entry.evaluate(el => el.scrollTop)).toBe(0);
  await drive(page, async () => { await clickWhenIdle(painted(page, 'exit-bridge')); return (await station(page, 'bridge').count()) > 0; });

  // the viewscreen: no painted buttons of its own; shot with a hail up
  await drive(page, async () => {
    if ((await page.evaluate(() => window.__au!.art().ship.station)) === 'viewscreen') return true;
    const list = page.getByRole('list', { name: 'Comms' });
    if ((await list.count()) === 0) await clickWhenIdle(page.locator('.au-ship-item[title="Comms"]'));
    else await clickWhenIdle(list.locator('button[data-object]').first());
    return (await page.evaluate(() => window.__au!.art().ship.station)) === 'viewscreen';
  }, 90_000, true);
  await expect(page.locator('.au-ship [data-painted]')).toHaveCount(0);
  await shoot(page, 'viewscreen');

  expect(errors).toEqual([]);
});

test('the bridge strip shows the journey, the sensor records and the hover name once a course is plotted', async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1280, height: 960 });
  const errors = watchConsole(page);
  await page.goto('/play/afu/?game=unity&speed=4&mute&dev');
  await page.waitForFunction(() => window.__au?.ready === true);
  await quiet(page);
  await page.waitForFunction(() => window.__au!.art().ship.set, undefined, { timeout: 60_000 });
  await goTo(page, 'Astrogation', 'astrogation');
  const panel = page.locator('.au-astro');
  // (the original's first leg, by ids)
  await panel.getByRole('combobox', { name: 'Sector' }).selectOption('156');
  await panel.getByLabel('Star').selectOption('3');
  await panel.getByLabel('Planet').selectOption('3');
  await engageCourse(page);
  // (Engage goes on to the bridge, as the original's does, once the warp movie is over)
  await drive(page, async () => (await station(page, 'bridge').count()) > 0);
  await expect(page.locator('.au-astro')).toHaveCount(0);
  // (Stop is unit tested: by the time the lift has brought us back to astrogation a journey this short can be over)
  // (under way: the strip shows the speed or the light years left, and where to)
  const speed = page.locator('[data-strip-readout="speed"]');
  await expect(speed).toHaveText(/^(WARP: \d+\.\d|IMPL: \d+\.\d|LY: *\d+\.\d)$/);
  await expect(page.locator('[data-strip-readout="dest"]')).toHaveText(/^DEST: ./);
  await drive(page, async () => (await state(page)).ship.transit === null);
  // (arrived: the destination stays as ARR, the speed goes, and the course is the first sensor record)
  await expect(page.locator('[data-strip-readout="dest"]')).toHaveText(/^ARR: ./);
  await expect(speed).toHaveCount(0);
  const record = page.locator('[data-strip-readout="record-0"]');
  await expect(record).not.toHaveText('');
  const name = (await record.textContent())!;
  await expect(page.locator('[data-strip="sensor-down"]')).toHaveAttribute('data-end', '');
  // (a row goes to astrogation with that place chosen)
  await drive(page, async () => { await clickWhenIdle(page.locator('.au-ship-strip-btn[data-strip="sensor-row-0"]')); return (await station(page, 'astrogation').count()) > 0; });
  await expect(page.locator('.au-astro').getByRole('combobox', { name: 'Sector' })).toHaveValue('156');
  await expect(page.locator('.au-astro select').nth(1)).toHaveValue('3');
  expect(name.length).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});
