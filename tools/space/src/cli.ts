// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { NodeIO } from '@gltf-transform/core';
import { parseCombat } from '@another-unity/engine';
import { decodeTexture, parseSpaceMaterials, parseSpaceModel, spacePalette, SPACE_EXT, type SpaceTexture } from '@another-unity/lift/space';
import { buildSpaceGltf } from './gltf';
import { publishSprites, publishStills } from './stills';

const USAGE = 'usage: space --raw <export dir> [--game games/unity] [--images <images export>]';
const SPACE_FILE = new RegExp(`\\.(?:${SPACE_EXT})$|^(?:spc00a\\.pic|space\\.mrg|cheap\\.pic)$`, 'i');

/**
 * The space build (Plan 18 Task 8, Plan 24 Task 3): a .glb for every model combat.yaml names, from the export's verbatim files;
 * tactical's stills (COMBAT_STILLS); and, with the images export, a sheet for every sprite combat.yaml names. A setup error (no
 * combat.yaml, no verbatim files) is a `space:` line and exit 1.
 */
export async function runSpace(argv: string[], log: (line: string) => void): Promise<number> {
  try {
    return await build(argv, log);
  } catch (e) {
    log(`space: ${(e as Error).message}`);
    return 1;
  }
}

async function build(argv: string[], log: (line: string) => void): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { raw: { type: 'string' }, game: { type: 'string', default: 'games/unity' }, images: { type: 'string' } } });
  if (!values.raw) {
    log(USAGE);
    return 2;
  }
  const game = values.game!;
  const combat = parseCombat(await readFile(join(game, 'combat.yaml'), 'utf8'));
  const verbatim = join(values.raw, 'verbatim');
  const files = new Map<string, Uint8Array>();
  for (const name of await readdir(verbatim)) {
    if (SPACE_FILE.test(name)) files.set(name.toLowerCase(), new Uint8Array(await readFile(join(verbatim, name))));
  }
  // Without enterprs.mtl's first texture, TacticalScreen::start keeps the graphics palette's entry 0 (tactical.cpp:275-276):
  // whatever palette the screen before the battle left set, which is run-time state and no file. The build doesn't guess
  // it; it stops, as no export of the game lacks that texture.
  const palette = spacePalette(files);
  if (!palette) {
    log('space: no space palette: the export lacks enterprs.mtl or its first texture (tactical.cpp:271-276)');
    return 1;
  }
  const textures = new Map<string, SpaceTexture | null>();
  const texture = (name: string): SpaceTexture | null => {
    const k = name.toLowerCase();
    if (!textures.has(k)) {
      const bytes = files.get(k);
      textures.set(k, bytes ? decodeTexture(k, bytes) : null);
    }
    return textures.get(k)!;
  };
  const io = new NodeIO();
  const out = join(game, 'space');
  await mkdir(out, { recursive: true });
  const written = new Set<string>();
  // (a model that fails keeps its last good .glb: only one combat.yaml no longer names is removed)
  const named = new Set(Object.values(combat.models).map(m => join(game, m.url)));
  let failed = 0;
  for (const [key, m] of Object.entries(combat.models).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const bytes = files.get(m.geometry);
    const model = bytes ? parseSpaceModel(bytes) : null;
    if (!model) {
      log(`space: ${key}: no model ${m.geometry} in ${verbatim}`);
      failed++;
      continue;
    }
    const mtl = m.materials ? files.get(m.materials) : undefined;
    try {
      const { doc, warnings } = buildSpaceGltf({ key, model, materials: mtl ? parseSpaceMaterials(mtl) : null, materialsName: m.materials, texture, palette });
      for (const w of warnings) log(`space: ${w}`);
      const path = join(game, m.url);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, await io.writeBinary(doc));
      written.add(path);
    } catch (e) {
      log(`space: ${key}: ${(e as Error).message}`);
      failed++;
    }
  }
  for (const name of await readdir(out)) {
    if (name.endsWith('.glb') && !named.has(join(out, name))) await rm(join(out, name));
  }
  // (tactical's stills, and the sprites: Plan 24)
  const stillProblems = await publishStills(game, files, palette);
  const problems = [...stillProblems];
  let sheets = 0;
  if (values.images) {
    const sprites = await publishSprites(game, values.images, combat.media.sprites);
    sheets = sprites.written;
    problems.push(...sprites.problems);
  } else {
    log('space: no images export (--images, IMAGES_DIR): the combat sprites are left out');
  }
  for (const p of problems) log(`space: ${p}`);
  failed += problems.length;
  log(`space: ${written.size} models${stillProblems.length === 0 ? ', the stills' : ''}${values.images ? ` and ${sheets} sprite sheets` : ''} in ${out}${failed > 0 ? `, ${failed} failed` : ''}`);
  return failed > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSpace(process.argv.slice(2), line => console.log(line)).then(
    code => { process.exitCode = code; },
    (e: unknown) => { console.log(`space: ${(e as Error).message}`); process.exitCode = 1; },
  );
}
