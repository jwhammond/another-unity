// SPDX-License-Identifier: GPL-3.0-or-later
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { z } from 'zod';
import {
  AstStatFile, CombatFile, ConversationFile, ExecutableFile, GameObject, MovieMap, ScreenFile, SpriteList, TrigFile, TriggersFile, WorldFile,
  type CombatFileT, type ConversationFileT, type GameObjectT, type ScreenFileT, type TrigFileT, type WorldFileT,
} from '@another-unity/rawcheck/ir';
import { Manifest } from '@another-unity/rawcheck/manifest';
import { LiftError } from './problems';
import { SPACE_EXT } from './space/files';

export type TriggerT = z.infer<typeof TriggersFile>[number];
export type MovieMapT = z.infer<typeof MovieMap>;
export type SpriteListT = z.infer<typeof SpriteList>;
export type AstStatT = z.infer<typeof AstStatFile>;
export type ExecutableT = z.infer<typeof ExecutableFile>;
export type { CombatFileT, ConversationFileT, GameObjectT, ScreenFileT, TrigFileT, WorldFileT };

/** One export of Plan 3's raw IR, validated. */
export interface RawIR {
  manifest: Manifest;
  objects: Map<string, GameObjectT>;
  conversations: Map<string, ConversationFileT>;
  screens: Map<string, ScreenFileT>;
  worlds: Map<string, WorldFileT>;
  triggers: TriggerT[];
  movies: MovieMapT;
  sprites: SpriteListT;
  executable: ExecutableT;
  /** verbatim/computer.db, when the export has it (Plan 8 Task 8). */
  computer?: Uint8Array;
  /** verbatim/compstat: the computer's hidden entries and recorded readings at the start (Plan 12 Task 1). */
  compstat?: Uint8Array;
  /** verbatim/astro.db and verbatim/sector.ast (Plan 10 Task 6), and ast_stat.json's starting flags. */
  astro?: Uint8Array;
  sectorNames?: Uint8Array;
  astStat?: AstStatT;
  /** verbatim/t_WWSS00.bst, by "WWSS" (hex): each screen's text records (showScreenText). */
  screenTexts?: Map<string, Uint8Array>;
  /** combat.json (Plan 18 Task 2): ScummVM's combat constants, the power presets and the archive's media names. */
  combat?: CombatFileT;
  /** trig.json (Plan 22 Task 1): ScummVM's sinf and cosf of each whole angle. */
  trig?: TrigFileT;
  /** The verbatim tactics, model, material and texture files (Plan 18 Task 2), by lowercase name. */
  space?: Map<string, Uint8Array>;
}

export async function readRaw(dir: string): Promise<RawIR> {
  const problems: string[] = [];
  async function read<T>(rel: string, schema: z.ZodType<T>): Promise<T | undefined> {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(join(dir, rel), 'utf8'));
    } catch (e) {
      problems.push(`${rel}: ${(e as Error).message}`);
      return undefined;
    }
    const result = schema.safeParse(value);
    if (result.success) return result.data;
    for (const issue of result.error.issues) problems.push(`${rel}: ${issue.path.join('.') || '(root)'}: ${issue.message}`);
    return undefined;
  }
  async function readAll<T>(ids: string[], file: (id: string) => string, schema: z.ZodType<T>): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    for (const id of ids) {
      const value = await read(file(id), schema);
      if (value !== undefined) out.set(id, value);
    }
    return out;
  }

  const manifest = await read('manifest.json', Manifest);
  if (!manifest) throw new LiftError(problems);
  const objects = await readAll(manifest.objects, id => `objects/o_${id}.json`, GameObject);
  const conversations = await readAll(manifest.conversations, id => `conversations/${id}.json`, ConversationFile);
  const screens = await readAll(manifest.screens, id => `screens/${id}.json`, ScreenFile);
  const worlds = await readAll(manifest.worlds, id => `worlds/${id}.json`, WorldFile);
  const triggers = await read('triggers.json', TriggersFile);
  const movies = await read('maps/movie.json', MovieMap);
  const sprites = await read('maps/sprite.json', SpriteList);
  const executable = await read('executable.json', ExecutableFile);
  if (problems.length > 0 || !triggers || !movies || !sprites || !executable) throw new LiftError(problems);
  const verbatim = async (name: string) => (manifest.files.includes(`verbatim/${name}`) ? new Uint8Array(await readFile(join(dir, 'verbatim', name))) : undefined);
  const computer = await verbatim('computer.db');
  const compstat = await verbatim('compstat');
  const astro = await verbatim('astro.db');
  const sectorNames = await verbatim('sector.ast');
  const astStat = manifest.files.includes('ast_stat.json') ? await read('ast_stat.json', AstStatFile) : undefined;
  const screenTexts = new Map<string, Uint8Array>();
  for (const f of manifest.files) {
    const m = /^verbatim\/t_([0-9a-f]{4})00\.bst$/.exec(f);
    if (m?.[1]) screenTexts.set(m[1], new Uint8Array(await readFile(join(dir, f))));
  }
  const combat = manifest.files.includes('combat.json') ? await read('combat.json', CombatFile) : undefined;
  const trig = manifest.files.includes('trig.json') ? await read('trig.json', TrigFile) : undefined;
  const space = new Map<string, Uint8Array>();
  for (const f of manifest.files) {
    const m = new RegExp(`^verbatim/([^/]+\\.(?:bin|${SPACE_EXT}))$`).exec(f);
    if (m?.[1]) space.set(m[1].toLowerCase(), new Uint8Array(await readFile(join(dir, f))));
  }
  if (problems.length > 0) throw new LiftError(problems);
  return {
    ...(screenTexts.size > 0 ? { screenTexts } : {}),
    manifest, objects, conversations, screens, worlds, triggers, movies, sprites, executable,
    ...(computer ? { computer } : {}), ...(compstat ? { compstat } : {}), ...(astro ? { astro } : {}), ...(sectorNames ? { sectorNames } : {}), ...(astStat ? { astStat } : {}),
    ...(combat ? { combat } : {}), ...(trig ? { trig } : {}), ...(space.size > 0 ? { space } : {}),
  };
}
