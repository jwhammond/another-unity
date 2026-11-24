// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { parse } from 'yaml';
import { goTo, quiet, station, watchConsole } from './helpers';

const COMBAT = new URL('../../../games/unity/combat.yaml', import.meta.url);
const lifted = existsSync(COMBAT) && existsSync(new URL('../../../games/unity/audio/music/enterpri.ogg', import.meta.url));
test.skip(!lifted, 'needs the lifted game with combat.yaml and its audio under games/unity (npm run unity:build, docs/unity-local.md)');

/**
 * The battle the sound is heard in: 16, as the console's e2e fights it, the Enterprise and two ships at red alert. Left 20 s of
 * its clock it raises a hail of its own (Plan 23's Facts), so the test is short at the game's own pace. Muted: the master gain
 * is 0, so the sounds start and run their length unheard, and `window.__au.sounds()` lists them.
 */
const BATTLE = 16;
const START = '/play/afu/?game=unity&dev&mute&art=0';

/** A cue's file and bus, by its name in combat.yaml's cueIds: read here and compared, never printed (the game's own names). */
function cue(name: string): { stem: string; bus: 'voice' | 'sfx' } {
  const combat = parse(readFileSync(COMBAT, 'utf8')) as { cueIds: Record<string, number>; cues: { speaker: number; file: string }[] };
  const c = combat.cues[combat.cueIds[name]!]!;
  return { stem: c.file.toLowerCase().replace(/\.[^.]*$/, ''), bus: c.speaker < 8 ? 'voice' : 'sfx' };
}

const sounds = (page: Page) => page.evaluate(() => window.__au!.sounds());
const channels = (page: Page) => page.evaluate(() => window.__au!.battleSound()!.channels);
/** Whether `stem` started on `bus` since the `from`th sound the mixer started. */
const started = async (page: Page, from: number, { stem, bus }: { stem: string; bus: string }) =>
  (await sounds(page)).slice(from).some(s => s.bus === bus && s.url.includes(`/${stem}.`));

/** Opens the game with the combat chunk already in, as the console's e2e does: a cold dev server reloads the page as it optimises the chunk. */
async function open(page: Page): Promise<void> {
  const ready = async () => {
    await page.goto(START);
    await page.waitForFunction(() => window.__au?.ready === true);
    await quiet(page);
  };
  await ready();
  // (asked once, and again only if the evaluate met the reload: each ask builds a new scene, whose warm-up (Plan 34 Task 8) then starts over,
  // so asking on every poll would never see it draw)
  let asked = false;
  await expect.poll(async () => {
    try {
      if (!asked) { await page.evaluate(() => window.__au!.previewBattle(8)); asked = true; }
      await page.waitForTimeout(100);
      return await page.evaluate(() => window.__au!.combatView().drawing);
    } catch {
      asked = false;
      return false;
    }
  }, { timeout: 60_000 }).toBe(true);
  await page.evaluate(() => window.__au!.endPreview());
  await ready();
}

/** Whether the page's audio clock runs: a sound ends only as it does (playwright.config.ts's fake output; a stalled device holds it at 0). */
async function audioClockRuns(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const ctx = new AudioContext();
    const from = ctx.currentTime;
    await new Promise(r => setTimeout(r, 300));
    const ran = ctx.currentTime - from > 0.1;
    await ctx.close();
    return ran;
  });
}

test('a battle plays its music and the crew\'s cues, a cue after a cue, and nothing new while paused (Plan 28)', async ({ page }) => {
  const errors = watchConsole(page);
  await open(page);
  expect(await audioClockRuns(page), 'the browser\'s audio clock is stopped, so no sound ends: run with playwright.config.ts\'s --disable-audio-output').toBe(true);
  await page.evaluate(n => window.__au!.battleScenario(n), BATTLE);
  await goTo(page, 'Tactical', 'tactical');
  const tactical = station(page, 'tactical');
  const consoleGroup = tactical.getByRole('group', { name: 'Console' });
  await expect(consoleGroup).toBeVisible();

  // tactical's music, looped (tactical.cpp:287)
  await expect.poll(async () => (await sounds(page)).filter(s => s.loop && s.bus === 'music').at(-1)?.url.match(/([^/]+)\.ogg/)?.[1], { timeout: 30_000 }).toBe('enterpri');

  // Shields up: its cue on the voice bus, then, once that has ended, the cue played after it (raiseShields, weapons.cpp:636, 644)
  const raised = await page.evaluate(() => window.__au!.combatConsole()!.console.shieldsRaised);
  if (raised) {
    await consoleGroup.getByRole('button', { name: 'Shields', exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => window.__au!.combatConsole()!.console.shieldsRaised))).toBe(false);
  }
  // (nobody says two things at once: the crew is quiet first, so the cue isn't refused for its speaker, cues.cpp:68-71)
  await expect.poll(async () => (await channels(page)).slice(0, 3).some(Boolean), { timeout: 30_000 }).toBe(false);
  const from = (await sounds(page)).length;
  await consoleGroup.getByRole('button', { name: 'Shields', exact: true }).click();
  await expect.poll(() => started(page, from, cue('shieldsRaising')), { timeout: 10_000 }).toBe(true);
  await expect.poll(() => started(page, from, cue('shieldsRaised')), { timeout: 20_000 }).toBe(true);

  // paused: the battle's frames stop, so nothing new starts, and what plays comes to its end (M8 spec §6.3)
  await tactical.getByText('Dev tools', { exact: true }).click();
  const battle = tactical.getByRole('region', { name: 'Battle' });
  await battle.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect.poll(async () => (await channels(page)).some(Boolean), { timeout: 30_000 }).toBe(false);
  const paused = (await sounds(page)).filter(s => !s.loop).length;
  await page.waitForTimeout(3_000);
  expect((await sounds(page)).filter(s => !s.loop).length).toBe(paused);
  await battle.getByRole('button', { name: 'Resume', exact: true }).click();
  expect(errors).toEqual([]);
});
