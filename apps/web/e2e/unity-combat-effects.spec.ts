// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { parse } from 'yaml';
// (for its `window.__au` declaration; Playwright erases the import)
import type {} from '../src/debug';
import { goTo, quiet, watchConsole } from './helpers';

const COMBAT = new URL('../../../games/unity/combat.yaml', import.meta.url);
const SPRITES = new URL('../../../games/unity/space/sprites.json', import.meta.url);
test.skip(!existsSync(COMBAT) || !existsSync(SPRITES), 'needs the lifted game and its space build under games/unity (npm run unity:build, docs/unity-local.md)');
test.setTimeout(900_000);
const MiB = 1048576;
/** How far each battle is fought by Delegate, a chunk at a time, looking at the effects after each. */
const STEPS = 1200, CHUNK = 40;

/**
 * The world tick each preview's battle is taken to start at (previewBattle's `tick`): its clock and the ship's timers from
 * there, not from however long the page took to get here, so a run's battles, and its counts, are the same each time.
 */
const TICK = 3600;

/** Waits for the battle's view to draw: its scene is warmed before its first frame (Plan 34 Task 8), and the steps below read the frame it drew. */
const drawn = (page: Page) => expect.poll(() => page.evaluate(() => window.__au!.combatView().drawing), { timeout: 30_000 }).toBe(true);

/**
 * Opens the game with the combat chunk already in: a cold dev server optimises the chunk's dependencies as it first loads
 * and reloads the page, which mid-test destroys it. A battle drawn and ended, then the page opened again.
 */
async function open(page: Page, url: string): Promise<void> {
  const ready = async () => {
    await page.goto(url);
    await page.waitForFunction(() => window.__au?.ready === true);
    await quiet(page);
  };
  await ready();
  // (the evaluate may meet the reload itself: it is asked again)
  // (asked once, and again only if the evaluate met the reload: each ask builds a new scene, whose warm-up (Plan 34 Task 8) then starts over,
  // so asking on every poll would never see it draw)
  let asked = false;
  await expect.poll(async () => {
    try {
      if (!asked) { await page.evaluate(() => window.__au!.previewBattle(8)); asked = true; }
      await frames(page, 2);
      return await page.evaluate(() => window.__au!.combatView().drawing);
    } catch {
      asked = false;
      return false;
    }
  }, { timeout: 60_000 }).toBe(true);
  await page.evaluate(() => window.__au!.endPreview());
  await ready();
}

/** Waits for `n` drawn frames. */
const frames = (page: Page, n: number) => page.evaluate(k => new Promise<void>(done => {
  let left = k;
  const next = () => (--left <= 0 ? done() : requestAnimationFrame(next));
  requestAnimationFrame(next);
}), n);

test('every battle\'s effects draw, fought by Delegate: each kind somewhere, where the scene says, within the draw budget, and freed (M8 spec §3.2, §9.2)', async ({ page }) => {
  // (the GL's own complaints too: the bloom's composite is a shader of ours, compiled first here)
  const errors = watchConsole(page, { gl: true });
  const scenarios = Object.keys((parse(readFileSync(COMBAT, 'utf8')) as { battles: Record<string, unknown> }).battles).map(Number).sort((a, b) => a - b).filter(n => n !== 3);
  await page.setViewportSize({ width: 640, height: 480 });
  await open(page, '/play/afu/?game=unity&dev&mute&art=0&start=lab.s01');
  const base = await page.evaluate(() => window.__au!.memory().bytes);
  const kinds = new Map<string, number>();
  /** By kind: how many times one was drawn on the window 2 pixels or more across, clear of every ship, and how many of those showed there. */
  const shown = new Map<string, { drawn: number; lit: number }>();
  /**
   * Beams whose target was drawn, by how they were aimed (BeamAim): how many were checked; and those on the first step of
   * a shield flash, whose end is the impact the last flash left (a quirk of ScummVM's, kept), counted apart and not checked.
   */
  const checked = new Map<string, number>();
  let stale = 0;
  const strays: string[] = [];
  const lines: string[] = [];
  let most = { calls: 0, triangles: 0, battle: 0 };
  for (const scenario of scenarios) {
    expect(await page.evaluate(([n, tick]) => window.__au!.previewBattle(n, { tick, commands: [{ type: 'delegate', on: true }] }), [scenario, TICK] as const), `battle ${scenario}`).toEqual({ battle: true, warnings: [] });
    await frames(page, 2);
    await drawn(page);
    const seen = new Set<string>();
    for (let step = 0; step < STEPS; step += CHUNK) {
      await page.evaluate(n => window.__au!.stepPreview(n), CHUNK);
      const f = await page.evaluate(() => window.__au!.combatFrame());
      expect(f.calls, `battle ${scenario} step ${step}`).toBeLessThanOrEqual(150);
      expect(f.triangles, `battle ${scenario} step ${step}`).toBeLessThanOrEqual(150_000);
      if (f.calls > most.calls) most = { calls: f.calls, triangles: f.triangles, battle: scenario };
      // (an effect whose middle is on the window, 2 pixels or more across and clear of every ship's disc, shows there: one in a
      // ship's disc can be hidden by it, as a torpedo is as it leaves its ship, by the depth buffer as by ScummVM's z-buffer)
      const v = await page.evaluate(() => window.__au!.combatView());
      for (const [i, e] of f.effects.entries()) {
        if (e.of === 0) continue;
        seen.add(e.kind);
        const at = v.effects[i]!;
        if (e.r < 2 || v.ships.some(s => Math.hypot(s.x - at.x, s.y - at.y) < s.r)) continue;
        const s = shown.get(e.kind) ?? { drawn: 0, lit: 0 };
        s.drawn++;
        if (e.lit > 0) s.lit++;
        shown.set(e.kind, s);
      }
      // (a beam's far end, as the layer drew its first vertex, where ScummVM's is (weapons.cpp:349-380): a hit's on the target's
      // centre, a miss's 0.75 R beside it, a shield hit's on the shield's impact R out (or the centre, its roll failed), so each
      // within R of the target's centre as drawn, and a unit. Measured in space: the window's disc is the sphere's projection
      // at the centre's depth, which a point on the near side overhangs (the Enterprise's impact, 97.5 px against r 92.4). A
      // target later in the list moves after the shooter in a step, and the end lags it by its travel, as ScummVM's does)
      for (const e of v.effects) {
        const target = e.kind === 'beam' && e.end && e.aim ? v.ships.find(s => s.index === e.aim!.to) : undefined;
        if (!target || !e.end || !e.aim) continue;
        if (e.aim.stale) {
          stale++;
          continue;
        }
        checked.set(e.aim.kind, (checked.get(e.aim.kind) ?? 0) + 1);
        const { off, radius, lag } = e.aim, allowed = radius + lag + 1;
        if (off > allowed) strays.push(`battle ${scenario} step ${step + CHUNK}: a ${e.aim.kind} on ship ${e.aim.to} ${off.toFixed(1)} from it, ${allowed.toFixed(1)} allowed (R ${radius.toFixed(1)}, lag ${lag.toFixed(1)}; ${Math.hypot(e.end.x - target.x, e.end.y - target.y).toFixed(1)} px, r ${target.r.toFixed(1)})`);
      }
    }
    for (const k of seen) kinds.set(k, (kinds.get(k) ?? 0) + 1);
    lines.push(`${scenario}: ${[...seen].sort().join(' ') || 'none'}`);
    await page.evaluate(() => window.__au!.endPreview());
    expect(Math.abs((await page.evaluate(() => window.__au!.memory().bytes)) - base), `battle ${scenario}`).toBeLessThan(MiB);
  }
  console.log(`[combat effects] most ${most.calls} calls, ${most.triangles} triangles (battle ${most.battle}); battles showing each: ${[...kinds].map(([k, n]) => `${k} ${n}`).join(', ')}; lit of drawn: ${[...shown].map(([k, s]) => `${k} ${s.lit}/${s.drawn}`).join(', ')}; beams checked ${[...checked].map(([k, n]) => `${k} ${n}`).join(', ')}, on a flash's first step ${stale}; ${lines.join('; ')}`);
  // (every kind drawn in some battle, and nearly all of each kind's draws clear of the ships showing)
  for (const kind of ['beam', 'torpedo', 'shield', 'explosion', 'debris', 'boom']) {
    expect(kinds.get(kind) ?? 0, kind).toBeGreaterThan(0);
    const s = shown.get(kind) ?? { drawn: 0, lit: 0 };
    expect(s.lit, kind).toBeGreaterThan(0.9 * s.drawn);
  }
  // (every beam ends where ScummVM's would, and each way of aiming one was seen)
  expect(strays).toEqual([]);
  for (const kind of ['hit', 'miss', 'shield']) expect(checked.get(kind) ?? 0, kind).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('the bloom goes over the modern view only: the parity mode draws the same effects in fewer calls (M8 spec §3.2, §9.3)', async ({ page }) => {
  const errors = watchConsole(page, { gl: true });
  await page.setViewportSize({ width: 640, height: 480 });
  await open(page, '/play/afu/?game=unity&dev&mute&art=0&start=lab.s01');
  // (battle 16 fought by Delegate until something glows)
  await page.evaluate(tick => window.__au!.previewBattle(16, { tick, commands: [{ type: 'delegate', on: true }] }), TICK);
  await frames(page, 2);
  await drawn(page);
  let modern = { calls: 0, effects: [] as { kind: string }[] };
  for (let step = 0; step < STEPS && !modern.effects.some(e => ['beam', 'torpedo', 'explosion', 'boom'].includes(e.kind)); step += 10) {
    await page.evaluate(() => window.__au!.stepPreview(10));
    modern = await page.evaluate(() => window.__au!.combatFrame());
  }
  expect(modern.effects.length).toBeGreaterThan(0);
  await page.evaluate(() => window.__au!.combatParity(true));
  const parity = await page.evaluate(() => window.__au!.combatFrame());
  await page.evaluate(() => window.__au!.combatParity(false));
  // (the parity mode's frame: the same effects, without the bloom's passes (two over the scene and 13 of the pass and its blend))
  expect(parity.effects.map(e => e.kind)).toEqual(modern.effects.map(e => e.kind));
  expect(modern.calls - parity.calls).toBeGreaterThanOrEqual(13);
  console.log(`[combat bloom] ${modern.calls} calls modern, ${parity.calls} in the parity mode, effects ${modern.effects.map(e => e.kind).join(' ')}`);
  await page.evaluate(() => window.__au!.endPreview());
  expect(errors).toEqual([]);
});

test('the warp overlay shows over the tactical box for its 3000 ms, the battle held meanwhile, then the view again (tactical.cpp:818-854)', async ({ page }) => {
  const errors = watchConsole(page, { gl: true });
  await open(page, '/play/afu/?game=unity&dev&mute&art=0&speed=4');
  await page.evaluate(() => window.__au!.battleScenario(8));
  await goTo(page, 'Tactical', 'tactical');
  await expect.poll(() => page.evaluate(() => window.__au!.combatView().drawing), { timeout: 20_000 }).toBe(true);
  expect(await page.evaluate(() => window.__au!.battleWarp())).toBe(true);
  await frames(page, 2);
  const during = await page.evaluate(() => ({ view: window.__au!.combatView(), steps: window.__au!.combatView().steps ?? -1 }));
  expect(during.view.overlay).toBe('warp');
  await frames(page, 10);
  expect(await page.evaluate(() => window.__au!.combatView().steps ?? -1)).toBe(during.steps);
  // (3000 battle ms at 4x: 750 ms of the page's)
  await expect.poll(() => page.evaluate(() => window.__au!.combatView().overlay), { timeout: 10_000 }).toBeNull();
  await expect.poll(() => page.evaluate(() => window.__au!.combatView().steps ?? -1)).toBeGreaterThan(during.steps);
  expect(errors).toEqual([]);
});
