// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { parse } from 'yaml';
// (for its `window.__au` declaration; Playwright erases the import)
import type {} from '../src/debug';
import { goTo, quiet, station, watchConsole } from './helpers';

const COMBAT = new URL('../../../games/unity/combat.yaml', import.meta.url);
const SPRITES = new URL('../../../games/unity/space/sprites.json', import.meta.url);
test.skip(!existsSync(COMBAT) || !existsSync(SPRITES), 'needs the lifted game and its space build under games/unity (npm run unity:build, docs/unity-local.md)');
test.setTimeout(600_000);
const MiB = 1048576;
/** combatView.ts' WARM_LIMIT_MS: past it the host draws a scene whose warm-up hasn't finished. */
const WARM_LIMIT_MS = 5000;

/** Waits for `n` drawn frames. */
const frames = (page: Page, n: number) => page.evaluate(k => new Promise<void>(done => {
  let left = k;
  const next = () => (--left <= 0 ? done() : requestAnimationFrame(next));
  requestAnimationFrame(next);
}), n);

test('every battle draws: its ships where the scene says, within the draw budget, and frees all it took (M8 spec §9.2)', async ({ page }) => {
  const errors = watchConsole(page);
  const warmFailed: string[] = [];
  page.on('console', m => { if (/warm-up failed/.test(m.text())) warmFailed.push(m.text()); });
  const scenarios = Object.keys((parse(readFileSync(COMBAT, 'utf8')) as { battles: Record<string, unknown> }).battles).map(Number).sort((a, b) => a - b);
  expect(scenarios).toHaveLength(40);
  await page.setViewportSize({ width: 640, height: 480 });
  await page.goto('/play/afu/?game=unity&dev&mute&art=0&start=lab.s01');
  await page.waitForFunction(() => window.__au?.ready === true);
  await quiet(page);
  const base = await page.evaluate(() => window.__au!.memory().bytes);
  const seen: string[] = [];
  let most = { calls: 0, triangles: 0 };
  for (const scenario of scenarios) {
    const r = await page.evaluate(n => window.__au!.previewBattle(n, { steps: 30 }), scenario);
    // (battle 3 has no Enterprise: setup's failure, tactical.cpp:314-318, and nothing drawn)
    if (scenario === 3) {
      expect(r.battle, 'battle 3').toBe(false);
      continue;
    }
    expect(r, `battle ${scenario}`).toEqual({ battle: true, warnings: [] });
    // (each set's scene is warmed before its first frame: its programs compiled, its textures uploaded; Plan 34 Task 8. It is
    // done well inside the host's limit (combatView.ts WARM_LIMIT_MS, 5 s), which would draw the view unwarmed)
    const asked = Date.now();
    await expect.poll(() => page.evaluate(() => window.__au!.combatView().drawing), { timeout: 20_000 }).toBe(true);
    expect(Date.now() - asked, `battle ${scenario}'s warm-up`).toBeLessThan(WARM_LIMIT_MS);
    await frames(page, 30);
    const v = await page.evaluate(() => window.__au!.combatView());
    expect(v, `battle ${scenario}`).toMatchObject({ module: 'ready', drawing: true, scenario, window: { width: 320, height: 220 } });
    const f = await page.evaluate(() => window.__au!.combatFrame());
    // (each ship the scene draws whose middle is on the window, and that is at least 2 pixels across, shows there: some pixel
    // of the square about its middle is not space's black. A ship further off is a pixel or none, as the original's is)
    const onWindow = v.ships.filter(s => s.x >= 0 && s.y >= 0 && s.x < 320 && s.y < 220);
    expect(onWindow.length, `battle ${scenario}`).toBeGreaterThan(0);
    for (const s of f.ships.filter(x => x.r >= 2 && onWindow.some(o => o.index === x.index))) expect(s.lit, `battle ${scenario} ship ${s.index} (${s.model})`).toBeGreaterThan(0);
    // (the busiest frame: at most 150 draw calls and 150k triangles, M8 spec §8)
    expect(f.calls, `battle ${scenario}`).toBeLessThanOrEqual(150);
    expect(f.triangles, `battle ${scenario}`).toBeLessThanOrEqual(150_000);
    most = { calls: Math.max(most.calls, f.calls), triangles: Math.max(most.triangles, f.triangles) };
    seen.push(`${scenario}: ${v.ships.length} ships (${onWindow.length} on the window), ${f.calls} calls, ${f.triangles} triangles`);
    await page.evaluate(() => window.__au!.endPreview());
    // (the scene's own objects and the set gone: the ledger back where it was)
    expect(Math.abs((await page.evaluate(() => window.__au!.memory().bytes)) - base), `battle ${scenario}`).toBeLessThan(MiB);
  }
  expect(warmFailed).toEqual([]);
  console.log(`[combat view] most ${most.calls} calls, ${most.triangles} triangles; ${seen.join('; ')}`);
  expect(errors).toEqual([]);
});

test('the world\'s battle at tactical draws in the console\'s box, from the combat chunk loaded then (M8 spec §3, §8; Plan 27)', async ({ page }) => {
  const errors = watchConsole(page);
  const asked: string[] = [];
  page.on('request', r => { if (/spaceScene/.test(r.url())) asked.push(r.url()); });
  await page.goto('/play/afu/?game=unity&dev&mute&art=0&speed=4');
  await page.waitForFunction(() => window.__au?.ready === true);
  await quiet(page);
  // (no battle drawn yet: the chunk not asked for)
  expect([asked, (await page.evaluate(() => window.__au!.combatView())).module]).toEqual([[], 'none']);
  // (the default battle, 8: the Enterprise alone in a new game)
  await page.evaluate(() => window.__au!.battleScenario(8));
  await goTo(page, 'Tactical', 'tactical');
  const box = station(page, 'tactical').getByRole('group', { name: 'Console' });
  await expect(box).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__au!.combatView().drawing), { timeout: 20_000 }).toBe(true);
  expect(asked.length).toBeGreaterThan(0);
  const v = await page.evaluate(() => window.__au!.combatView());
  expect(v).toMatchObject({ module: 'ready', scenario: 8, wide: false, window: { width: 320, height: 220 } });
  // (Split's rectangle of the box: 320 x 220 at (319, 23) of 640 x 480, in the canvas's pixels)
  const b = (await box.boundingBox())!;
  const dpr = await page.evaluate(() => devicePixelRatio);
  expect(v.viewport!.width).toBe(Math.round((b.width * dpr * 320) / 640));
  expect(v.ships.map(s => s.index)).toContain(0);
  const f = await page.evaluate(() => window.__au!.combatFrame());
  expect(f.ships.find(s => s.index === 0)!.lit).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});
