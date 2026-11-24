// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PNG } from 'pngjs';
import { decodeMrg, decodePic } from '@another-unity/lift/space';
import { writePack } from '../../../engine/src/view/indexed';
import { COMBAT_STILLS, sheetColumns, SPRITE_INDEX, spriteSheetPath, type CombatSpriteSheet, type SpriteEntry } from '../../../engine/src/view/combat/files';

/** Writes a file through a temporary name, so a failure leaves what was there. */
async function writeAtomic(path: string, bytes: Uint8Array | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, bytes);
  await rename(`${path}.tmp`, path);
}

/**
 * Tactical's stills as the original draws them, from the export's verbatim copies (Plan 24 Task 1): the console (spc00a.pic, then
 * space.mrg's entries) in the space palette, which TacticalScreen::start sets over the picture's own (tactical.cpp:264-278), and
 * the warp's background (cheap.pic) in its own palette (showWarp, tactical.cpp:819). Returns the problems: a file the export lacks
 * or can't be read; nothing is written then for that pack.
 */
export async function publishStills(game: string, files: ReadonlyMap<string, Uint8Array>, spacePalette: Uint8Array): Promise<string[]> {
  const problems: string[] = [];
  const pic = (name: string) => {
    const bytes = files.get(name);
    const decoded = bytes ? decodePic(bytes) : null;
    if (!decoded) problems.push(`${bytes ? 'no picture in' : 'no'} ${name} (re-export: sh tools/rawcheck/run-harness.sh export 300)`);
    return decoded;
  };
  const plate = pic('spc00a.pic');
  const mrgBytes = files.get('space.mrg');
  const mrg = mrgBytes ? decodeMrg(mrgBytes) : null;
  if (!mrg) problems.push(`${mrgBytes ? 'no images in' : 'no'} space.mrg (re-export: sh tools/rawcheck/run-harness.sh export 300)`);
  if (plate && mrg) {
    await writeAtomic(join(game, COMBAT_STILLS.console), writePack([plate.image, ...mrg]));
    await writeAtomic(join(game, COMBAT_STILLS.palette), spacePalette);
  }
  const warp = pic('cheap.pic');
  if (warp) {
    await writeAtomic(join(game, COMBAT_STILLS.warp), writePack([warp.image]));
    await writeAtomic(join(game, COMBAT_STILLS.warpPalette), warp.palette);
  }
  return problems;
}

/** An entry with a picture is a frame of the sheet; one without (a null png) is neither drawn into it nor numbered. */
function isFrame(e: { type: string; png?: unknown }): boolean {
  return e.type === 'sprite' && typeof e.png === 'string';
}

interface SpriteJson { palette: string; entries: (Record<string, unknown> & { type: string; png?: string; width?: number; height?: number })[] }

/**
 * Combat's sprites (combat.yaml's `media.sprites`: the booms, each race's phaser, photon and shield, and the warp overlay's) as
 * one sheet each, from the images export's frames (in the palette the battle draws them in: Plan 18 Task 3, Plan 24 Task 1), and
 * their index (SPRITE_INDEX). A sprite's frames are all one size (measured: every combat sprite's are). Returns the problems: a
 * sprite the images export lacks, or with frames of more than one size, is left out of the index, and its sheet removed with
 * every sheet no longer named.
 */
export async function publishSprites(game: string, images: string, sprites: readonly string[]): Promise<{ written: number; problems: string[] }> {
  const problems: string[] = [];
  const index: Record<string, CombatSpriteSheet> = {};
  for (const file of [...sprites].map(s => s.toLowerCase()).sort()) {
    const jsonPath = join(images, 'images', 'sprites', file, 'sprite.json');
    if (!existsSync(jsonPath)) {
      problems.push(`${file}: not in the images export (${jsonPath})`);
      continue;
    }
    const json = JSON.parse(await readFile(jsonPath, 'utf8')) as SpriteJson;
    const frames = json.entries.filter(isFrame);
    const sizes = new Set(frames.map(e => `${e.width}x${e.height}`));
    if (frames.length === 0 || sizes.size !== 1) {
      problems.push(`${file}: ${frames.length === 0 ? 'no frames' : `frames of ${sizes.size} sizes`}`);
      continue;
    }
    const w = frames[0]!.width!, h = frames[0]!.height!;
    const columns = sheetColumns(frames.length, w);
    const sheet = new PNG({ width: columns * w, height: Math.ceil(frames.length / columns) * h });
    for (const [k, e] of frames.entries()) {
      const png = PNG.sync.read(await readFile(join(images, e.png!)));
      PNG.bitblt(png, sheet, 0, 0, w, h, (k % columns) * w, Math.floor(k / columns) * h);
    }
    let frame = 0;
    const entries: SpriteEntry[] = json.entries.map(({ png, ...rest }) => (isFrame({ ...rest, png }) ? { ...rest, frame: frame++ } : rest));
    const image = spriteSheetPath(file);
    await writeAtomic(join(game, image), PNG.sync.write(sheet));
    index[file] = { image, frames: frames.length, columns, cell: [w, h], palette: json.palette, entries };
  }
  await writeAtomic(join(game, SPRITE_INDEX), `${JSON.stringify(index)}\n`);
  const named = new Set(Object.values(index).map(s => s.image.slice('space/sprites/'.length)));
  const dir = join(game, 'space', 'sprites');
  for (const name of existsSync(dir) ? await readdir(dir) : []) if (name.endsWith('.png') && !named.has(name)) await rm(join(dir, name));
  return { written: Object.keys(index).length, problems };
}
