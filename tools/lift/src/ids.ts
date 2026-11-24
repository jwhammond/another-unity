// SPDX-License-Identifier: GPL-3.0-or-later
import type { Problems } from './problems';

/** objectID(0x10, 0, 0): the current member, or "anyone". */
export const ANYONE_ID = '000010';
/** objectID(0x20, 0, 0): whoever is acting now (CommandBlock). */
export const ACTOR_ID = '000020';
export const NONE_ID = 'ffffff';
/** A condition's target 0xfffffe: fail if another object was given (object.cpp ConditionBlock::check). */
export const NOT_OTHER_ID = 'fffffe';
/** objectID(0, 1, 0x5f): the Enterprise, whose alters warp it (object.cpp AlterBlock::execute). */
export const ENTERPRISE_ID = '5f0100';
export const SHIP_WORLD = 0x5f;
/** The space world (0x10): each screen is a battle's scenario (combat.cpp Combat::setup, `listScreenObjects(0x10, screen)`). */
export const SPACE_WORLD = 0x10;

export function hex2(n: number): string {
  return n.toString(16).padStart(2, '0');
}

export function parseId(id: string): { world: number; screen: number; id: number } {
  return { world: parseInt(id.slice(0, 2), 16), screen: parseInt(id.slice(2, 4), 16), id: parseInt(id.slice(4, 6), 16) };
}

/** isCrew (object.cpp): world 0, screen 0, below 0x10. */
export function isCrewId(id: string): boolean {
  return id.startsWith('0000') && parseInt(id.slice(4), 16) < 0x10;
}

export const screenKey = (world: number, screen: number) => `s_${hex2(world)}${hex2(screen)}`;
export const conversationKey = (world: number, id: number) => `w${world.toString(16).padStart(3, '0')}c${String(id).padStart(3, '0')}`;
export const worldKey = (world: number) => `w_${hex2(world)}`;

/** The worlds, named as sound.cpp's music cases name them. */
export const WORLD_SLUGS: Readonly<Record<number, string>> = {
  0x00: 'crew', 0x02: 'allanor', 0x03: 'zoo', 0x04: 'lab', 0x05: 'frigis', 0x06: 'unity', 0x07: 'horst3',
  0x10: 'space', 0x5f: 'ship',
};

export function worldSlug(world: number): string {
  return WORLD_SLUGS[world] ?? `w${hex2(world)}`;
}

export function nameSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export const screenSlug = (world: number, screen: number) => `${worldSlug(world)}.s${hex2(screen)}`;
export const conversationSlug = (world: number, id: number) => `${worldSlug(world)}.c${String(id).padStart(3, '0')}`;
export const adviceSlug = (world: number, id: number) => `${worldSlug(world)}.a${id}`;
export const triggerSlug = (id: number) => `t${id}`;
export const regionName = (id: number) => `r${id}`;

/** World 0's objects by name, others `<world>.<name>`; names shared within a world all get `.<ssii>`. */
export function assignObjectSlugs(objects: Iterable<{ id: string; name: string }>): Map<string, string> {
  const byWorld = new Map<number, { id: string; base: string }[]>();
  for (const o of objects) {
    const { world } = parseId(o.id);
    const base = nameSlug(o.name) || `o${o.id.slice(2)}`;
    const list = byWorld.get(world) ?? [];
    list.push({ id: o.id, base });
    byWorld.set(world, list);
  }
  const out = new Map<string, string>();
  for (const [world, list] of byWorld) {
    const counts = new Map<string, number>();
    for (const { base } of list) counts.set(base, (counts.get(base) ?? 0) + 1);
    for (const { id, base } of list) {
      const local = (counts.get(base) ?? 0) > 1 ? `${base}.${id.slice(2)}` : base;
      out.set(id, world === 0 ? local : `${worldSlug(world)}.${local}`);
    }
  }
  return out;
}

/** What a lift reached: by IR id (objects `070103`, conversations `w007c000`, screens `s_0701`, advice `w_07/1`). */
export class Scope {
  readonly objects = new Set<string>();
  readonly conversations = new Set<string>();
  readonly screens = new Set<string>();
  readonly triggers = new Set<number>();
  readonly advice = new Set<string>();

  addAll(other: Scope): boolean {
    let grew = false;
    const add = <T>(into: Set<T>, from: Set<T>) => {
      for (const v of from) if (!into.has(v)) {
        into.add(v);
        grew = true;
      }
    };
    add(this.objects, other.objects);
    add(this.conversations, other.conversations);
    add(this.screens, other.screens);
    add(this.triggers, other.triggers);
    add(this.advice, other.advice);
    return grew;
  }
}

export interface Known {
  objects: ReadonlySet<string>;
  conversations: ReadonlySet<string>;
  screens: ReadonlySet<string>;
  triggers: ReadonlySet<number>;
}

const sortedRecord = (m: Map<string, string>) => Object.fromEntries([...m].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** Original ids to slugs; records each one used (for ids.yaml) and each one needed (for the scope). */
export class IdTable {
  readonly need = new Scope();
  /** Set while lifting secondary content: references must already be in scope (Decision 6). */
  lenient = false;
  private readonly used = {
    worlds: new Map<string, string>(), screens: new Map<string, string>(), objects: new Map<string, string>(),
    conversations: new Map<string, string>(), triggers: new Map<string, string>(), advice: new Map<string, string>(),
    lists: new Map<string, string>(),
  };

  constructor(
    private readonly slugs: ReadonlyMap<string, string>,
    private readonly known: Known,
    private readonly problems: Problems,
    private readonly scope?: Scope,
  ) {}

  /** In lenient mode, false (with an error) for a reference outside the scope. */
  private allowed(key: string, inScope: boolean, where: string): boolean {
    if (!this.lenient || inScope) return true;
    this.problems.error(where, `${key} is outside the lift's scope (only primary content widens it)`);
    return false;
  }

  private world(world: number): void {
    this.used.worlds.set(hex2(world), worldSlug(world));
  }

  object(id: string, where: string): string {
    const slug = this.slugs.get(id);
    if (slug === undefined || !this.known.objects.has(id)) {
      this.problems.error(where, `no object ${id} in the export`);
      return `unknown.${id}`;
    }
    if (!this.allowed(id, this.scope?.objects.has(id) ?? true, where)) return slug;
    this.used.objects.set(id, slug);
    if (!this.lenient) this.need.objects.add(id);
    return slug;
  }

  screen(world: number, screen: number, where: string): string {
    const key = screenKey(world, screen);
    const slug = screenSlug(world, screen);
    if (!this.known.screens.has(key)) {
      this.problems.error(where, `no screen ${key} in the export`);
      return slug;
    }
    if (!this.allowed(key, this.scope?.screens.has(key) ?? true, where)) return slug;
    this.world(world);
    this.used.screens.set(key, slug);
    if (!this.lenient) this.need.screens.add(key);
    return slug;
  }

  conversation(world: number, id: number, where: string): string {
    const key = conversationKey(world, id);
    const slug = conversationSlug(world, id);
    if (!this.known.conversations.has(key)) {
      this.problems.error(where, `no conversation ${key} in the export`);
      return slug;
    }
    if (!this.allowed(key, this.scope?.conversations.has(key) ?? true, where)) return slug;
    this.world(world);
    this.used.conversations.set(key, slug);
    if (!this.lenient) this.need.conversations.add(key);
    return slug;
  }

  trigger(id: number, where: string): string {
    const slug = triggerSlug(id);
    if (!this.known.triggers.has(id)) {
      this.problems.error(where, `no trigger ${id} in triggers.json`);
      return slug;
    }
    if (!this.allowed(`trigger ${id}`, this.scope?.triggers.has(id) ?? true, where)) return slug;
    this.used.triggers.set(String(id), slug);
    if (!this.lenient) this.need.triggers.add(id);
    return slug;
  }

  /** (whether the advice exists is the world file's business: a missing one lifts as empty, see world.ts) */
  advice(world: number, id: number, where: string): string {
    const slug = adviceSlug(world, id);
    const key = `${worldKey(world)}/${id}`;
    if (!this.allowed(`advice ${key}`, this.scope?.advice.has(key) ?? true, where)) return slug;
    this.world(world);
    this.used.advice.set(key, slug);
    if (!this.lenient) this.need.advice.add(key);
    return slug;
  }

  /** An IR list (`o_070103#/use_entries`) and the content path its rule keys start with (`horst3.rubble/use`). */
  list(pointer: string, path: string): void {
    this.used.lists.set(pointer, path);
  }

  toYaml(): Record<string, Record<string, string>> {
    const u = this.used;
    return {
      worlds: sortedRecord(u.worlds), screens: sortedRecord(u.screens), objects: sortedRecord(u.objects),
      conversations: sortedRecord(u.conversations), triggers: sortedRecord(u.triggers), advice: sortedRecord(u.advice),
      lists: sortedRecord(u.lists),
    };
  }
}
