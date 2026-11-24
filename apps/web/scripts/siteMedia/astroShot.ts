// SPDX-License-Identifier: GPL-3.0-or-later
// The astrogation screen as a player sees it (the map, the plate's panels, the game's fonts) is DOM and canvas, so it is captured headlessly from the
// game: an element screenshot of the screen only, at /play/afu/ with the dev hooks, from a vite dev server this step starts on its own port (5293 by
// default, never 5173/5174) and stops again. It is the one browser step of site:media, and it skips with a logged reason when it cannot run.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { decodePng, type Rgba } from '../../../../tools/art/src/image';

export const DEFAULT_PORT = 5293;

/** Why the capture should not run here, or null when it should: it needs the real game (not a GAMES_DIR override), its published astrogation plate, and not SITE_MEDIA_BROWSER=0. */
export function skipReason(env: NodeJS.ProcessEnv, gameDir: string): string | null {
  if (env.SITE_MEDIA_BROWSER === '0') return 'SITE_MEDIA_BROWSER=0';
  if (env.GAMES_DIR) return 'GAMES_DIR is set (the capture plays the repo\'s own games/unity)';
  if (env.VITEST) return 'running under vitest';
  if (!existsSync(join(gameDir, 'game.yaml'))) return 'no games/unity/game.yaml (npm run unity:build)';
  const plate = ((parse(readFileSync(join(gameDir, 'presentation.yaml'), 'utf8')) as { art?: { ship?: Record<string, { plate?: string }> } }).art?.ship ?? {}).astrogation?.plate;
  if (!plate || !existsSync(join(gameDir, plate))) return 'no published astrogation plate (npm run art -- ship publish)';
  return null;
}

/** The port to serve on, from SITE_MEDIA_PORT, kept within 5290-5293 (the ports this project's agents may use besides the dev ones). */
export function portFor(env: NodeJS.ProcessEnv): number {
  const p = Number(env.SITE_MEDIA_PORT ?? DEFAULT_PORT);
  return Number.isInteger(p) && p >= 5290 && p <= 5293 ? p : DEFAULT_PORT;
}

async function up(url: string): Promise<boolean> {
  try { return (await fetch(url)).ok; } catch { return false; }
}

async function startServer(repo: string, port: number): Promise<{ stop: () => void }> {
  const url = `http://localhost:${port}/play/afu/`;
  if (await up(url)) return { stop: () => {} };
  const child: ChildProcess = spawn('npm', ['run', 'dev', '-w', '@another-unity/web', '--', '--port', String(port), '--strictPort'], { cwd: repo, detached: true, stdio: 'ignore' });
  const stop = () => { try { if (child.pid) process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ } };
  for (let i = 0; i < 240; i++) {
    if (await up(url)) return { stop };
    if (child.exitCode !== null) break;
    await new Promise(r => setTimeout(r, 500));
  }
  stop();
  throw new Error(`the dev server did not come up on port ${port}`);
}

/** The screen's picture, or `{ skipped }` with the reason. Never throws for a missing browser or server. */
export async function captureAstrogation(repo: string, env: NodeJS.ProcessEnv = process.env): Promise<{ picture: Rgba } | { skipped: string }> {
  const why = skipReason(env, join(repo, 'games/unity'));
  if (why) return { skipped: why };
  let server: { stop: () => void } | undefined;
  try {
    const { chromium } = await import('@playwright/test');
    const { goTo, quiet, drive, clickWhenIdle } = await import('../../e2e/helpers');
    server = await startServer(repo, portFor(env));
    const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
      page.setDefaultTimeout(60_000);
      await page.goto(`http://localhost:${portFor(env)}/play/afu/?game=unity&speed=4&mute&dev`);
      await page.waitForFunction(() => (window as any).__au?.ready === true, undefined, { timeout: 90_000 });
      await quiet(page);
      await page.waitForFunction(() => (window as any).__au.art().ship.set, undefined, { timeout: 90_000 });
      await goTo(page, 'Astrogation', 'astrogation');
      await quiet(page, 1);
      // a scanned star in the sector view, the map stilled: the screen with something chosen and written about
      await drive(page, () => clickWhenIdle(page.locator('.au-ship [data-painted="pad-stop"]')));
      await page.evaluate(() => (window as any).__au.astroKnow(292, 1));
      const panel = page.locator('.au-astro');
      await panel.locator('select').nth(0).selectOption('292');
      await panel.locator('select').nth(1).selectOption('1');
      await drive(page, () => clickWhenIdle(page.locator('.au-ship [data-painted="view-sector"]')));
      await page.waitForTimeout(800);
      const png = await page.locator('.au-astro-plate .au-ship-screen').screenshot();
      return { picture: decodePng(new Uint8Array(png)) };
    } finally {
      await browser.close();
    }
  } catch (e) {
    return { skipped: `the browser capture could not run: ${(e as Error).message.split('\n')[0]}` };
  } finally {
    server?.stop();
  }
}
