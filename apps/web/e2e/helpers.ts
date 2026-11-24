// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, type Locator, type Page } from '@playwright/test';
import { parse } from 'yaml';
// (for its `window.__au` declaration; Playwright erases the import)
import type {} from '../src/debug';

// Plan 5's e2e helpers, shared by the demo's and Horst III's tests.

/**
 * What the GL says when something it was given is wrong, though not as an error: the browser's own WebGL complaints
 * ("WebGL: INVALID_OPERATION: ...", "[.WebGL-...]GL_INVALID_..."), as warnings. Not its performance notes (a stall on
 * readPixels), nor three's info log on a program that linked (a driver's "unused varying"): a shader that fails to compile
 * or link is three's console.error ("THREE.WebGLProgram: Shader Error"), which the plain watch takes.
 */
const GL_COMPLAINT = /WebGL: [A-Z_]+|GL_INVALID_|INVALID_(OPERATION|VALUE|ENUM|FRAMEBUFFER_OPERATION)|Shader Error|CONTEXT_LOST/;

/** The page's console errors and uncaught exceptions; `gl`, the GL's complaints too (GL_COMPLAINT), whatever their level. */
export function watchConsole(page: Page, o: { gl?: boolean } = {}): string[] {
  const errors: string[] = [];
  page.on('console', m => {
    if (m.type() === 'error' || (o.gl && GL_COMPLAINT.test(m.text()))) errors.push(m.text());
  });
  page.on('pageerror', e => errors.push(e.message));
  return errors;
}

export const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
export const state = (page: Page) => page.evaluate(() => window.__au!.state());

export async function poll(check: () => Promise<boolean>, ms = 2_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return false;
}

/**
 * Idle, and still idle a moment later: a timer can start an action one tick after an idle frame
 * (the lab's alarm does), so one idle frame isn't enough.
 */
export async function settled(page: Page): Promise<void> {
  for (let i = 0; i < 100; i++) {
    await page.waitForFunction(() => window.__au!.idle(), undefined, { timeout: 30_000 });
    await page.waitForTimeout(150);
    if (await page.evaluate(() => window.__au!.idle())) return;
  }
  throw new Error('the game never settled');
}

/**
 * Does something that should start an action, once the game is settled, and checks that it did (by
 * `done`, or by the input's count of started actions). A timer's action can still take the moment,
 * and then the click is dropped, as the original drops it: so it tries again.
 */
export async function act(page: Page, what: () => Promise<void>, done?: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    await settled(page);
    const before = await page.evaluate(() => window.__au!.started());
    await what();
    const took = await poll(done ?? (async () => (await page.evaluate(() => window.__au!.started())) > before));
    if (took) return;
  }
  throw new Error('the game never took the action');
}

/** Waits for a line in the transcript: subtitles at 4× can come and go between two checks. */
export async function heard(page: Page, line: string): Promise<void> {
  await page.waitForFunction(l => window.__au!.heard().includes(l), line, { timeout: 30_000 });
}

/** Clicks an object where it is drawn, so the click goes through the stage's raycast picking. */
export async function clickObject(page: Page, id: string): Promise<void> {
  const p = await page.evaluate(i => window.__au!.point(i), id);
  if (!p) throw new Error(`${id} isn't on the screen`);
  await page.mouse.click(p.x, p.y);
}

/**
 * Picks an object up as the original does: in Use mode, press on it, drag it onto the inventory and let go there
 * (handleAwayTeamMouseUp).
 */
export async function dragToInventory(page: Page, id: string): Promise<void> {
  await button(page, 'Use').click();
  const p = await page.evaluate(i => window.__au!.point(i), id);
  if (!p) throw new Error(`${id} isn't on the screen`);
  const box = await page.locator('[data-drop="inventory"]').boundingBox();
  if (!box) throw new Error('the inventory is not on the page');
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
}

/** Use mode with this item in hand (a second click on a held item would let go of it). */
export async function hold(page: Page, item: string): Promise<void> {
  await button(page, 'Use').click();
  const b = button(page, item);
  if ((await b.getAttribute('aria-pressed')) === 'true') return;
  // (a click on this item with another in hand would use the two together: let go of the other first)
  const other = page.locator('.au-inventory button[aria-pressed="true"]');
  if ((await other.count()) > 0) await other.click();
  await b.click();
}

export async function expectFrames(page: Page): Promise<void> {
  const c = await page.evaluate(() => window.__au!.coverage());
  expect(c.width).toBeGreaterThan(0);
  // (the floor, the crew and the hotspots, not just the background colour)
  expect(c.nonBackground).toBeGreaterThan(0.1);
}

/**
 * The gameplay specs run without art: under SwiftShader the plates' texture fetches roughly double the time to the opening's menus, and art
 * never touches the sim (the art specs check that, with art on and off).
 */
export const GAMEPLAY_ART = 'art=0';

/** The dev mission select (R11): a new game otherwise opens on the ship's bridge. */
export const missionSelectUrl = (query = `speed=4&mute&${GAMEPLAY_ART}`) => `/play/afu/?game=unity&dev&missions&${query}`;

/** The dev mission select (`missionSelectUrl`): the mission by its world, then past the arrival movie (headless Chromium may not decode it). */
export async function beamDown(page: Page, world: string): Promise<void> {
  await page.getByRole('dialog', { name: 'Bridge' }).locator(`button[data-world="${world}"]`).click();
  const arrival = page.getByRole('dialog', { name: 'Arrival' });
  if (await arrival.waitFor({ timeout: 2_000 }).then(() => true, () => false)) {
    await arrival.getByRole('button', { name: 'Skip' }).click().catch(() => {});
  }
}

/** The ship's station panel on the page (`data-station`), whatever the station. */
export const station = (page: Page, name: string) => page.locator(`[data-station="${name}"]`);

/**
 * Waits for a conversation menu (the original's has no cancel) and picks an option by its index, as a walk's `pick` does.
 * With `at` (`<conversation id>@<situation>`, ids only) it first checks that this is the menu it means to answer, so a menu
 * answered by mistake fails here, loudly, and not minutes later where the route has gone wrong.
 */
export async function answer(page: Page, index: number, at?: string, timeout = 60_000): Promise<void> {
  const menu = page.locator('.au-menu');
  await drive(page, () => menu.isVisible(), timeout, true);
  if (at !== undefined) {
    const [conversation, situation] = await Promise.all([menu.getAttribute('data-conversation'), menu.getAttribute('data-situation')]);
    const got = `${conversation}@${situation}`;
    if (got !== at) throw new Error(`answered the wrong menu: expected ${at}, the menu is ${got}`);
  }
  await menu.getByRole('button').nth(index).click();
  await menu.waitFor({ state: 'detached', timeout });
}

/**
 * Clicks `target` only if the game is idle, in one step in the page, and says whether it did. A separate idle check and click can
 * be split by a timer's hail, and the game refuses a click made while it is busy (SHIP_REFUSED), so every click a ship test makes
 * on the ship's controls goes through here. With `timeout`, a target that is not there (it went while the click was waiting) is an error after that long: the default is the
 * action timeout, which a control that goes away of its own accord (a crew member walking off a pad) would wait out.
 */
export async function clickWhenIdle(target: Locator, timeout?: number): Promise<boolean> {
  return target.evaluate(el => {
    if (!window.__au!.idle() || (el as HTMLButtonElement).disabled) return false;
    (el as HTMLElement).click();
    return true;
  }, undefined, timeout === undefined ? undefined : { timeout });
}

/** A bridge item (the tableau's clickable area) by its description, whatever the art. */
export const bridgeItem = (page: Page, description: string) => page.locator(`.au-ship-item[title="${description}"]`);

/** The bridge's own interface-strip button: `viewscreen` or `admin`. */
export const stripButton = (page: Page, id: 'viewscreen' | 'admin') => page.locator(`.au-ship-strip-btn[data-strip="${id}"]`);

/**
 * Goes to a station the way a player does, once the game is idle (a conversation or a hail in progress refuses it), until it shows:
 * astrogation, computer and tactical by their tableau items; the transporter room and engineering through the turbolift's list.
 */
export async function goTo(page: Page, label: string, name: string): Promise<void> {
  const item: Record<string, string> = { astrogation: 'Astrogation', computer: 'Computer', tactical: 'Tactical' };
  const lift: Record<string, string> = { transporter: 'Transporter', engineering: 'Engineering' };
  await drive(page, async () => {
    if ((await station(page, name).count()) > 0) return true;
    const list = page.getByRole('list', { name: 'Turbolift' });
    if (item[name]) await clickWhenIdle(bridgeItem(page, item[name]!));
    else if ((await list.count()) > 0) await clickWhenIdle(list.getByRole('button', { name: lift[name], exact: true }));
    else await clickWhenIdle(bridgeItem(page, 'Turbolift'));
    return (await station(page, name).count()) > 0;
  });
}

/**
 * Engages the plotted course at astrogation: clicks Engage while the game is idle, until the journey is under way (`ship.transit`). The original's
 * Engage then goes on to the bridge, after the warp movie (which the drive skips), so the astrogation panel goes: this does not wait for the bridge.
 */
export async function engageCourse(page: Page): Promise<void> {
  const button = page.locator('.au-astro').getByRole('button', { name: 'Engage' });
  // (the screen opens on the Info tab: Engage is on the Course tab)
  const tab = page.locator('.au-ship [data-painted="tab-course"]');
  await drive(page, async () => {
    if ((await state(page)).ship.transit !== null) return true;
    if ((await button.count()) === 0 && (await tab.count()) > 0) await clickWhenIdle(tab);
    if ((await button.count()) > 0) await clickWhenIdle(button);
    return (await state(page)).ship.transit !== null;
  }, 60_000, true);
}

/**
 * Plots a course in astrogation by the sector, star and planet ids (never names) and engages. Then waits for the arrival
 * (`ship.transit === null`) while answering any conversation menu with option `option` (the first by default) and skipping any movie.
 */
export async function plot(page: Page, to: { sector: number; star: number; planet: number }, option = 0): Promise<void> {
  await goTo(page, 'Astrogation', 'astrogation');
  const panel = page.locator('.au-astro');
  await panel.getByRole('combobox', { name: 'Sector' }).selectOption(String(to.sector));
  await panel.getByLabel('Star').selectOption(String(to.star));
  await panel.getByLabel('Planet').selectOption(String(to.planet));
  await engageCourse(page);
  await drive(page, async () => (await state(page)).ship.transit === null, 90_000, false, option);
}

/** Steps the game along by answering what blocks it (a menu's first option, a movie's Skip) until `done`. */
export async function drive(page: Page, done: () => Promise<boolean>, ms = 90_000, menuWanted = false, option = 0): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await done()) return;
    const menu = page.locator('.au-menu');
    // (a spoken line is skipped by the page itself, in one step and only if no menu is up: a Space key press could land on a
    // menu that mounted just before it and answer it with its first option; muted, a voice line still plays out in real time)
    if (await page.locator('.au-subtitle').isVisible()) {
      await page.evaluate(() => window.__au!.skipLine());
    } else if (await menu.isVisible() && !menuWanted) await menu.getByRole('button').nth(option).click({ timeout: 2_000 }).catch(() => {});
    // (a battle: the placeholder combat dialog, Plan 12 Task 6, is won)
    // (the console's dev view folds the dialog's ways out behind its summary, which a closed details hides from isVisible)
    const dev = page.locator('[data-station="tactical"] details.au-console-dev:not([open]) > summary');
    if (await dev.isVisible()) await dev.click({ timeout: 2_000 }).catch(() => {});
    const win = page.locator('[data-station="tactical"]').getByRole('button', { name: 'Win', exact: true });
    if (await win.isVisible()) await win.click({ timeout: 2_000 }).catch(() => {});
    const skip = page.locator('.au-movie').getByRole('button', { name: 'Skip' });
    if (await skip.isVisible()) await skip.click({ timeout: 2_000 }).catch(() => {});
    await page.waitForTimeout(100);
  }
  // (ids and flags only, so a failure says where it stuck)
  const at = await page.evaluate(() => {
    const w = window.__au!.state();
    return { blocked: w.awayFlags.inputBlocked, problem: document.querySelector('.au-problem')?.textContent, bt: w.beamTarget, loc: w.ship.location, t64: w.triggers.t64, t192: w.triggers.t192, tick: w.tick, station: w.ship.station, pendingHail: w.pendingHail, idle: window.__au!.idle(), dialog: document.querySelector('[role=dialog]')?.className ?? null, subtitle: !!document.querySelector('.au-subtitle') };
  });
  throw new Error(`the game never got there: ${JSON.stringify(at)}`);
}

/** In the transporter room: Recommended, then Energize, then past the beam-down piece's movie, if it shows. */
export async function energize(page: Page): Promise<void> {
  await station(page, 'transporter').waitFor();
  await button(page, 'Recommended').click();
  const go = button(page, 'Energize');
  // (the room opens on the map, and Energize waits for its scan to lock on and for the crew to be on their pads)
  await expect(go).toBeEnabled({ timeout: 60_000 });
  await go.click();
  await drive(page, async () => (await state(page)).onShip === null);
}

/**
 * Imports an exported save through the admin console and waits for the game to load it (the console closes). Until the SETTINGS page's GAME
 * tab has IMPORT (Plan 32 Task 8), it is on the LOAD page.
 */
export async function importSave(page: Page, file: string): Promise<void> {
  await button(page, 'Admin').click();
  const padd = page.getByRole('dialog', { name: 'Admin console' });
  // (IMPORT is on SETTINGS' GAME tab)
  await padd.getByRole('button', { name: 'SETTINGS', exact: true }).click();
  await padd.getByRole('button', { name: 'GAME', exact: true }).click();
  await padd.locator('input[type=file]').setInputFiles(file);
  await padd.waitFor({ state: 'detached', timeout: 30_000 });
}

/** Opens the bridge's Comms or Lounge list once the game is idle, and picks the contact by its object id. */
async function contact(page: Page, list: 'Comms' | 'Lounge', object: string): Promise<void> {
  const choices = page.getByRole('list', { name: list });
  const wanted = choices.locator(`button[data-object="${object}"]`);
  // (the contact may not be listed until the ship has arrived: close the list and look again)
  await drive(page, async () => {
    if ((await choices.count()) === 0) {
      const open = bridgeItem(page, list === 'Comms' ? 'Comms' : 'Conf. Lounge');
      // (no such button now, a hail or a station in the way: look again, and `drive` answers what blocks)
      if ((await open.count()) === 0) return false;
      // (the lists are shut while the viewscreen is up: a player turns it off first)
      if (await open.isDisabled()) await clickWhenIdle(stripButton(page, 'viewscreen'));
      else await clickWhenIdle(open);
      return false;
    }
    // (the contact is picked only while the game is idle: a hail that came in meanwhile would refuse it)
    if ((await wanted.count()) > 0) return clickWhenIdle(wanted);
    await choices.getByRole('button', { name: 'Cancel', exact: true }).click();
    return false;
  }, 180_000, true);
}

export const comms = (page: Page, object: string) => contact(page, 'Comms', object);
export const lounge = (page: Page, object: string) => contact(page, 'Lounge', object);

/** Answers whatever blocks the game (menus by `option`) until it has been idle for a moment, twice running. */
export async function quiet(page: Page, option = 0): Promise<void> {
  for (let still = 0; still < 2; still++) {
    await drive(page, () => page.evaluate(() => window.__au!.idle()), 120_000, false, option);
    await page.waitForTimeout(400);
    still = (await page.evaluate(() => window.__au!.idle())) && !(await page.locator('.au-menu').isVisible()) ? still : -1;
  }
}

/** A mask or prop layer as `art masks` published it; an animated one (Batch 8) has `strips` by sprite animation. */
export interface PublishedLayer {
  object: string;
  anim?: number;
  /** What a character plays while it replies, and the animation it goes back to after the line (Batch 10). */
  talk?: { anim: number; idle: number };
  strips?: Record<string, { image?: string; images?: string[]; pages?: [number, number][]; cells?: number[][]; cell?: [number, number]; frames: number; of?: number[]; columns?: number; delays: number[]; loop: boolean; next?: number; rect: number[]; rects?: number[][] }>;
}

interface ArtPresentation {
  art?: { rooms?: Record<string, { plate?: string; masks?: PublishedLayer[] }>; cards?: Record<string, { anims?: Record<string, unknown> }> };
}

const GAME = fileURLToPath(new URL('../../../games/unity/', import.meta.url));

function presentation(): { art: ArtPresentation['art']; why: string } {
  if (!existsSync(`${GAME}game.yaml`)) return { art: undefined, why: 'games/unity/game.yaml (npm run unity:build)' };
  return { art: (parse(readFileSync(`${GAME}presentation.yaml`, 'utf8')) as ArtPresentation).art, why: '' };
}

/**
 * Are these rooms' plates published (Plan 14)? The art is Paramount's, so it is local: `games/unity/art/` is not committed. `why` says
 * what is missing (every room that is, by id), for a test's skip message.
 */
export function artPresent(screens: string | string[]): { present: boolean; why: string } {
  const here = presentation();
  if (here.why) return { present: false, why: here.why };
  const missing: string[] = [];
  for (const screen of Array.isArray(screens) ? screens : [screens]) {
    const plate = here.art?.rooms?.[screen]?.plate;
    if (!plate) missing.push(`art.rooms["${screen}"].plate in presentation.yaml (npm run art -- publish)`);
    else if (!existsSync(`${GAME}${plate}`)) missing.push(`${plate} under games/unity`);
  }
  return { present: missing.length === 0, why: missing.join('; ') };
}

/**
 * Stills the astrogation map and returns where a star is on it. The map opens turning by itself, and the pad's middle button stills it, but a click made while a
 * line is spoken only ends the line (and one on a map that is already still would put it back to its 6 and 3), so the button is pressed, once the game is idle, only while the
 * camera says it is turning. The point is then read until two frames in a row agree: the camera the page draws has caught up with the one the game holds.
 */
export async function stillMapPoint(page: Page, sector: number, star: number): Promise<{ x: number; y: number }> {
  await drive(page, async () => {
    if (!(await page.evaluate(() => window.__au!.astro().spinning))) return true;
    await clickWhenIdle(page.locator('.au-ship [data-painted="pad-stop"]'));
    return !(await page.evaluate(() => window.__au!.astro().spinning));
  });
  const point = await page.evaluate(async ([sec, st]) => {
    const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    let last = window.__au!.astroPoint(sec!, st!);
    for (let i = 0; i < 120; i++) {
      await frame();
      const now = window.__au!.astroPoint(sec!, st!);
      if (now && last && !window.__au!.astro().spinning && Math.abs(now.x - last.x) < 0.01 && Math.abs(now.y - last.y) < 0.01) return now;
      last = now;
    }
    return null;
  }, [sector, star] as const);
  if (!point) throw new Error(`star ${star} of sector ${sector} has no steady projected point on the map`);
  return point;
}

/** The ids of a room's occlusion masks in presentation.yaml (Plan 15). */
export function artMasks(screen: string): string[] {
  return (presentation().art?.rooms?.[screen]?.masks ?? []).map(m => m.object);
}

/** An animated layer of a room as published (its starting animation and strips), or undefined where there is none. */
export function artLayer(screen: string, object: string): PublishedLayer | undefined {
  return presentation().art?.rooms?.[screen]?.masks?.find(m => m.object === object && m.strips !== undefined);
}

/** Every room with animated layers, and its layers, as published: what the strip budget is checked on. */
export function artAnimatedRooms(): Record<string, PublishedLayer[]> {
  const rooms = presentation().art?.rooms ?? {};
  return Object.fromEntries(Object.entries(rooms).map(([room, r]) => [room, (r.masks ?? []).filter(m => m.strips !== undefined)]).filter(([, l]) => (l as PublishedLayer[]).length > 0));
}

/** The files of a published strip (its grid image, or the pages of its atlas), by path under the game's directory. */
export function stripFiles(strip: NonNullable<PublishedLayer['strips']>[string]): string[] {
  return strip.images ?? (strip.image ? [strip.image] : []);
}

/** The game's directory (games/unity/), with a trailing slash. */
export const GAME_DIR = GAME;

/** Whether `npm run unity:build` has made the game under games/unity (the specs that play it skip without: CI has none, the game being Paramount's). */
export const gameLifted = existsSync(`${GAME}game.yaml`) && existsSync(`${GAME}ship.yaml`);
export const NEEDS_GAME = 'needs the lifted game under games/unity (npm run unity:build, docs/unity-local.md)';

/** ScummVM's dump of one object (`placement scummvm`): the animation its sprite player is on, and whether that animation has ended (a loop never does). Undefined without the dump. */
export function scummvmPlayer(room: string, slug: string): { playing: number; stopped: boolean; active: boolean } | undefined {
  const file = `${homedir()}/pcode/unity-raw/runs/placement/scummvm-all.json`;
  if (!existsSync(file)) return undefined;
  const dump = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { slug?: string; playing: number; stopped: boolean; active: boolean }[]>;
  const o = dump[room]?.find(x => x.slug === slug);
  return o && { playing: o.playing, stopped: o.stopped, active: o.active };
}

/** Do these crew members have animated cards (Plan 15)? `why` names the ones that don't. */
export function cardsPresent(ids: string[]): { present: boolean; why: string } {
  const here = presentation();
  if (here.why) return { present: false, why: here.why };
  const missing = ids.filter(id => Object.keys(here.art?.cards?.[id]?.anims ?? {}).length === 0);
  return { present: missing.length === 0, why: missing.length ? `animated cards for ${missing.join(', ')} (npm run art -- strips)` : '' };
}

/** Are these crew portraits and item icons published (`art publish-kit`)? `why` names what is missing. */
export function portraitsPresent(crew: string[], items: string[]): { present: boolean; why: string } {
  const here = presentation();
  if (here.why) return { present: false, why: here.why };
  const art = here.art as { portraits?: Record<string, string>; icons?: Record<string, string> } | undefined;
  const missing = [
    ...crew.filter(id => !art?.portraits?.[id] || !existsSync(`${GAME}${art.portraits[id]}`)).map(id => `portrait ${id}`),
    ...items.filter(id => !art?.icons?.[id] || !existsSync(`${GAME}${art.icons[id]}`)).map(id => `icon ${id}`),
  ];
  return { present: missing.length === 0, why: missing.length ? `${missing.join(', ')} (npm run art -- publish-kit)` : '' };
}

/** Is the original's away-team panel published (`art panel publish`)? Like `portraitsPresent`, for every sprite of art.panel. */
export function panelPresent(): { present: boolean; why: string } {
  const here = presentation();
  if (here.why) return { present: false, why: here.why };
  const sprites = (here.art as { panel?: { sprites?: Record<string, string> } } | undefined)?.panel?.sprites;
  if (!sprites || !sprites.panel) return { present: false, why: 'art.panel in presentation.yaml (npm run art -- panel publish)' };
  const missing = Object.values(sprites).filter(f => !existsSync(`${GAME}${f}`));
  return { present: missing.length === 0, why: missing.length ? `${missing.join(', ')} (npm run art -- panel publish)` : '' };
}

/** Are the pictures of `art[key]` (art cursors publish, art tricorder publish) published? Each is a file under games/unity named in `sprites`. */
export function artSpritesPresent(key: 'cursors' | 'tricorder', command: string): { present: boolean; why: string } {
  const here = presentation();
  if (here.why) return { present: false, why: here.why };
  const sprites = (here.art as Record<string, { sprites?: Record<string, string> } | undefined> | undefined)?.[key]?.sprites;
  if (!sprites) return { present: false, why: `art.${key} in presentation.yaml (npm run art -- ${command})` };
  const missing = Object.values(sprites).filter(f => !existsSync(`${GAME}${f}`));
  return { present: missing.length === 0, why: missing.length ? `${missing.join(', ')} (npm run art -- ${command})` : '' };
}

/**
 * Are the ship's plates published (Plan 16)? Like `artPresent`, for `art.ship[station].plate`: the art is local. `why` names what is
 * missing, for a test's skip message.
 */
export function shipArtPresent(stations: string[]): { present: boolean; why: string } {
  const game = fileURLToPath(new URL('../../../games/unity/', import.meta.url));
  if (!existsSync(`${game}game.yaml`)) return { present: false, why: 'games/unity/game.yaml (npm run unity:build)' };
  const ship = (parse(readFileSync(`${game}presentation.yaml`, 'utf8')) as { art?: { ship?: Record<string, { plate?: string }> } }).art?.ship ?? {};
  const missing: string[] = [];
  for (const station of stations) {
    const plate = ship[station]?.plate;
    if (!plate) missing.push(`art.ship["${station}"].plate in presentation.yaml (npm run art -- ship publish)`);
    else if (!existsSync(`${game}${plate}`)) missing.push(`${plate} under games/unity`);
  }
  return { present: missing.length === 0, why: missing.join('; ') };
}

/** Is combat's art published (`npm run art:space -- publish`, Plan 30): `art.space` with a kind's pack, the effects' and the console's, each file there? */
export function spaceArtPresent(): { present: boolean; why: string } {
  const game = fileURLToPath(new URL('../../../games/unity/', import.meta.url));
  if (!existsSync(`${game}presentation.yaml`)) return { present: false, why: 'games/unity/presentation.yaml (npm run unity:build)' };
  const space = (parse(readFileSync(`${game}presentation.yaml`, 'utf8')) as { art?: { space?: { kinds?: Record<string, string>; effects?: string; console?: { plate: string; pack: string } } } }).art?.space;
  const files = space ? [...Object.values(space.kinds ?? {}), space.effects, space.console?.plate, space.console?.pack] : [];
  const missing = !space ? ['art.space in presentation.yaml (npm run art:space -- publish)'] : files.flatMap(f => (!f ? ['a pack or the console in art.space'] : existsSync(`${game}${f}`) ? [] : [`${f} under games/unity`]));
  return { present: missing.length === 0, why: missing.join('; ') };
}

/** Is the 3D set's glb published for a station (`?dev&ship3d`)? */
export function shipSetPresent(station: string): boolean {
  const game = fileURLToPath(new URL('../../../games/unity/', import.meta.url));
  if (!existsSync(`${game}presentation.yaml`)) return false;
  const gltf = ((parse(readFileSync(`${game}presentation.yaml`, 'utf8')) as { art?: { ship?: Record<string, { gltf?: string }> } }).art?.ship ?? {})[station]?.gltf;
  return !!gltf && existsSync(`${game}${gltf}`);
}

/** Does any crew card have the phaser's firing animations (12 to 23, Batch 10)? */
export function crewFires(): boolean {
  const cards = presentation().art?.cards ?? {};
  return Object.values(cards).some(c => Object.keys(c.anims ?? {}).some(a => Number(a) >= 12 && Number(a) <= 23));
}
