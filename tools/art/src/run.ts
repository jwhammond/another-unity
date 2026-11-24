// SPDX-License-Identifier: GPL-3.0-or-later
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { ArtCache } from './cache';
import type { Generator } from './generator';
import { decodePng, encodePng, meanAbsDiff } from './image';
import { sha256File, type ModelsFile } from './models';
import { originalBackground } from './originals';
import { parse as parseYaml } from 'yaml';
import { existsSync } from 'node:fs';
import { plateChecks } from './poststep';
import { keepComposite, shipInputs, type ShipInputs, type ShipLift } from './shipscreen';
import { shipOriginal } from './shiporig';
import { pagesPictures, spaceOriginal } from './spaceconsole';
import { hailOriginal } from './hail';
import { adminOriginalFile } from './admin';
import { shipGameZip } from './shipsprite';
import { edgePoints, EDGE_POINTS, type CheckPoint } from './points';
import { plateStation, PLATE_STEMS, type Recipe, type Rect, type RepaintRecipe } from './recipe';
import { repaint, upscaleOnly, type ControlReport, type ReferenceReport, type ResolvedReference } from './repaint';
import { refFile } from './refs';
import { denoiseMask, maskToRgba, MASK_DEFAULTS, type MaskGeometry } from './maskdenoise';
import { loadScreenInputs } from './screen';
import { makeTexture, SeamError, type TextureResult } from './texture';
import { defaultChoice, modelsFor, type Choice } from './select';

export interface RunMeta {
  recipe: string;
  recipeSha256: string;
  models: Record<string, { file: string; sha256: string }>;
  comfyui: string;
  torch: string;
  flags: string[];
  seconds: number;
  outputs: Record<string, { file: string; sha256: string; width: number; height: number }>;
  checks: Record<string, unknown>;
  /** Each ControlNet's window (relative to the sampled steps), what ComfyUI was given, and the fraction of steps it acted on. */
  controls?: ControlReport[];
  /** Reference crops that fed the run, by id: sha256. Verify refuses a baseline made from different ones (M4). */
  references?: Record<string, string>;
  /** Each IP-Adapter reference's model, crops, weight and window (relative, and the absolute percents ComfyUI was given). */
  referenceUse?: ReferenceReport[];
  /** The masked denoise's settings (the mask itself is outputs.mask). */
  mask?: Record<string, number>;
  /** The de-dither pre-step's settings (the de-dithered original is outputs.dedithered). */
  dedither?: Record<string, number | string>;
  /** A ship source: the sha256 of the original's PNG, and the kept interface rectangles (original pixels, [x, y, w, h]). */
  source?: string;
  keep?: Rect[];
  /** The pages' atlas (Plan 30 R5): the sha256 of the pages.json it was laid out by, so publish can refuse a run the layout has moved past. */
  layout?: string;
  /** An upscale-only room plate (recipe `repaint: false`): the de-dithered upscale, no diffusion pass. Only such a plate may have skipped the alignment check. */
  upscaleOnly?: true;
}
export interface RunDeps {
  generator: Generator;
  models: ModelsFile;
  cache: ArtCache;
  imagesDir?: string;
  /** games/unity, where the lifted rooms and screens are (the alignment check's points). Default: the repo's. */
  gameDir?: string;
  /** The game's folder with STTNG.ZIP, for an admin source (decoded at run time). Default: GAMEDATA_DIR; unset, the one decoded before. */
  gameData?: string;
  /** Test hook: games/unity/ship.yaml's content for a ship source (with the transporter's pads). Default: the file, read at run time. */
  shipLift?: () => Promise<ShipLift>;
  /** Test hook: the hotspot rects and walk polygons for the denoise mask. Default: the lifted room and screen of the recipe's id. */
  maskGeometry?: (recipe: Recipe) => Promise<MaskGeometry>;
  /** Test hook: the alignment check's points. Default: the lifted room and screen of the recipe's id. */
  alignPoints?: (recipe: Recipe) => Promise<CheckPoint[]>;
  now?: () => number;
  /** Where the reference crops are (`crops/<id>.png`). Default: <cache>/refs. */
  refsDir?: string;
  /** Test hooks. Defaults: sha256 of the file, `git rev-parse HEAD` in the cache's ComfyUI, tools/art/setup/pins.env. */
  hash?: (path: string) => Promise<string>;
  comfyCommit?: () => Promise<string>;
  /** Test hooks (M5). `git status --porcelain` of a checkout, and the HEAD of the aux or IP-Adapter custom node. With `comfyCommit` set and these not, they are skipped. */
  dirty?: (dir: string) => Promise<string>;
  auxCommit?: (which: 'aux' | 'ipadapter') => Promise<string>;
  pinsFile?: string;
  /** The ComfyUI flags the server was started with. Default: `selected.comfyFlags`. */
  flags?: string[];
  /** True when the server is COMFY_URL's, not ours: its commit can't be proved, only its version, and verify refuses it. */
  external?: boolean;
  /** Where a warning goes (the CLI's log). */
  warn?: (line: string) => void;
}
export type PinDeps = Pick<RunDeps, 'generator' | 'models' | 'cache' | 'hash' | 'comfyCommit' | 'dirty' | 'auxCommit' | 'pinsFile' | 'external' | 'warn'>;

const here = dirname(fileURLToPath(import.meta.url));
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** The model keys a repaint recipe uses: the recipe's own, else `selected`'s. */
export function choiceFor(recipe: Extract<Recipe, { kind: 'repaint' | 'texture' | 'card' | 'bridgecrew' | 'spacetex' | 'spaceup' }>, file: ModelsFile): Choice {
  const c: Choice = { ...defaultChoice(file) };
  for (const [k, v] of Object.entries(recipe.models)) if (v !== undefined) (c as unknown as Record<string, string>)[k] = v;
  return c;
}

async function gitCommit(cache: ArtCache): Promise<string> {
  return (await promisify(execFile)('git', ['-C', cache.comfy, 'rev-parse', 'HEAD'])).stdout.trim();
}

const NODES = { aux: 'comfyui_controlnet_aux', ipadapter: 'ComfyUI_IPAdapter_plus' } as const;
const nodeDir = (cache: ArtCache, which: keyof typeof NODES): string => join(cache.comfy, 'custom_nodes', NODES[which]);
async function gitStatus(dir: string): Promise<string> {
  return (await promisify(execFile)('git', ['-C', dir, 'status', '--porcelain'])).stdout.trim();
}

/** Refuses (before anything is generated) a model whose file hash isn't models.yaml's, or a ComfyUI not at the pinned commit. */
export async function checkPins(choice: Choice, deps: PinDeps, only?: (keyof Choice)[]): Promise<Record<string, { file: string; sha256: string }>> {
  const hash = deps.hash ?? sha256File;
  const used: Record<string, { file: string; sha256: string }> = {};
  const all = ['checkpoint', 'vae', 'lora', 'depth', 'lineart', 'depthAnnotator', 'lineartAnnotator', 'upscaler', 'ipadapterStyle', 'ipadapterFace', 'clipVision'] as const;
  const keys = new Set(all.filter(k => !only || only.includes(k)).map(k => choice[k]));
  for (const key of keys) {
    if (!key) continue;
    const m = deps.models.models[key];
    if (!m) throw new Error(`no model "${key}" in art/models.yaml`);
    if (m.sha256 === 'pending') throw new Error(`model "${key}" has no recorded sha256 (art fetch --record)`);
    const actual = await hash(join(deps.cache.models, m.file));
    if (actual !== m.sha256) throw new Error(`model "${key}": ${m.file} has sha256 ${actual}, art/models.yaml says ${m.sha256}`);
    used[key] = { file: m.file, sha256: actual };
  }
  const pins = await readFile(deps.pinsFile ?? join(here, '..', 'setup', 'pins.env'), 'utf8');
  if (deps.external) {
    // COMFY_URL: the checkout behind it is unknown; the version it reports is the most that can be checked
    const tag = /^COMFYUI_TAG=v?(.*)$/m.exec(pins)?.[1];
    const version = (await deps.generator.info()).comfyui;
    if (version.replace(/^v/, '') !== tag) throw new Error(`the ComfyUI at COMFY_URL reports version ${version}, pins.env says ${tag}`);
    deps.warn?.(`COMFY_URL: ComfyUI ${version} matches pins.env's tag, but its commit, flags and offline mode can't be proved`);
    return used;
  }
  const want = /^COMFYUI_COMMIT=(.*)$/m.exec(pins)?.[1];
  const have = await (deps.comfyCommit ?? (() => gitCommit(deps.cache)))();
  if (want !== have) throw new Error(`ComfyUI is at ${have}, pins.env says ${want}`);
  // M5: the custom nodes are code too, and a checkout with local edits is not the pinned code
  const real = !deps.comfyCommit;
  const auxCommit = deps.auxCommit ?? (real ? async (w: 'aux' | 'ipadapter') => gitCommit({ comfy: nodeDir(deps.cache, w) } as ArtCache) : undefined);
  const dirty = deps.dirty ?? (real ? gitStatus : undefined);
  const nodes = [
    ['aux', 'the controlnet_aux custom node', /^AUX_COMMIT=(.*)$/m.exec(pins)?.[1]],
    ['ipadapter', 'the IP-Adapter custom node', /^IPADAPTER_COMMIT=(.*)$/m.exec(pins)?.[1]],
  ] as const;
  for (const [which, label, pinned] of nodes) {
    if (!pinned || !auxCommit) continue;
    const got = await auxCommit(which);
    if (got !== pinned) throw new Error(`${label} (${which === 'aux' ? 'aux' : 'IP-Adapter'}) is at ${got}, pins.env says ${pinned}`);
  }
  if (dirty) {
    const dirs: [string, string][] = [['ComfyUI', deps.cache.comfy]];
    for (const [which, label, pinned] of nodes) if (pinned) dirs.push([which === 'aux' ? `${label} (aux)` : `${label} (IP-Adapter)`, nodeDir(deps.cache, which)]);
    for (const [label, dir] of dirs) {
      const changes = await dirty(dir);
      if (changes) throw new Error(`${label} has uncommitted changes in ${dir}: ${changes.split('\n').slice(0, 3).join('; ')}`);
    }
  }
  return used;
}

/** R12: the blend at a kept rectangle's edge, in original pixels. */
const KEEP_FEATHER = 2;

/** games/unity/ship.yaml, with the transporter's pads from the export when the lift carries them. */
export async function readShipLift(gameDir: string): Promise<ShipLift> {
  const file = join(gameDir, 'ship.yaml');
  if (!existsSync(file)) throw new Error(`no lifted ship at ${file}: run npm run lift (docs/lift.md)`);
  return parseYaml(await readFile(file, 'utf8')) as ShipLift;
}

/** `updateLast: false` (verify's re-run) leaves last.json where it is. */
export interface RunOpts {
  updateLast?: boolean;
}

/** Runs a recipe into <work>/<id>/<run-stamp>/ and updates <work>/<id>/last.json. */
export async function runRecipe(any: Recipe, recipeText: string, deps: RunDeps, opts: RunOpts = {}): Promise<{ dir: string; meta: RunMeta }> {
  if (any.kind === 'texture') return runTexture(any, recipeText, deps, opts);
  if (any.kind !== 'repaint') throw new Error(`runRecipe is for repaint and texture recipes; ${any.id} is a ${any.kind} recipe`);
  const recipe = any;
  const now = deps.now ?? Date.now;
  const choice = choiceFor(recipe, deps.models);
  // the IP-Adapter weights are checked only when the recipe uses them
  const uponly = recipe.repaint === false;
  const need = new Set<string>(recipe.reference.map(r => (r.model === 'style' ? 'ipadapterStyle' : 'ipadapterFace')));
  if (need.size > 0) need.add('clipVision');
  const core = (uponly ? ['depthAnnotator', 'upscaler'] : ['checkpoint', 'vae', 'lora', 'depth', 'lineart', 'depthAnnotator', 'lineartAnnotator', 'upscaler']) as (keyof Choice)[];
  const models = await checkPins(choice, deps, [...core, ...(need as Set<keyof Choice>)]);
  const ship = 'ship' in recipe.source ? recipe.source.ship : undefined;
  const hail = 'hail' in recipe.source ? recipe.source.hail : undefined;
  const space = 'space' in recipe.source ? recipe.source.space : undefined;
  const admin = 'admin' in recipe.source ? recipe.source.admin : undefined;
  if (!ship && !hail && !space && !admin && !deps.imagesDir) throw new Error('a repaint recipe needs the exported originals (IMAGES_DIR)');
  const t0 = now();
  const stamp = new Date(t0).toISOString().replace(/[:.]/g, '-');
  let original: Uint8Array;
  if (ship) {
    const file = shipOriginal(deps.cache, ship);
    if (!existsSync(file)) throw new Error(`${recipe.id}: no decoded ship original at ${file}: run art ship originals`);
    original = new Uint8Array(readFileSync(file));
  } else if (hail) {
    const file = hailOriginal(deps.cache, hail);
    if (!existsSync(file)) throw new Error(`${recipe.id}: no decoded hail frame at ${file}: run art ship originals`);
    original = new Uint8Array(readFileSync(file));
  } else if (space) {
    // (Plan 30 R3, R5: tactical's console or the pages' atlas, decoded by art:space originals)
    const file = spaceOriginal(deps.cache, space);
    if (!existsSync(file)) throw new Error(`${recipe.id}: no decoded ${space} at ${file}: run npm run art:space -- originals`);
    original = new Uint8Array(readFileSync(file));
  } else if (admin) {
    // (Plan 32 Task 12: the admin console's body or the F1 screen, from the game zip)
    const gameData = deps.gameData ?? process.env.GAMEDATA_DIR;
    original = await adminOriginalFile(deps.cache, admin, deps.gameDir ?? join(here, '..', '..', '..', 'games', 'unity'), gameData ? shipGameZip(gameData) : undefined);
  } else original = await originalBackground(deps.imagesDir!, (recipe.source as { background: string }).background);
  // R13: a ship source's points and mask geometry come from the lift (read now, never copied into the recipe) and the original
  const gameDir = deps.gameDir ?? join(here, '..', '..', '..', 'games', 'unity');
  let shipIn: ShipInputs | undefined;
  if (ship) {
    const station = plateStation(recipe);
    if (!station || PLATE_STEMS[station] !== ship) throw new Error(`${recipe.id}: a ship source needs a plate.<station> id`);
    const lift = deps.shipLift ? await deps.shipLift() : await readShipLift(gameDir);
    shipIn = shipInputs(station, recipe, lift, decodePng(original));
  }
  if (admin) shipIn = shipInputs('admin', recipe, null, decodePng(original));
  if (space) shipIn = shipInputs('tactical', recipe, null, decodePng(original), space === 'pages' ? await pagesPictures(deps.cache) : []);
  const m = modelsFor(deps.models, choice);
  // reference crops: read from the cache and hashed, so meta.json records what fed the run
  const references: Record<string, string> = {};
  const refs: ResolvedReference[] = recipe.reference.map(spec => ({
    spec,
    images: spec.refs.map(id => {
      const bytes = new Uint8Array(readFileSync(refFile(deps.refsDir ?? join(deps.cache.root, 'refs'), id)));
      references[id] = sha(bytes);
      return { id, bytes };
    }),
  }));
  // masked denoise: the soft mask is made from the original and the lifted room, and recorded with the run
  let maskPng: Uint8Array | undefined;
  if (recipe.mask && !uponly) {
    const geom = deps.maskGeometry ? await deps.maskGeometry(recipe) : shipIn ? shipIn.geometry : hail ? { rects: [], polygons: [], keep: [] } : (await loadScreenInputs(gameDir, recipe.id)).geometry;
    maskPng = encodePng(maskToRgba(denoiseMask(decodePng(original), geom, recipe.size.work, { ...MASK_DEFAULTS, ...recipe.mask, open: 1 })));
  }
  const r = uponly
    ? await upscaleOnly(recipe, original, deps.generator, m, stamp).then(u => ({ ...u, work: undefined, repainted: undefined, controls: [] as ControlReport[], references: [] as ReferenceReport[] }))
    : await repaint(recipe, original, deps.generator, m, stamp, refs, maskPng);
  // R12: the kept interface is the run's own upscale of the original, blended over 2 original pixels at each rectangle's edge
  const repaintPlate = r.plate;
  if (recipe.keep.length > 0) r.plate = encodePng(keepComposite(decodePng(r.plate), decodePng(r.keepUpscaled ?? r.upscaled), recipe.keep, KEEP_FEATHER, decodePng(original).width));
  const info = await deps.generator.info();

  const dir = join(deps.cache.work, recipe.id, stamp);
  await mkdir(dir, { recursive: true });
  const outputs: RunMeta['outputs'] = {};
  const files: Record<string, Uint8Array | undefined> = { plate: r.plate, upscaled: r.upscaled, work: r.work, repainted: r.repainted, ...(recipe.keep.length > 0 ? { repaint: repaintPlate } : {}), depth: r.depth, mask: maskPng, dedithered: r.dedithered, keepUpscaled: r.keepUpscaled };
  for (const [name, bytes] of Object.entries(files)) {
    if (!bytes) continue;
    const file = join(dir, `${name}.png`);
    await writeFile(file, bytes);
    const d = decodePng(bytes);
    outputs[name] = { file, sha256: sha(bytes), width: d.width, height: d.height };
  }
  const originalImg = decodePng(original);
  const { checks, alignReport } = await plateChecks(recipe, originalImg, dir, outputs, async () => (deps.alignPoints ? await deps.alignPoints(recipe) : shipIn ? shipIn.points : hail ? edgePoints(originalImg, EDGE_POINTS).map(p => ({ x: p.x, y: p.y, source: `${p.label} ${p.x},${p.y}` })) : (await loadScreenInputs(gameDir, recipe.id, originalImg)).points), deps.warn);
  const meta: RunMeta = {
    recipe: recipe.id,
    recipeSha256: createHash('sha256').update(recipeText).digest('hex'),
    models,
    comfyui: info.comfyui,
    torch: info.torch,
    flags: deps.flags ?? deps.models.selected?.comfyFlags ?? [],
    seconds: (now() - t0) / 1000,
    outputs,
    checks,
    controls: r.controls,
    ...(recipe.mask && !uponly ? { mask: recipe.mask } : {}),
    ...(recipe.dedither ? { dedither: recipe.dedither } : {}),
    ...(recipe.repaint === false ? { upscaleOnly: true as const } : {}),
    ...(ship || space || admin ? { source: sha(original), keep: recipe.keep } : {}),
    ...(space === 'pages' ? { layout: sha(new Uint8Array(readFileSync(join(dirname(spaceOriginal(deps.cache, 'pages')), 'pages.json')))) } : {}),
    ...(refs.length > 0 ? { references, referenceUse: r.references } : {}),
  };
  await writeFile(join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  // a misaligned plate is kept in its run directory for a look, but isn't the last good run
  if (alignReport && !alignReport.ok) throw new Error(`${recipe.id}: the plate is misaligned (${alignReport.why}); see ${join(dir, 'align-overlay.png')}`);
  if (opts.updateLast !== false) await writeFile(join(deps.cache.work, recipe.id, 'last.json'), `${JSON.stringify({ dir, meta }, null, 2)}\n`);
  return { dir, meta };
}

/** A texture recipe: albedo, normal map and 3x3 preview into <work>/<id>/<run-stamp>/. A visible seam keeps the files but isn't the last good run. */
async function runTexture(recipe: Extract<Recipe, { kind: 'texture' }>, recipeText: string, deps: RunDeps, opts: RunOpts): Promise<{ dir: string; meta: RunMeta }> {
  const now = deps.now ?? Date.now;
  const choice = choiceFor(recipe, deps.models);
  const models = await checkPins(choice, deps, ['checkpoint', 'vae', 'lora']);
  const t0 = now();
  let result: TextureResult;
  let seamError: SeamError | undefined;
  try {
    result = await makeTexture(recipe, deps.generator, modelsFor(deps.models, choice));
  } catch (e) {
    if (!(e instanceof SeamError)) throw e;
    seamError = e;
    result = e.result;
  }
  const info = await deps.generator.info();
  const stamp = new Date(t0).toISOString().replace(/[:.]/g, '-');
  const dir = join(deps.cache.work, recipe.id, stamp);
  await mkdir(dir, { recursive: true });
  const outputs: RunMeta['outputs'] = {};
  // albedo first: blender recipes take a texture recipe's first output
  const files: [string, Uint8Array | undefined][] = [
    ['albedo', result.albedo],
    ['normal', recipe.post.some(p => 'normal' in p) ? result.normal : undefined],
    ['preview', recipe.post.some(p => 'tilePreview' in p) ? result.preview : undefined],
  ];
  for (const [name, bytes] of files) {
    if (!bytes) continue;
    const file = join(dir, `${name}.png`);
    await writeFile(file, bytes);
    const d = decodePng(bytes);
    outputs[name] = { file, sha256: sha(bytes), width: d.width, height: d.height };
  }
  const meta: RunMeta = {
    recipe: recipe.id,
    recipeSha256: createHash('sha256').update(recipeText).digest('hex'),
    models,
    comfyui: info.comfyui,
    torch: info.torch,
    flags: deps.flags ?? deps.models.selected?.comfyFlags ?? [],
    seconds: (now() - t0) / 1000,
    outputs,
    checks: { seam: { before: result.seamBefore, after: result.seamAfter, coarse: result.seamCoarse, limit: 1.5 } },
  };
  await writeFile(join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  if (seamError) throw new Error(`${seamError.message}; see ${dir}`);
  if (opts.updateLast !== false) await writeFile(join(deps.cache.work, recipe.id, 'last.json'), `${JSON.stringify({ dir, meta }, null, 2)}\n`);
  return { dir, meta };
}

/** Re-runs and compares the plate with work/<id>/last.json's: passes at a mean difference of at most 1 level of 255 (R5). */
export async function verifyRecipe(recipe: Recipe, recipeText: string, deps: RunDeps): Promise<{ ok: boolean; meanAbsDiff: number; detail: string }> {
  if (recipe.kind !== 'repaint' && recipe.kind !== 'texture') throw new Error(`verify is for repaint and texture recipes; ${recipe.id} is a ${recipe.kind} recipe`);
  let last: { meta: RunMeta };
  try {
    last = JSON.parse(await readFile(join(deps.cache.work, recipe.id, 'last.json'), 'utf8')) as { meta: RunMeta };
  } catch {
    throw new Error(`no previous run of ${recipe.id} (${join(deps.cache.work, recipe.id, 'last.json')}): run it first`);
  }
  // ComfyUI's execution cache can answer an identical graph from memory, so a re-run on a long-lived server proves nothing
  if (deps.external) throw new Error('art verify needs a server of its own: unset COMFY_URL (a long-lived server answers a repeated graph from its cache)');
  // M4: a re-run of a changed recipe proves nothing about the baseline, so refuse before spending the time
  if (last.meta.recipeSha256 !== sha(new TextEncoder().encode(recipeText))) throw new Error(`verify: the recipe ${recipe.id} has changed since the last run (recipe sha256 differs): run it again first`);
  const key = recipe.kind === 'texture' ? 'albedo' : 'plate';
  const before = last.meta.outputs[key]!;
  const old = decodePng(new Uint8Array(await readFile(before.file)));
  // the re-run is a witness, not a new baseline: only a passing verify moves last.json to it
  const run = await runRecipe(recipe, recipeText, deps, { updateLast: false });
  const now = run.meta.outputs[key]!;
  // the models and references the re-run used must be the baseline's, or a drift (or a match) means nothing
  for (const [k, v] of Object.entries(run.meta.models)) {
    const was = last.meta.models[k];
    if (!was || was.sha256 !== v.sha256) throw new Error(`verify: model ${k} differs from the last run's (${was?.sha256 ?? 'not used'} vs ${v.sha256})`);
  }
  if (JSON.stringify(last.meta.references ?? {}) !== JSON.stringify(run.meta.references ?? {})) throw new Error('verify: the reference hashes differ from the last run\'s');
  const diff = meanAbsDiff(old, decodePng(new Uint8Array(await readFile(now.file))));
  const ok = diff <= 1;
  if (ok) await writeFile(join(deps.cache.work, recipe.id, 'last.json'), `${JSON.stringify(run, null, 2)}\n`);
  return { ok, meanAbsDiff: diff, detail: `${ok ? 'within' : 'beyond'} 1/255: mean difference ${diff.toFixed(3)}; last ${before.sha256}, now ${now.sha256}` };
}
