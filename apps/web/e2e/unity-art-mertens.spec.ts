// SPDX-License-Identifier: GPL-3.0-or-later
import { homedir } from 'node:os';
import { mkdirSync, readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
// (for its `window.__au` declaration; Playwright erases the import)
import type {} from '../src/debug';
import { act, artMasks, artPresent, button, cardsPresent, expectFrames, poll, quiet, settled, state, watchConsole } from './helpers';

// Plan 15 Task 11: every Mertens room shows its repainted plate, its masks and the crew's animated cards, and none of it changes
// what a click does. Art on and off pick the same objects and walk to the same point. The art is local (Paramount's), so the file
// is skipped, naming what is missing, unless all 13 rooms and the seven crew cards are published.

const ROOMS = ['s01', 's02', 's03', 's04', 's05', 's06', 's07', 's08', 's09', 's0a', 's0b', 's0c', 's0d'].map(s => `lab.${s}`);
const CLOSE_UPS = ['lab.s0a', 'lab.s0b', 'lab.s0c', 'lab.s0d'];
const CREW = ['picard', 'riker', 'data', 'troi', 'worf', 'crusher', 'la_forge'];
const rooms = artPresent(ROOMS);
const cards = cardsPresent(CREW);
const missing = [rooms.why, cards.why].filter(Boolean).join('; ');
test.skip(missing !== '', `needs ${missing}`);

const shots = `${homedir()}/pcode/unity-raw/runs/art-mertens`;

/** A dev start's away team of four: it moves along the crew by two a room, so the 13 rooms between them show all seven. */
const teamFor = (i: number): string[] => [0, 1, 2, 3].map(k => CREW[(i * 2 + k) % CREW.length]!);

interface Run {
  art: { screen: string | null; plate: boolean; masks: string[]; cards: string[]; on: boolean };
  picks: Record<string, string | null>;
  floor: { x: number; y: number } | null;
  end: { actor: string; pos: { x: number; z: number } } | null;
  /** Where the actor that walked stood before the walk, and why the walk failed, if it did. */
  start: { x: number; z: number } | null;
  walkError: string | null;
  errors: string[];
}

async function play(page: Page, room: string, team: string[], query: string, name: string | null, floorAt: Run['floor'] | undefined): Promise<Run> {
  const errors = watchConsole(page);
  await page.goto(`/play/afu/?game=unity&dev&start=${room}&team=${team.join(',')}&mute${query}`);
  await page.waitForFunction(() => window.__au?.ready === true);
  await settled(page);
  // (the plate, then the cards, load after the room: wait for them with art on, before the frame check reads the picture back)
  if (query === '') await poll(() => page.evaluate(() => window.__au!.art().plate), 20_000);
  // (a close-up without its plate is an empty greybox: no floor, no crew, nothing but the background)
  if (query === '' || !CLOSE_UPS.includes(room)) await expectFrames(page);
  if (query === '') await poll(() => page.evaluate(t => t.every(id => window.__au!.art().cards.includes(id)), team), 20_000);
  const shown = await page.evaluate(() => window.__au!.art());

  // (every active pickable on the screen, at the point where it is drawn: what a click there picks)
  const screen = await page.evaluate(() => window.__au!.state().screen);
  const ids = await page.evaluate(s => {
    const w = window.__au!.state();
    return Object.entries(w.objects).filter(([, o]) => o.active && o.screen === s && !o.inventory).map(([id]) => id).sort();
  }, screen);
  const picks: Record<string, string | null> = {};
  for (const id of ids) {
    const p = await page.evaluate(i => window.__au!.point(i), id);
    if (p) picks[id] = await page.evaluate(([x, y]) => window.__au!.objectAt(x, y), [p.x, p.y]);
  }

  if (name) {
    mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: `${shots}/${name}.png` });
  }

  // (a floor point free of objects, chosen in the art-on run and used in both; a close-up has no floor to walk)
  let floor = floorAt ?? null;
  if (floorAt === undefined) {
    floor = await page.evaluate(() => {
      const c = document.querySelector('canvas')!.getBoundingClientRect();
      for (const fy of [0.85, 0.75, 0.65, 0.55]) {
        for (const fx of [0.5, 0.35, 0.65, 0.2, 0.8]) {
          const x = c.left + c.width * fx;
          const y = c.top + c.height * fy;
          // (on the room itself: the HUD's bar, which is taller where it wraps, may cover the lowest rows)
          if (window.__au!.objectAt(x, y) === null && document.elementFromPoint(x, y) === document.querySelector('canvas')) return { x, y };
        }
      }
      return null;
    });
  }
  let end: Run['end'] = null;
  let start: Run['start'] = null;
  let walkError: string | null = null;
  if (floor) {
    // (a click while a line is spoken only ends the line: the walk is clicked once nothing is being said)
    await quiet(page);
    const before = await state(page);
    const leader = before.currentActor as string;
    start = { x: before.objects[leader].pos.x, z: before.objects[leader].pos.z };
    await act(page, async () => {
      await button(page, 'Walk').click();
      await page.mouse.click(floor.x, floor.y);
    }).catch((e: Error) => { walkError = e.message; });
    await settled(page);
    const w = await state(page);
    const actor = w.currentActor as string;
    end = { actor, pos: { x: w.objects[actor].pos.x, z: w.objects[actor].pos.z } };
  }
  return { art: shown, picks, floor, end, start, walkError, errors };
}

for (const [i, room] of ROOMS.entries()) {
  test(`${room}: shows the plate, masks and crew cards, and art on and off pick and walk the same`, async ({ page }) => {
    test.setTimeout(240_000);
    const team = teamFor(i);
    const on = await play(page, room, team, '', room, undefined);
    expect(on.art).toMatchObject({ screen: room, plate: true, on: true });
    // (a mask sorted above the horizon is not drawn, so the room shows some or all of the published ones)
    const published = artMasks(room);
    for (const id of on.art.masks) expect(published).toContain(id);
    if (published.length > 0) expect(on.art.masks.length).toBeGreaterThan(0);
    // (a close-up shows no crew)
    if (!CLOSE_UPS.includes(room)) for (const id of team) expect(on.art.cards).toContain(id);
    expect(Object.keys(on.picks).length).toBeGreaterThan(0);
    expect(on.errors).toEqual([]);

    const off = await play(page, room, team, '&art=0', null, on.floor);
    expect(off.art).toMatchObject({ screen: room, plate: false, masks: [], cards: [], on: false });
    expect(off.errors).toEqual([]);

    expect(off.picks).toEqual(on.picks);
    expect(off.floor).toEqual(on.floor);
    expect(off.end).toEqual(on.end);
    // (the walk really happened in both runs: a click that moves no one would compare two start positions)
    if (!CLOSE_UPS.includes(room)) {
      for (const run of [on, off]) {
        expect(run.walkError).toBeNull();
        expect(run.end).not.toBeNull();
        expect(run.end!.pos).not.toEqual(run.start);
      }
    }
  });
}

// (the lifter now stands a sprite's pick box at the sprite's own position, where its rect is; s06's hull breach has the same fault
// but is inactive until the probe breaks out, so these two, active from the start, are checked)
for (const [room, object] of [['lab.s03', 'lab.big_cable.0308'], ['lab.s06', 'lab.strange_machine']] as const) {
  test(`${room}: a click at the middle of ${object}'s rect picks it with art on, as the original draws and picks it`, async ({ page }) => {
    test.setTimeout(120_000);
    const lifted = JSON.parse(readFileSync(new URL(`../../../games/unity/rooms/lab/${room.slice(4)}.json`, import.meta.url), 'utf8')) as { hotspots: { object: string; rect: [number, number, number, number] }[] };
    const [x0, y0, x1, y1] = lifted.hotspots.find(h => h.object === object)!.rect;
    await page.goto(`/play/afu/?game=unity&dev&start=${room}&team=${teamFor(ROOMS.indexOf(room)).join(',')}&mute`);
    await page.waitForFunction(() => window.__au?.ready === true);
    await settled(page);
    await poll(() => page.evaluate(() => window.__au!.art().plate), 20_000);
    const picked = await page.evaluate(([x, y]) => {
      const c = document.querySelector('canvas')!.getBoundingClientRect();
      return window.__au!.objectAt(c.left + (x / 640) * c.width, c.top + (y / 480) * c.height);
    }, [(x0 + x1) / 2, (y0 + y1) / 2]);
    expect(picked).toBe(object);
  });
}

// The big cable and the trapped woman are sprites the original draws over the plate (it has neither): their cards (card.lab_big_cable,
// card.lab_trapped_woman, `art masks lab.s03`) stand in a mask's place, so the room shows them. Skipped until those are published.
const PROPS = ['lab.big_cable.0308', 'lab.trapped_woman.0301'];
test(`lab.s03: shows the big cable and the trapped woman as layers over the plate`, async ({ page }) => {
  test.skip(!PROPS.every(p => artMasks('lab.s03').includes(p)), 'the props of lab.s03 are not published (art batch card.lab_*.yaml, then art masks lab.s03)');
  test.setTimeout(120_000);
  const errors = watchConsole(page);
  await page.goto(`/play/afu/?game=unity&dev&start=lab.s03&team=${teamFor(ROOMS.indexOf('lab.s03')).join(',')}&mute`);
  await page.waitForFunction(() => window.__au?.ready === true);
  await settled(page);
  await poll(() => page.evaluate(ids => ids.every(id => window.__au!.art().masks.includes(id)), PROPS), 20_000);
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: `${shots}/t7-s03c-props.png` });
  expect(errors).toEqual([]);
});
