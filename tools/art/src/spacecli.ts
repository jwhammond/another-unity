// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { COMBAT_STILLS, SPRITE_INDEX, type CombatSpriteSheet } from '../../../engine/src/view/combat/files';
import { parsePack } from '../../../engine/src/view/indexed';
import { artCache, type ArtCache } from './cache';
import { decodePng, encodePng, type Rgba } from './image';
import { colourPicture, pagesAtlas, spaceOriginal } from './spaceconsole';
import { parseArgs } from 'node:util';
import { parseCombat } from '../../../engine/src/content/parse';
import { withGenerator } from './comfy';
import type { Generator } from './generator';
import { loadModels } from './models';
import { parseRecipe, type SpaceTexturesRecipe, type SpaceUpscalesRecipe } from './recipe';
import { checkPins, choiceFor } from './run';
import { modelsFor } from './select';
import { spaceInventory } from './spaceinventory';
import { publishSpaceArt } from './spacepublish';
import { checkSilhouettes, gatherSpaceArt, makeTextures, makeUpscales, missingParts, staleParts, upscalesSource } from './spacerun';

/**
 * `npm run art:space -- <command>` (Plan 30 R2): combat's art, beside `npm run art` (tools/art/src/cli.ts), which it doesn't change.
 * `originals` decodes the console and the pages' atlas into the cache; `textures`, `upscales`, `check` and `publish` are spacerun.ts'.
 */
export const SPACE_USAGE = 'usage: art:space originals | art:space textures [--only <name>]… (the flag repeated) [--fresh] | art:space upscales | art:space check | art:space publish';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export interface SpaceCliDeps {
  game: string; cache: ArtCache; env: NodeJS.ProcessEnv;
  /** Test hook: the generator a run uses (default: comfy.ts withGenerator: COMFY_URL's ComfyUI, which must be on the local network, or this machine's under the GPU lock). */
  withGen?: <T>(use: (g: Generator) => Promise<T>) => Promise<T>;
}

/** The effects' sheets of the game's space build (its sprite index), as the upscales take them. */
function effectSheets(game: string): Map<string, { picture: Rgba; frames: number; columns: number; cell: [number, number] }> {
  const index = JSON.parse(readFileSync(join(game, SPRITE_INDEX), 'utf8')) as Record<string, CombatSpriteSheet>;
  const sheets = new Map<string, { picture: Rgba; frames: number; columns: number; cell: [number, number] }>();
  for (const [f, s] of Object.entries(index)) sheets.set(f, { picture: decodePng(new Uint8Array(readFileSync(join(game, s.image)))), frames: s.frames, columns: s.columns, cell: s.cell });
  return sheets;
}

export async function runSpaceArt(argv: string[], log: (line: string) => void, deps: SpaceCliDeps = { game: join(REPO, 'games', 'unity'), cache: artCache(), env: process.env }): Promise<number> {
  const [cmd] = argv;
  if (cmd === 'originals') {
    const pack = join(deps.game, COMBAT_STILLS.console), palette = join(deps.game, COMBAT_STILLS.palette);
    if (!existsSync(pack) || !existsSync(palette)) {
      log(`art:space: no ${COMBAT_STILLS.console} or ${COMBAT_STILLS.palette} in ${deps.game}: build the game's space first (npm run unity:build)`);
      return 1;
    }
    const [plate, ...images] = parsePack(new Uint8Array(readFileSync(pack)));
    const rgb = new Uint8Array(readFileSync(palette));
    const out = spaceOriginal(deps.cache, 'console');
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, encodePng(colourPicture(plate!, rgb)));
    const { atlas, places } = pagesAtlas(images, rgb);
    await writeFile(spaceOriginal(deps.cache, 'pages'), encodePng(atlas));
    await writeFile(join(dirname(out), 'pages.json'), JSON.stringify(places.map(p => ({ ...p, width: images[p.image]!.width, height: images[p.image]!.height }))));
    log(`art:space: the console and the pages' atlas (${places.length} pictures) in ${dirname(out)}`);
    return 0;
  }
  if (cmd !== 'textures' && cmd !== 'upscales' && cmd !== 'check' && cmd !== 'publish') {
    log(SPACE_USAGE);
    return 2;
  }
  const { values } = parseArgs({ args: argv.slice(1), options: { only: { type: 'string', multiple: true }, fresh: { type: 'boolean' } } });
  if (cmd === 'upscales' || cmd === 'publish') {
    const needed = [COMBAT_STILLS.console, COMBAT_STILLS.palette, SPRITE_INDEX].filter(f => !existsSync(join(deps.game, f)));
    if (needed.length > 0) {
      log(`art:space: no ${needed.join(' or ')} in ${deps.game}: build the game's space first (npm run unity:build)`);
      return 1;
    }
  }
  if (cmd === 'publish') {
    // (every part it needs has a run, said before anything is read or written: art.space is replaced wholesale, so a part left out would drop its keys)
    const absent = await missingParts(deps.cache);
    if (absent.length > 0) {
      for (const a of absent) log(`art:space: not published: no run of ${a}`);
      return 1;
    }
  }
  const combatFile = join(deps.game, 'combat.yaml');
  if (!existsSync(combatFile)) {
    log(`art:space: no ${combatFile}: lift the game first (npm run unity:build)`);
    return 1;
  }
  const combat = parseCombat(await readFile(combatFile, 'utf8'));
  const inv = await spaceInventory(combat, async url => (existsSync(join(deps.game, url)) ? new Uint8Array(await readFile(join(deps.game, url))) : null));
  if (inv.missing.length > 0) log(`art:space: the space build lacks ${inv.missing.length} models (${inv.missing.slice(0, 3).join(', ')}…): their textures are left out`);
  if (cmd === 'check') {
    const r = await checkSilhouettes(inv.models, deps.cache);
    for (const f of r.failed) log(`art:space: ${f.model}'s silhouette differs: ${JSON.stringify(f.differ)}`);
    log(`art:space: silhouettes ${r.ok ? 'identical' : 'DIFFER'} for ${inv.models.size - r.failed.length} of ${inv.models.size} models`);
    return r.ok ? 0 : 1;
  }
  const file = loadModels(readFileSync(join(REPO, 'art', 'models.yaml'), 'utf8'));
  const gen = deps.withGen ?? (<T>(use: (g: Generator) => Promise<T>) => withGenerator(deps.cache, use, {}, deps.env));
  if (cmd === 'textures') {
    const path = join(REPO, 'art', 'recipes', 'space.textures.yaml');
    const text = readFileSync(path, 'utf8');
    const r = parseRecipe(text, path) as SpaceTexturesRecipe;
    const choice = choiceFor(r, file);
    const counts = await gen(async g => {
      await checkPins(choice, { generator: g, models: file, cache: deps.cache }, ['checkpoint', 'vae', 'lora', 'upscaler']);
      return makeTextures(r, text, inv.textures, { cache: deps.cache, generator: g, models: modelsFor(file, choice), log }, { only: values.only, fresh: values.fresh });
    });
    log(`art:space: textures: ${counts.repainted} repainted, ${counts.upscaled} the upscale, ${counts.skipped} already made`);
    return 0;
  }
  const [, ...pictures] = parsePack(new Uint8Array(readFileSync(join(deps.game, COMBAT_STILLS.console))));
  const palette = new Uint8Array(readFileSync(join(deps.game, COMBAT_STILLS.palette)));
  if (cmd === 'upscales') {
    const path = join(REPO, 'art', 'recipes', 'space.upscales.yaml');
    const r = parseRecipe(readFileSync(path, 'utf8'), path) as SpaceUpscalesRecipe;
    const sheets = effectSheets(deps.game);
    const choice = choiceFor(r, file);
    const dir = await gen(async g => {
      await checkPins(choice, { generator: g, models: file, cache: deps.cache }, ['upscaler']);
      return makeUpscales(r, sheets, pictures, palette, { cache: deps.cache, generator: g, models: modelsFor(file, choice), log });
    });
    log(`art:space: the upscales in ${dir}`);
    return 0;
  }
  // publish: no run made from an original that has since changed (a re-lift or a rebuild), then the silhouettes; nothing is published while one differs (Plan 30 R10, R14)
  const stale = await staleParts(deps.cache, inv.textures, upscalesSource(effectSheets(deps.game), pictures, palette));
  if (stale.length > 0) {
    for (const a of stale) log(`art:space: not published: ${a}`);
    return 1;
  }
  const check = await checkSilhouettes(inv.models, deps.cache);
  if (!check.ok) {
    log(`art:space: not published: ${check.failed.map(f => f.model).join(', ')} differ in silhouette (npm run art:space -- check)`);
    return 1;
  }
  const plate = parseRecipe(readFileSync(join(REPO, 'art', 'recipes', 'plate.tactical.yaml'), 'utf8'), join(REPO, 'art', 'recipes', 'plate.tactical.yaml'));
  const areas = 'areas' in plate ? (plate.areas as Record<string, [number, number, number, number]>) : {};
  const written = await publishSpaceArt(deps.game, await gatherSpaceArt(deps.cache, inv.textures, pictures, areas));
  log(`art:space: published ${written.length} files under ${join(deps.game, 'art', 'space')} and art.space in presentation.yaml`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSpaceArt(process.argv.slice(2), line => console.log(line)).then(code => { process.exitCode = code; }, (e: unknown) => { console.log(`art:space: ${(e as Error).message}`); process.exitCode = 1; });
}
