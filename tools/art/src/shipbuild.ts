// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { BLENDER_SCRIPTS, inspectGlb, runBlender } from './blender';
import type { ArtCache } from './cache';
import type { SpawnLike } from './comfy';
import { decodePng, encodePng } from './image';
import type { ShipRecipe } from './recipe';
import { alignIds, alignOverlay, type ItemFit } from './shipalign';
import { bridgeLayout, ID_BACKGROUND, type ShipLayout, type ShipYaml } from './shiplayout';
import { writeSheet } from './sheet';

const here = dirname(fileURLToPath(import.meta.url));
const sha = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');

export interface ShipMeta {
  recipe: string;
  recipeSha256: string;
  blender: string;
  script: string;
  scriptSha256: string;
  /** The sha256s of the lifted inputs, so a rebuild from other data is a different run. */
  inputs: { shipYaml: string; original: string; /** albedo sha256 of each material bake used */ materials?: Record<string, string> };
  paramsSha256: string;
  seconds: number;
  camera: ShipLayout['camera'];
  fit: { rms: number; residuals: number[] };
  align: ItemFit[];
  outputs: Record<string, { file: string; sha256: string }>;
  checks: { nodes: number; cameras: number; meshes: number; itemNodes: number };
}

export interface ShipDeps {
  spawnFn?: SpawnLike;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  scriptsDir?: string;
  /** The images export (IMAGES_DIR): the bridge sprites' own positions come from its sprite.json files. Default: $IMAGES_DIR; without it the objects' x, y. */
  imagesDir?: string;
  /** games/unity, where ship.yaml is. Default: the repo's. */
  gameDir?: string;
}

/** The decoded original a station is traced from (art cache, originals/ship). */
const ORIGINAL: Record<ShipRecipe['station'], string> = { bridge: 'bridge', transporter: 'transp', astrogation: 'astropnl', computer: 'compupnl' };

/** Each bridge sprite file's first position block (where the original draws it), from the images export; none without one. */
export async function spritePositions(ship: ShipYaml, imagesDir: string | undefined): Promise<Record<string, [number, number]>> {
  const out: Record<string, [number, number]> = {};
  if (!imagesDir) return out;
  for (const o of ship.bridge.objects) {
    try {
      const json = JSON.parse(await readFile(join(imagesDir, 'images', 'sprites', o.file, 'sprite.json'), 'utf8')) as { entries: { type: string; x?: number; y?: number }[] };
      const pos = json.entries.find(e => e.type === 'position');
      if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') out[o.file] = [pos.x, pos.y];
    } catch {
      // (no sprite file there: the object's own x, y)
    }
  }
  return out;
}

/**
 * R2/R3: lays out the set from the lifted ship.yaml, has Blender build it, and measures each item's ID-pass silhouette against its
 * rectangle. Writes <work>/<id>/<stamp>/{id.glb, id.id.png, id.solid.png, align.json, align-overlay.png, sheet.png, meta.json} and
 * last.json. A failing item keeps the files but throws, and isn't the last good run.
 */
export async function runShipRecipe(recipe: ShipRecipe, recipeText: string, cache: ArtCache, deps: ShipDeps = {}): Promise<{ dir: string; meta: ShipMeta; fits: ItemFit[] }> {
  const gameDir = deps.gameDir ?? join(here, '..', '..', '..', 'games', 'unity');
  const shipText = await readFile(join(gameDir, 'ship.yaml'), 'utf8');
  const shipYaml = parseYaml(shipText) as ShipYaml;
  const layout = bridgeLayout(recipe, shipYaml, await spritePositions(shipYaml, deps.imagesDir ?? process.env.IMAGES_DIR));
  const originalFile = join(cache.root, 'originals', 'ship', `${ORIGINAL[recipe.station]}.png`);
  let originalBytes: Uint8Array;
  try {
    originalBytes = new Uint8Array(await readFile(originalFile));
  } catch {
    throw new Error(`no decoded original ${originalFile}: run art ship originals first`);
  }
  const script = resolve(deps.scriptsDir ?? BLENDER_SCRIPTS, recipe.script);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(cache.work, recipe.id, stamp);
  const glb = join(dir, `${recipe.id}.glb`);
  await mkdir(dir, { recursive: true });
  // R5: each material's last bake, by recipe id, handed to the script as --textures
  const textures: { id: string; albedo: string; mr: string; normal: string }[] = [];
  const materialShas: Record<string, string> = {};
  for (const id of recipe.materials) {
    let last: { meta: { outputs: Record<string, { file: string; sha256: string }> } };
    try {
      last = JSON.parse(await readFile(join(cache.work, id, 'last.json'), 'utf8'));
    } catch {
      throw new Error(`material recipe "${id}" has no bake (${join(cache.work, id, 'last.json')}): art run art/recipes/${id}.yaml first`);
    }
    const o = last.meta.outputs;
    textures.push({ id: id.slice(4), albedo: o.albedo!.file, mr: o.mr!.file, normal: o.normal!.file });
    materialShas[id] = o.albedo!.sha256;
  }
  const r = await runBlender(script, glb, layout as unknown as Record<string, unknown>, { ...deps, timeoutMs: 900_000, extraArgs: textures.length ? ['--textures', JSON.stringify(textures)] : [] });
  const idFile = join(dir, `${recipe.id}.id.png`);
  const solidFile = join(dir, `${recipe.id}.solid.png`);
  const lookFile = join(dir, `${recipe.id}.look.png`);
  const idBytes = new Uint8Array(await readFile(idFile));
  const id = decodePng(idBytes);
  const checked = layout.items.filter(i => i.quad).map(i => ({ index: i.index, action: i.action, rect: i.rect, colour: i.colour }));
  const fits = alignIds(id, checked);
  const original = decodePng(originalBytes);
  const overlayFile = join(dir, 'align-overlay.png');
  await writeFile(overlayFile, encodePng(alignOverlay(original, id, checked, fits)));
  await writeSheet(
    [[{ png: originalBytes, caption: 'game original' }, { png: new Uint8Array(await readFile(lookFile)), caption: 'new set (Blender, Cycles)' }, { png: new Uint8Array(await readFile(overlayFile)), caption: 'overlay: ID edges cyan, rects yellow, failures red' }]],
    join(dir, 'sheet'),
    { cell: [640, 480] },
  );
  await writeFile(join(dir, 'align.json'), `${JSON.stringify({ rms: layout.fit.rms, residuals: layout.fit.residuals, camera: layout.camera, fits }, null, 2)}\n`);
  const glbBytes = new Uint8Array(await readFile(glb));
  const g = await inspectGlb(glbBytes);
  const outputs: ShipMeta['outputs'] = {};
  for (const [k, f] of Object.entries({ glb, id: idFile, solid: solidFile, look: lookFile, overlay: overlayFile, sheet: join(dir, 'sheet.png') })) outputs[k] = { file: f, sha256: sha(new Uint8Array(await readFile(f))) };
  const meta: ShipMeta = {
    recipe: recipe.id,
    recipeSha256: sha(recipeText),
    blender: r.version,
    script: recipe.script,
    scriptSha256: sha(await readFile(script)),
    inputs: { shipYaml: sha(shipText), original: sha(originalBytes), materials: materialShas },
    paramsSha256: sha(JSON.stringify(layout)),
    seconds: r.seconds,
    camera: layout.camera,
    fit: layout.fit,
    align: fits,
    outputs,
    checks: { nodes: g.nodes.length, cameras: g.cameras, meshes: g.meshes, itemNodes: g.nodes.filter(n => n.name.startsWith('item:')).length },
  };
  await writeFile(join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  const bad = fits.filter(f => !f.pass);
  if (bad.length > 0) throw new Error(`${recipe.id}: ${bad.length} item(s) fail the alignment check (${bad.map(f => `${f.index}: coverage ${f.coverage.toFixed(2)}, spill ${f.spill.toFixed(2)}`).join('; ')}); see ${overlayFile}`);
  await writeFile(join(cache.work, recipe.id, 'last.json'), `${JSON.stringify({ dir, meta }, null, 2)}\n`);
  return { dir, meta, fits };
}

export { ID_BACKGROUND };
