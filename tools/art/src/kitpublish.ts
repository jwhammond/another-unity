// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { decodePng, meanAbsDiff, type Rgba } from './image';
import { readWebp, toWebp } from './webp';

export interface KitDeps {
  /** Default: Homebrew's cwebp, lossless. */
  encode?: (png: string, out: string) => Promise<void>;
  decode?: (webp: string) => Promise<Rgba>;
}

/**
 * The pictures to publish: portraits by file id and icons by item, and for a portrait the other object ids it is recorded under (`speakers`:
 * the game's objects that show the same head, e.g. each id of one character, which the subtitle looks up by its object name).
 */
export interface Kit { portraits: Record<string, string>; icons: Record<string, string>; speakers: Record<string, string[]> }

/** The ids with an avatar in `dir` (<id>.png, but not the sheets and variants: <id>.<something>.png) among `crew`, and the item icons (item.<object>.png) among `items`. */
export async function findKit(dir: string, crew: string[], items: string[], speakers: Record<string, string[]> = {}): Promise<Kit> {
  const names = new Set(await readdir(dir));
  const portraits: Record<string, string> = {};
  const icons: Record<string, string> = {};
  const aliases: Record<string, string[]> = {};
  for (const id of crew)
    if (names.has(`${id}.png`)) {
      portraits[id] = join(dir, `${id}.png`);
      if (speakers[id]?.length) aliases[id] = speakers[id]!;
    }
  for (const id of items) if (names.has(`item.${id}.png`)) icons[id] = join(dir, `item.${id}.png`);
  return { portraits, icons, speakers: aliases };
}

/**
 * Publishes the away team's portraits and the kit's icons: games/unity/art/avatars/<crew>.webp and art/icons/<item>.webp (lossless, so the
 * pixels stay hard) and presentation.yaml's art.portraits.<crew> and art.icons.<item>. Local and git-ignored, like the rest of art/.
 * Every WebP is read back and must be the PNG exactly; a mismatch refuses the publish before anything is renamed or recorded.
 */
export async function publishKit(gameDir: string, kit: Pick<Kit, 'portraits' | 'icons'> & Partial<Pick<Kit, 'speakers'>>, deps: KitDeps = {}): Promise<string[]> {
  const encode = deps.encode ?? ((png, out) => toWebp(png, out, { quality: 100, lossless: true }));
  const decode = deps.decode ?? readWebp;
  const jobs: { section: 'portraits' | 'icons'; id: string; png: string; rel: string }[] = [];
  for (const [id, png] of Object.entries(kit.portraits)) jobs.push({ section: 'portraits', id, png, rel: `art/avatars/${id}.webp` });
  for (const [id, png] of Object.entries(kit.icons)) jobs.push({ section: 'icons', id, png, rel: `art/icons/${id}.webp` });
  for (const j of jobs) if (!/^[a-z0-9_]+$/.test(j.id)) throw new Error(`"${j.id}" isn't an object id`);
  for (const others of Object.values(kit.speakers ?? {})) for (const who of others) if (!/^[a-z0-9_.]+$/.test(who)) throw new Error(`"${who}" isn't an object id`);
  const staged: { tmp: string; dest: string }[] = [];
  try {
    for (const j of jobs) {
      const dest = join(gameDir, j.rel);
      await mkdir(join(dest, '..'), { recursive: true });
      const tmp = `${dest}.tmp`;
      await encode(j.png, tmp);
      staged.push({ tmp, dest });
      const drift = meanAbsDiff(decodePng(new Uint8Array(await readFile(j.png))), await decode(tmp));
      if (drift !== 0) throw new Error(`${j.rel}: the WebP differs from ${j.png} (mean ${drift.toFixed(2)}/255); nothing was published`);
    }
  } catch (e) {
    for (const s of staged) await rm(s.tmp, { force: true });
    throw e;
  }
  for (const s of staged) await rename(s.tmp, s.dest);
  const path = join(gameDir, 'presentation.yaml');
  const doc = parseDocument(existsSync(path) ? await readFile(path, 'utf8') : '');
  for (const j of jobs) doc.setIn(['art', j.section, j.id], j.rel);
  for (const [id, others] of Object.entries(kit.speakers ?? {}))
    for (const who of others) {
      if (kit.portraits[id]) doc.setIn(['art', 'portraits', who], `art/avatars/${id}.webp`);
    }
  await writeFile(path, String(doc));
  return jobs.map(j => j.rel);
}
