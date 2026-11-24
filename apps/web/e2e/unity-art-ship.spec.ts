// SPDX-License-Identifier: GPL-3.0-or-later
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
// (for its `window.__au` declaration; Playwright erases the import)
import type {} from '../src/debug';
import { bridgeItem, clickWhenIdle, stillMapPoint, stripButton, drive, expectFrames, goTo, quiet, settled, shipArtPresent, shipSetPresent, state, watchConsole } from './helpers';

// Plan 16 Task 12: the repainted ship screens change nothing the game does. Every screen is visited with art on and with `&art=0`: the same
// buttons (names, data-*, order, enabled state), the same bridge item rectangles, the same state after one harmless click. With art on,
// every other control lies inside the plate's box and its area, and no two overlap.

const STATIONS = ['bridge', 'viewscreen', 'transporter', 'astrogation', 'computer'];
const art = shipArtPresent(STATIONS);
test.skip(!art.present, `needs ${art.why}`);

test.use({ actionTimeout: 30_000 });
const log = (...a: unknown[]): void => { if (process.env.ARTSHIP_LOG) console.log(new Date().toISOString().slice(11, 19), ...a); };

const shots = `${homedir()}/pcode/unity-raw/runs/art-ship`;

interface Control { tag: string; name: string; data: Record<string, string>; disabled: boolean }
interface Box { x: number; y: number; width: number; height: number }
interface Visit {
  station: string | null;
  kind: 'plate' | 'set' | 'space' | null;
  controls: Control[];
  items: { object: string | undefined; box: Box }[];
  clicked: unknown;
  /** Controls in the plate's box that are outside it, outside their area, or overlapping another (art on only). */
  misplaced: string[];
}

/** What the ship panel offers now (read in the page, in DOM order) and, with a plate, where its controls sit. */
async function look(page: Page): Promise<Pick<Visit, 'controls' | 'items' | 'misplaced'>> {
  return page.evaluate(() => {
    const visible = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    };
    const els = [...document.querySelectorAll('.au-ship button, .au-ship select, .au-ship input')].filter(visible) as HTMLElement[];
    const controls = els.map(el => ({
      tag: el.tagName.toLowerCase(),
      name: ((el as HTMLInputElement).labels?.[0]?.textContent ?? el.getAttribute('aria-label') ?? el.textContent ?? '').trim(),
      data: Object.fromEntries(Object.entries(el.dataset).map(([k, v]) => [k, v ?? ''])),
      disabled: (el as HTMLButtonElement).disabled === true,
    }));
    const rect = (el: Element) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
    const items = [...document.querySelectorAll('.au-ship-item')].map(el => ({ object: (el as HTMLElement).dataset.object, box: rect(el) }));

    // (only a plate's box: the bridge's bar is under it, not in it)
    const misplaced: string[] = [];
    const screen = document.querySelector('.au-ship-screen');
    if (screen && document.querySelector('.au-ship-art, .au-transporter-plate, .au-computer-plate, .au-astro-plate')) {
      const box = screen.getBoundingClientRect();
      const placed: { label: string; r: DOMRect }[] = [];
      // (tactical's console, and the ?dev view folded out in it, is no plate: its controls sit at TacticalScreen's own rectangles, which
      // overlap by design (Fire both over the two fire buttons, the power slider's segments), with no areas. Its other checks still hold)
      const plated = els.filter(el => !el.closest('.au-console'));
      for (const el of plated) {
        if (!screen.contains(el) || el.classList.contains('au-ship-item')) continue;
        const r = el.getBoundingClientRect();
        const label = `${el.tagName.toLowerCase()} "${controls[els.indexOf(el)]!.name}"`;
        const area = el.closest('[data-area]');
        const cx = r.x + r.width / 2;
        const cy = r.y + r.height / 2;
        if (area) {
          const a = area.getBoundingClientRect();
          // (a list longer than its area scrolls: a row scrolled out of sight isn't on the plate)
          if (cx < a.left - 1 || cx > a.right + 1 || cy < a.top - 1 || cy > a.bottom + 1) continue;
          if (r.left < a.left - 1 || r.top < a.top - 1 || r.right > a.right + 1 || r.bottom > a.bottom + 1) misplaced.push(`${label} leaves its area`);
        } else {
          misplaced.push(`${label} is in no area`);
        }
        if (r.left < box.left - 1 || r.top < box.top - 1 || r.right > box.right + 1 || r.bottom > box.bottom + 1) misplaced.push(`${label} leaves the plate box`);
        placed.push({ label, r });
      }
      // (a note or any other layer over a control takes its clicks: the point at each control's centre must be the control or inside it)
      for (const el of plated) {
        // (a control kept for the keyboard and screen readers and out of sight, as the astrogation selectors are on the plate, is not covered by what it is not drawn over)
        if (el.closest('.au-visually-hidden')) continue;
        const r = el.getBoundingClientRect();
        const cx = r.x + r.width / 2;
        const cy = r.y + r.height / 2;
        if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) continue;
        const area = el.closest('[data-area]');
        if (area) {
          const a = area.getBoundingClientRect();
          if (cx < a.left || cx > a.right || cy < a.top || cy > a.bottom) continue;
        }
        const hit = document.elementFromPoint(cx, cy);
        if (hit !== el && !el.contains(hit)) misplaced.push(`${el.tagName.toLowerCase()} "${controls[els.indexOf(el)]!.name}" is covered by ${hit?.tagName.toLowerCase()}.${hit?.className}`);
      }
      for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i]!.r;
        const b = placed[j]!.r;
        // (the original's own rectangles for astrogation's rotation pad overlap: its up and down bars span the whole pad, over the corners of left and right)
        const side = (label: string) => /^button "Turn the map (left|right)"$/.test(label);
        const bar = (label: string) => /^button "Turn the map (up|down)"$/.test(label);
        if ((side(placed[i]!.label) && bar(placed[j]!.label)) || (bar(placed[i]!.label) && side(placed[j]!.label))) continue;
        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) misplaced.push(`${placed[i]!.label} overlaps ${placed[j]!.label}`);
      }
    }
    return { controls, items, misplaced };
  });
}

async function visit(page: Page, name: string, mode: 'on' | 'off', clicked: () => Promise<unknown>, busy = false): Promise<Visit> {
  // (a hail's conversation keeps the game busy: it is looked at as it stands)
  if (!busy) await settled(page);
  // (tactical draws the world's battle in the space view, art on or off (Plan 25): waited for, as a plate is)
  if (mode === 'on' || name === 'tactical') await page.waitForFunction(() => window.__au!.art().ship.set, undefined, { timeout: 60_000 });
  await page.waitForTimeout(800);
  const art = await page.evaluate(() => window.__au!.art().ship);
  await expectFrames(page);
  const seen = await look(page);
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: `${shots}/${name}-${mode}.png` });
  log(name, mode, 'looked at', art.kind, seen.controls.length, 'controls', seen.items.length, 'items', seen.misplaced.length, 'misplaced');
  const result = await clicked();
  log(name, mode, 'clicked');
  return { station: art.station, kind: art.kind, ...seen, clicked: result };
}

const shipBar = (page: Page, label: string) => (label === 'Viewscreen' ? stripButton(page, 'viewscreen') : bridgeItem(page, label));

/** One pass over every screen, with art on or off. */
async function tour(page: Page, mode: 'on' | 'off'): Promise<{ screens: Map<string, Visit>; errors: string[] }> {
  const errors = watchConsole(page);
  await page.goto(`/play/afu/?game=unity&speed=4&mute&dev${mode === 'off' ? '&art=0' : ''}`);
  // (the content loads in the page: on a busy machine the first load can pass the action timeout)
  await page.waitForFunction(() => window.__au?.ready === true, undefined, { timeout: 120_000 });
  await quiet(page);
  await expect(page.locator('[data-station="bridge"]')).toBeVisible();
  const screens = new Map<string, Visit>();
  const back = async (): Promise<void> => {
    await drive(page, async () => {
      if ((await page.locator('[data-station="bridge"]').count()) > 0) return true;
      for (const name of ['Back to the bridge', 'Bridge']) {
        const exit = page.locator('.au-ship').getByRole('button', { name, exact: true }).first();
        if ((await exit.count()) > 0 && (await clickWhenIdle(exit))) break;
      }
      return (await page.locator('[data-station="bridge"]').count()) > 0;
    });
  };

  // the bridge, and one harmless click: the turbolift list opens and shuts
  screens.set('bridge', await visit(page, 'bridge', mode, async () => {
    const lift = page.getByRole('list', { name: 'Turbolift' });
    await drive(page, async () => { if (await lift.isVisible()) return true; await clickWhenIdle(shipBar(page, 'Turbolift')); return lift.isVisible(); });
    const names = await lift.getByRole('button').allTextContents();
    await clickWhenIdle(shipBar(page, 'Turbolift'));
    await expect(lift).toBeHidden();
    return names;
  }));

  // the viewscreen up over the bridge: the items shut, the replay stays
  await drive(page, async () => { await clickWhenIdle(shipBar(page, 'Viewscreen')); return page.evaluate(() => window.__au!.art().ship.viewscreen !== null || document.querySelector('.au-ship-bridge-up') !== null); });
  screens.set('bridge-up', await visit(page, 'bridge-up', mode, async () => null));
  if (mode === 'on') expect((await page.evaluate(() => window.__au!.art().ship)).viewscreen).not.toBeNull();
  await drive(page, async () => { await clickWhenIdle(shipBar(page, 'Viewscreen')); return (await page.locator('.au-ship-bridge-up').count()) === 0; });

  // the viewscreen station: the first contact in the comms list is hailed (no click after: the conversation is the game's own dialog)
  await drive(page, async () => {
    if ((await page.evaluate(() => window.__au!.art().ship.station)) === 'viewscreen') return true;
    const list = page.getByRole('list', { name: 'Comms' });
    if ((await list.count()) === 0) await clickWhenIdle(shipBar(page, 'Comms'));
    else await clickWhenIdle(list.locator('button[data-object]').first());
    return (await page.evaluate(() => window.__au!.art().ship.station)) === 'viewscreen';
  }, 90_000, true);
  screens.set('viewscreen', await visit(page, 'viewscreen', mode, async () => null, true));
  await quiet(page, 1);

  await goTo(page, 'Transporter room', 'transporter');
  screens.set('transporter', await visit(page, 'transporter', mode, async () => {
    const panel = page.locator('.au-transporter');
    const crew = panel.locator('button[data-crew]').first();
    const who = await crew.getAttribute('data-crew');
    await drive(page, async () => { await clickWhenIdle(crew); return (await panel.locator('button[data-pad]').count()) > 0; });
    const padded = await panel.locator('button[data-pad]').evaluateAll(b => b.map(x => [(x as HTMLElement).dataset.pad, x.textContent]));
    // (a crew member with a card walks off their pad, and the pad's button goes when they reach the door: not at the click)
    const pads = panel.locator('button[data-pad]');
    await drive(page, async () => {
      if ((await pads.count()) > 0) await clickWhenIdle(pads.first(), 1_000).catch(() => false);
      return (await pads.count()) === 0;
    });
    return { who, padded };
  }));
  await back();

  await goTo(page, 'Astrogation', 'astrogation');
  screens.set('astrogation', await visit(page, 'astrogation', mode, async () => {
    const panel = page.locator('.au-astro');
    await panel.locator('select').nth(0).selectOption('156');
    await panel.locator('select').nth(1).selectOption('0');
    // (the map opens spinning: the point is read once the camera is still, or it would move before the click)
    await stillMapPoint(page, 156, 3);
    // (a click while a line is spoken only ends the line: the map is clicked once nothing is being said)
    await quiet(page, 1);
    // (a star picked at its projected point: the same star with art on and off; read again now that nothing is being said, and it must not have moved)
    const p = await stillMapPoint(page, 156, 3);
    await page.mouse.click(p.x, p.y);
    await expect(panel.locator('select').nth(1)).toHaveValue('3');
    return { sector: await panel.locator('select').nth(0).inputValue(), star: await panel.locator('select').nth(1).inputValue() };
  }));
  await back();

  await goTo(page, 'Computer', 'computer');
  screens.set('computer', await visit(page, 'computer', mode, async () => {
    const rows = page.locator('[data-row]');
    const n = await rows.count();
    await clickWhenIdle(rows.nth(Math.min(1, n - 1)));
    await page.waitForTimeout(300);
    const current = await rows.evaluateAll(r => r.findIndex(x => x.getAttribute('aria-current') === 'true'));
    return { rows: n, current };
  }));
  await back();

  await goTo(page, 'Tactical', 'tactical');
  screens.set('tactical', await visit(page, 'tactical', mode, async () => null));
  return { screens, errors };
}

test('every ship screen has the same buttons, rectangles and picks with art on and off, and the plates hold their controls', async ({ browser }) => {
  test.setTimeout(900_000);
  const run = async (mode: 'on' | 'off') => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
    try { return await tour(page, mode); } finally { await page.close(); }
  };
  const on = await run('on');
  const off = await run('off');

  expect(on.errors).toEqual([]);
  expect(off.errors).toEqual([]);
  expect([...on.screens.keys()]).toEqual([...off.screens.keys()]);
  for (const [name, a] of on.screens) {
    const b = off.screens.get(name)!;
    // art on: the plate; art off: none. Tactical, which has no plate, draws the battle's space view either way (Plan 25)
    expect(a.kind, `${name} with art on`).toBe(name === 'tactical' ? 'space' : 'plate');
    expect(b.kind, `${name} with art off`).toBe(name === 'tactical' ? 'space' : null);
    expect(a.station, name).toBe(b.station);
    expect(a.controls, `${name}: the buttons`).toEqual(b.controls);
    expect(a.clicked, `${name}: the state after one click`).toEqual(b.clicked);
    expect(a.items.map(i => i.object), `${name}: the items`).toEqual(b.items.map(i => i.object));
    a.items.forEach((item, i) => {
      for (const key of ['x', 'y', 'width', 'height'] as const) {
        expect(Math.abs(item.box[key] - b.items[i]!.box[key]), `${name}: item ${i} ${key}`).toBeLessThanOrEqual(0.5);
      }
    });
    expect(a.misplaced, `${name}: controls off the plate`).toEqual([]);
  }
  expect(on.screens.get('bridge')!.items.length).toBeGreaterThan(0);
});

test('the bridge plate shows no hotspot labels until H or the Hotspots button turns them on, and remembers it', async ({ page }) => {
  const errors = watchConsole(page);
  await page.goto('/play/afu/?game=unity&speed=4&mute&dev');
  await page.waitForFunction(() => window.__au?.ready === true);
  await quiet(page);
  await page.waitForFunction(() => window.__au!.art().ship.set, undefined, { timeout: 60_000 });
  const item = bridgeItem(page, 'Astrogation');
  const visibleLabel = () => item.evaluate(el => getComputedStyle(el).color !== 'rgba(0, 0, 0, 0)' && getComputedStyle(el).textShadow !== 'none');
  expect(await visibleLabel()).toBe(false);
  // (the name is still there for the pointer and for assistive tech)
  await expect(page.getByRole('button', { name: 'Astrogation', exact: true })).toHaveCount(1);
  await page.keyboard.press('h');
  await expect.poll(visibleLabel).toBe(true);
  await expect(page.getByRole('button', { name: 'Hotspots', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await page.waitForFunction(() => window.__au?.ready === true);
  await quiet(page);
  await page.waitForFunction(() => window.__au!.art().ship.set, undefined, { timeout: 60_000 });
  await expect.poll(visibleLabel).toBe(true);
  await page.getByRole('button', { name: 'Hotspots', exact: true }).click();
  await expect.poll(visibleLabel).toBe(false);
  expect(errors).toEqual([]);
});

test('the 3D set is shown only with ?dev&ship3d', async ({ page }) => {
  test.skip(!shipSetPresent('bridge'), 'needs a published bridge glb (npm run art -- ship publish --set)');
  const errors = watchConsole(page);
  await page.goto('/play/afu/?game=unity&speed=60&mute&dev&ship3d');
  await page.waitForFunction(() => window.__au?.ready === true);
  await quiet(page);
  await page.waitForFunction(() => window.__au!.art().ship.set, undefined, { timeout: 60_000 });
  expect((await page.evaluate(() => window.__au!.art().ship)).kind).toBe('set');
  expect((await state(page)).onShip).not.toBeNull();
  expect(errors).toEqual([]);
});
