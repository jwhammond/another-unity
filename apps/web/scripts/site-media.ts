// SPDX-License-Identifier: GPL-3.0-or-later
// `npm run site:media`: the site's pictures, made from the local game data into apps/web/public/site-media/ (git-ignored) with a manifest.
// Without games/unity/presentation.yaml it writes an empty manifest, so every Figure shows its placeholder. docs/site.md.
//   GAMEDATA_DIR, RAW_DIR, IMAGES_DIR as for tools/art; GAMES_DIR overrides games/unity (tests, dry runs).
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { addItem, newManifest, serialize, type MediaEntry, type MediaManifest } from './siteMedia/manifest';
import { avatarOriginal, flat, nearest, readPublished, roomOriginal, scaleTo, strokeRect, writeWebp, GOLD, type Written } from './siteMedia/sources';
import { frameAt, gridSheet } from './siteMedia/sheet';
import { crop, sceneRect } from './siteMedia/crop';
import { fitCell, selectCards } from './siteMedia/characters';
import { renderEngineering, renderHolodeck } from './siteMedia/screens';
import { captureAstrogation } from './siteMedia/astroShot';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const OUT = fileURLToPath(new URL('../public/site-media/', import.meta.url));
/** Where a run builds: outside public/, so a killed run's leftovers can never be copied into a deploy. Git-ignored. */
const STAGE = fileURLToPath(new URL('../.site-media.tmp', import.meta.url));
const MAX_FRAMES = 12;
const SHEET_WIDTH = 960;
const SHIP_STATIONS = ['bridge', 'viewscreen', 'transporter', 'astrogation', 'computer'];

type Art = {
  rooms: Record<string, { plate: string; masks?: { object: string; image?: string; card?: boolean }[] }>;
  cards: Record<string, { anims?: Record<string, { image?: string; frames: number; cell: [number, number]; columns?: number }> }>;
  ship: Record<string, { plate?: string }>;
  portraits: Record<string, string>;
  icons: Record<string, string>;
};

/** Builds into `stage` and swaps it in only on success (the old set is moved aside first and put back if the swap fails), so a failed or refused run never destroys a good set. */
export async function build(env: NodeJS.ProcessEnv = process.env, target = OUT, stage = STAGE, rename: typeof renameSync = renameSync): Promise<MediaManifest> {
  const gameDir = env.GAMES_DIR ?? join(REPO, 'games/unity');
  const hasGame = existsSync(join(gameDir, 'presentation.yaml'));
  // (the rooms' before pictures come from the exported originals: without them the set would silently lack every room pair and portrait)
  if (hasGame && !(env.IMAGES_DIR && existsSync(env.IMAGES_DIR))) {
    throw new Error(`site:media: the game data is here but IMAGES_DIR ${env.IMAGES_DIR ? `(${env.IMAGES_DIR}) does not exist` : 'is not set'}: `
      + 'set IMAGES_DIR to the exported originals (runs/images/media, see docs/unity-local.md). Nothing was changed.');
  }
  const dest = target.replace(/[\\/]+$/, '');
  const out = stage.replace(/[\\/]+$/, '');
  const old = `${out}-old`;
  const manifest = newManifest();
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const finish = () => {
    writeFileSync(join(out, 'manifest.json'), serialize(manifest));
    rmSync(old, { recursive: true, force: true });
    const had = existsSync(dest);
    if (had) rename(dest, old);
    try {
      rename(out, dest);
    } catch (e) {
      if (had) rename(old, dest);
      throw e;
    }
    rmSync(old, { recursive: true, force: true });
    return manifest;
  };
  try {
    return await run();
  } catch (e) {
    rmSync(out, { recursive: true, force: true });
    throw e;
  }

  async function run(): Promise<MediaManifest> {
  if (!hasGame) {
    console.log(`site:media: no games/unity/presentation.yaml here: cleared ${dest} and wrote an empty manifest (the site shows placeholders).`);
    return finish();
  }
  const art = (parse(readFileSync(join(gameDir, 'presentation.yaml'), 'utf8')) as { art: Art }).art;
  const imagesDir = env.IMAGES_DIR ?? '';
  const recipes = join(REPO, 'art/recipes');
  const counts: Record<string, number> = {};
  let bytes = 0;
  const add = (id: string, e: MediaEntry, ...w: Written[]) => {
    addItem(manifest, id, e);
    counts[e.kind] = (counts[e.kind] ?? 0) + 1;
    for (const x of w) bytes += x.bytes;
  };
  const skipped: string[] = [];
  const write = async (img: Parameters<typeof writeWebp>[0], name: string): Promise<Written> => writeWebp(img, out, name);

  // home.afu and the ship stations
  for (const st of SHIP_STATIONS) {
    const rel = art.ship[st]?.plate;
    if (!rel || !existsSync(join(gameDir, rel))) { skipped.push(`ship.${st}`); continue; }
    const img = scaleTo(await readPublished(gameDir, rel), st === 'bridge' ? 1280 : 960);
    const w = await write(img, `ship-${st}.webp`);
    add(`ship.${st}`, { src: w.src, w: w.w, h: w.h, alt: `The ${st} screen of the remake`, kind: 'shot' }, w);
    if (st === 'bridge') add('home.afu', { src: w.src, w: w.w, h: w.h, alt: 'The bridge of the Enterprise-D in the remake', kind: 'shot' });
  }

  // engineering and the holodeck are drawn by the game from packed indexed data: the engine's own renderers, in node, in the original's palette
  for (const [id, draw] of [['engineering', renderEngineering], ['holodeck', renderHolodeck]] as const) {
    const img = await draw(gameDir);
    if (!img) { skipped.push(`ship.${id}`); continue; }
    const w = await write(scaleTo(img, 960), `ship-${id}.webp`);
    add(`ship.${id}`, { src: w.src, w: w.w, h: w.h, alt: `The ${id} screen of the remake, as a player sees it`, kind: 'shot' }, w);
  }
  // astrogation as played (map, panels, fonts) needs the game in a browser: the one opt-in step, skipped with its reason when it cannot run
  const astro = await captureAstrogation(REPO, env);
  if ('picture' in astro) {
    const w = await write(scaleTo(astro.picture, 960), 'ship-astrogation-screen.webp');
    add('ship.astrogation.screen', { src: w.src, w: w.w, h: w.h, alt: 'The astrogation screen of the remake, as a player sees it: the sector map, the panels and the information box', kind: 'shot' }, w);
  } else {
    console.log(`site:media: no astrogation screen picture: ${astro.skipped}`);
    skipped.push('ship.astrogation.screen');
  }

  // rooms: the original background and the published plate, as a pair
  const roomKeys = Object.keys(art.rooms).sort();
  for (const room of roomKeys) {
    const rel = art.rooms[room]!.plate;
    const orig = imagesDir ? await roomOriginal(recipes, imagesDir, room) : null;
    if (!orig || !existsSync(join(gameDir, rel))) { skipped.push(`room.${room}`); continue; }
    // both pictures cropped to the game's scene area (the top 400 of 480 rows; the HUD panel owns the rest), so the slider lines up
    const oImg = scaleTo(orig, 960);
    const pImg = scaleTo(await readPublished(gameDir, rel), 960);
    const box = sceneRect(960, 720);
    if (oImg.height !== 720 || pImg.height !== 720) { skipped.push(`room.${room} (not 960x720)`); continue; }
    const o = await write(crop(oImg, box), `room-${flat(room)}-orig.webp`);
    const p = await write(crop(pImg, box), `room-${flat(room)}.webp`);
    add(`room.${room}`, { src: o.src, pairSrc: p.src, w: p.w, h: p.h, alt: `Room ${room}: the original background and the remake's plate`, kind: 'pair' }, o, p);
  }

  // hotspots: one room per world, the plate with every pickable hotspot boxed in gold
  const seenWorld = new Set<string>();
  for (const room of roomKeys) {
    const [world, sNN] = room.split('.') as [string, string];
    if (seenWorld.has(world)) continue;
    const json = join(gameDir, 'rooms', world, `${sNN}.json`);
    const rel = art.rooms[room]!.plate;
    if (!existsSync(json) || !existsSync(join(gameDir, rel))) continue;
    seenWorld.add(world);
    const img = scaleTo(await readPublished(gameDir, rel), 960);
    const k = img.width / 640;
    const spots = (JSON.parse(readFileSync(json, 'utf8')) as { hotspots?: { rect?: [number, number, number, number]; pickable?: boolean }[] }).hotspots ?? [];
    for (const h of spots) if (h.rect && h.pickable !== false) strokeRect(img, h.rect.map(v => Math.round(v * k)) as [number, number, number, number], GOLD, 2);
    const w = await write(img, `hotspots-${flat(room)}.webp`);
    add(`hotspots.${room}`, { src: w.src, w: w.w, h: w.h, alt: `Room ${room} with its clickable hotspots outlined in gold`, kind: 'hotspots' }, w);
  }

  // portraits: the game's head x4 beside the published one. Names sharing a file share the pictures.
  const done = new Map<string, [Written, Written]>();
  for (const [name, rel] of Object.entries(art.portraits).sort(([a], [b]) => a.localeCompare(b))) {
    const file = rel.replace(/^.*\//, '').replace(/\.webp$/, '');
    let pair = done.get(file);
    if (!pair) {
      const orig = imagesDir ? avatarOriginal(recipes, imagesDir, file) : null;
      if (!orig || !existsSync(join(gameDir, rel))) { skipped.push(`portrait.${name}`); continue; }
      const pub = await readPublished(gameDir, rel);
      pair = [await write(nearest(orig, 4), `portrait-${flat(file)}-orig.webp`), await write(pub, `portrait-${flat(file)}.webp`)];
      done.set(file, pair);
      bytes += pair[0].bytes + pair[1].bytes;
    }
    add(`portrait.${name}`, { src: pair[0].src, pairSrc: pair[1].src, w: pair[1].w, h: pair[1].h, alt: `${name}: the original portrait and the remake's`, kind: 'portrait' });
  }

  // sprite sheets: up to 12 frames of animation 0
  for (const [card, c] of Object.entries(art.cards).sort(([a], [b]) => a.localeCompare(b))) {
    const a = c.anims?.['0'];
    if (!a?.image || !existsSync(join(gameDir, a.image))) { if (c.anims) skipped.push(`sheet.${card}`); continue; }
    const img = await readPublished(gameDir, a.image);
    const cols = a.columns ?? a.frames;
    const n = Math.min(a.frames, MAX_FRAMES);
    const frames = Array.from({ length: n }, (_, i) => frameAt(img, a.cell, cols, i));
    const perRow = Math.min(n, 6);
    const w = await write(scaleTo(gridSheet(frames, perRow), Math.min(SHEET_WIDTH, perRow * a.cell[0])), `sheet-${flat(card)}.webp`);
    add(`sheet.${card}`, { src: w.src, w: w.w, h: w.h, alt: `${card}: ${n} frames of the first animation`, kind: 'sheet' }, w);
  }

  // one sheet per world: the stills of its characters (props after them, when it has few), each fitted to a cell
  const worlds = [...new Set(roomKeys.map(r => r.split('.')[0]!))];
  for (const world of worlds) {
    const masks = roomKeys.filter(r => r.startsWith(`${world}.`)).flatMap(r => art.rooms[r]!.masks ?? []);
    const picks = selectCards(masks, 12).filter(p => existsSync(join(gameDir, p.image)));
    if (!picks.length) { skipped.push(`sheet.world.${world}`); continue; }
    const cells = await Promise.all(picks.map(async p => fitCell(await readPublished(gameDir, p.image), 240)));
    const w = await write(gridSheet(cells, Math.min(4, cells.length)), `sheet-world-${world}.webp`);
    add(`sheet.world.${world}`, { src: w.src, w: w.w, h: w.h, alt: `The remake's cards for ${world}: ${picks.map(p => p.name.replace(/_/g, ' ')).join(', ')}`, kind: 'sheet' }, w);
  }

  // icons: the published kit icons in one row
  const icons = Object.values(art.icons).filter(r => existsSync(join(gameDir, r)));
  if (icons.length) {
    const imgs = await Promise.all(icons.map(r => readPublished(gameDir, r)));
    const h = Math.max(...imgs.map(i => i.height));
    const cell = Math.max(...imgs.map(i => i.width));
    const fixed = imgs.map(i => {
      const f = { width: cell, height: h, data: new Uint8Array(cell * h * 4) };
      for (let y = 0; y < i.height; y++) f.data.set(i.data.subarray(y * i.width * 4, (y + 1) * i.width * 4), y * cell * 4);
      return f;
    });
    const w = await write(gridSheet(fixed, fixed.length), 'icons.webp');
    add('icons', { src: w.src, w: w.w, h: w.h, alt: 'The kit icons: communicator, medical kit, medical tricorder, phaser, tricorder', kind: 'sheet' }, w);
  }

  const total = Object.keys(manifest.items).length;
  console.log(`site:media: ${total} items (${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}); ${(bytes / 1048576).toFixed(1)} MiB of WebP in ${dest}`);
  if (skipped.length) console.log(`site:media: skipped ${skipped.length} with no source: ${skipped.slice(0, 8).join(', ')}${skipped.length > 8 ? ', ...' : ''}`);
  return finish();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  build().catch(e => { console.error(e); process.exit(1); });
}
