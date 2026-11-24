// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArtCache } from './cache';
import { makeStrips, publishAnimStrip, type MadeAnim } from './card';
import { atlasBytes as atlasBytesOf, packAtlas, unpackCell, visibleDiff, type Atlas } from './atlas';
import { encodePages, publishPropAtlas, type PageDeps } from './propatlas';
import { WEBP_MAX_MEAN_DIFF } from './publish';
import { checkAnim, checkTransition, type AnimCheck, type Placed } from './cardchecks';
import { repaintAnim } from './cardrepaint';
import type { Generator } from './generator';
import { decodePng, encodePng, type Rgba } from './image';
import type { ModelsFile } from './models';
import type { CardRecipe } from './recipe';
import { refFile } from './refs';
import { checkPins, choiceFor } from './run';
import { modelsFor } from './select';
import { canonicalAnim, FIRE_ANIMS, SHADOW_COLOURS, USED_ANIMS, usedBodies, type SpriteJson } from './sprites';
import { mouthOver } from './strips';

const sha = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');

export interface CardDeps {
  generator: Generator;
  models: ModelsFile;
  cache: ArtCache;
  imagesDir: string;
  gameDir: string;
  refsDir?: string;
  warn?: (line: string) => void;
  /** The encoder and decoder of an animated prop's atlas pages (default: cwebp and dwebp). */
  pages?: PageDeps;
}

/** The frames per canvas an animation gets. */
export const groupFor = (recipe: Pick<CardRecipe, 'group' | 'groupOverrides'>, anim: number): number => recipe.groupOverrides[String(anim)] ?? recipe.group;
/** The seed an animation is repainted with: its own (seedOverrides) where it has one, else the recipe's. */
export const seedFor = (recipe: Pick<CardRecipe, 'sampling' | 'seedOverrides'>, anim: number): number => recipe.seedOverrides[String(anim)] ?? recipe.sampling.seed;
/**
 * What a repaint's output depends on in the recipe: its text without the lines that only change checking or one animation's
 * group or seed, plus this animation's group, and its own seed where it has one (an animation on the recipe's seed keeps the key it had).
 */
export const coreText = (text: string, group: number, seed?: number): string =>
  // (the seedOverrides line goes with its line break, so adding one leaves the other animations' keys as they were)
  `${text.replace(/^seedOverrides:.*(\r?\n|$)/m, '').replace(/^(checks|groupOverrides):.*$/gm, '')}\0group=${group}${seed !== undefined ? `\0seed=${seed}` : ''}`;
/** coreText for one animation of a recipe. */
export const animCoreText = (text: string, recipe: Pick<CardRecipe, 'group' | 'groupOverrides' | 'seedOverrides'>, anim: number): string =>
  coreText(text, groupFor(recipe, anim), recipe.seedOverrides[String(anim)]);

export function loadSprite(imagesDir: string, recipe: Pick<CardRecipe, 'sprite'> & Partial<Pick<CardRecipe, 'prop'>>): SpriteJson {
  const file = join(imagesDir, 'images', 'sprites', recipe.sprite);
  if (!existsSync(join(file, 'sprite.json'))) throw new Error(`no sprite at ${file}`);
  const sprite = JSON.parse(readFileSync(join(file, 'sprite.json'), 'utf8')) as SpriteJson;
  return recipe.prop ? propSprite(sprite, recipe.prop) : sprite;
}

/**
 * The sprite as a prop card sees it: the prop's animation cut to its first frame (`stillOf`), unless the recipe animates it, and every other
 * animation whole (an animation the recipe lists in `prop.animate` publishes all its frames).
 */
export function propSprite(sprite: SpriteJson, prop: { anim: number; animate: number[]; talk?: number | undefined }): SpriteJson {
  const base = prop.animate.includes(prop.anim) ? sprite : stillOf(sprite, prop.anim);
  // (a talk animation's mouths sit on the frame the start animation marked: the sprite is played from that one into it)
  return prop.talk === undefined ? base : { ...base, primed: { ...base.primed, [canonicalAnim(base, prop.talk)]: prop.anim } };
}

/**
 * The frames of an animation that are not repeats: the index of each first occurrence (`unique`), and for every frame which of them it is
 * (`of`, an index into `unique`). A blinking light plays forty frames of two pictures; repainting the two is the same as repainting the forty.
 * Two cells are the same when every byte is, alpha too.
 */
export function uniqueCells(frames: Rgba[]): { unique: number[]; of: number[] } {
  const seen = new Map<string, number>();
  const unique: number[] = [];
  const of = frames.map((f, i) => {
    const key = `${f.width}x${f.height}:${sha(f.data)}`;
    let at = seen.get(key);
    if (at === undefined) {
      at = unique.length;
      seen.set(key, at);
      unique.push(i);
    }
    return at;
  });
  return { unique, of };
}

/**
 * The sprite with animation `anim` cut to its first frame (that frame, its position, a pause). A prop card is a still of that frame, and an
 * animation that loops over a dozen frames would be repainted whole, each frame a work canvas, for the one the card shows.
 */
export function stillOf(sprite: SpriteJson, anim: number): SpriteJson {
  const start = sprite.anims[canonicalAnim(sprite, anim)];
  if (start === undefined) return sprite;
  const at = sprite.entries.findIndex((e, i) => i >= start && e.type === 'sprite');
  if (at < 0) return sprite;
  const next = sprite.entries.slice(at + 1).findIndex(e => e.type === 'sprite' || e.type === 'pause' || e.type === 'exit' || e.type === 'jump' || e.type === 'wait');
  const position = sprite.entries.slice(at + 1, next < 0 ? undefined : at + 1 + next).find(e => e.type === 'position');
  const added = [sprite.entries[at]!, ...(position ? [position] : []), { type: 'pause' }];
  return { ...sprite, anims: sprite.anims.map((s, i) => (i === anim ? sprite.entries.length : s)), entries: [...sprite.entries, ...added] };
}

/** The animations a card recipe repaints: each real body once (aliases share one), in index order. */
export function recipeAnims(sprite: SpriteJson, recipe: Pick<CardRecipe, 'anims'>): number[] {
  // (a listed animation the sprite doesn't have is a mistake in the recipe: it used to be skipped, so the recipe ran nothing)
  if (recipe.anims !== 'used') {
    const missing = recipe.anims.filter(a => a >= sprite.anims.length);
    if (missing.length > 0) throw new Error(`the recipe lists animation ${missing.join(', ')}, but the sprite has only ${sprite.anims.length} (0-${sprite.anims.length - 1})`);
  }
  // (a crew card's used set is the walks, stands and talks, and the seven ways it fires a phaser: the sprite's own animation of each, if it has one)
  const { bodies } = usedBodies(sprite, recipe.anims === 'used' ? [...USED_ANIMS, ...FIRE_ANIMS.filter(a => a < sprite.anims.length)] : recipe.anims);
  return [...bodies].filter(([, b]) => b.frames.length > 0).map(([i]) => i).sort((a, b) => a - b);
}

/** An animation's cells, cut out of its strip. */
export function cells(strip: Rgba, frames: number, cell: [number, number], columns: number): Rgba[] {
  return Array.from({ length: frames }, (_, i) => {
    const ox = (i % columns) * cell[0];
    const oy = Math.floor(i / columns) * cell[1];
    const data = new Uint8Array(cell[0] * cell[1] * 4);
    for (let y = 0; y < cell[1]; y++) data.set(strip.data.subarray(((oy + y) * strip.width + ox) * 4, ((oy + y) * strip.width + ox + cell[0]) * 4), y * cell[0] * 4);
    return { width: cell[0], height: cell[1], data };
  });
}

/** The strip's cells put back (the inverse of `cells`, same wrapping). */
export function stripOf(frames: Rgba[], cell: [number, number], columns: number): Rgba {
  const rows = Math.ceil(frames.length / columns);
  const strip: Rgba = { width: cell[0] * columns, height: cell[1] * rows, data: new Uint8Array(cell[0] * columns * cell[1] * rows * 4) };
  frames.forEach((f, i) => {
    const ox = (i % columns) * cell[0];
    const oy = Math.floor(i / columns) * cell[1];
    for (let y = 0; y < cell[1]; y++) strip.data.set(f.data.subarray(y * cell[0] * 4, (y + 1) * cell[0] * 4), ((oy + y) * strip.width + ox) * 4);
  });
  return strip;
}

/** The upscaled-only animation (R8's strips), from the frame cache `art strips` fills (or made now, through the upscaler). */
export async function upscaledAnim(deps: CardDeps, recipe: CardRecipe, sprite: SpriteJson, anim: number): Promise<{ made: MadeAnim; alias: Map<number, number>; pixelHeight: number }> {
  const choice = choiceFor(recipe, deps.models);
  const frames = join(deps.cache.work, 'cards', recipe.object, 'frames');
  mkdirSync(frames, { recursive: true });
  const strips = await makeStrips(deps.generator, modelsFor(deps.models, choice), sprite, async png => new Uint8Array(readFileSync(join(deps.imagesDir, png))), {
    shadowColours: SHADOW_COLOURS,
    roots: [anim],
    cached: {
      get: async key => (existsSync(join(frames, `${key}.png`)) ? new Uint8Array(readFileSync(join(frames, `${key}.png`))) : null),
      put: async (key, png) => writeFileSync(join(frames, `${key}.png`), png),
    },
  });
  let made = strips.anims.get(anim);
  let result = strips;
  if (!made) {
    // (a speech animation's frames are its talk animation's, drawn with the mouths: only a run from the talk root has them)
    result = await makeStrips(deps.generator, modelsFor(deps.models, choice), sprite, async png => new Uint8Array(readFileSync(join(deps.imagesDir, png))), {
      shadowColours: SHADOW_COLOURS,
      roots: USED_ANIMS,
      cached: {
        get: async key => (existsSync(join(frames, `${key}.png`)) ? new Uint8Array(readFileSync(join(frames, `${key}.png`))) : null),
        put: async (key, png) => writeFileSync(join(frames, `${key}.png`), png),
      },
    });
    made = result.anims.get(anim);
  }
  if (!made) throw new Error(`${recipe.id}: animation ${anim} has no frames`);
  return { made, alias: result.alias, pixelHeight: result.pixelHeight };
}

export interface CardRun {
  dir: string;
  ok: boolean;
  check: AnimCheck;
  seconds: number;
  canvases: number;
  frames: number;
  secondsPerCanvas: number;
}

/** What an animation's output depends on (R11): the recipe, the models and references (by hash), the sprite file, the animation and the pins are in the key. */
export function animKey(recipeText: string, anim: number, parts: { models: string[]; references: string[]; sprite: string; pins: string }): string {
  return sha([recipeText, String(anim), ...[...parts.models].sort(), ...[...parts.references].sort(), parts.sprite, parts.pins].join('\0'));
}

/** The newest earlier run of an animation with this core recipe, these models and these references that kept its repainted strip. */
function findPrior(dir: string, core: string, models: Record<string, unknown>, refs: Record<string, string>): string | null {
  if (!existsSync(dir)) return null;
  for (const stamp of readdirSync(dir).sort().reverse()) {
    try {
      const meta = JSON.parse(readFileSync(join(dir, stamp, 'meta.json'), 'utf8')) as { recipeCoreSha256?: string; models?: unknown; references?: unknown };
      if (meta.recipeCoreSha256 === core && JSON.stringify(meta.models) === JSON.stringify(models) && JSON.stringify(meta.references) === JSON.stringify(refs) && existsSync(join(dir, stamp, 'repainted.png'))) return join(dir, stamp);
    } catch {
      // not a run
    }
  }
  return null;
}

/**
 * The first or the last frame of the newest run in `dir` (work/cards/<object>/repaint/<anim>/) that passed its checks and recorded the sprite's
 * origin in its cells, as the switch check sees it. null when there is none: that animation has not been run, or ran before the origin was kept.
 */
export function siblingEdge(dir: string, which: 'first' | 'last'): Placed | null {
  if (!existsSync(dir)) return null;
  for (const stamp of readdirSync(dir).sort().reverse()) {
    try {
      const meta = JSON.parse(readFileSync(join(dir, stamp, 'meta.json'), 'utf8')) as { ok?: boolean; cell?: [number, number]; columns?: number; frames?: number; anchor?: [number, number]; flickerMedian?: number | null };
      if (meta.ok !== true || !meta.cell || !meta.columns || !meta.frames || !meta.anchor) continue;
      const pick = (file: string): Rgba => cells(decodePng(new Uint8Array(readFileSync(join(dir, stamp, file)))), meta.frames!, meta.cell!, meta.columns!)[which === 'first' ? 0 : meta.frames! - 1]!;
      return { up: pick('upscaled.png'), rep: pick('repainted.png'), anchor: meta.anchor, median: meta.flickerMedian ?? null };
    } catch {
      // not a run
    }
  }
  return null;
}

/**
 * One animation of a card recipe: the upscaled frames, the repaint (R6), the checks (R7). Writes
 * work/cards/<object>/repaint/<anim>/<stamp>/ (repainted.png: the strip; upscaled.png; check.json; meta.json). A passing run is
 * published (the animation's strip, and its aliases) unless `publish` is false; a failing one is kept and reported.
 */
export async function runCardAnim(recipe: CardRecipe, recipeText: string, anim: number, deps: CardDeps, opts: { publish?: boolean; stamp?: string; log?: (l: string) => void } = {}): Promise<CardRun> {
  const t0 = Date.now();
  const choice = choiceFor(recipe, deps.models);
  const need = new Set<string>(recipe.reference.map(r => (r.model === 'style' ? 'ipadapterStyle' : 'ipadapterFace')));
  if (need.size > 0) need.add('clipVision');
  const core = ['checkpoint', 'vae', 'lora', 'depth', 'lineart', 'depthAnnotator', 'lineartAnnotator', 'upscaler'] as const;
  const used = await checkPins(choice, { generator: deps.generator, models: deps.models, cache: deps.cache, external: !!process.env.COMFY_URL, warn: deps.warn }, [...core, ...(need as Set<never>)]);
  const stamp = opts.stamp ?? new Date(t0).toISOString().replace(/[:.]/g, '-');
  const sprite = loadSprite(deps.imagesDir, recipe);
  const { made, alias, pixelHeight } = await upscaledAnim(deps, recipe, sprite, anim);
  const up = cells(made.strip, made.frames, made.cell, made.columns);
  const orig = cells(made.original, made.frames, [made.cell[0] / 4, made.cell[1] / 4], made.columns);
  const refsDir = deps.refsDir ?? join(deps.cache.root, 'refs');
  const refHashes: Record<string, string> = {};
  const refs = recipe.reference.flatMap(r => r.refs).map(id => {
    const bytes = new Uint8Array(readFileSync(refFile(refsDir, id)));
    refHashes[id] = sha(bytes);
    return bytes;
  });
  const m = modelsFor(deps.models, choice);
  const canvasSeconds: number[] = [];
  // the checks don't change what is painted: a finished repaint of the same recipe (checks aside), models and references is checked again, not painted again
  // (a speech animation's mouths go back over the repaint of its marked frame: a run that painted the whole composite is not this one)
  const coreSha = sha(animCoreText(recipeText, recipe, anim) + (made.base ? '\0mouths-over-2' : ''));
  const seed = seedFor(recipe, anim);
  const prior = recipe.repaint === false ? null : findPrior(join(deps.cache.work, 'cards', recipe.object, 'repaint', String(anim)), coreSha, used, refHashes);
  let reused = false;
  // (an upscale-only card is the upscaled frames themselves: no diffusion pass)
  // (a frame that repeats is painted once: a blinking light plays forty frames of two pictures. The repaint of each is laid back at every place it is played, so the checks, flicker between frames included, see the whole animation)
  // (a speech animation repaints its marked frame alone, once, and the mouths go back over it: the body is the one the character stands in, in every frame)
  const plain = made.base ? cells(made.base, made.frames, made.cell, made.columns) : null;
  const { unique, of } = uniqueCells(up);
  const painting = plain ? uniqueCells(plain) : { unique, of };
  if (painting.unique.length < up.length) opts.log?.(`anim ${anim}: ${painting.unique.length} distinct ${plain ? 'bodies' : 'frames'} of ${up.length}${plain ? ` (${unique.length} with their mouths)` : ''}`);
  const distinct = async (): Promise<Rgba[]> => {
    const painted = await repaintAnim(deps.generator, m, { ...recipe, group: groupFor(recipe, anim), sampling: { ...recipe.sampling, seed } }, painting.unique.map(i => (plain ?? up)[i]!), refs, { stamp, onCanvas: c => { canvasSeconds.push(c.seconds); opts.log?.(`anim ${anim}: canvas ${c.canvas}/${c.of} (${c.frames} frames) ${c.seconds.toFixed(1)} s`); } });
    return painting.of.map((k, i) => (plain ? mouthOver(painted[k]!, up[i]!, plain[i]!) : painted[k]!));
  };
  const rep = recipe.repaint === false ? up.map(f => ({ ...f, data: new Uint8Array(f.data) })) : prior ? ((reused = true), cells(decodePng(new Uint8Array(readFileSync(join(prior, 'repainted.png')))), made.frames, made.cell, made.columns)) : await distinct();
  const check = checkAnim(orig, up, rep, recipe.checks, { skipAlign: !!recipe.align?.skip });
  // (an animated prop's layer switches between its animations, a door's still to its opening: the repaint must not jump there either)
  if (recipe.prop && recipe.prop.animate.length > 0) {
    const here: Placed = { up: up[0]!, rep: rep[0]!, anchor: made.anchor };
    const end: Placed = { up: up[up.length - 1]!, rep: rep[rep.length - 1]!, anchor: made.anchor };
    const siblings = [...new Set([recipe.prop.anim, ...recipe.prop.animate])].filter(a => a !== anim);
    for (const other of siblings) {
      const dir = join(deps.cache.work, 'cards', recipe.object, 'repaint', String(other));
      const [theirFirst, theirLast] = [siblingEdge(dir, 'first'), siblingEdge(dir, 'last')];
      // (the animation that plays in the original switches both ways)
      for (const [label, a, b] of [[`${other} to ${anim}`, theirLast, here], [`${anim} to ${other}`, end, theirFirst]] as const) {
        if (!a || !b) continue;
        // (the animations' own flicker is what a switch is measured against: the larger of the two medians, where they have one)
        const own = [check.flicker.length > 0 ? check.flickerMedian : null, theirFirst?.median ?? null].filter((m): m is number => m !== null);
        const why = checkTransition(a, b, own.length > 0 ? Math.max(...own) : null, recipe.checks);
        if (why) {
          check.ok = false;
          check.why = [check.why, `switch ${label}: ${why}`].filter(Boolean).join('; ');
        }
      }
      if (!theirFirst) opts.log?.(`anim ${anim}: animation ${other} has no passing run yet, so the switch to and from it is checked when it has`);
    }
  }
  // (an animated prop's strip is published as an atlas of its distinct cells, each cropped to its own frame's opaque bounds. The check runs again on the pixels
  // that are published, the WebP's own, as a plate's does: lossy first, then near-lossless, then lossless, and the thresholds are the same)
  const atlasMode = !!recipe.prop && recipe.prop.animate.includes(anim);
  let atlas: { atlas: Atlas; files: string[]; work: string; mode: string; bytes: number } | null = null;
  if (check.ok && opts.publish !== false && atlasMode) {
    const packed = packAtlas(unique.map(i => rep[i]!));
    const work = mkdtempSync(join(tmpdir(), 'atlas-'));
    const r = await encodePages(packed.pages, work, `${anim}`, pages => {
      const back = of.map(k => unpackCell(pages, packed.atlas, k, made.cell));
      const drift = visibleDiff(rep, back);
      if (drift > WEBP_MAX_MEAN_DIFF) return { ok: false, why: `the atlas differs from the repaint by a mean of ${drift.toFixed(2)}/255 (limit ${WEBP_MAX_MEAN_DIFF})` };
      const again = checkAnim(orig, up, back, recipe.checks, { skipAlign: !!recipe.align?.skip });
      return again.ok ? { ok: true } : { ok: false, why: `the published pixels fail the card check (${again.why})` };
    }, deps.pages);
    if (r.ok) {
      atlas = { atlas: packed.atlas, files: r.files, work, mode: r.mode, bytes: r.bytes };
      if (r.mode !== 'lossy') opts.log?.(`anim ${anim}: the lossy WebP failed its check; the atlas is ${r.mode}`);
      opts.log?.(`anim ${anim}: atlas of ${unique.length} cells in ${packed.pages.length} page${packed.pages.length === 1 ? '' : 's'} (${packed.atlas.pages.map(([w, h]) => `${w}x${h}`).join(', ')}), ${(atlasBytesOf(packed.atlas) / 1048576).toFixed(1)} MB decoded, ${(r.bytes / 1024).toFixed(0)} KB as ${r.mode} WebP`);
    } else {
      rmSync(work, { recursive: true, force: true });
      check.ok = false;
      check.why = [check.why, `atlas: ${r.why}`].filter(Boolean).join('; ');
    }
  }
  const dir = join(deps.cache.work, 'cards', recipe.object, 'repaint', String(anim), stamp);
  mkdirSync(dir, { recursive: true });
  const strip = stripOf(rep, made.cell, made.columns);
  writeFileSync(join(dir, 'repainted.png'), encodePng(strip));
  writeFileSync(join(dir, 'upscaled.png'), encodePng(made.strip));
  writeFileSync(join(dir, 'check.json'), `${JSON.stringify(check, null, 2)}\n`);
  const seconds = (Date.now() - t0) / 1000;
  const total = canvasSeconds.reduce((a, b) => a + b, 0);
  writeFileSync(
    join(dir, 'meta.json'),
    `${JSON.stringify({ recipe: recipe.id, anim, recipeSha256: sha(recipeText), seed, cell: made.cell, columns: made.columns, recipeCoreSha256: coreSha, anchor: made.anchor, flickerMedian: check.flicker.length > 0 ? check.flickerMedian : null, distinctFrames: unique.length, ...(atlas ? { atlas: { mode: atlas.mode, bytes: atlas.bytes, pages: atlas.atlas.pages } } : {}), ...(recipe.repaint === false ? { upscaleOnly: true } : {}), ...(recipe.align ? { alignSkipped: recipe.align.reason } : {}), reusedRepaint: reused, models: used, references: refHashes, frames: made.frames, canvases: canvasSeconds.length, canvasSeconds, seconds, ok: check.ok, ...(check.why ? { why: check.why } : {}) }, null, 2)}\n`,
  );
  if (check.ok && opts.publish !== false) {
    if (atlas) {
      try {
        await publishPropAtlas(deps.gameDir, recipe.object, anim, atlas.files, atlas.atlas, of);
      } finally {
        rmSync(atlas.work, { recursive: true, force: true });
      }
    } else {
      const aliases = [...alias].filter(([i, t]) => t === anim && i !== anim).map(([i]) => i);
      await publishAnimStrip(deps.gameDir, recipe.object, anim, { ...made, strip }, aliases, pixelHeight, undefined, { presentation: !recipe.prop });
    }
  }
  return { dir, ok: check.ok, check, seconds, canvases: canvasSeconds.length, frames: made.frames, secondsPerCanvas: canvasSeconds.length ? total / canvasSeconds.length : 0 };
}
