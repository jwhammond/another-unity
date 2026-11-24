// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { GAMEDATA_DIR, importCdFolder } from './gate';

// A deploy after a deploy (docs/deploy.md): a returning player's page is the new build's (pages come from the network first) while the
// old build's worker still controls it, and that worker doesn't know the new sealed files' names. The gate must have the new worker
// take over before the game's text is asked for. The second build is made from the first without building again (nextBuild), and the
// fixture server (scripts/deploy/authsim.ts) lays it over the output. Nothing read from the CD or the game is logged.
const OUT = fileURLToPath(new URL('../dist-deploy', import.meta.url));
const lifted = existsSync(fileURLToPath(new URL('../../../games/unity/game.yaml', import.meta.url)));
const built = existsSync(join(OUT, 'au-manifest.json')) && readdirSync(join(OUT, 'assets')).some(n => /^content-[\w-]{8}\.pack$/.test(n));
test.skip(!lifted || !GAMEDATA_DIR || !built, 'needs the lifted game, its CD folder (GAMEDATA_DIR) and a sealed deploy build (npm run deploy:build)');

const GAME = '/play/afu/?game=unity&mute';

/**
 * The next deploy, as a changed game would make it: every script chunk and content.pack under a new name, and the pages, the manifest
 * and the worker pointing at them under a new version, written to `dir` (the old names stay in the output below it, as a host keeps
 * them for a while). Nothing is decrypted: content.pack's bytes are the same, only its name is new.
 */
function nextBuild(dir: string): { from: string; to: string } {
  rmSync(dir, { recursive: true, force: true });
  const from = (JSON.parse(readFileSync(join(OUT, 'au-manifest.json'), 'utf8')) as { version: string }).version;
  const to = createHash('sha256').update(`next ${from}`).digest('hex').slice(0, 12);
  // (every chunk, the ones in subfolders too: the game page's own is assets/play/afu-*.js, which imports ../main-*.js and the rest; one
  // left under its old name would load the old build's code on the new build's page. Names are hashed, so a name is replaced wherever it
  // stands, in the chunks and the pages alike.)
  const assets = (d: string, out: string[] = []): string[] => {
    for (const e of readdirSync(join(OUT, d), { withFileTypes: true })) {
      if (e.isDirectory()) assets(join(d, e.name), out);
      else if (e.isFile()) out.push(join(d, e.name));
    }
    return out;
  };
  const renames = new Map<string, string>();
  const moves = new Map<string, string>();
  for (const rel of assets('assets')) {
    const name = basename(rel);
    const m = /^(.+)-([\w-]{8})\.(js|pack)$/.exec(name);
    if (!m || (m[3] === 'pack' && m[1] !== 'content')) continue;
    const next = `${m[1]}-${createHash('sha256').update(name).digest('hex').slice(0, 8)}.${m[3]}`;
    renames.set(name, next);
    moves.set(rel, join(dirname(rel), next));
  }
  const names = (text: string): string => {
    for (const [a, b] of renames) text = text.split(a).join(b);
    return text;
  };
  const write = (rel: string, text: string): void => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  for (const [a, b] of moves) {
    if (a.endsWith('.pack')) {
      mkdirSync(dirname(join(dir, b)), { recursive: true });
      copyFileSync(join(OUT, a), join(dir, b));
    } else write(b, names(readFileSync(join(OUT, a), 'utf8')));
  }
  // (the build's version is in these three only)
  const pages = (d: string, out: string[] = []): string[] => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory() && e.name !== 'assets' && e.name !== 'site-media') pages(join(d, e.name), out);
      else if (e.isFile() && e.name.endsWith('.html')) out.push(join(d, e.name));
    }
    return out;
  };
  for (const file of [...pages(OUT), join(OUT, 'au-manifest.json'), join(OUT, 'sw.js')]) {
    write(relative(OUT, file), names(readFileSync(file, 'utf8')).split(from).join(to));
  }
  return { from, to };
}

async function firstScreen(page: Page): Promise<void> {
  await expect(page.getByRole('region', { name: 'Bridge' })).toBeVisible({ timeout: 180_000 });
  await expect(page.locator('canvas#view')).toBeVisible();
}

/** The controlling worker's build, asked as the gate asks it. */
function controllerVersion(page: Page): Promise<string | undefined> {
  return page.evaluate(() => new Promise<string | undefined>(resolve => {
    const worker = navigator.serviceWorker.controller;
    if (!worker) return resolve(undefined);
    const channel = new MessageChannel();
    channel.port1.onmessage = e => resolve((e.data as { version?: string }).version);
    worker.postMessage({ type: 'version' }, [channel.port2]);
    setTimeout(() => resolve(undefined), 3000);
  }));
}

const pageVersion = (page: Page) => page.evaluate(() => document.querySelector<HTMLMetaElement>('meta[name="au-version"]')?.content);

test('after a deploy, a returning player loads the new build under its own worker', async ({ page, request }, info) => {
  test.setTimeout(480_000);
  const dir = info.outputPath('next-build');
  await request.get('/__mode?m=ok');
  await request.get('/__build');
  const problems: string[] = [];
  page.on('pageerror', e => problems.push(`pageerror: ${e.message.slice(0, 120)}`));
  page.on('response', r => { if (r.status() >= 400) problems.push(`${r.status()} ${new URL(r.url()).pathname}`); });

  // Build A: unlock, play, and the worker of A in control.
  await page.goto(GAME);
  await importCdFolder(page);
  await firstScreen(page);
  await page.waitForFunction(async () => !!navigator.serviceWorker.controller && (await caches.keys()).some(n => n.startsWith('au-shell-')), undefined, { timeout: 60_000 });
  const { from, to } = nextBuild(dir);
  expect(await pageVersion(page)).toBe(from);
  expect(await controllerVersion(page)).toBe(from);

  // Build B is deployed; the player comes back. B's page meets A's worker, which must not be asked for B's content.pack.
  try {
    await request.get(`/__build?dir=${encodeURIComponent(dir)}`);
    let loads = 0;
    page.on('framenavigated', f => { if (f === page.mainFrame()) loads++; });
    await page.goto(GAME);
    await firstScreen(page);
    // (Updating…, then one reload at most)
    expect(loads).toBeLessThanOrEqual(2);
    expect(await pageVersion(page)).toBe(to);
    expect(await controllerVersion(page)).toBe(to);
    await expect(page.getByText('Could not start')).toHaveCount(0);
    expect(problems).toEqual([]);
  } finally {
    await request.get('/__build');
    rmSync(dir, { recursive: true, force: true });
  }
});
