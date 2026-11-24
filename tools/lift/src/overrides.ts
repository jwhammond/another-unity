// SPDX-License-Identifier: GPL-3.0-or-later
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { LiftedContent } from './lift';
import { LiftError, type Problems } from './problems';
import type { ProjectionOverride } from './projection';

export interface Patch {
  /** The override file, relative to games/unity. */
  file: string;
  patch: Record<string, unknown>;
}

export interface Overrides {
  objects: Map<string, Patch>;
  screens: Map<string, Patch>;
  conversations: Map<string, Patch>;
  triggers: Map<string, Patch>;
  advice: Map<string, Patch>;
  game?: Patch;
  /** Lift inputs: the projection's scale and per-screen fits (by slug). */
  coords: { metersPerPixel?: number; screens: Record<string, ProjectionOverride> };
  /** Lift inputs: a screen (IR key) for an IR file's lists that can run anywhere. */
  contexts: Record<string, { screen: string }>;
  /** Things in the overrides directory that were skipped (not errors). */
  warnings: string[];
}

export const emptyOverrides = (): Overrides => ({
  objects: new Map(), screens: new Map(), conversations: new Map(), triggers: new Map(), advice: new Map(),
  coords: { screens: {} }, contexts: {}, warnings: [],
});

const CoordsSchema = z.object({
  metersPerPixel: z.number().positive().optional(),
  screens: z.record(z.object({
    kind: z.enum(['perspective', 'flat']).optional(), slope: z.number().optional(),
    horizonY: z.number().optional(), meanScale: z.number().positive().optional(), topY: z.number().optional(),
  }).strict()).optional(),
}).strict();
const ContextsSchema = z.record(z.string().regex(/^(o_[0-9a-f]{6}|w[0-9a-f]{3}c\d{3}|w_[0-9a-f]{2})$/), z.object({ screen: z.string().regex(/^s_[0-9a-f]{4}$/) }).strict());

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** The path of the first key that could poison a merge, if any. */
function unsafePath(value: unknown, path = ''): string | undefined {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const p = unsafePath(value[i], `${path}/${i}`);
      if (p) return p;
    }
  } else if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      if (UNSAFE_KEYS.has(k)) return `${path}/${k}`;
      const p = unsafePath(v, `${path}/${k}`);
      if (p) return p;
    }
  }
  return undefined;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Objects merge key by key; arrays and scalars replace; null deletes the key. */
export function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else if (UNSAFE_KEYS.has(key)) continue;
    else out[key] = Object.hasOwn(base, key) ? deepMerge(base[key], value) : value;
  }
  return out;
}

/** Every file under dir (relative, sorted); a missing directory has none, any other failure is an error. */
async function listFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { recursive: true, withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new LiftError([`overrides: can't read ${dir}: ${(e as Error).message}`]);
  }
  return entries.filter(e => e.isFile())
    .map(e => relative(dir, join(e.parentPath, e.name)).split(sep).join('/')).sort();
}

export async function readOverrides(dir: string): Promise<Overrides> {
  const o = emptyOverrides();
  const problems: string[] = [];
  for (const rel of await listFiles(dir)) {
    const file = `overrides/${rel}`;
    if (!rel.endsWith('.yaml')) {
      if (!rel.split('/').some(part => part.startsWith('.'))) o.warnings.push(`${file}: not a .yaml file, ignored`);
      continue;
    }
    let value: unknown;
    try {
      value = parseYaml(await readFile(join(dir, rel), 'utf8'));
    } catch (e) {
      problems.push(`${file}: YAML error: ${(e as Error).message}`);
      continue;
    }
    const unsafe = unsafePath(value);
    if (unsafe) {
      problems.push(`${file}: key at ${unsafe} is not allowed`);
      continue;
    }
    const kind = rel.split('/')[0];
    if (kind === 'objects' || kind === 'screens' || kind === 'conversations') {
      if (!isPlainObject(value) || typeof value.id !== 'string') {
        problems.push(`${file}: needs a string "id"`);
        continue;
      }
      if (o[kind].has(value.id)) problems.push(`${file}: "${value.id}" is also overridden in ${o[kind].get(value.id)?.file}`);
      else o[kind].set(value.id, { file, patch: value });
    } else if (rel === 'triggers.yaml' || rel === 'advice.yaml') {
      if (!isPlainObject(value)) {
        problems.push(`${file}: needs a map by id`);
        continue;
      }
      const into = rel === 'triggers.yaml' ? o.triggers : o.advice;
      for (const [id, patch] of Object.entries(value)) {
        if (isPlainObject(patch)) into.set(id, { file, patch });
        else problems.push(`${file}: ${id}: needs a map`);
      }
    } else if (rel === 'game.yaml') {
      if (isPlainObject(value)) o.game = { file, patch: value };
      else problems.push(`${file}: needs a map`);
    } else if (rel === 'coords.yaml') {
      const r = CoordsSchema.safeParse(value);
      if (r.success) o.coords = { metersPerPixel: r.data.metersPerPixel, screens: r.data.screens ?? {} };
      else problems.push(...r.error.issues.map(i => `${file}: ${i.path.join('.') || '(root)'}: ${i.message}`));
    } else if (rel === 'contexts.yaml') {
      const r = ContextsSchema.safeParse(value);
      if (r.success) o.contexts = r.data;
      else problems.push(...r.error.issues.map(i => `${file}: ${i.path.join('.') || '(root)'}: ${i.message}`));
    } else {
      problems.push(`${file}: not a kind of override (objects/, screens/, conversations/, triggers.yaml, advice.yaml, game.yaml, coords.yaml, contexts.yaml)`);
    }
  }
  if (problems.length > 0) throw new LiftError(problems);
  return o;
}

/** Deep-merges each override onto the generated content with its id; an id that wasn't generated is an error. */
export function applyOverrides(lifted: LiftedContent, o: Overrides, problems: Problems): string[] {
  const applied = new Set<string>();
  const merge = <T extends { id: string }>(kind: string, into: Map<string, { def: T }>, patches: Map<string, Patch>) => {
    for (const [id, { file, patch }] of patches) {
      const target = into.get(id);
      if (!target) {
        problems.error(file, `no generated ${kind} "${id}" to override`);
        continue;
      }
      target.def = deepMerge(target.def, patch) as T;
      applied.add(file);
    }
  };
  merge('object', lifted.objects, o.objects);
  merge('screen', lifted.screens, o.screens);
  merge('conversation', lifted.conversations, o.conversations);
  for (const [id, { file, patch }] of o.triggers) {
    const i = lifted.triggers.findIndex(t => t.id === id);
    if (i < 0) problems.error(file, `no generated trigger "${id}" to override`);
    else {
      lifted.triggers[i] = deepMerge(lifted.triggers[i], patch) as LiftedContent['triggers'][number];
      applied.add(file);
    }
  }
  for (const [id, { file, patch }] of o.advice) {
    if (!lifted.advice[id]) problems.error(file, `no generated advice "${id}" to override`);
    else {
      lifted.advice[id] = deepMerge(lifted.advice[id], patch) as LiftedContent['advice'][string];
      applied.add(file);
    }
  }
  if (o.game) {
    lifted.game = deepMerge(lifted.game, o.game.patch) as LiftedContent['game'];
    applied.add(o.game.file);
  }
  return [...applied].map(f => f.replace(/^overrides\//, '')).sort();
}
