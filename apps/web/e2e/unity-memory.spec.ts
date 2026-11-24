// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync } from 'node:fs';
import { devices, expect, test, type Page } from '@playwright/test';
// (for its `window.__au` declaration; Playwright erases the import)
import type {} from '../src/debug';
import { artPresent, clickWhenIdle, drive, expectFrames, goTo, quiet, settled, shipArtPresent, station, watchConsole } from './helpers';

const ROOM = 'lab.s01';
const ship = shipArtPresent(['bridge', 'astrogation']);
const room = artPresent(ROOM);
test.skip(!ship.present || !room.present, `needs ${[ship.why, room.why].filter(Boolean).join('; ')}`);
test.setTimeout(300_000);

// (the chromium project runs these: a descriptor's own browser type is dropped, its screen, touch and agent kept)
const phone = (name: string) => {
  const { defaultBrowserType: _ignored, ...rest } = devices[name]!;
  return rest;
};

const MB = 1048576;
type Memory = ReturnType<NonNullable<Window['__au']>['memory']>;
const memory = (page: Page): Promise<Memory> => page.evaluate(() => window.__au!.memory());
const mb = (bytes: number): string => (bytes / MB).toFixed(1);

async function bridge(page: Page, query = ''): Promise<void> {
  await page.goto(`/play/afu/?game=unity&dev&mute&speed=8${query}`);
  await page.waitForFunction(() => window.__au?.ready === true);
  await quiet(page);
  await expect(station(page, 'bridge')).toBeVisible();
  await page.waitForFunction(() => window.__au!.art().ship.set === true, undefined, { timeout: 60_000 });
}

async function lab(page: Page, query = ''): Promise<void> {
  await page.goto(`/play/afu/?game=unity&dev&start=${ROOM}&mute${query}`);
  await page.waitForFunction(() => window.__au?.ready === true);
  await settled(page);
  await page.waitForFunction(() => window.__au!.art().plate === true, undefined, { timeout: 60_000 });
}

test.describe('Pixel 7, on its side', () => {
  test.use(phone('Pixel 7 landscape'));

  test('takes the half-resolution plates and a pixel ratio of 2 at most, on the bridge and in the lab', async ({ page }) => {
    const errors = watchConsole(page);
    await bridge(page);
    const onBridge = await memory(page);
    expect(onBridge.plates.filter(p => p.startsWith('plate.half.webp'))).toEqual(['plate.half.webp 1280x960']);
    expect(onBridge.plates.filter(p => /^plate\.webp/.test(p))).toEqual([]);
    // (a Pixel's own ratio is 2.625)
    expect(await page.evaluate(() => window.devicePixelRatio)).toBeGreaterThan(2);
    expect(onBridge.pixelRatio).toBe(2);
    console.log(`[memory] Pixel 7, bridge: ${onBridge.textures} textures, ${mb(onBridge.bytes)} MB decoded, ${mb(onBridge.gpuBytes)} MB on the GPU, renderer ${onBridge.rendererTextures} textures`);
    await lab(page);
    const inLab = await memory(page);
    expect(inLab.plates).toEqual(['plate.half.webp 1280x960']);
    console.log(`[memory] Pixel 7, ${ROOM}: ${inLab.textures} textures, ${mb(inLab.bytes)} MB decoded, ${mb(inLab.gpuBytes)} MB on the GPU, renderer ${inLab.rendererTextures} textures`);
    console.log(`[memory] biggest in lab: ${inLab.biggest.join('; ')}`);
    expect(errors).toEqual([]);
  });
});

test.describe('desktop', () => {
  test('keeps the full plates and the screen\'s own pixel ratio', async ({ page }) => {
    await bridge(page, '&res=full');
    const full = await memory(page);
    expect(full.plates.filter(p => /^plate\.webp/.test(p))).toEqual(['plate.webp 2560x1920']);
    expect(full.pixelRatio).toBe(await page.evaluate(() => window.devicePixelRatio));
    console.log(`[memory] desktop full, bridge: ${full.textures} textures, ${mb(full.bytes)} MB decoded, ${mb(full.gpuBytes)} MB on the GPU, renderer ${full.rendererTextures} textures`);
    await lab(page, '&res=full');
    const inLab = await memory(page);
    expect(inLab.plates).toEqual(['plate.webp 2560x1920']);
    console.log(`[memory] desktop full, ${ROOM}: ${inLab.textures} textures, ${mb(inLab.bytes)} MB decoded, ${mb(inLab.gpuBytes)} MB on the GPU, renderer ${inLab.rendererTextures} textures`);
  });

  test('half resolution (?res=half) holds a quarter of the plate memory', async ({ page }) => {
    await bridge(page, '&res=full');
    const full = await memory(page);
    await bridge(page, '&res=half');
    const half = await memory(page);
    expect(half.plates.filter(p => /^plate\.half\.webp/.test(p))).toEqual(['plate.half.webp 1280x960']);
    console.log(`[memory] biggest, full: ${full.biggest.join('; ')}`);
    expect(half.bytes).toBeLessThan(full.bytes * 0.8);
    console.log(`[memory] bridge: full ${mb(full.bytes)} MB, half ${mb(half.bytes)} MB; biggest, half: ${half.biggest.join('; ')}`);
  });

  test('leaves no texture behind across screen changes: the bridge, astrogation and back, again and again', async ({ page }) => {
    await bridge(page, '&res=half');
    const first = await memory(page);
    const seen: number[] = [];
    for (let i = 0; i < 3; i++) {
      await goTo(page, 'Astrogation', 'astrogation');
      await page.waitForFunction(() => window.__au!.art().ship.set === true, undefined, { timeout: 60_000 });
      await drive(page, async () => {
        await clickWhenIdle(page.getByRole('button', { name: 'Back to the bridge' }));
        return (await station(page, 'bridge').count()) > 0;
      });
      await page.waitForFunction(() => window.__au!.art().ship.set === true, undefined, { timeout: 60_000 });
      await page.waitForTimeout(500);
      seen.push((await memory(page)).bytes);
    }
    console.log(`[memory] bridge ${mb(first.bytes)} MB; back on it after each trip to astrogation: ${seen.map(mb).join(', ')} MB`);
    // (the same after every trip: what was left is freed, what comes back is loaded once)
    expect(new Set(seen).size).toBe(1);
    expect(seen[0]).toBeLessThanOrEqual(first.bytes * 1.05);
  });

  test('a battle\'s models and sprites load as it starts and go as it ends: three trips into battle 8 and out (M8 spec §8)', async ({ page }) => {
    test.skip(!existsSync(new URL('../../../games/unity/space/sprites.json', import.meta.url)), 'needs the space build\'s sprites (npm run unity:build)');
    const errors = watchConsole(page);
    await bridge(page, '&res=half');
    const onBridge = (await memory(page)).bytes;
    const trips: string[] = [];
    for (let i = 0; i < 3; i++) {
      // (the default battle, 8: in a new game its only active ship is the Enterprise, so it stands down at once: Plan 23)
      await page.evaluate(() => window.__au!.battleScenario(8));
      await goTo(page, 'Tactical', 'tactical');
      await page.waitForFunction(() => window.__au!.combatAssets()?.state === 'ready', undefined, { timeout: 60_000 });
      const set = (await page.evaluate(() => window.__au!.combatAssets()))!;
      expect(set).toMatchObject({ scenario: 8, missing: [], stills: true });
      // (the ledger holds the set beside tactical's own: the bridge's plate is freed as the station changes)
      expect((await memory(page)).bytes).toBeGreaterThanOrEqual(set.bytes);
      // (the console's repaint pictures, held while the battle is up, if the art publishes one: Plan 31 R3)
      const consoleArt = (await memory(page)).consoleArt;
      // (R2, recorded only: memory() has no audio figure, so the sounds the mixer has started stand for it; the page is muted)
      const sounds = await page.evaluate(() => window.__au!.sounds().length);
      // (the dev view folds out over the console: Plan 27)
      await station(page, 'tactical').getByText('Dev tools', { exact: true }).click();
      const battle = station(page, 'tactical').getByRole('region', { name: 'Battle' });
      await battle.getByRole('button', { name: 'Auto-resolve', exact: true }).click();
      await expect(battle.getByLabel('Result')).toContainText('Stood down');
      await battle.getByRole('button', { name: 'Continue', exact: true }).click();
      await expect(station(page, 'bridge')).toBeVisible({ timeout: 20_000 });
      await page.waitForFunction(() => window.__au!.art().ship.set === true, undefined, { timeout: 60_000 });
      expect(await page.evaluate(() => window.__au!.combatAssets())).toBeNull();
      const after = (await memory(page)).bytes;
      // (freed with the battle's set)
      expect((await memory(page)).consoleArt).toBe(0);
      trips.push(`${mb(set.bytes)} MB in battle (${set.textures} textures), console art ${mb(consoleArt)} MB in battle, ${sounds} sounds started, ${mb(after)} MB after`);
      expect(Math.abs(after - onBridge)).toBeLessThan(MB);
    }
    console.log(`[memory] bridge ${mb(onBridge)} MB; battle 8, three times: ${trips.join('; ')}`);
    expect(errors).toEqual([]);
  });

  test('a lost WebGL context comes back: the art uploads again and the frame is not blank, with no reload', async ({ page }) => {
    const errors = watchConsole(page);
    await lab(page, '&res=half');
    await expectFrames(page);
    await page.evaluate(() => { (window as unknown as { __kept: boolean }).__kept = true; });
    const restored = page.waitForEvent('console', { predicate: m => m.text().includes('The WebGL context was restored') });
    await page.evaluate(() => {
      const gl = document.querySelector('canvas')!.getContext('webgl2')!;
      const lose = gl.getExtension('WEBGL_lose_context')!;
      lose.loseContext();
      setTimeout(() => lose.restoreContext(), 300);
    });
    await restored;
    await page.waitForTimeout(500);
    await expectFrames(page);
    expect(await page.evaluate(() => (window as unknown as { __kept?: boolean }).__kept)).toBe(true);
    expect(errors).toEqual([]);
  });
});
