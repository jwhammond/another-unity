// SPDX-License-Identifier: GPL-3.0-or-later
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PassThrough, Readable } from 'node:stream';
import { parseArgs, promisify } from 'node:util';
import { homedir, totalmem } from 'node:os';
import { parse as parseYaml, parseDocument, stringify } from 'yaml';
import { alignCheck, ALIGN_DEFAULTS, overlay } from './align';
import { rebuildRun } from './poststep';
import { artCache } from './cache';
import { doctor, familyReady, remoteDoctor } from './doctor';
import { compareSchema, contactSheet, resultsYaml, runCompare, sheetHtml, type VariantResult } from './compare';
import type { ExperimentalFamily } from './families';
import { BUDGET_BYTES, chosenResult, runBench, type BenchCase, type BenchFile } from './bench';
import { checkComfyUrl, ComfyHttp, isLoopback, withGenerator } from './comfy';
import type { Models, Sampling } from './graphs';
import { decodePng, encodePng, type Rgba } from './image';
import { gen, parseSize, samplingFor } from './gen';
import { blenderPath, runBlender, runBlenderRecipe } from './blender';
import { CARD_SCALE, makeCard, makeStrips, publishCard, publishStrips, upscaledAlphaKey, writeCardMeta } from './card';
import { canonicalAnim, replyAnims, SHADOW_COLOURS, type SpriteJson } from './sprites';
import { WalkFloor } from '../../../engine/src/sim/walkFloor';
import { findMasks, findProps, publishMasks, type PropLayer, type PropStrip } from './masks';
import { readStripPack, stripLayout } from './layer';
import { halfPublishedPlates, publishRoom, publishShip, publishCrewStrips, publishShipCrew, publishShipPlate, publishShipViews, type ShipCrewFrame } from './publish';
import { readWebp, webpSize } from './webp';
import { itemKey, runBatch, type BatchItem } from './batch';
import { animCoreText, animKey, loadSprite, recipeAnims, runCardAnim, type CardDeps } from './cardrun';
import { createHash } from 'node:crypto';
import { originalBackground } from './originals';
import { exportShipOriginals, readZipMember, shipOriginal, type ItemRect } from './shiporig';
import { backgroundOf, parseRecipe, plateStation, PLATE_STEMS, type PlateStation, type RepaintRecipe, type Recipe } from './recipe';
import { shipInputs } from './shipscreen';
import { bridgeStrips, readScript, viewStrips, type BridgeStrip, type Upscale, type ViewStrip } from './bridgeanim';
import { recipeRepaint } from './bridgerepaint';
import { bridgePalette, colourFrame, firstSpriteFrame, firstSpritePosition, shipGameZip, viewFrame, viewPalette } from './shipsprite';
import { hailOriginal, publishHail } from './hail';
import { edgePoints, EDGE_POINTS } from './points';
import { runMaterialRecipe } from './material';
import { runShipRecipe, spritePositions } from './shipbuild';
import type { ShipYaml } from './shiplayout';
import { loadScreenInputs } from './screen';
import { checkPins, choiceFor, readShipLift, runRecipe, verifyRecipe, type RunMeta } from './run';
import { fetchModel, loadModels, sha256File } from './models';
import { defaultChoice, modelsFor, type Choice } from './select';
import { Jellyfin } from './jellyfin';
import { ffmpegGrabber, grabRefs, manifestSchema, recordHashes, refFile, scan } from './refs';
import { writeSheet, type Cell } from './sheet';
import { loadJellyfin } from './secrets';
import { curlLanFetch } from './lanFetch';
import { avatarBases, avatarRecipe, gamePortrait, GRAB, latestRuns, newestRun, repixelRuns, runAvatar, runGrabAvatar, sheetRows, type AvatarRecipe, type AvatarRun } from './avatar';
import { faceBoxes, facePython, scoreFaces, scoreLabel, type FaceBox, type FaceScore } from './face';
import { findKit, publishKit } from './kitpublish';
import { publishAstro } from './astro';
import { publishSensor } from './sensor';
import { publishTransporter } from './transporter';
import { publishEngineering } from './engineering';
import { publishHolodeck } from './holodeck';
import { publishPanel } from './panel';
import { phaserTable, publishPhaser } from './phaser';
import { publishCursors } from './cursors';
import { publishTricorder } from './tricorder';
import { adminPlates, publishAdmin } from './admin';
import { iconRecipe, iconSource, newestIconRun, runIcon } from './icon';
import { nearestResize } from './pixel';

const here = dirname(fileURLToPath(import.meta.url));
const TOOL = join(here, '..');
const REPO = join(TOOL, '..', '..');
const MODELS = join(REPO, 'art', 'models.yaml');
const REFS = join(REPO, 'art', 'refs', 'show.yaml');
/** Every manifest under art/refs: crop ids share one namespace. */
const allManifests = () =>
  readdirSync(join(REPO, 'art', 'refs'))
    .filter(f => f.endsWith('.yaml'))
    .map(f => manifestSchema.parse(parseYaml(readFileSync(join(REPO, 'art', 'refs', f), 'utf8'))));
/** The decoded game originals (art cache, originals/ship) shown beside each ship set's board. */
const SHIP_ORIGINALS: Record<string, string[]> = {
  'set:bridge': ['bridge.png', 'viewscr.png'],
  'set:transporter-room': ['transp.png'],
  'set:observation-lounge': ['bridge.png'],
  'set:astrogation': ['astropnl.png', 'compupnl.png'],
};
const gameZip = (): string => shipGameZip(process.env.GAMEDATA_DIR);

/**
 * The hail frames: every sprite the comms contacts name, every sprite the Enterprise's own views name (viewscreenSprites), plus every
 * view*.spr (but the frame's own viewscr and viewscan), each one's first frame coloured with viewscr.rm's palette (the ship screen that
 * draws it). PNGs go to `dir`. Each one's sheets too (viewStrips): the animation the viewscreen plays, in the same palette.
 */
async function hailFrames(dir: string): Promise<{ stem: string; png: string; sheets: Map<number, ViewStrip> }[]> {
  const zip = gameZip();
  const ship = parseYaml(readFileSync(join(REPO, 'games', 'unity', 'ship.yaml'), 'utf8')) as ShipYaml & { contacts?: { comms: { file?: string }[] }; viewscreenSprites?: Record<string, string> };
  const stems = new Set<string>();
  for (const c of ship.contacts?.comms ?? []) if (c.file) stems.add(c.file);
  for (const file of Object.values(ship.viewscreenSprites ?? {})) stems.add(file);
  const members = (await promisify(execFile)('unzip', ['-Z1', zip])).stdout.split('\n').map(m => m.trim().toLowerCase());
  for (const m of members) if (/^view[a-z0-9_]*\.spr$/.test(m) && m !== 'viewscr.spr' && m !== 'viewscan.spr') stems.add(m.replace(/\.spr$/, ''));
  const [rm, pal] = [await readZipMember(zip, 'viewscr.rm'), await readZipMember(zip, 'standard.pal')];
  mkdirSync(dir, { recursive: true });
  const out: { stem: string; png: string; sheets: Map<number, ViewStrip> }[] = [];
  for (const stem of [...stems].sort()) {
    const png = join(dir, `${stem}.png`);
    const spr = await readZipMember(zip, `${stem}.spr`);
    writeFileSync(png, encodePng(viewFrame(spr, rm, pal)));
    out.push({ stem, png, sheets: viewStrips(readScript(spr), viewPalette(spr, rm, pal)) });
  }
  return out;
}

/** The bridge's crew frames for `art ship publish`: each sprite's first frame, at its first position block, with bridge.objects' depth (R14). */
async function bridgeCrew(images: string | undefined, log: (m: string) => void, recolourDir?: string): Promise<ShipCrewFrame[]> {
  const crew: ShipCrewFrame[] = [];
  const ship = parseYaml(readFileSync(join(REPO, 'games', 'unity', 'ship.yaml'), 'utf8')) as ShipYaml;
  const spots = await spritePositions(ship, images);
  // (a ship sprite needs its screen's palette, decoded from the game's own files: without them the export's frames have black holes)
  const zip = gameZip();
  const palette = { zip, pal: bridgePalette(await readZipMember(zip, 'bridge.rm'), await readZipMember(zip, 'standard.pal')) };
  if (!images) {
    log('art ship publish: no IMAGES_DIR, so no crew cards (the exported originals, e.g. ~/pcode/unity-raw/runs/images/media)');
    return crew;
  }
  for (const o of ship.bridge.objects) {
    const json = JSON.parse(readFileSync(join(images, 'images', 'sprites', o.file, 'sprite.json'), 'utf8')) as SpriteJson;
    const first = json.entries.find(e => e.type === 'sprite' && typeof e.png === 'string');
    if (typeof first?.png !== 'string') throw new Error(`${o.file} has no frame to make a card from`);
    let png = join(images, first.png);
    // (the export colours a sprite no screen shows with the standard half of the palette only: the bridge's own 128 entries,
    // which the bridge draws it with, are black there. Decoded again from the game's .spr with the bridge's palette.)
    if (recolourDir) {
      const frame = firstSpriteFrame(await readZipMember(palette.zip, o.file.toLowerCase()));
      const coloured = colourFrame(frame, palette.pal);
      mkdirSync(recolourDir, { recursive: true });
      png = join(recolourDir, `${o.file.replace(/\.spr$/i, '')}.png`);
      writeFileSync(png, encodePng(coloured));
    }
    crew.push({ object: o.object, file: o.file, png, at: spots[o.file] ?? [o.x, o.y], depth: o.depth });
  }
  return crew;
}

/**
 * The bridge crew's animation strips for `art ship publish`: each sprite decoded again from the game's .spr with the bridge's palette, played from
 * the idle animation (and the ship's idle and talk ones), every frame at its own offset from the card's place.
 */
async function bridgeStripsFor(images: string | undefined, log: (m: string) => void, background?: Rgba): Promise<{ object: string; file: string; strips: Map<number, BridgeStrip> }[]> {
  const ship = parseYaml(readFileSync(join(REPO, 'games', 'unity', 'ship.yaml'), 'utf8')) as ShipYaml;
  const zip = gameZip();
  const palette = bridgePalette(await readZipMember(zip, 'bridge.rm'), await readZipMember(zip, 'standard.pal'));
  const spots = await spritePositions(ship, images);
  // (the same smooth 4x the room crew's cards have: the sprites are 1x pixels with dither, which a 2-4x screen shows as blocks)
  const cache = artCache();
  const models = loadModels(readFileSync(MODELS, 'utf8'));
  const choice = defaultChoice(models);
  const frames = join(cache.work, 'cards', 'bridge-crew', 'frames');
  mkdirSync(frames, { recursive: true });
  return withGenerator(cache, async g => {
    await checkPins(choice, { generator: g, models, cache, external: !!process.env.COMFY_URL, warn: log }, ['upscaler']);
    const made = modelsFor(models, choice);
    const upscale: Upscale = {
      scale: CARD_SCALE,
      run: async frame => {
        const input = encodePng(frame);
        // (the alpha is upscaled with the colours: the key says so, and with what shapes it, so a card made another way isn't reused)
        const file = join(frames, `${createHash('sha256').update(input).update(upscaledAlphaKey()).digest('hex')}.png`);
        if (existsSync(file)) return decodePng(new Uint8Array(readFileSync(file)));
        const out = await makeCard(g, made, input, `bridge-crew-in-${process.pid}`, { alpha: 'upscaled' });
        writeFileSync(file, out);
        return decodePng(out);
      },
    };
    const out = [];
    for (const o of ship.bridge.objects) {
      const script = readScript(await readZipMember(zip, o.file.toLowerCase()));
      // (Plan 33: a crew member with a recipe, art/recipes/bridgecrew.<object>.yaml, is repainted over the upscale)
      const repaint = await recipeRepaint(join(REPO, 'art', 'recipes'), o.object, { generator: g, models, cache, scale: CARD_SCALE, log });
      const strips = await bridgeStrips(script, palette, [o.x, o.y], spots[o.file] ?? [o.x, o.y], background, undefined, upscale, o.file, repaint);
      log(`${o.object}: ${[...strips].map(([i, s]) => `anim ${i} ${s.frames} frames${s.loop ? ' loop' : s.next !== undefined ? ` then ${s.next}` : ''}`).join(', ')}`);
      out.push({ object: o.object, file: o.file, strips });
    }
    return out;
  }, { flags: choice.comfyFlags });
}

/** Publishes a plate recipe's last run: the WebP is measured against the original again before it is published (R10, R14). */
async function publishPlate(cache: ReturnType<typeof artCache>, recipe: RepaintRecipe, station: PlateStation, log: (m: string) => void): Promise<string[] | null> {
  const lastFile = join(cache.work, recipe.id, 'last.json');
  if (!existsSync(lastFile)) {
    log(`${recipe.id} has no run (${lastFile}): art run art/recipes/${recipe.id}.yaml first`);
    return null;
  }
  const last = JSON.parse(readFileSync(lastFile, 'utf8')) as { dir: string; meta: Parameters<typeof publishShipPlate>[2]['meta'] };
  const original = decodePng(new Uint8Array(readFileSync(shipOriginal(cache, PLATE_STEMS[station]))));
  const gameDir = join(REPO, 'games', 'unity');
  const align = recipe.post.find(p => 'align' in p);
  const points = shipInputs(station, recipe, await readShipLift(gameDir), original).points;
  const { files, plate } = await publishShipPlate(gameDir, station, last, recipe, {
    original,
    align: align && 'align' in align ? { original, points, maxShift: align.align.maxShift } : undefined,
  });
  log(`published ${recipe.id} from ${last.dir}: ${files.join(', ')} (plate png ${plate.png.slice(0, 12)}, webp ${plate.webp.slice(0, 12)}, mean diff ${plate.meanAbsDiff.toFixed(2)}/255)`);
  return files;
}

const USAGE = 'usage: art doctor | art refs list [--season N] | art refs scan --season N --episode N [--every 20] | art refs grab [--manifest art/refs/ship.yaml] [--only id…] [--record] | art refs board [--manifest art/refs/ship.yaml] [--tag crew:riker] | art fetch [--model <id>] [--record] | art gen --prompt <text> [--seed N] [--size WxH] --out <file.png> | art bench [--runs 3] [--out art/bench/<date>-m5-pro.yaml] | art blender <script.py> [--params <json>] --out <file.glb> | art run <recipe.yaml> | art verify <recipe.yaml> | art batch <recipe.yaml…> | art post <recipe.yaml> [--run dir | --all] | art publish <recipe.yaml> | art card <object> <frame.png> | art align <plate.png> --screen <world.sNN> [--max-shift 2] | art masks <world.sNN> | art strips <object> [--sprite <file>] --upscale-only | art ship originals | art hail publish <name> | art ship build [bridge] | art ship publish [station] [--set] | art half | art sheet plate.<station> | art compare <file.yaml> [--family f] [--variant v] [--fresh] [--sheet-only] [--wait <minutes>] | art avatar <recipe.yaml> [--variant v|grab] [--sheet-only] [--base-only] | art avatars <recipe.yaml…> [--name crew.compare] | art icon <recipe.yaml…> [--variant v] [--sheet-only] [--name kit.compare] | art publish-kit | art panel publish | art cursors publish | art tricorder publish | art phaser publish | art astro publish | art transporter publish | art sensor publish | art engineering publish | art holodeck publish';

function run(cmd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', d => (out += d));
    p.stderr.on('data', d => (out += d));
    p.on('error', reject);
    p.on('close', code => resolve({ code: code ?? 1, out }));
  });
}

/**
 * A `fetch` that streams through curl. Node's own fetch reaches this CDN at about 1.5 MB/s where curl gets 40+, and the
 * models are tens of GB. A curl failure errors the stream, so a truncated download is never renamed into place.
 */
export const curlFetch = (async (url: string) => {
  const p = spawn('curl', ['-L', '--fail', '--silent', '--show-error', url], { stdio: ['ignore', 'pipe', 'pipe'] });
  const out = new PassThrough();
  let err = '';
  p.stderr.on('data', d => (err += d));
  p.stdout.pipe(out, { end: false });
  p.on('error', e => out.destroy(e));
  p.on('close', code => (code === 0 ? out.end() : out.destroy(new Error(`curl ${url} exited ${code}: ${err.trim()}`))));
  return new Response(Readable.toWeb(out) as ReadableStream, { status: 200 });
}) as typeof fetch;

async function benchCommand(cache: ReturnType<typeof artCache>, runs: number, outArg: string | undefined, log: (line: string) => void, only?: string): Promise<number> {
  const images = process.env.IMAGES_DIR;
  if (!images) {
    log('art bench needs IMAGES_DIR (the exported originals, e.g. ~/pcode/unity-raw/runs/images/media)');
    return 2;
  }
  const file = loadModels(readFileSync(MODELS, 'utf8'));
  const base = defaultChoice(file);
  const common = { generator: withGenerator, originals: images, runs, log };
  // A COMFY_URL bench is a different machine's: its images and numbers stay out of the local bench's files
  const remote = process.env.COMFY_URL;
  const benchDir = remote && outArg ? join(dirname(outArg), `${basename(outArg).replace(/\.ya?ml$/, '')}-images`) : cache.bench;
  if (remote && !outArg) {
    log("art bench with COMFY_URL needs --out (a path outside the repo, e.g. under the art cache): its numbers are not this Mac's");
    return 2;
  }
  mkdirSync(benchDir, { recursive: true });
  const writeImage = (name: string, png: Uint8Array): void => writeFileSync(join(benchDir, name), png);

  const light: Choice = { ...base, lora: 'sdxl-lightning-8step', comfyFlags: undefined };
  const plain: Choice = { ...base, lora: undefined, comfyFlags: undefined };
  const sampling = (m: Models): Sampling => ({ seed: 1, ...samplingFor(m) });
  const txtCases: BenchCase[] = [];
  // (a COMFY_URL server is only asked for the selected models: the other candidates are the local bench's)
  for (const [candidate, choice] of remote ? ([['sdxl-base-1.0', plain]] as const) : ([['sdxl-base-1.0', plain], ['sdxl-base-1.0+sdxl-lightning-8step', light]] as const)) {
    // (server flags mean nothing to a COMFY_URL server)
    for (const flags of remote ? [[]] : [[], ['--force-fp16']]) {
      const models = modelsFor(file, choice);
      txtCases.push({ id: 'txt2img-1024', candidate, models, sampling: sampling(models), flags });
    }
  }
  const upCases: BenchCase[] = (remote ? [base.upscaler] : ['realesrgan-x4plus', 'realesrgan-x4plus-anime6b']).map(u => {
    const models = modelsFor(file, { ...plain, upscaler: u });
    return { id: 'upscale-4x' as const, candidate: u, models, sampling: sampling(models), flags: [] };
  });
  if (only === 'upscale') {
    // Re-time the upscalers alone and replace those rows in the existing file.
    const out = outArg ?? join(REPO, 'art', 'bench', `${new Date().toISOString().slice(0, 10)}-m5-pro.yaml`);
    const existing = parseYaml(readFileSync(out, 'utf8')) as BenchFile;
    const fresh = await runBench(cache, upCases, { ...common, writeImage });
    existing.results = [...existing.results.filter(r => r.case !== 'upscale-4x'), ...fresh.results];
    writeFileSync(out, `# Numbers and ids only (Plan 14 Task 3). peakFootprint is /usr/bin/time -l's, in bytes.\n${stringify(existing)}`);
    for (const r of fresh.results) log(`${r.case} ${r.candidate} ${r.seconds.toFixed(1)} s  ${(r.peakFootprint / 2 ** 30).toFixed(1)} GB`);
    return 0;
  }
  log('txt2img 1024 and upscale 4x');
  const first = await runBench(cache, [...txtCases, ...upCases], { ...common, writeImage });

  // The repaint uses the fastest txt2img setting within budget.
  const win = chosenResult(first.results, 'txt2img-1024', BUDGET_BYTES);
  const winChoice = win.candidate.includes('lightning') ? light : plain;
  const upscaler = chosenResult(first.results, 'upscale-4x', BUDGET_BYTES).candidate;
  log(`repaint 1152 with ${win.candidate} ${win.flags.join(' ')}`);
  const rpCases: BenchCase[] = (
    remote
      ? [['cn-union-sdxl', 'cn-union-sdxl']]
      : [
          ['cn-union-sdxl', 'cn-union-sdxl'],
          ['cn-depth-sdxl-small', 'cn-mistoline'],
        ]
  ).map(([depth, lineart]) => {
    const models = modelsFor(file, { ...winChoice, depth: depth!, lineart: lineart!, upscaler });
    return { id: 'repaint-1152' as const, candidate: depth === lineart ? depth! : `${depth}+${lineart}`, models, sampling: sampling(models), flags: win.flags };
  });
  const second = await runBench(cache, rpCases, { ...common, writeImage });

  const pins = readFileSync(join(TOOL, 'setup', 'pins.env'), 'utf8');
  const pin = (k: string): string => new RegExp(`^${k}=(.*)$`, 'm').exec(pins)?.[1] ?? '';
  const sh = async (cmd: string, args: string[]): Promise<string> => (await run(cmd, args)).out.trim();
  const benchFile: BenchFile = {
    machine: remote
      ? { model: `remote ${new URL(remote).host}`, chip: `${second.stack.torch.includes('cu') ? 'CUDA' : 'GPU'} (peakFootprint not measured)`, memoryGb: 0, macos: '' }
      : {
          model: await sh('sysctl', ['-n', 'hw.model']),
          chip: await sh('sysctl', ['-n', 'machdep.cpu.brand_string']),
          memoryGb: Math.round(totalmem() / 2 ** 30),
          macos: await sh('sw_vers', ['-productVersion']),
        },
    stack: { ...second.stack, aux: pin('AUX_COMMIT'), python: remote ? '' : (await sh(cache.python, ['--version'])).replace('Python ', '') },
    date: new Date().toISOString().slice(0, 10),
    results: [...first.results, ...second.results],
  };
  const out = outArg ?? join(REPO, 'art', 'bench', `${benchFile.date}-m5-pro.yaml`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `# Numbers and ids only (Plan 14 Task 3). peakFootprint is /usr/bin/time -l's, in bytes.\n${stringify(benchFile)}`);
  log(`wrote ${out}`);
  for (const r of benchFile.results) log(`${r.case.padEnd(13)} ${r.candidate.padEnd(36)} ${r.flags.join(' ').padEnd(12)} ${r.seconds.toFixed(1).padStart(6)} s  ${(r.peakFootprint / 2 ** 30).toFixed(1)} GB`);
  return 0;
}

export async function runArt(argv: string[], log: (line: string) => void): Promise<number> {
  const [cmd, ...rest] = argv;
  const cache = artCache();
  if (cmd === 'doctor' && process.env.COMFY_URL) {
    // A remote server: check it, not this machine's cache.
    const url = process.env.COMFY_URL;
    await checkComfyUrl(url);
    const http = new ComfyHttp(url, { fetchFn: isLoopback(url) ? undefined : curlLanFetch() });
    const lines = await remoteDoctor(url, { info: () => http.info(), objectInfo: () => http.objectInfo(), read: p => readFileSync(p, 'utf8'), pinsFile: join(TOOL, 'setup', 'pins.env'), modelsFile: MODELS });
    for (const l of lines) log(`${l.ok ? 'ok  ' : l.optional ? 'MISS' : 'FAIL'} ${l.what}: ${l.detail}`);
    return lines.every(l => l.ok || l.optional) ? 0 : 1;
  }
  if (cmd === 'doctor') {
    const lines = await doctor(cache, {
      run,
      exists: existsSync,
      read: p => readFileSync(p, 'utf8'),
      hash: sha256File,
      pinsFile: join(TOOL, 'setup', 'pins.env'),
      modelsFile: MODELS,
      jellyfinEnv: (() => {
        const path = process.env.JELLYFIN_ENV || join(cache.root, 'jellyfin.env');
        return { path, mode: existsSync(path) ? statSync(path).mode : null };
      })(),
    });
    for (const l of lines) log(`${l.ok ? 'ok  ' : 'FAIL'} ${l.what}: ${l.detail}`);
    return lines.every(l => l.ok) ? 0 : 1;
  }
  if (cmd === 'refs') {
    const [sub, ...args] = rest;
    const v = parseArgs({
      args,
      options: { season: { type: 'string' }, episode: { type: 'string' }, every: { type: 'string', default: '20' }, only: { type: 'string', multiple: true }, record: { type: 'boolean' }, tag: { type: 'string' }, manifest: { type: 'string' } },
      allowPositionals: true,
    });
    const manifestFile = v.values.manifest ? resolve(REPO, v.values.manifest) : REFS;
    const manifestText = readFileSync(manifestFile, 'utf8');
    const manifest = manifestSchema.parse(parseYaml(manifestText));
    if (sub === 'board') {
      // from the cache only: no server needed
      const refsDir = join(cache.root, 'refs');
      const media = join(process.env.IMAGES_DIR ?? join(process.env.HOME ?? '', 'pcode', 'unity-raw', 'runs', 'images', 'media'), 'images');
      const tags = [...new Set(Object.values(manifest.refs).flatMap(r => r.tags.filter(t => /^(crew|set):/.test(t))))]
        .filter(t => !v.values.tag || t === v.values.tag)
        .sort();
      const read = (f: string): Uint8Array => new Uint8Array(readFileSync(f));
      for (const tag of tags) {
        const ids = Object.keys(manifest.refs).filter(id => manifest.refs[id]!.tags.includes(tag));
        const crops: Cell[] = ids.map(id => ({ png: read(refFile(refsDir, id, allManifests())), caption: `${id} s${manifest.refs[id]!.season}e${manifest.refs[id]!.episode} @${manifest.refs[id]!.ms}ms ${manifest.refs[id]!.tags.join(' ')}` }));
        const name = tag.replace(':', '-');
        const rows: Cell[][] = [];
        for (let i = 0; i < crops.length; i += 4) rows.push(crops.slice(i, i + 4));
        if (tag.startsWith('crew:')) {
          const spr = join(media, 'sprites', `${tag.slice(5).replace('_', '')}.spr`);
          const sheetPng = ['0001.png', '0010.png', '0030.png'].filter(f => existsSync(join(spr, f))).map(f => ({ png: read(join(spr, f)), caption: `sprite frame ${f}` }));
          rows.push(sheetPng);
        } else if (SHIP_ORIGINALS[tag]) {
          const shipDir = join(cache.root, 'originals', 'ship');
          rows.push(SHIP_ORIGINALS[tag]!.filter(f => existsSync(join(shipDir, f))).map(f => ({ png: read(join(shipDir, f)), caption: `game original ${f.replace('.png', '')}` })));
        } else {
          const bgs = readdirSync(join(media, 'backgrounds')).filter(f => /^s_04[0-9a-f]{2}\.png$/.test(f)).sort();
          for (let i = 0; i < bgs.length; i += 4) rows.push(bgs.slice(i, i + 4).map(f => ({ png: read(join(media, 'backgrounds', f)), caption: `room original ${f.slice(2, 6)}` })));
        }
        const out = join(cache.root, 'work', 'sheets', `refs-${name}`);
        await writeSheet(rows, out, { cell: [tag.startsWith('crew:') ? 360 : 320, 300] });
        log(`${out}.png`);
      }
      return 0;
    }
    const cfg = await loadJellyfin();
    const j = new Jellyfin(cfg, { log, fetchFn: curlLanFetch() });
    const cacheRefs = join(cache.root, 'refs');
    const episodes = (await j.episodes(manifest.series)).filter(e => !v.values.season || e.season === Number(v.values.season));
    if (sub === 'list') {
      // season, episode, item id and runtime: never titles
      for (const e of episodes) log(`s${e.season}e${String(e.episode).padStart(2, '0')} ${e.item} ${Math.round(e.ms / 60000)} min`);
      log(`${episodes.length} episodes`);
      return 0;
    }
    if (sub === 'scan') {
      const ep = episodes.find(e => e.season === Number(v.values.season) && e.episode === Number(v.values.episode));
      if (!v.values.season || !v.values.episode || !ep) {
        log(USAGE);
        return 2;
      }
      const sheets = await scan(j, ffmpegGrabber, ep, Number(v.values.every), join(cacheRefs, 'sheets'));
      for (const s of sheets) log(s);
      return 0;
    }
    if (sub === 'grab') {
      const res = await grabRefs(j, ffmpegGrabber, manifest, cacheRefs, { only: v.values.only, record: v.values.record });
      for (const r of res) {
        if (!v.values.record && !r.matched) log(`WARN ${r.id}: crop hash ${r.sha256} differs from the manifest after a re-grab`);
        log(`${r.matched ? 'ok  ' : 'DIFF'} ${r.id} ${r.file}`);
      }
      if (v.values.record) writeFileSync(manifestFile, recordHashes(manifestText, res));
      return res.every(r => r.matched) ? 0 : 1;
    }
    log(USAGE);
    return 2;
  }
  if (cmd === 'ship') {
    if (rest[0] === 'build') {
      const station = rest[1] ?? 'bridge';
      const path = join(REPO, 'art', 'recipes', `ship.${station}.yaml`);
      if (!existsSync(path)) {
        log(`no recipe ${path}`);
        return 2;
      }
      const text = readFileSync(path, 'utf8');
      const recipe = parseRecipe(text, path);
      if (recipe.kind !== 'ship') throw new Error(`${path} is a ${recipe.kind} recipe, not a ship recipe`);
      const res = await runShipRecipe(recipe, text, cache).catch(e => {
        log(String(e instanceof Error ? e.message : e));
        return undefined;
      });
      if (!res) return 1;
      log(`camera fit rms ${res.meta.fit.rms.toFixed(2)} px (blender ${res.meta.blender}, ${res.meta.seconds.toFixed(1)} s)`);
      for (const f of res.fits) log(`item ${String(f.index).padStart(2)} action ${f.action.padStart(2)}  coverage ${f.coverage.toFixed(2)}  spill ${f.spill.toFixed(2)}  ${f.pass ? 'ok' : 'FAIL'}`);
      log(res.dir);
      return 0;
    }
    if (rest[0] === 'publish') {
      const set = rest.includes('--set');
      const station = rest.slice(1).find(a => !a.startsWith('--')) ?? 'bridge';
      const images = process.env.IMAGES_DIR;
      const background = existsSync(join(cache.root, 'originals', 'ship', 'bridge.png')) ? { background: decodePng(readFileSync(join(cache.root, 'originals', 'ship', 'bridge.png'))) } : {};
      if (!set) {
        // (R14: the station's last plate run, plus the bridge's crew cards and their places)
        const path = join(REPO, 'art', 'recipes', `plate.${station}.yaml`);
        if (!existsSync(path)) {
          log(`no recipe ${path}`);
          return 2;
        }
        const recipe = parseRecipe(readFileSync(path, 'utf8'), path);
        const st = recipe.kind === 'repaint' ? plateStation(recipe) : null;
        if (recipe.kind !== 'repaint' || !st) throw new Error(`${path} is not a ship plate recipe`);
        // (a station with ship sprites needs the game's files before anything is published)
        if (station === 'bridge' || station === 'viewscreen') {
          try {
            gameZip();
          } catch (e) {
            log(String(e instanceof Error ? e.message : e));
            return 2;
          }
        }
        const files = await publishPlate(cache, recipe, st, log).catch(e => {
          log(String(e instanceof Error ? e.message : e));
          return null;
        });
        if (!files) return 1;
        if (station === 'viewscreen') {
          // (R7: the hail frames, first frames at their own pixels, in viewscr.rm's palette, and their animations' sheets)
          const views = await publishShipViews(join(REPO, 'games', 'unity'), await hailFrames(join(cache.work, recipe.id, 'view-src')));
          log(`published ${views.length} viewscreen frames and sheets`);
        }
        if (station === 'bridge') {
          const crew = await bridgeCrew(images, log, join(cache.work, recipe.id, 'crew-src'));
          const cards = crew.length > 0 ? await publishShipCrew(join(REPO, 'games', 'unity'), station, join(cache.work, recipe.id), { crew, ...background }) : [];
          log(`published ${cards.length} crew cards`);
          const strips = await publishCrewStrips(join(REPO, 'games', 'unity'), station, await bridgeStripsFor(images, log, background.background));
          log(`published ${strips.length} crew strips`);
        }
        return 0;
      }
      const lastFile = join(cache.root, 'work', `ship.${station}`, 'last.json');
      if (!existsSync(lastFile)) {
        log(`no build of ship.${station} yet: art ship build ${station}`);
        return 2;
      }
      const last = JSON.parse(readFileSync(lastFile, 'utf8')) as { dir: string; meta: Parameters<typeof publishShip>[2]['meta'] };
      // (the bridge's crew: each brdg*.spr's first frame, from the images export)
      const crew = station === 'bridge' ? await bridgeCrew(images, log, join(cache.work, `ship.${station}`, 'crew-src')) : [];
      const { gltf, crew: cards } = await publishShip(join(REPO, 'games', 'unity'), station, last, { crew, ...background }).catch(e => {
        log(String(e instanceof Error ? e.message : e));
        return { gltf: '', crew: [] as string[] };
      });
      if (!gltf) return 1;
      if (station === 'bridge') log(`published ${(await publishCrewStrips(join(REPO, 'games', 'unity'), station, await bridgeStripsFor(images, log, background.background))).length} crew strips`);
      log(`published ${station} from ${last.dir}: ${gltf}${cards.length ? ` and ${cards.length} crew cards` : ''}`);
      return 0;
    }
    if (rest[0] !== 'originals') {
      log(USAGE);
      return 2;
    }
    const gameData = process.env.GAMEDATA_DIR;
    if (!gameData) {
      log('art ship originals needs GAMEDATA_DIR (the game\'s folder with STTNG.ZIP, e.g. ~/pcode/unity-gamedata/cd)');
      return 2;
    }
    const ship = parseYaml(readFileSync(join(REPO, 'games', 'unity', 'ship.yaml'), 'utf8')) as { bridge: { items: ItemRect[] } };
    for (const f of await exportShipOriginals(gameData, cache, ship.bridge.items)) log(f);
    // (the hail frames, in their own palettes: the originals a hail recipe repaints)
    const frames = await hailFrames(join(cache.root, 'originals', 'view'));
    log(`${frames.length} hail frames in ${join(cache.root, 'originals', 'view')}`);
    return 0;
  }
  if (cmd === 'half') {
    // (a game published before `art publish` wrote plate.half.webp: the phone's half-size plates, from the published ones)
    const written = await halfPublishedPlates(join(REPO, 'games', 'unity'));
    log(written.length === 0 ? 'every published plate has a half-size one' : `wrote ${written.length} half-size plates:\n${written.join('\n')}`);
    return 0;
  }
  if (cmd === 'hail') {
    // art hail publish <name>: the last run of art/recipes/hail.<name>.yaml, as the still the viewscreen shows for that caller
    const name = rest[1];
    const path = name ? join(REPO, 'art', 'recipes', `hail.${name}.yaml`) : '';
    if (rest[0] !== 'publish' || !name || !/^[a-z0-9_]+$/.test(name) || !existsSync(path)) {
      log(USAGE);
      return 2;
    }
    const recipe = parseRecipe(readFileSync(path, 'utf8'), path);
    if (recipe.kind !== 'repaint' || !('hail' in recipe.source)) throw new Error(`${path} is not a hail recipe`);
    const stem = recipe.source.hail;
    const lastFile = join(cache.work, recipe.id, 'last.json');
    if (!existsSync(lastFile)) {
      log(`${recipe.id} has no run (${lastFile}): art run art/recipes/${recipe.id}.yaml first`);
      return 2;
    }
    const last = JSON.parse(readFileSync(lastFile, 'utf8')) as { dir: string; meta: Parameters<typeof publishHail>[2]['meta'] };
    const original = decodePng(new Uint8Array(readFileSync(hailOriginal(cache, stem))));
    const at = firstSpritePosition(await readZipMember(gameZip(), `${stem}.spr`));
    if (!at) throw new Error(`${stem}.spr has no position block`);
    const align = recipe.post.find(p => 'align' in p);
    const points = edgePoints(original, EDGE_POINTS).map(p => ({ x: p.x, y: p.y, source: `${p.label} ${p.x},${p.y}` }));
    const r = await publishHail(join(REPO, 'games', 'unity'), stem, last, { original, at, align: { points, maxShift: align && 'align' in align ? align.align.maxShift : undefined } });
    log(`published ${recipe.id} from ${last.dir}: ${r.file} (${r.scale}x, drawn at ${at.join(',')}, webp drift ${r.drift.toFixed(2)}/255)`);
    return 0;
  }
  if (cmd === 'fetch') {
    const { model, record } = parseArgs({ args: rest, options: { model: { type: 'string' }, record: { type: 'boolean' } } }).values;
    const text = readFileSync(MODELS, 'utf8');
    const file = loadModels(text);
    const doc = parseDocument(text);
    const ids = model ? [model] : Object.keys(file.models);
    for (const id of ids) {
      const m = file.models[id];
      if (!m) throw new Error(`no model "${id}" in art/models.yaml`);
      if (m.remoteOnly) {
        log(`skip ${id}: remote only (lives on the COMFY_URL server; art doctor with COMFY_URL lists it)`);
        continue;
      }
      const dest = join(cache.models, m.file);
      if (existsSync(dest) && m.sha256 === 'pending' && record) {
        const sha256 = await sha256File(dest);
        doc.setIn(['models', id, 'sha256'], sha256);
        writeFileSync(MODELS, String(doc));
        log(`recorded ${id}: sha256 ${sha256}`);
        continue;
      }
      if (existsSync(dest) && m.sha256 !== 'pending') {
        log(`have ${id} (${(statSync(dest).size / 1e6).toFixed(0)} MB)`);
        continue;
      }
      log(`fetching ${id} from ${m.url}`);
      const r = await fetchModel(cache, id, m, curlFetch);
      log(`got ${id}: ${(r.bytes / 1e6).toFixed(1)} MB sha256 ${r.sha256}`);
      if (record && m.sha256 === 'pending') {
        doc.setIn(['models', id, 'sha256'], r.sha256);
        writeFileSync(MODELS, String(doc));
      }
    }
    return 0;
  }
  if (cmd === 'bench') {
    const v = parseArgs({ args: rest, options: { runs: { type: 'string', default: '3' }, out: { type: 'string' }, only: { type: 'string' } } }).values;
    return benchCommand(cache, Number(v.runs), v.out, log, v.only);
  }
  if (cmd === 'gen') {
    const v = parseArgs({
      args: rest,
      options: { prompt: { type: 'string' }, seed: { type: 'string', default: '1' }, size: { type: 'string', default: '1024x1024' }, out: { type: 'string' } },
    }).values;
    if (!v.prompt || !v.out) {
      log(USAGE);
      return 2;
    }
    const file = loadModels(readFileSync(MODELS, 'utf8'));
    const models = modelsFor(file, defaultChoice(file));
    const t0 = Date.now();
    const png = await withGenerator(cache, async g => {
      await checkPins(defaultChoice(file), { generator: g, models: file, cache, external: !!process.env.COMFY_URL, warn: log }, ['checkpoint', 'vae', 'lora']);
      return gen(g, models, { prompt: v.prompt!, seed: Number(v.seed), size: parseSize(v.size!), sampling: samplingFor(models) });
    }, { flags: defaultChoice(file).comfyFlags });
    mkdirSync(dirname(v.out), { recursive: true });
    writeFileSync(v.out, png);
    const img = decodePng(png);
    log(`wrote ${v.out} (${img.width}x${img.height}) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    return 0;
  }
  if (cmd === 'align') {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { screen: { type: 'string' }, 'max-shift': { type: 'string', default: '2' } } });
    const plate = positionals[0];
    const images = process.env.IMAGES_DIR;
    if (!plate || !values.screen) {
      log(USAGE);
      return 2;
    }
    if (!images) {
      log('art align needs IMAGES_DIR (the exported originals, e.g. ~/pcode/unity-raw/runs/images/media)');
      return 2;
    }
    const inputs = await loadScreenInputs(join(REPO, 'games', 'unity'), values.screen);
    if (!inputs.backgroundPng) throw new Error(`${values.screen} has no background`);
    const original = decodePng(new Uint8Array(readFileSync(join(images, inputs.backgroundPng))));
    const img = decodePng(new Uint8Array(readFileSync(plate)));
    const report = alignCheck(original, img, inputs.points, { ...ALIGN_DEFAULTS, maxShift: Number(values['max-shift']) });
    const out = join(dirname(plate), 'align-overlay.png');
    writeFileSync(out, encodePng(overlay(original, img, report)));
    writeFileSync(join(dirname(plate), 'align.json'), `${JSON.stringify(report, null, 2)}\n`);
    const w = report.worst;
    log(`${report.ok ? 'ok' : 'FAIL'} ${report.measured}/${report.total} points measured${w ? `, worst ${w.source} shift (${w.dx}, ${w.dy}) peak ${w.peak}` : ''}${report.why ? `: ${report.why}` : ''}; overlay ${out}`);
    return report.ok ? 0 : 1;
  }
  if (cmd === 'post') {
    // art post <recipe.yaml> [--run <dir> | --all]: warp and check an existing run again (no generation)
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { run: { type: 'string' }, all: { type: 'boolean' } } });
    const path = positionals[0];
    const images = process.env.IMAGES_DIR;
    if (!path) {
      log(USAGE);
      return 2;
    }
    if (!images) {
      log('art post needs IMAGES_DIR (the exported originals, e.g. ~/pcode/unity-raw/runs/images/media)');
      return 2;
    }
    const text = readFileSync(path, 'utf8');
    const recipe = parseRecipe(text, path);
    if (recipe.kind !== 'repaint' || plateStation(recipe)) {
      log('art post is for a room\'s repaint recipe');
      return 2;
    }
    const base = join(cache.work, recipe.id);
    const runs = readdirSync(base).filter(d => existsSync(join(base, d, 'meta.json')) && !d.includes('-post-')).sort().reverse();
    const lastFile = join(base, 'last.json');
    const first = values.run ? [resolve(values.run)] : values.all ? runs.map(d => join(base, d)) : [existsSync(lastFile) ? (JSON.parse(readFileSync(lastFile, 'utf8')) as { dir: string }).dir : join(base, runs[0]!)];
    const original = decodePng(await originalBackground(images, backgroundOf(recipe)));
    const screens = await loadScreenInputs(join(REPO, 'games', 'unity'), recipe.id, original);
    for (const src of first) {
      const r = await rebuildRun(recipe, text, src, original, async () => screens.points, log);
      const w = r.meta.checks.warp as { passes?: { warped: { source: string; dx: number; dy: number }[] }[]; refused?: string } | undefined;
      const moved = (w?.passes ?? []).flatMap((p, i) => p.warped.map(q => `pass ${i + 1} ${q.source} (${q.dx}, ${q.dy})`));
      log(`${r.ok ? 'ok' : 'FAIL'} ${recipe.id} from ${src} -> ${r.dir}${moved.length ? `; warped ${moved.join('; ')}` : ''}${r.why ? `: ${r.why}` : ''}`);
      if (r.ok) {
        writeFileSync(lastFile, `${JSON.stringify({ dir: r.dir, meta: r.meta }, null, 2)}\n`);
        return 0;
      }
    }
    return 1;
  }
  if (cmd === 'batch') {
    if (rest.length === 0) {
      log(USAGE);
      return 2;
    }
    const images = process.env.IMAGES_DIR;
    if (!images) {
      log('art batch needs IMAGES_DIR (the exported originals, e.g. ~/pcode/unity-raw/runs/images/media)');
      return 2;
    }
    const models = loadModels(readFileSync(MODELS, 'utf8'));
    const manifest = manifestSchema.parse(parseYaml(readFileSync(REFS, 'utf8')));
    const pins = readFileSync(join(TOOL, 'setup', 'pins.env'), 'utf8');
    const flags = models.selected?.comfyFlags ?? [];
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const doneDir = join(cache.work, 'batch', 'done');
    mkdirSync(doneDir, { recursive: true });
    const logFile = join(cache.work, 'batch', `${stamp}.log`);
    const out = (line: string): void => {
      writeFileSync(logFile, `${new Date().toISOString()} ${line}\n`, { flag: 'a' });
      log(line);
    };
    log(`batch log: ${logFile}`);
    const gameDir = join(REPO, 'games', 'unity');
    const sha = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');
    const items: BatchItem[] = [];
    for (const path of rest) {
      const text = readFileSync(path, 'utf8');
      const recipe: Recipe = parseRecipe(text, path);
      if (recipe.kind === 'card') {
        // Plan 15 Task 9: a card recipe is one item per animation (R11)
        const sprite = loadSprite(images, recipe);
        const spriteSha = sha(readFileSync(join(images, 'images', 'sprites', recipe.sprite, 'sprite.json')));
        const choice = choiceFor(recipe, models);
        const cardDeps = (): CardDeps => ({ generator: currentGenerator!, models, cache, imagesDir: images, gameDir, warn: out });
        for (const anim of recipeAnims(sprite, recipe)) {
          const key = animKey(animCoreText(text, recipe, anim), anim, {
            models: Object.values(choice).filter((v): v is string => typeof v === 'string' && !!models.models[v]).map(v => `${v}:${models.models[v]!.sha256}`),
            references: recipe.reference.flatMap(r => r.refs).map(id => `${id}:${manifest.refs[id]?.sha256 ?? 'unknown'}`),
            sprite: spriteSha,
            // (an animated prop's strip is published as an atlas, checked on its published pixels: a strip published as a grid before that is published again)
            pins: recipe.prop && recipe.prop.animate.includes(anim) ? `${pins}\0publish=atlas-v3` : pins,
          });
          items.push({
            id: `${recipe.id}#${anim}`,
            key,
            async run() {
              const r = await runCardAnim(recipe, text, anim, cardDeps(), { log: out });
              if (r.ok) writeFileSync(join(doneDir, `${key}.json`), `${JSON.stringify({ id: recipe.id, anim, dir: r.dir })}\n`);
              return { ok: r.ok, detail: `${r.dir} (${r.frames} frames, ${r.canvases} canvases, ${r.secondsPerCanvas.toFixed(0)} s a canvas; flicker median ${r.check.flickerMedian.toFixed(1)}, worst shift ${r.check.worstShift.toFixed(2)} px, dE max ${Math.max(0, ...r.check.deltaE)}${r.check.why ? `; ${r.check.why}` : ''})` };
            },
          });
        }
        continue;
      }
      if (recipe.kind !== 'repaint') throw new Error(`art batch runs repaint and card recipes; ${recipe.id} is a ${recipe.kind} recipe`);
      const choice = choiceFor(recipe, models);
      const m = recipe.id.split('.');
      const lifted = [join(gameDir, 'rooms', m[0]!, `${m[1]}.json`), join(gameDir, 'screens', m[0]!, `${m[1]}.yaml`)].filter(existsSync).map(f => sha(readFileSync(f)));
      const key = itemKey({
        recipe: text,
        models: Object.values(choice).filter((v): v is string => typeof v === 'string' && !!models.models[v]).map(v => `${v}:${models.models[v]!.sha256}`),
        references: recipe.reference.flatMap(r => r.refs).map(id => `${id}:${manifest.refs[id]?.sha256 ?? 'unknown'}`),
        sources: [sha(await originalBackground(images, backgroundOf(recipe))), ...lifted],
        pins,
      });
      items.push({
        id: recipe.id,
        key,
        async run() {
          const { dir, meta } = await runRecipe(recipe, text, { generator: currentGenerator!, models, cache, imagesDir: images, flags, external: !!process.env.COMFY_URL, warn: out });
          writeFileSync(join(doneDir, `${key}.json`), `${JSON.stringify({ id: recipe.id, dir })}\n`);
          const a = meta.checks.align as { measured?: number; total?: number; worst?: { source: string } } | undefined;
          return { ok: true, detail: `${dir} (align ok, ${a?.measured}/${a?.total} points)` };
        },
      });
    }
    let currentGenerator: Parameters<Parameters<typeof withGenerator>[1]>[0] | undefined;
    const done = async (key: string): Promise<boolean> => {
      const marker = join(doneDir, `${key}.json`);
      if (!existsSync(marker)) return false;
      const { dir } = JSON.parse(readFileSync(marker, 'utf8')) as { dir: string };
      try {
        const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as RunMeta & { ok?: boolean };
        // (a card animation's meta has `ok`; a room's has the alignment check)
        const a = meta.checks?.align as { ok?: boolean; skipped?: boolean } | undefined;
        return meta.ok === true || a?.ok === true || (a?.skipped === true && meta.upscaleOnly === true);
      } catch {
        return false;
      }
    };
    // nothing to run (all done): don't start ComfyUI
    const todo: boolean[] = [];
    for (const it of items) todo.push(!(await done(it.key)));
    if (!todo.some(Boolean)) {
      const r = await runBatch(items, { done, log: out });
      return r.failed.length ? 1 : 0;
    }
    return withGenerator(
      cache,
      async generator => {
        currentGenerator = generator;
        const r = await runBatch(items, { done, log: out });
        return r.failed.length ? 1 : 0;
      },
      { flags },
    );
  }
  if (cmd === 'publish') {
    const path = rest[0];
    if (!path) {
      log(USAGE);
      return 2;
    }
    const recipe = parseRecipe(readFileSync(path, 'utf8'), path);
    if (recipe.kind !== 'repaint') {
      log('art publish is for repaint recipes (a room\'s plate)');
      return 2;
    }
    // a ship screen's plate (R14) has no room's images export: it goes to publishShipPlate
    const station = plateStation(recipe);
    if (station) return (await publishPlate(cache, recipe, station, log).catch(e => {
      log(String(e instanceof Error ? e.message : e));
      return null;
    })) ? 0 : 1;
    const lastFile = join(cache.work, recipe.id, 'last.json');
    if (!existsSync(lastFile)) {
      log(`${recipe.id} has no run (${lastFile}): art run ${path} first`);
      return 2;
    }
    const last = JSON.parse(readFileSync(lastFile, 'utf8')) as { dir: string; meta: Parameters<typeof publishRoom>[2]['meta'] };
    // the WebP is measured against the original again before it is published (R10)
    const images = process.env.IMAGES_DIR;
    if (!images) {
      log('art publish needs IMAGES_DIR (the exported originals, e.g. ~/pcode/unity-raw/runs/images/media)');
      return 2;
    }
    const original = decodePng(await originalBackground(images, backgroundOf(recipe)));
    const align = recipe.post.find(p => 'align' in p);
    const points = (await loadScreenInputs(join(REPO, 'games', 'unity'), recipe.id, original)).points;
    const { files, plate } = await publishRoom(join(REPO, 'games', 'unity'), recipe.id, last, {
      original,
      align: align && 'align' in align ? { original, points, maxShift: align.align.maxShift } : undefined,
    });
    // the room's masks are cut from the plate just published
    if (process.env.RAW_DIR) files.push(...(await cutMasks(recipe.id, images, process.env.RAW_DIR, log)));
    else log('RAW_DIR is not set: the masks were not cut (art masks <screen>)');
    log(`published ${recipe.id} from ${last.dir}: ${files.join(', ')} (plate png ${plate.png.slice(0, 12)}, webp ${plate.webp.slice(0, 12)}, mean diff ${plate.meanAbsDiff.toFixed(2)}/255)`);
    return 0;
  }
  if (cmd === 'masks') {
    const screen = rest[0];
    const images = process.env.IMAGES_DIR;
    const raw = process.env.RAW_DIR;
    if (!screen) {
      log(USAGE);
      return 2;
    }
    if (!images || !raw) {
      log('art masks needs IMAGES_DIR (e.g. ~/pcode/unity-raw/runs/images/media) and RAW_DIR (e.g. ~/pcode/unity-raw/runs/export/raw)');
      return 2;
    }
    const files = await cutMasks(screen, images, raw, log);
    log(`${screen}: ${files.length} mask${files.length === 1 ? '' : 's'}`);
    return 0;
  }
  if (cmd === 'strips') {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { 'upscale-only': { type: 'boolean', default: false }, sprite: { type: 'string' } } });
    const object = positionals[0];
    const images = process.env.IMAGES_DIR;
    if (!object) {
      log(USAGE);
      return 2;
    }
    if (!values['upscale-only']) {
      log('art strips only makes upscaled strips for now: pass --upscale-only (the repaint is Task 9)');
      return 2;
    }
    if (!images) {
      log('art strips needs IMAGES_DIR (the exported originals, e.g. ~/pcode/unity-raw/runs/images/media)');
      return 2;
    }
    // (the sprite file's name: the object's id without its underscores, as the export names it)
    // (--sprite names the file when it isn't the object's: the two Mertens officers wear the generic Starfleet sprites)
    const file = join(images, 'images', 'sprites', `${values.sprite ?? object.replace(/_/g, '')}.spr`);
    if (!existsSync(join(file, 'sprite.json'))) throw new Error(`no sprite at ${file}`);
    const sprite = JSON.parse(readFileSync(join(file, 'sprite.json'), 'utf8')) as SpriteJson;
    const models = loadModels(readFileSync(MODELS, 'utf8'));
    const choice = defaultChoice(models);
    const frames = join(cache.work, 'cards', object, 'frames');
    mkdirSync(frames, { recursive: true });
    const t0 = Date.now();
    const strips = await withGenerator(cache, async g => {
      await checkPins(choice, { generator: g, models, cache, external: !!process.env.COMFY_URL, warn: log }, ['upscaler']);
      return makeStrips(g, modelsFor(models, choice), sprite, async png => new Uint8Array(readFileSync(join(images, png))), {
        shadowColours: SHADOW_COLOURS,
        log,
        cached: {
          get: async key => (existsSync(join(frames, `${key}.png`)) ? new Uint8Array(readFileSync(join(frames, `${key}.png`))) : null),
          put: async (key, png) => writeFileSync(join(frames, `${key}.png`), png),
        },
      });
    }, { flags: choice.comfyFlags });
    const written = await publishStrips(join(REPO, 'games', 'unity'), object, strips);
    // (R12: one row a animation, each strip whole: for the eye)
    const sheet = join(cache.work, 'sheets', `strips-${object}`);
    await writeSheet(
      [...strips.anims].sort((a, b) => a[0] - b[0]).map(([index, a]) => [{ png: encodePng(a.strip), caption: `${object} anim ${index}: ${a.frames} frames, ${a.loop ? 'loops' : a.next !== undefined ? `then ${a.next}` : 'holds'}, ${Math.round(a.delays.reduce((x, y) => x + y, 0))} ms` }]),
      sheet, { cell: [1400, 220] },
    );
    log(`strip sheet ${sheet}.png`);
    log(`published ${object}: ${strips.anims.size} animations (${strips.frames} frames, ${strips.shadowPixels} shadow pixels smoothed), pixel height ${strips.pixelHeight}, ${written.length} files in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    return 0;
  }
  if (cmd === 'card') {
    const [object, frame] = rest;
    if (!object || !frame) {
      log(USAGE);
      return 2;
    }
    const file = loadModels(readFileSync(MODELS, 'utf8'));
    const models = modelsFor(file, defaultChoice(file));
    const t0 = Date.now();
    const frameBytes = new Uint8Array(readFileSync(frame));
    const { png, metaDir } = await withGenerator(cache, async g => {
      const used = await checkPins(defaultChoice(file), { generator: g, models: file, cache, external: !!process.env.COMFY_URL, warn: log }, ['upscaler']);
      const made = await makeCard(g, models, frameBytes);
      const info = await g.info();
      return { png: made, metaDir: await writeCardMeta(cache, object, { models: used, frame: frameBytes, card: made, comfyui: info.comfyui, torch: info.torch, now: t0 }) };
    }, { flags: defaultChoice(file).comfyFlags });
    log(`card run recorded in ${metaDir}`);
    const { file: out } = await publishCard(join(REPO, 'games', 'unity'), object, png);
    const img = decodePng(png);
    log(`published ${object}'s card ${out} (${img.width}x${img.height}) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    return 0;
  }
  if (cmd === 'blender') {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { params: { type: 'string', default: '{}' }, out: { type: 'string' } } });
    const script = positionals[0];
    if (!script || !values.out) {
      log(USAGE);
      return 2;
    }
    if (!blenderPath()) {
      log('art blender needs Blender: set $BLENDER or install it at /Applications/Blender.app');
      return 2;
    }
    const r = await runBlender(resolve(script), resolve(values.out), JSON.parse(values.params!) as Record<string, unknown>, { log });
    log(`wrote ${values.out} with Blender ${r.version} in ${r.seconds.toFixed(1)} s`);
    return 0;
  }
  if (cmd === 'sheet') {
    // R11: the last good run of a plate recipe: original | plate | alignment overlay | the recipe's references
    const id = rest[0];
    const file = id ? join(REPO, 'art', 'recipes', `${id}.yaml`) : '';
    if (!id || !/^plate\.[a-z]+$/.test(id) || !existsSync(file)) {
      log(USAGE);
      return 2;
    }
    const recipe = parseRecipe(readFileSync(file, 'utf8'), file);
    if (recipe.kind !== 'repaint' || !('ship' in recipe.source)) {
      log(`${id} is not a plate recipe`);
      return 2;
    }
    const last = JSON.parse(readFileSync(join(cache.work, id, 'last.json'), 'utf8')) as { dir: string };
    const read = (f: string): Uint8Array => new Uint8Array(readFileSync(join(last.dir, f)));
    const cells: Cell[] = [
      { png: new Uint8Array(readFileSync(shipOriginal(cache, recipe.source.ship))), caption: `${id} original` },
      { png: read('plate.png'), caption: 'plate' },
      { png: read('align-overlay.png'), caption: 'alignment' },
      ...recipe.reference.flatMap(r => r.refs).map(ref => ({ png: new Uint8Array(readFileSync(refFile(join(cache.root, 'refs'), ref, allManifests()))), caption: ref })),
    ];
    const out = join(cache.work, 'sheets', id);
    await writeSheet([cells], out, { cell: [480, 360] });
    log(`sheet ${out}.png`);
    return 0;
  }
  /** InsightFace likeness of each run's smooth and pixel pictures (face.ts), when the recipe has held-out frames and the face venv exists. */
  function avatarScores(recipe: AvatarRecipe, cache: ReturnType<typeof artCache>, runs: AvatarRun[], log: (m: string) => void): Record<string, FaceScore | null> {
    const id = recipe.identity;
    if (!id || id.holdout.length === 0) return {};
    const py = facePython(cache.root);
    if (!py) {
      log('likeness scores skipped: no face venv (FACE_PY, or <cache>/venv-face with insightface)');
      return {};
    }
    const refsDir = join(cache.root, 'refs');
    const others: Record<string, string[]> = {};
    for (const o of id.others) (others[o.split('.')[1] ?? o] ??= []).push(refFile(refsDir, o));
    // a grab portrait is a show frame: held-out frames from its episode would score it against itself, so none of them count
    const show = allManifests().find(m => recipe.grab?.ref && recipe.grab.ref in m.refs);
    const grabItem = show && recipe.grab?.ref ? show.refs[recipe.grab.ref]!.item : undefined;
    const target = id.holdout.filter(h => !grabItem || show!.refs[h]?.item !== grabItem);
    if (target.length < id.holdout.length) log(`likeness: ${id.holdout.length - target.length} held-out frame(s) from the grab's episode left out`);
    return scoreFaces(py, { target: target.map(h => refFile(refsDir, h)), others, images: runs.flatMap(r => [r.smooth, [r.small, r.smooth] as [string, string]]) });
  }
  if (cmd === 'avatar') {
    const { values: v, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { variant: { type: 'string' }, 'sheet-only': { type: 'boolean' }, 'base-only': { type: 'boolean' } } });
    const path = positionals[0];
    if (!path) {
      log(USAGE);
      return 2;
    }
    const images = process.env.IMAGES_DIR;
    if (!images) {
      log('art avatar needs IMAGES_DIR (the exported originals)');
      return 2;
    }
    const recipe = avatarRecipe.parse(parseYaml(readFileSync(path, 'utf8')));
    const models = loadModels(readFileSync(MODELS, 'utf8'));
    const choice = defaultChoice(models);
    const outDir = process.env.AVATAR_OUT ?? join(homedir(), 'pcode', 'unity-raw', 'runs', 'avatars');
    // the grab portrait (grab.ts) needs no ComfyUI: InsightFace and the matting model run in the face venv
    const grab = (): void => {
      const py = facePython(cache.root);
      if (!py) throw new Error('art avatar --variant grab needs the face venv (FACE_PY, or <cache>/venv-face with insightface, rembg and pymatting)');
      const manifests = allManifests();
      const frame = (ref: string): { file: string; crop: [number, number, number, number] } => {
        const m = manifests.find(x => ref in x.refs);
        if (!m) throw new Error(`no ref "${ref}" in any manifest`);
        const r = m.refs[ref]!;
        return { file: join(cache.root, 'refs', 'frames', r.item, `${r.ms}.png`), crop: r.crop };
      };
      const run = runGrabAvatar(recipe, { cache, imagesDir: images, frame, faceBox: file => faceBoxes(py, [file])[file] ?? null, python: py, outDir, log });
      log(`${GRAB}: ${run.dir} (${run.seconds.toFixed(0)} s)`);
    };
    const onlyGrab = v.variant === GRAB;
    if (onlyGrab && !recipe.grab) {
      log(`${recipe.id} has no grab block`);
      return 2;
    }
    if (onlyGrab && !v['sheet-only']) grab();
    // ComfyUI only when a model variant runs (or --base-only needs the upscaled portrait)
    if (!onlyGrab && (!v['sheet-only'] || v['base-only'])) await withGenerator(cache, async generator => {
      await checkPins(choice, { generator, models, cache, external: !!process.env.COMFY_URL, warn: log });
      const py = facePython(cache.root);
      // a detail pass's face box: the picture written to the work dir, InsightFace run on it
      const faceBox = py
        ? (png: Uint8Array): FaceBox | null => {
            const file = join(cache.work, 'avatars', recipe.object, 'detail-input.png');
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, png);
            return faceBoxes(py, [file])[file] ?? null;
          }
        : undefined;
      const deps = { generator, models, sdxl: modelsFor(models, choice), cache, imagesDir: images, outDir, log, faceProvider: (process.env.COMFY_URL ? 'CUDA' : 'CPU') as 'CUDA' | 'CPU', faceBox };
      if (v['base-only']) {
        const bases = await avatarBases(recipe, deps);
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, `${recipe.object}.base.png`), bases.base);
        log(`base ${join(outDir, `${recipe.object}.base.png`)}`);
        return;
      }
      if (!v['sheet-only']) for (const r of await runAvatar(recipe, deps, v.variant)) log(`${r.variant}: ${r.dir} (${r.seconds.toFixed(0)} s)`);
      if (!v['sheet-only'] && recipe.grab && !v.variant) grab();
    });
    if (v['base-only']) return 0;
    {
      const deps = { cache, imagesDir: images };
      // the sheet shows each variant's newest run, so one variant can be run again on its own
      const runs = latestRuns(recipe, cache, !!v.variant);
      // a `pixel` block added or changed since the runs: their small pictures follow it
      if (v['sheet-only']) repixelRuns(recipe, runs, gamePortrait(images, recipe.base));
      const out = join(cache.work, 'sheets', `${recipe.id}.${recipe.sheet.name}`);
      const previous = recipe.sheet.previous.map(n => newestRun(recipe, cache, n)).filter((r): r is AvatarRun => !!r);
      const scores = avatarScores(recipe, cache, [...previous, ...runs], log);
      if (Object.keys(scores).length) writeFileSync(`${out}.scores.json`, `${JSON.stringify(Object.fromEntries(runs.map(r => [r.variant, { smooth: scores[r.smooth], pixel: scores[r.small] }])), null, 2)}\n`);
      for (const r of runs) if (scores[r.smooth] !== undefined) log(`likeness ${r.variant}: smooth ${scoreLabel(scores[r.smooth])}, pixel ${scoreLabel(scores[r.small])}`);
      const rows = sheetRows(recipe, deps, runs, scores, previous);
      const side = Math.min(384, Math.floor(recipe.sheet.maxWidth / Math.max(...rows.map(r => r.length))));
      await writeSheet(rows, out, { cell: [side, side], label: true });
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, `${recipe.object}.${recipe.sheet.name}.png`), readFileSync(`${out}.png`));
      log(`sheet ${join(outDir, `${recipe.object}.${recipe.sheet.name}.png`)}`);
      const pick = recipe.pick && runs.find(r => r.variant === recipe.pick);
      if (pick) {
        writeFileSync(join(outDir, `${recipe.object}.png`), readFileSync(pick.small));
        log(`pick ${recipe.pick}: ${join(outDir, `${recipe.object}.png`)}`);
      }
    }
    return 0;
  }
  if (cmd === 'avatars') {
    // one row per recipe from the cache (art avatar ran each): game portrait, a show frame, the pick smooth and its pixel version (large)
    const { values: v, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { name: { type: 'string', default: 'crew.compare' } } });
    const images = process.env.IMAGES_DIR;
    if (!images || positionals.length === 0) {
      log(images ? USAGE : 'art avatars needs IMAGES_DIR (the exported originals)');
      return 2;
    }
    const outDir = process.env.AVATAR_OUT ?? join(homedir(), 'pcode', 'unity-raw', 'runs', 'avatars');
    const refsDir = join(cache.root, 'refs');
    const rows: Cell[][] = [];
    for (const path of positionals) {
      const recipe = avatarRecipe.parse(parseYaml(readFileSync(path, 'utf8')));
      const pick = recipe.pick && newestRun(recipe, cache, recipe.pick);
      if (!pick) {
        log(`${recipe.id}: no run of its pick (${recipe.pick ?? 'none'}): left out`);
        continue;
      }
      const scoresFile = join(cache.work, 'sheets', `${recipe.id}.${recipe.sheet.name}.scores.json`);
      const scores = existsSync(scoresFile) ? (JSON.parse(readFileSync(scoresFile, 'utf8')) as Record<string, { smooth: FaceScore | null; pixel: FaceScore | null }>)[pick.variant] : undefined;
      const game = gamePortrait(images, recipe.base);
      const ref = recipe.identity?.holdout[0] ?? recipe.identity?.refs[0];
      rows.push([
        { png: encodePng(game), caption: `${recipe.object} game` },
        ref ? { png: new Uint8Array(readFileSync(refFile(refsDir, ref))), caption: ref.replace(/^crew\.[a-z_]+\./, 'ref ') } : { png: encodePng(game), caption: 'no show refs' },
        { png: new Uint8Array(readFileSync(pick.smooth)), title: pick.variant, caption: scores ? scoreLabel(scores.smooth) : 'smooth' },
        { png: new Uint8Array(readFileSync(pick.small)), title: 'pixel', caption: scores ? scoreLabel(scores.pixel) : 'no score' },
      ]);
    }
    // three cells of 360x512, then the pixel pick at 512 (twice its 256 px avatar, nearest, so the pixels stay square): 1592 px wide
    const out = join(cache.work, 'sheets', v.name!);
    await writeSheet(rows.map(r => r.slice(0, 3)), `${out}.left`, { cell: [360, 512], label: true });
    await writeSheet(rows.map(r => [{ ...r[3]!, png: encodePng(nearestResize(decodePng(r[3]!.png), 512, 512)) }]), `${out}.right`, { cell: [512, 512], label: true });
    const left = decodePng(new Uint8Array(readFileSync(`${out}.left.png`)));
    const right = decodePng(new Uint8Array(readFileSync(`${out}.right.png`)));
    const sheet: Rgba = { width: left.width + right.width, height: left.height, data: new Uint8Array((left.width + right.width) * left.height * 4) };
    for (let y = 0; y < left.height; y++) {
      sheet.data.set(left.data.subarray(y * left.width * 4, (y + 1) * left.width * 4), y * sheet.width * 4);
      sheet.data.set(right.data.subarray(y * right.width * 4, (y + 1) * right.width * 4), (y * sheet.width + left.width) * 4);
    }
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, `${v.name}.png`), encodePng(sheet));
    log(`sheet ${join(outDir, `${v.name}.png`)}`);
    return 0;
  }
  if (cmd === 'panel' && rest[0] === 'publish') {
    // the away team's panel (awayteam.mrg) from the game zip, as it is: 4x nearest-neighbour, lossless WebP, art.panel
    const zip = gameZip();
    const written = await publishPanel(join(REPO, 'games', 'unity'), await readZipMember(zip, 'awayteam.mrg'), await readZipMember(zip, 'standard.pal'));
    log(`published the panel: ${written.length} sprites under games/unity/art/panel`);
    return 0;
  }
  if (cmd === 'phaser' && rest[0] === 'publish') {
    // how a phaser shot is drawn: the executable's muzzle table (RAW_DIR's executable.json) and the beam's palette colours (standard.pal), art.phaser
    const raw = process.env.RAW_DIR;
    if (!raw) {
      log('art phaser publish needs RAW_DIR (the raw export, for the executable\'s muzzle table)');
      return 2;
    }
    const exe = JSON.parse(readFileSync(join(raw, 'executable.json'), 'utf8')) as { _phaserMuzzles: { x: number; y: number; frame: number }[] };
    const ids = parseYaml(readFileSync(join(REPO, 'games', 'unity', 'ids.yaml'), 'utf8')) as { objects: Record<string, string> };
    const table = phaserTable(exe._phaserMuzzles, ids.objects, await readZipMember(gameZip(), 'standard.pal'));
    await publishPhaser(join(REPO, 'games', 'unity'), table);
    log(`published the phaser's table: ${table.muzzles.length} muzzles for ${table.crew.join(', ')}`);
    return 0;
  }
  if (cmd === 'cursors' && rest[0] === 'publish') {
    // the away team's pointers (cursor.dat) from the game zip, as they are: each verb's pointer and its lit one, the exit arrows; 4x nearest-neighbour, lossless WebP, art.cursors
    const zip = gameZip();
    const written = await publishCursors(join(REPO, 'games', 'unity'), await readZipMember(zip, 'cursor.dat'), await readZipMember(zip, 'standard.pal'));
    log(`published the pointers: ${written.length} under games/unity/art/cursors`);
    return 0;
  }
  if (cmd === 'tricorder' && rest[0] === 'publish') {
    // the tricorder viewer's frame (tricord.spr) and buttons (tricord.mrg) from the game zip, as they are: 4x nearest-neighbour, lossless WebP, art.tricorder
    const zip = gameZip();
    const written = await publishTricorder(join(REPO, 'games', 'unity'), await readZipMember(zip, 'tricord.spr'), await readZipMember(zip, 'tricord.mrg'), await readZipMember(zip, 'standard.pal'));
    log(`published the tricorder: ${written.length} pictures under games/unity/art/tricorder`);
    return 0;
  }
  if (cmd === 'admin' && rest[0] === 'publish') {
    // the admin console (adminmnu.spr, adminmnu.mrg), the F1 Combat Options screen (final.spr) and the SETTINGS button and tab words made from them,
    // from the game zip: 4x nearest-neighbour, lossless WebP, art.admin; with the HD repaints' last runs (plate.admin, plate.final) beside them
    const zip = gameZip();
    const plates = await adminPlates(cache);
    const written = await publishAdmin(join(REPO, 'games', 'unity'), await readZipMember(zip, 'adminmnu.spr'), await readZipMember(zip, 'adminmnu.mrg'), await readZipMember(zip, 'final.spr'), await readZipMember(zip, 'standard.pal'), { plates });
    log(`published the admin console: ${written.length} pictures under games/unity/art/admin${Object.keys(plates).length > 0 ? ` (HD repaints: ${Object.keys(plates).join(', ')})` : ' (no HD repaint runs)'}`);
    return 0;
  }
  if (cmd === 'astro' && rest[0] === 'publish') {
    // the astrogation course panel's sprites (astro.mrg 70-86, over astropnl.ast's palette) from the game zip, as they are: 4x nearest-neighbour, lossless WebP, art.astro
    const zip = gameZip();
    // (and the screen's tables, from the executable in STTNGINS.ZIP beside it: labels, planet sizes and descriptions, colours)
    const ovl = await readZipMember(join(dirname(zip), 'STTNGINS.ZIP'), 'STTNG.OVL');
    const written = await publishAstro(join(REPO, 'games', 'unity'), await readZipMember(zip, 'astro.mrg'), await readZipMember(zip, 'astropnl.ast'), await readZipMember(zip, 'standard.pal'), { ovl, engine: await readZipMember(zip, 'engine.spr'), fonts: await Promise.all(Array.from({ length: 10 }, (_, i) => readZipMember(zip, `font${i}.fon`))) });
    log(`published the astrogation sprites and tables: ${written.length} sprites under games/unity/art/astro`);
    return 0;
  }
  if (cmd === 'sensor' && rest[0] === 'publish') {
    // the bridge strip's Viewscreen button (sensor.mrg entries 3 and 1, over bridge.rm's palette) from the game zip, as it is: 4x nearest-neighbour, lossless WebP, art.sensor
    const zip = gameZip();
    const written = await publishSensor(join(REPO, 'games', 'unity'), await readZipMember(zip, 'sensor.mrg'), await readZipMember(zip, 'bridge.rm'), await readZipMember(zip, 'standard.pal'));
    log(`published the bridge strip's buttons: ${written.length} under games/unity/art/sensor`);
    return 0;
  }
  if (cmd === 'transporter' && rest[0] === 'publish') {
    // the transporter room's console pictures (transp.mrg, over transp.rm's palette) from the game zip, as they are: 4x nearest-neighbour, lossless WebP, art.transporter
    const zip = gameZip();
    // (and the map's: tmaps.spr, the scan's two lines and the lock's blip)
    const map = { tmaps: await readZipMember(zip, 'tmaps.spr'), beamhori: await readZipMember(zip, 'beamhori.spr'), beamvert: await readZipMember(zip, 'beamvert.spr'), tranblip: await readZipMember(zip, 'tranblip.spr') };
    const written = await publishTransporter(join(REPO, 'games', 'unity'), await readZipMember(zip, 'transp.mrg'), await readZipMember(zip, 'transp.rm'), await readZipMember(zip, 'standard.pal'), { map });
    log(`published the transporter sprites: ${written.length} under games/unity/art/transporter`);
    return 0;
  }
  if (cmd === 'engineering' && rest[0] === 'publish') {
    // the engineering screen's picture and sprites (eng00a.pic, eng01b.mrg) as indices with their palette, its tables from the executable, and the game's fonts, as they are
    const zip = gameZip();
    const ovl = await readZipMember(join(dirname(zip), 'STTNGINS.ZIP'), 'STTNG.OVL');
    const fonts = await Promise.all(Array.from({ length: 10 }, (_, i) => readZipMember(zip, `font${i}.fon`)));
    // (the English eng00a.pic is the loose file beside the zip, which the engine finds first; the zip's own is the German one)
    const loose = readdirSync(dirname(zip)).find(f => f.toLowerCase() === 'eng00a.pic');
    const written = await publishEngineering(join(REPO, 'games', 'unity'), {
      pic: loose ? new Uint8Array(readFileSync(join(dirname(zip), loose))) : await readZipMember(zip, 'eng00a.pic'), mrg: await readZipMember(zip, 'eng01b.mrg'), ovl, standardPal: await readZipMember(zip, 'standard.pal'), fonts,
    });
    log(`published the engineering screen: ${written.length} files under games/unity/art/engineering and art/fonts`);
    return 0;
  }
  if (cmd === 'holodeck' && rest[0] === 'publish') {
    // the holodeck's picture (holodeck.rm) and the choice dialog's frame (dialog.mrg) as indices with their palette, and the game's fonts, as they are
    const zip = gameZip();
    const fonts = await Promise.all(Array.from({ length: 10 }, (_, i) => readZipMember(zip, `font${i}.fon`)));
    const written = await publishHolodeck(join(REPO, 'games', 'unity'), {
      rm: await readZipMember(zip, 'holodeck.rm'), dialog: await readZipMember(zip, 'dialog.mrg'), standardPal: await readZipMember(zip, 'standard.pal'), fonts,
    });
    log(`published the holodeck screen: ${written.length} files under games/unity/art/holodeck and art/fonts`);
    return 0;
  }
  if (cmd === 'publish-kit') {
    // the away team's portraits and the kit's icons, from the picks art avatar and art icon wrote (AVATAR_OUT), to the game's art/ (lossless WebP)
    const outDir = process.env.AVATAR_OUT ?? join(homedir(), 'pcode', 'unity-raw', 'runs', 'avatars');
    const recipes = join(REPO, 'art', 'recipes');
    const ids = (kind: string): string[] => readdirSync(recipes).flatMap(f => (new RegExp(`^${kind}\\.([a-z0-9_]+)\\.yaml$`).exec(f)?.[1] ?? []));
    const speakers: Record<string, string[]> = {};
    for (const id of ids('avatar')) {
      const r = avatarRecipe.parse(parseYaml(readFileSync(join(recipes, `avatar.${id}.yaml`), 'utf8')));
      if (r.speakers.length) speakers[id] = r.speakers;
    }
    const kit = await findKit(outDir, ids('avatar'), ids('icon'), speakers);
    const written = await publishKit(join(REPO, 'games', 'unity'), kit);
    log(`published ${Object.keys(kit.portraits).length} portraits and ${Object.keys(kit.icons).length} icons from ${outDir}: ${written.join(', ')}`);
    return 0;
  }
  if (cmd === 'icon') {
    const { values: v, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { variant: { type: 'string' }, 'sheet-only': { type: 'boolean' }, name: { type: 'string', default: 'kit.compare' } } });
    const images = process.env.IMAGES_DIR;
    if (!images || positionals.length === 0) {
      log(images ? USAGE : 'art icon needs IMAGES_DIR (the exported originals)');
      return 2;
    }
    const recipes = positionals.map(p => iconRecipe.parse(parseYaml(readFileSync(p, 'utf8'))));
    const models = loadModels(readFileSync(MODELS, 'utf8'));
    const choice = defaultChoice(models);
    const outDir = process.env.AVATAR_OUT ?? join(homedir(), 'pcode', 'unity-raw', 'runs', 'avatars');
    const readGame = (member: string): Promise<Uint8Array> => readZipMember(gameZip(), member);
    if (!v['sheet-only'])
      await withGenerator(cache, async generator => {
        await checkPins(choice, { generator, models, cache, external: !!process.env.COMFY_URL, warn: log });
        const deps = { generator, sdxl: modelsFor(models, choice), cache, imagesDir: images, readGame, log };
        for (const r of recipes) for (const run of await runIcon(r, deps, v.variant)) log(`${r.id} ${run.variant}: ${run.dir} (${run.seconds.toFixed(0)} s)`);
      });
    // one row per item: the game icon, then each variant smooth and pixel (the pick first), the pick written as item.<object>.png
    const rows: Cell[][] = [];
    mkdirSync(outDir, { recursive: true });
    for (const r of recipes) {
      const icon = await iconSource(r, { imagesDir: images, readGame });
      const row: Cell[] = [{ png: encodePng(icon), caption: `${r.object} game` }];
      const names = [...r.variants.map(x => x.name)].sort((a, b) => (a === r.pick ? -1 : b === r.pick ? 1 : 0));
      for (const n of names) {
        const run = newestIconRun(cache, r.object, n);
        if (!run) continue;
        row.push({ png: new Uint8Array(readFileSync(run.smooth)), title: n, caption: 'smooth' }, { png: new Uint8Array(readFileSync(run.pixel)), title: n === r.pick ? 'pick' : '', caption: 'pixel' });
        if (n === r.pick) writeFileSync(join(outDir, `item.${r.object}.png`), readFileSync(run.pixel));
      }
      rows.push(row);
    }
    const cols = Math.max(...rows.map(r => r.length));
    const side = Math.min(320, Math.floor(1600 / cols));
    const out = join(cache.work, 'sheets', v.name!);
    await writeSheet(rows, out, { cell: [side, Math.round((side * 48) / 52)], label: true });
    writeFileSync(join(outDir, `${v.name}.png`), readFileSync(`${out}.png`));
    log(`sheet ${join(outDir, `${v.name}.png`)}`);
    return 0;
  }
  if (cmd === 'compare') {
    const { values: v, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { family: { type: 'string' }, variant: { type: 'string' }, fresh: { type: 'boolean' }, 'sheet-only': { type: 'boolean' }, wait: { type: 'string' } } });
    const path = positionals[0];
    if (!path) {
      log(USAGE);
      return 2;
    }
    const file = compareSchema.parse(parseYaml(readFileSync(path, 'utf8')));
    const dir = join(cache.work, 'compare', file.id);
    if (!v['sheet-only']) {
      const images = process.env.IMAGES_DIR;
      const url = process.env.COMFY_URL;
      if (!images) {
        log('art compare needs IMAGES_DIR (the exported originals)');
        return 2;
      }
      if (!url) {
        log('art compare needs COMFY_URL: the experimental models are on that server only');
        return 2;
      }
      const models = loadModels(readFileSync(MODELS, 'utf8'));
      const choice = defaultChoice(models);
      const http = new ComfyHttp(url, { fetchFn: isLoopback(url) ? undefined : curlLanFetch() });
      const doctorLines = () => remoteDoctor(url, { info: () => http.info(), objectInfo: () => http.objectInfo(), read: p => readFileSync(p, 'utf8'), pinsFile: join(TOOL, 'setup', 'pins.env'), modelsFile: MODELS });
      const wanted = (Object.keys(file.families) as (keyof typeof file.families)[]).filter(f => f !== 'sdxl' && (!v.family || v.family === f)) as ExperimentalFamily[];
      // --wait: poll the server's loader lists until every wanted family's files are there (or the minutes run out)
      const deadline = Date.now() + Number(v.wait ?? 0) * 60_000;
      for (;;) {
        const lines = await doctorLines();
        const missing = wanted.filter(f => !familyReady(lines, f));
        for (const l of lines.filter(x => x.optional)) log(`${l.ok ? 'ok  ' : 'MISS'} ${l.what}: ${l.detail}`);
        if (missing.length === 0 || Date.now() > deadline) break;
        log(`waiting for ${missing.join(', ')}: polling again in 3 minutes`);
        await new Promise(r => setTimeout(r, 180_000));
      }
      await withGenerator(cache, async generator => {
        await checkPins(choice, { generator, models, cache, external: true, warn: log });
        await runCompare(file, {
          generator,
          models,
          sdxl: modelsFor(models, choice),
          cache,
          imagesDir: images,
          gameDir: join(REPO, 'games', 'unity'),
          refsDir: join(cache.root, 'refs'),
          read: p => readFileSync(resolve(REPO, p), 'utf8'),
          ready: async f => f === 'sdxl' || familyReady(await doctorLines(), f as ExperimentalFamily),
          log,
          fresh: v.fresh,
          only: { family: v.family as never, variant: v.variant },
        });
      });
    }
    if (!existsSync(join(dir, 'results.json'))) {
      log(`no results at ${dir}: run art compare without --sheet-only first`);
      return 1;
    }
    const results = JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8')) as VariantResult[];
    const html = join(cache.work, 'sheets', 'model-compare.html');
    mkdirSync(dirname(html), { recursive: true });
    writeFileSync(html, sheetHtml({ file, results, dir, html }));
    const png = join(process.env.MODEL_COMPARE_OUT ?? join(homedir(), 'pcode', 'unity-raw', 'runs', 'model-compare'), 'sheet');
    await contactSheet({ file, results, dir, html }, png);
    const yamlOut = path.replace(/\.ya?ml$/, '.results.yaml');
    writeFileSync(yamlOut, resultsYaml(file, results));
    log(`sheet ${html}\ncontact sheet ${png}.png\nnumbers ${yamlOut}`);
    return 0;
  }
  if (cmd === 'run' || cmd === 'verify') {
    const path = rest[0];
    if (!path) {
      log(USAGE);
      return 2;
    }
    const text0 = readFileSync(path, 'utf8');
    const recipe0 = parseRecipe(text0, path);
    if (recipe0.kind === 'blender') {
      if (cmd === 'verify') {
        log('art verify is for repaint and texture recipes');
        return 2;
      }
      const { dir, meta } = await runBlenderRecipe(recipe0, text0, cache, { log });
      log(`wrote ${dir} with Blender ${meta.blender} in ${meta.seconds.toFixed(1)} s: ${meta.outputs.glb.file}`);
      return 0;
    }
    if (recipe0.kind === 'material') {
      if (cmd === 'verify') {
        log('art verify is for repaint and texture recipes');
        return 2;
      }
      const { dir, meta } = await runMaterialRecipe(recipe0, text0, cache, { log }).catch(e => {
        log(String(e instanceof Error ? e.message : e));
        return { dir: '', meta: undefined };
      });
      if (!meta) return 1;
      log(`baked ${recipe0.id} in ${meta.seconds.toFixed(1)} s (seam ${meta.checks.seam.after.toFixed(2)}, coarse ${meta.checks.seam.coarse.toFixed(2)}): ${dir}`);
      return 0;
    }
    if (recipe0.kind === 'ship') {
      log('use art ship build for a ship recipe');
      return 2;
    }
    const images = process.env.IMAGES_DIR;
    // a ship source reads the cache's decoded originals, so only a room recipe needs the images export
    if (!images && recipe0.kind === 'repaint' && 'background' in recipe0.source) {
      log(`art ${cmd} needs IMAGES_DIR (the exported originals, e.g. ~/pcode/unity-raw/runs/images/media)`);
      return 2;
    }
    const text = readFileSync(path, 'utf8');
    const recipe = parseRecipe(text, path);
    const models = loadModels(readFileSync(MODELS, 'utf8'));
    const flags = models.selected?.comfyFlags ?? [];
    return withGenerator(
      cache,
      async generator => {
        const deps = { generator, models, cache, imagesDir: images, flags, external: !!process.env.COMFY_URL, warn: log };
        if (cmd === 'run') {
          const { dir, meta } = await runRecipe(recipe, text, deps);
          log(`wrote ${dir} in ${meta.seconds.toFixed(0)} s: ${Object.keys(meta.outputs).join(', ')}`);
          return 0;
        }
        const v = await verifyRecipe(recipe, text, deps);
        log(`${v.ok ? 'ok' : 'FAIL'} ${v.detail}`);
        return v.ok ? 0 : 1;
      },
      { flags },
    );
  }
  log(USAGE);
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runArt(process.argv.slice(2), l => console.log(l)).then(
    code => process.exit(code),
    e => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}

/** The floor's scale (out of 256) at a pixel of the screen, over its open regions' polygons: Screen::scaleAt. 256 without a floor. */
function floorScaleAt(screen: string, x: number, y: number): number {
  const [world, slug] = screen.split('.');
  const yaml = parseYaml(readFileSync(join(REPO, 'games', 'unity', 'screens', world!, `${slug}.yaml`), 'utf8')) as { regions?: Record<string, boolean>; pixelMetric?: { floor: { region: string; points: { x: number; y: number; scale: number }[] }[] } };
  const open = yaml.pixelMetric?.floor.filter(poly => yaml.regions?.[poly.region] === true) ?? [];
  return open.length === 0 ? 256 : new WalkFloor(open.map(poly => poly.points)).scaleAt({ x, y });
}

/** Cuts the screen's masks from its published plate (games/unity/art/rooms/<world>/<sNN>/plate.webp) and sets them in presentation.yaml. */
async function cutMasks(screen: string, imagesDir: string, rawDir: string, log: (line: string) => void): Promise<string[]> {
  const gameDir = join(REPO, 'games', 'unity');
  const [world, slug] = screen.split('.');
  const plate = await readWebp(join(gameDir, 'art', 'rooms', world!, slug!, 'plate.webp'));
  const masks = await findMasks({ rawDir, imagesDir, gameDir }, screen);
  for (const m of masks) log(`${screen}: mask ${m.object} (${m.sprite}) at ${m.rect.join(',')}, sorted by row ${m.depth}`);
  // the screen's props (card recipes with a `prop`): their published card, in a mask's place
  const props: PropLayer[] = [];
  const recipes = join(REPO, 'art', 'recipes');
  for (const file of readdirSync(recipes).filter(f => /^card\..*\.yaml$/.test(f)).sort()) {
    const recipe = parseRecipe(readFileSync(join(recipes, file), 'utf8'), file);
    if (recipe.kind !== 'card' || !recipe.prop || ![recipe.prop.screen, ...recipe.prop.screens].includes(screen)) continue;
    const source = join(gameDir, 'art', 'cards', recipe.object, `${recipe.prop.anim}.webp`);
    // (an animated prop's animation is a grid file, or an atlas: pages and a record)
    const published = (anim: number): boolean => existsSync(join(gameDir, 'art', 'cards', recipe.object, `${anim}.webp`)) || existsSync(join(gameDir, 'art', 'cards', recipe.object, `${anim}.0.webp`)) || existsSync(join(gameDir, 'art', 'cards', recipe.object, `${anim}.json`));
    if (!published(recipe.prop.anim)) {
      log(`${screen}: ${recipe.id} has no published card yet (art batch art/recipes/${file}): its props are not drawn`);
      continue;
    }
    const animated = recipe.prop.animate.length > 0;
    const size = animated ? null : webpSize(new Uint8Array(readFileSync(source)));
    for (const p of await findProps({ rawDir, imagesDir, gameDir }, screen, recipe.prop.objects, recipe.prop.anim, recipe.prop.screens.length > 0)) {
      if (animated) {
        // (Batch 8: the layer draws the frame the object's animation is on: every animation the recipe publishes, and the ones they fall into)
        const sprite = loadSprite(imagesDir, recipe);
        const strips: PropStrip[] = [];
        const want = [recipe.prop.anim, ...recipe.prop.animate];
        for (const anim of want) {
          if (strips.some(t => t.anim === anim)) continue;
          const plain = stripLayout(sprite, anim, { x: p.origin[0], y: p.origin[1] });
          if (!plain) throw new Error(`${recipe.id}: ${recipe.sprite} has no animation ${anim}`);
          // (a strip that holds each distinct frame once has a record beside it)
          const pack = await readStripPack(gameDir, recipe.object, plain.anim);
          const layout = pack ? stripLayout(sprite, anim, { x: p.origin[0], y: p.origin[1] }, pack)! : plain;
          const stripFile = join(gameDir, 'art', 'cards', recipe.object, `${layout.anim}.webp`);
          if (!published(layout.anim)) {
            if (anim === recipe.prop.anim) throw new Error(`${recipe.id}: the starting animation ${anim} has no published strip (art batch art/recipes/${file})`);
            log(`${screen}: ${p.object} has no published strip of animation ${anim} yet: it falls back to the still when the object plays it`);
            continue;
          }
          strips.push({ anim, source: stripFile, layout });
          if (layout.next !== undefined) want.push(layout.next);
        }
        const scale = p.walkType === 1 ? floorScaleAt(screen, p.rect[0] + Math.trunc(p.rect[2] / 2), p.rect[1] + p.rect[3]) : 256;
        // (drawn at the floor's scale where it stands, a walker-type object: the layer's rectangles shrink about the sprite's origin, the pictures are drawn into them as they are)
        if (scale < 256) log(`${screen}: ${p.object} is drawn at scale ${scale}/256 there`);
        log(`${screen}: animated prop ${p.object} (${p.sprite}, ${recipe.id}) at ${p.rect.join(',')}, sorted by row ${p.depth}, animations ${strips.map(t => t.anim).join(', ')} (${strips.reduce((n, t) => n + t.layout.frames, 0)} frames)`);
        const talk = recipe.prop.talk === undefined ? undefined : { anim: canonicalAnim(sprite, recipe.prop.talk), idle: replyAnims(sprite)?.idle ?? -1 };
        if (talk && !strips.some(t => t.layout.anim === talk.anim)) log(`${screen}: ${p.object} has no published strip of its talk animation ${talk.anim} yet: it will not talk`);
        props.push({ object: p.object, source, rect: p.rect, depth: p.depth, anim: recipe.prop.anim, strips, scale, origin: p.origin, ...(p.home ? { home: p.home } : {}), ...(p.mouth ? { mouth: p.mouth } : {}), ...(talk ? { talk } : {}) });
        continue;
      }
      // (an animation's strip is cells of the frame's size: its first cell, frame 0, is the still)
      if (!size || size.width % (p.rect[2] * 4) !== 0 || size.height % (p.rect[3] * 4) !== 0) throw new Error(`${recipe.id}: ${source} is ${size?.width}x${size?.height}, not whole cells of the sprite's frame ${p.rect[2] * 4}x${p.rect[3] * 4}`);
      log(`${screen}: prop ${p.object} (${p.sprite}, ${recipe.id}) at ${p.rect.join(',')}, sorted by row ${p.depth}`);
      // (a walker-type object, the trapped woman, is drawn at the floor's scale where she stands, not the frame's size)
      const scale = p.walkType === 1 ? floorScaleAt(screen, p.rect[0] + Math.trunc(p.rect[2] / 2), p.rect[1] + p.rect[3]) : 256;
      if (scale < 256) log(`${screen}: ${p.object} is drawn at scale ${scale}/256 there`);
      props.push({ object: p.object, source, rect: p.rect, depth: p.depth, scale, origin: p.origin, ...(p.home ? { home: p.home } : {}), ...(p.mouth ? { mouth: p.mouth } : {}) });
    }
  }
  return publishMasks(gameDir, screen, plate, masks, {
    report: r => {
      const mb = (n: number): string => `${(n / 1048576).toFixed(1)} MB`;
      log(`${screen}: animated layers keep ${mb(r.bytes)} resident (${mb(r.encoded)} of it encoded pages of streamed layers; ${r.objects.map(o => `${o.object} ${mb(o.bytes)}${o.mode === 'whole' ? ' whole' : ''}`).join(', ')}); budget ${mb(r.budget)}`);
      if (r.over) log(`WARNING ${screen}: its animated layers keep ${mb(r.bytes)} resident, over the ${mb(r.budget)} budget a lean device is trusted with: crop, thin or split the animations`);
    },
  }, props);
}
