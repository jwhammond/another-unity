// SPDX-License-Identifier: GPL-3.0-or-later
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { WORLD_SLUGS } from './ids';
import { defaultStart } from './hardcoded';
import { liftGame } from './lift';
import { readOverrides } from './overrides';
import { LiftError } from './problems';
import { readRaw } from './raw';
import { loadSpriteBounds } from './room';
import { loadSpriteFrames } from './combatAssets';
import { applyOutput, planOutput } from './write';

const USAGE = 'usage: lift --raw <export dir> --world <slug, number, list or all-away>... [--start <world>] [--out games/unity] [--images <dir>] [--audio <dir>] [--dry-run]';

function worldNumber(arg: string): number | undefined {
  const named = Object.entries(WORLD_SLUGS).find(([, slug]) => slug === arg);
  if (named) return Number(named[0]);
  if (arg === '') return undefined;
  const n = arg.startsWith('0x') ? parseInt(arg.slice(2), 16) : Number(arg);
  return Number.isInteger(n) && n >= 0 && n <= 0xff ? n : undefined;
}

/** The away missions, by world number (M3 Decision 1). */
export const ALL_AWAY: readonly number[] = [2, 3, 4, 5, 6, 7];

/** `--world` values: slugs, numbers, comma lists and all-away, in order, each once; undefined if any isn't a world. */
export function worldList(args: string[]): number[] | undefined {
  const out: number[] = [];
  for (const arg of args.flatMap(a => a.split(',')).map(a => a.trim())) {
    const worlds = arg === 'all-away' ? ALL_AWAY : [worldNumber(arg)];
    for (const w of worlds) {
      if (w === undefined) return undefined;
      if (!out.includes(w)) out.push(w);
    }
  }
  return out;
}

async function portedHooks(outDir: string): Promise<Set<string>> {
  const names = await readdir(join(outDir, 'hooks/ported')).catch(() => [] as string[]);
  return new Set(names.filter(n => n.endsWith('.ts')).map(n => n.slice(0, -3)));
}

async function audioStems(audioDir: string): Promise<Set<string>> {
  const manifest = JSON.parse(await readFile(join(audioDir, 'audio/manifest.json'), 'utf8')) as { files: { name: string }[] };
  return new Set(manifest.files.map(f => f.name.toLowerCase().replace(/\.[^.]*$/, '')));
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    options: {
      raw: { type: 'string' }, out: { type: 'string', default: 'games/unity' }, world: { type: 'string', multiple: true }, start: { type: 'string' },
      images: { type: 'string' }, audio: { type: 'string' }, 'dry-run': { type: 'boolean', default: false },
    },
  }).values;
}

export async function runLift(argv: string[], log: (line: string) => void): Promise<number> {
  let values: ReturnType<typeof parse>;
  try {
    values = parse(argv);
  } catch {
    log(USAGE);
    return 2;
  }
  const worlds = worldList(values.world ?? []);
  if (!values.raw || !worlds || worlds.length === 0) {
    log(USAGE);
    return 2;
  }
  const start = values.start === undefined ? defaultStart(worlds) : worldNumber(values.start);
  if (start === undefined || !worlds.includes(start)) {
    log(`--start ${values.start} is not one of the worlds lifted`);
    log(USAGE);
    return 2;
  }
  const out = values.out ?? 'games/unity';
  try {
    const raw = await readRaw(values.raw);
    const overrides = await readOverrides(join(out, 'overrides'));
    for (const w of overrides.warnings) log(`warning: ${w}`);
    const result = liftGame(raw, {
      worlds,
      start,
      sprites: values.images ? await loadSpriteBounds(values.images) : undefined,
      spriteFrames: values.images ? await loadSpriteFrames(values.images) : undefined,
      audio: values.audio ? await audioStems(values.audio) : undefined,
      ported: await portedHooks(out),
    }, overrides);
    for (const [world, c] of result.lifted.coverage) {
      const ported = c.hooks.filter(h => h.ported).length;
      log(`${world}: ${c.objects} objects, ${c.stubs} stubs, ${c.conversations} conversations, ${c.screens} screens, ${c.hooks.length} hooks (${ported} ported), ${result.problems.errors.length} errors`);
      log(`${world}: fields ${c.fields.consumed} lifted + ${c.fields.ignored} ignored of ${c.fields.total}; voices ${c.voices.mapped ?? '?'} of ${c.voices.lines} mapped; ${c.warnings.length} warnings`);
    }
    if (result.applied.length > 0) log(`overrides applied: ${result.applied.join(', ')}`);
    if (result.problems.errors.length > 0) {
      for (const e of result.problems.errors) log(`error: ${e}`);
      return 1;
    }
    const plan = await planOutput(out, result.files);
    if (values['dry-run']) {
      log(`dry run: would write ${plan.writes.length} files, ${plan.unchanged} unchanged, remove ${plan.removals.length}`);
      return 0;
    }
    await applyOutput(out, result.files, plan);
    log(`wrote ${plan.writes.length} files, ${plan.unchanged} unchanged, removed ${plan.removals.length}`);
    return 0;
  } catch (e) {
    if (!(e instanceof LiftError)) throw e;
    for (const p of e.problems) log(`error: ${p}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runLift(process.argv.slice(2), line => console.log(line)).then(code => process.exit(code), (e: unknown) => {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
