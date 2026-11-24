// SPDX-License-Identifier: GPL-3.0-or-later
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { checkRefs, combatRefProblems } from './refs';
import {
  adviceFileSchema,
  conversationDefSchema,
  combatDataSchema,
  computerTreeSchema,
  gameFileSchema,
  objectDefSchema,
  screenDefSchema,
  shipDataSchema,
  triggerDefSchema,
  universeSchema,
} from './schema';
import type { AdviceDef, CombatData, ComputerTree, ConversationDef, GameContent, ShipContent, ShipData, Universe, ObjectDef, ScreenDef, TriggerDef } from './types';

export interface SourceFile {
  /** Relative to the game directory, with '/' separators. */
  path: string;
  text: string;
}

export class ContentError extends Error {
  constructor(readonly problems: string[]) {
    super(`content has ${problems.length} problem(s):\n${problems.join('\n')}`);
    this.name = 'ContentError';
  }
}

function formatPath(path: (string | number)[]): string {
  return path.reduce<string>((s, k) => (typeof k === 'number' ? `${s}[${k}]` : s ? `${s}.${k}` : k), '') || '(root)';
}

/** The refusal for a ship.yaml lifted before Plan 23: one with `battles` (combat.yaml's only since), or a unit without its efficiency. */
export const STALE_SHIP = 'ship.yaml is from before Plan 23: lift the game again (npm run unity:build)';

/** Whether ship.yaml is from before Plan 23, said once instead of the schema's bare complaints; a YAML error is left to read(). */
function staleShip(file: SourceFile, problems: string[]): boolean {
  let raw: unknown;
  try { raw = parseYaml(file.text); } catch { return false; }
  if (typeof raw !== 'object' || raw === null) return false;
  const r = raw as { battles?: unknown; units?: unknown };
  const stale = 'battles' in r || (Array.isArray(r.units) && r.units.some(u => typeof u === 'object' && u !== null && !('efficiency' in u)));
  if (stale) problems.push(STALE_SHIP);
  return stale;
}

export function parseGame(files: SourceFile[]): GameContent {
  const problems: string[] = [];
  const read = <T>(file: SourceFile, schema: z.ZodType<T>): T | undefined => {
    let data: unknown;
    try {
      data = parseYaml(file.text);
    } catch (e) {
      problems.push(`${file.path}: YAML error: ${(e as Error).message}`);
      return undefined;
    }
    const result = schema.safeParse(data);
    if (!result.success) {
      for (const issue of result.error.issues) problems.push(`${file.path}: ${formatPath(issue.path)}: ${issue.message}`);
      return undefined;
    }
    return result.data;
  };

  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const gameFile = sorted.find(f => f.path === 'game.yaml');
  if (!gameFile) throw new ContentError(['game.yaml: missing']);
  const game = read(gameFile, gameFileSchema);

  const screens: Record<string, ScreenDef> = {};
  const objects: Record<string, ObjectDef> = {};
  const where = new Map<string, string>();
  let triggers: TriggerDef[] = [];
  const conversations: Record<string, ConversationDef> = {};
  let advice: Record<string, AdviceDef> = {};

  for (const file of sorted) {
    if (file.path.startsWith('screens/')) {
      const s = read(file, screenDefSchema);
      if (!s) continue;
      if (screens[s.id]) problems.push(`${file.path}: duplicate screen id "${s.id}"`);
      else {
        screens[s.id] = s;
        where.set(`screen:${s.id}`, file.path);
      }
    } else if (file.path.startsWith('objects/')) {
      const o = read(file, objectDefSchema);
      if (!o) continue;
      if (objects[o.id]) problems.push(`${file.path}: duplicate object id "${o.id}" (also in ${where.get(o.id)})`);
      else {
        objects[o.id] = o;
        where.set(o.id, file.path);
      }
    } else if (file.path === 'triggers.yaml') {
      triggers = read(file, z.array(triggerDefSchema)) ?? [];
    } else if (file.path.startsWith('conversations/')) {
      const conv = read(file, conversationDefSchema);
      if (!conv) continue;
      const key = `conversation:${conv.id}`;
      if (conversations[conv.id]) problems.push(`${file.path}: duplicate conversation id "${conv.id}" (also in ${where.get(key)})`);
      else {
        conversations[conv.id] = conv;
        where.set(key, file.path);
      }
    } else if (file.path === 'advice.yaml') {
      advice = read(file, adviceFileSchema) ?? {};
    }
  }

  // The ship: universe.yaml is the marker (the lifter writes `{}` for a game without one, and ship.yaml regardless); once it has
  // content, ship.yaml and computer.yaml must be there too.
  let ship: ShipContent | undefined;
  const universeFile = sorted.find(f => f.path === 'universe.yaml');
  let hasUniverse = false;
  if (universeFile) {
    try {
      const raw = parseYaml(universeFile.text);
      hasUniverse = typeof raw === 'object' && raw !== null && Object.keys(raw).length > 0;
    } catch {
      hasUniverse = true; // (read() reports the YAML error)
    }
  }
  if (universeFile && hasUniverse) {
    const shipFile = sorted.find(f => f.path === 'ship.yaml');
    const computerFile = sorted.find(f => f.path === 'computer.yaml');
    if (!shipFile) problems.push('ship.yaml: missing (universe.yaml is present)');
    if (!computerFile) problems.push('computer.yaml: missing (universe.yaml is present)');
    const universe: Universe | undefined = read(universeFile, universeSchema);
    const data: ShipData | undefined = shipFile && !staleShip(shipFile, problems) ? read(shipFile, shipDataSchema) : undefined;
    const computer: ComputerTree | undefined = computerFile && read(computerFile, computerTreeSchema);
    const combatFile = sorted.find(f => f.path === 'combat.yaml');
    const combat: CombatData | undefined = combatFile && read(combatFile, combatDataSchema);
    if (universe && data && computer) ship = { universe, data, computer, ...(combat ? { combat } : {}) };
  }

  if (!game || problems.length > 0) throw new ContentError(problems);
  const rules = { ...game.rules, items: game.rules?.items ?? {}, lines: game.rules?.lines ?? {} };
  const content: GameContent = { id: game.id, start: game.start, ...(game.missions ? { missions: game.missions } : {}), screens, objects, triggers, rules, conversations, advice, ...(ship ? { ship } : {}) };
  const refProblems = checkRefs(content, where);
  if (refProblems.length > 0) throw new ContentError(refProblems);
  return content;
}

/**
 * combat.yaml read after the rest of the game (the web app's lazy chunk, M8 spec §8): parsed, and its names checked against the
 * game's as parseGame checks them. Throws ContentError with every problem.
 */
export function parseCombatFor(content: GameContent, text: string): CombatData {
  const combat = parseCombat(text);
  const problems = combatRefProblems(content, combat);
  if (problems.length > 0) throw new ContentError(problems);
  return combat;
}

/** combat.yaml on its own, for the tools that read it (the space build, Plan 18 Task 8). */
export function parseCombat(text: string): CombatData {
  const result = combatDataSchema.safeParse(parseYaml(text));
  if (!result.success) throw new ContentError(result.error.issues.map(i => `combat.yaml: ${formatPath(i.path)}: ${i.message}`));
  return result.data;
}
