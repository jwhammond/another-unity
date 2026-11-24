// SPDX-License-Identifier: GPL-3.0-or-later
import type { Effect, GameContent, RuleGroup } from '@another-unity/engine';
import type { RawIR } from '@another-unity/lift/raw';
import type { EntryT } from '@another-unity/rawcheck/ir';
import { groupsIn, needs } from './outline';

export interface CensusRow {
  scenario: number;
  hails: { owner: string; type: number; needs: string[] }[];
  /** Original ids the scenario screen's scripts set a state or flag on (use/get/look/timer/stun and destroyed-hook scripts), outside world 0x10. */
  writes: string[];
  /** Owners (original ids) of the groups whose conditions read one of `writes`. */
  readBy: string[];
  mandatory: boolean;
}

type RawLike = Pick<RawIR, 'objects'> & Partial<Pick<RawIR, 'conversations'>>;

const BATTLE_TYPES = [0xa, 0xb, 0x10, 0x11];
/** An AlterBlock's alter_state of 255 leaves the state alone. */
const NO_STATE = 255;
function addValue(m: Map<string, Set<number>>, id: string, v: number): void {
  if (!m.has(id)) m.set(id, new Set());
  m.get(id)!.add(v);
}
const sentinel = (id: string) => id.startsWith('ff');

/**
 * The raw scripts' own view, for owners the lifter doesn't lift (the ship's objects and conversations run no scripts before M4):
 * a group is an array of blocks; its battle hails, the ids its conditions read, and the ids its alters write.
 */
function scanRaw(raw: RawLike): { hails: Array<{ owner: string; scenario: number; type: number; needs: string[] }>; readers: Map<string, Array<{ owner: string; state?: number }>>; alters: Map<string, Set<number>> } {
  const hails: Array<{ owner: string; scenario: number; type: number; needs: string[] }> = [];
  const readers = new Map<string, Array<{ owner: string; state?: number }>>();
  const alters = new Map<string, Set<number>>();
  const visit = (x: unknown, owner: string): void => {
    if (Array.isArray(x)) {
      const blocks = x.filter((b): b is Record<string, unknown> => typeof b === 'object' && b !== null && typeof (b as { class?: unknown }).class === 'string');
      if (blocks.length > 0 && blocks.length === x.length) {
        const needs: string[] = [];
        for (const b of blocks) {
          if (b.class !== 'ConditionBlock') continue;
          (b.condition as string[]).forEach((id, i) => {
            if (sentinel(id)) return;
            needs.push(`${id}=${(b.check_state as number[])[i]}`);
            if (!readers.has(id)) readers.set(id, []);
            readers.get(id)!.push({ owner, state: (b.check_state as number[])[i] });
          });
        }
        for (const b of blocks) {
          if (b.class === 'CommunicateBlock' && BATTLE_TYPES.includes(b.hail_type as number) && (b.conversation_id as number) < 0x100) {
            hails.push({ owner, scenario: b.conversation_id as number, type: b.hail_type as number, needs });
          }
          if (b.class === 'AlterBlock' && (b.alter_state as number) !== NO_STATE) addValue(alters, b.target as string, b.alter_state as number);
        }
      }
      x.forEach(v => visit(v, owner));
    } else if (typeof x === 'object' && x !== null) Object.values(x).forEach(v => visit(v, owner));
  };
  for (const [id, o] of raw.objects) if (!id.startsWith('10')) visit(o, id);
  for (const [key, c] of raw.conversations ?? []) visit(c, key);
  return { hails, readers, alters };
}

const LISTS = ['use_entries', 'get_entries', 'look_entries', 'timer_entries', 'stun_entries'] as const;

/** What a script sets: a state value (alter_state, unless 255), or just a flag/active/command change (`null`). Hail-only alters set nothing. */
type Writes = Map<string, Set<number | null>>;

function targetsIn(entries: EntryT[][], out: Writes): void {
  const add = (id: string, v: number | null) => {
    if (!out.has(id)) out.set(id, new Set());
    out.get(id)!.add(v);
  };
  for (const group of entries) {
    for (const e of group) {
      if (e.class === 'AlterBlock') {
        if (e.alter_state !== NO_STATE) add(e.target, e.alter_state);
        else if (e.alter_flags !== 0 || (e.alter_reset & 1) !== 0) add(e.target, null);
      } else if (e.class === 'CommandBlock') e.target.forEach(t => add(t, null));
      else if (e.class === 'ChoiceBlock') e._choice.forEach(list => targetsIn(list, out));
    }
  }
}

/** What a scenario's screen (`s_10NN`) objects write, outside world 0x10 and the 0xff sentinels: their scripts, and the destroyed hook (`phaser_data.kill_entries`). */
function scenarioWrites(raw: Pick<RawIR, 'objects'>, scenario: number): Writes {
  const prefix = `10${scenario.toString(16).padStart(2, '0')}`;
  const all: Writes = new Map();
  for (const [id, o] of raw.objects) {
    if (!id.startsWith(prefix)) continue;
    const bag = o as unknown as Record<string, EntryT[][] | undefined> & { phaser_data?: { kill_entries?: EntryT[][] } };
    for (const l of LISTS) targetsIn(bag[l] ?? [], all);
    targetsIn(bag.phaser_data?.kill_entries ?? [], all);
  }
  const out: Writes = new Map();
  for (const [id, v] of all) if (!id.startsWith('10') && !id.startsWith('ff')) out.set(id, v);
  return out;
}

/**
 * The space combats the story reaches (Plan 10 R6): every battle hail, what its scenario's scripts write, who reads it,
 * and whether the story needs the fight (some gate reads a written value that no lifted group alters, nor another scenario).
 */
export function combatCensus(content: GameContent, raw: RawLike, hexOf: Record<string, string>): CensusRow[] {
  const idOf = (slug: string) => hexOf[slug] ?? slug;
  const label = (slug: string) => idOf(slug);
  const groups: Array<{ owner: string; group: RuleGroup }> = [];
  for (const o of Object.values(content.objects)) {
    for (const [verb, list] of Object.entries(o.on ?? {})) groupsIn(list, verb).forEach(([, g]) => groups.push({ owner: idOf(o.id), group: g }));
  }
  for (const c of Object.values(content.conversations)) {
    for (const r of c.responses) (r.results ?? []).forEach(list => groupsIn(list, '').forEach(([, g]) => groups.push({ owner: idOf(c.id), group: g })));
  }

  const hails = new Map<number, CensusRow['hails']>();
  const altered = new Map<string, Set<number>>();
  const readers = new Map<string, Array<{ owner: string; state?: number }>>();
  for (const { owner, group } of groups) {
    for (const fx of group.do as Effect[]) {
      if ('communicate' in fx && fx.communicate.scenario !== undefined) {
        const list = hails.get(fx.communicate.scenario) ?? [];
        list.push({ owner, type: fx.communicate.type, needs: needs(group.when, label) });
        hails.set(fx.communicate.scenario, list);
      } else if ('alter' in fx && fx.alter.state !== undefined) addValue(altered, idOf(fx.alter.object), fx.alter.state);
    }
    for (const c of group.when?.checks ?? []) {
      if (!('object' in c)) continue;
      const id = idOf(c.object);
      if (!readers.has(id)) readers.set(id, []);
      readers.get(id)!.push({ owner, state: c.state });
    }
  }

  const scan = scanRaw(raw);
  for (const h of scan.hails) {
    const list = hails.get(h.scenario) ?? [];
    if (!list.some(l => l.owner === h.owner && l.type === h.type)) list.push({ owner: h.owner, type: h.type, needs: h.needs });
    hails.set(h.scenario, list);
  }
  for (const [id, values] of scan.alters) values.forEach(v => addValue(altered, id, v));
  for (const [id, who] of scan.readers) {
    if (!readers.has(id)) readers.set(id, []);
    readers.get(id)!.push(...who);
  }

  const scenarios = [...hails.keys()].sort((a, b) => a - b);
  const writesOf = new Map(scenarios.map(n => [n, scenarioWrites(raw, n)]));
  const reads = (id: string, v: number) => (readers.get(id) ?? []).some(r => r.state === undefined || r.state === v);
  return scenarios.map(scenario => {
    const writes = writesOf.get(scenario)!;
    const read = [...writes.keys()].filter(id => readers.has(id));
    // mandatory: it sets a value some gate reads, and neither a lifted/raw script nor another scenario sets that value
    const unique = [...writes].some(([id, values]) => [...values].some(v =>
      v !== null && reads(id, v) && !altered.get(id)?.has(v) && !scenarios.some(n => n !== scenario && writesOf.get(n)!.get(id)?.has(v))));
    return {
      scenario,
      hails: hails.get(scenario)!,
      writes: [...writes.keys()].sort(),
      readBy: [...new Set(read.flatMap(id => readers.get(id)!.map(r => r.owner)))].sort(),
      mandatory: unique,
    };
  });
}

export function renderCensus(rows: CensusRow[]): string[] {
  return rows.map(r =>
    `scenario ${r.scenario}: ${r.mandatory ? 'MANDATORY' : 'optional'}; hails [${r.hails.map(h => `${h.owner}/0x${h.type.toString(16)}`).join(', ')}]; writes [${r.writes.join(', ')}]; readBy [${r.readBy.join(', ')}]`);
}
