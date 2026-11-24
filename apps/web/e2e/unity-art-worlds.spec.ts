// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { parse } from 'yaml';
// (for its `window.__au` declaration; Playwright erases the import)
import type {} from '../src/debug';
import { expectFrames, watchConsole } from './helpers';

// (the rooms are independent pages: the workers share the file's tests, so a file of many rooms is not the tail of the run)
test.describe.configure({ mode: 'parallel' });

// Milestone 6: every Horst III, Allanor, zoo, Frigis and Unity room that has a published plate shows it with art on and shows no
// plate with art off, with no console errors either way. The art is local (Paramount's): a room without a plate here is skipped.

const GAME = fileURLToPath(new URL('../../../games/unity/', import.meta.url));
const WORLDS = ['horst3', 'allanor', 'zoo', 'frigis', 'unity'];
const presentationFile = `${GAME}presentation.yaml`;
// (no presentation.yaml is no art: the spec skips, saying so. One that is there but cannot be read is an error, not a skip: a file caught mid-write by another
// process listed a part of the rooms once, and the suite quietly ran half the tests)
let published: string[] = [];
if (existsSync(presentationFile)) {
  const rooms = (parse(readFileSync(presentationFile, 'utf8')) as { art?: { rooms?: Record<string, { plate?: string }> } } | null)?.art?.rooms ?? {};
  published = Object.entries(rooms).filter(([id, r]) => !!r.plate && WORLDS.includes(id.split('.')[0]!)).map(([id]) => id).sort();
}
/** The plates on disk under art/rooms/<world>/<screen>/, as the rooms they belong to. */
const onDisk = WORLDS.flatMap(world => (existsSync(`${GAME}art/rooms/${world}`) ? readdirSync(`${GAME}art/rooms/${world}`) : [])
  .filter(screen => existsSync(`${GAME}art/rooms/${world}/${screen}/plate.webp`)).map(screen => `${world}.${screen}`)).sort();
test.skip(published.length === 0 && onDisk.length === 0, 'needs published plates for the M6 worlds (games/unity/presentation.yaml, npm run art -- publish)');

test('presentation.yaml names the plate of every room published on disk, so no room is left out of this spec', () => {
  expect(published).toEqual(onDisk);
});

for (const room of published) {
  test(`${room}: the plate shows with art on, not with art off, and nothing logs an error`, async ({ page }) => {
    const errors = watchConsole(page);
    await page.goto(`/play/afu/?game=unity&dev&start=${room}&mute`);
    await page.waitForFunction(() => window.__au?.ready === true);
    await expect.poll(() => page.evaluate(() => window.__au!.art().plate), { timeout: 20_000 }).toBe(true);
    await expectFrames(page);
    await page.goto(`/play/afu/?game=unity&dev&start=${room}&mute&art=0`);
    await page.waitForFunction(() => window.__au?.ready === true);
    expect((await page.evaluate(() => window.__au!.art())).plate).toBe(false);
    expect(errors).toEqual([]);
  });
}
