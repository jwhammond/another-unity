// SPDX-License-Identifier: GPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';

// The import screen in the deploy e2e (docs/deploy.md): the player's CD is the real CD folder, GAMEDATA_DIR, as the deploy build sealed
// the game with it. Nothing read from it is ever logged: only how long the import took.

export const GAMEDATA_DIR = process.env.GAMEDATA_DIR;
/** Playwright's output folder (git-ignored): the ISO and the made-up folders go here. */
export const TEST_RESULTS = fileURLToPath(new URL('../test-results', import.meta.url));
const ISO = join(TEST_RESULTS, 'cd.iso');

export const gateScreen = (page: Page) => page.locator('[data-gate=screen]');
export const gateMessage = (page: Page) => page.locator('[data-gate=message]');

/** Waits for the import screen, gives it the folder, and waits for it to go; returns how long the unlock took, in ms. */
export async function importCdFolder(page: Page, dir: string = GAMEDATA_DIR!): Promise<number> {
  await expect(gateScreen(page)).toBeVisible({ timeout: 60_000 });
  const t0 = Date.now();
  await page.locator('[data-gate=folder]').setInputFiles(dir);
  await expect(gateScreen(page)).toHaveCount(0, { timeout: 120_000 });
  return Date.now() - t0;
}

/** The same with a disc image, through the image input (the only one a phone has). */
export async function importCdImage(page: Page, file: string): Promise<number> {
  await expect(gateScreen(page)).toBeVisible({ timeout: 60_000 });
  const t0 = Date.now();
  await page.locator('[data-gate=image]').setInputFiles(file);
  await expect(gateScreen(page)).toHaveCount(0, { timeout: 120_000 });
  return Date.now() - t0;
}

export const hasHdiutil = (): boolean => spawnSync('hdiutil', ['help'], { stdio: 'ignore' }).status !== null;

/** An ISO 9660 image of GAMEDATA_DIR, made once (`hdiutil makehybrid -iso`); removeIso() deletes it. */
export function makeIsoOnce(): string {
  if (existsSync(ISO)) return ISO;
  if (!GAMEDATA_DIR) throw new Error('GAMEDATA_DIR is not set');
  mkdirSync(TEST_RESULTS, { recursive: true });
  const r = spawnSync('hdiutil', ['makehybrid', '-iso', '-o', ISO, GAMEDATA_DIR], { stdio: 'ignore' });
  if (r.status !== 0 || !existsSync(ISO)) throw new Error(`hdiutil makehybrid failed (${r.status})`);
  return ISO;
}

export function removeIso(): void {
  rmSync(ISO, { force: true });
}

/**
 * A folder of made-up files under the CD's file names (`dir`'s names only; nothing of the CD is read), each a few bytes: every file
 * the gate asks for is there, and none holds the CD's bytes. Also a made-up `.iso` of no disc at all. Both in `out`.
 */
export function makeWrongCd(out: string, dir: string = GAMEDATA_DIR!): { folder: string; iso: string } {
  const folder = join(out, 'NOT_THE_CD');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });
  const mirror = (from: string, to: string): void => {
    for (const name of readdirSync(from)) {
      if (name.startsWith('.')) continue;
      const st = statSync(join(from, name));
      if (st.isDirectory()) {
        mkdirSync(join(to, name));
        mirror(join(from, name), join(to, name));
      } else if (st.isFile()) {
        writeFileSync(join(to, name), 'made-up bytes, not the game\n'.repeat(4));
      }
    }
  };
  mirror(dir, folder);
  writeFileSync(join(folder, 'README.TXT'), 'a made-up file\n');
  const iso = join(out, 'not-a-disc.iso');
  writeFileSync(iso, Buffer.alloc(64 * 1024, 0x5a));
  return { folder, iso };
}
