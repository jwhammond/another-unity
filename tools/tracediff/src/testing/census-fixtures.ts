// SPDX-License-Identifier: GPL-3.0-or-later
import type { GameContent, RuleGroup } from '@another-unity/engine';
import { makeGame } from '@another-unity/engine';
import type { RawIR } from '@another-unity/lift/raw';

/** Synthetic content: one object per slug, its `use` rules the given groups. */
export function content(rules: Record<string, RuleGroup[]>): GameContent {
  return makeGame(Object.entries(rules).map(([id, use]) => ({ id, name: id, screen: 'room', at: 'panel', on: { use } })));
}

export const group = (g: RuleGroup extends infer T ? Partial<T> : never): RuleGroup => ({ do: [], ...g }) as RuleGroup;

/**
 * Raw objects whose `use` script holds one AlterBlock per listed target, its `kill` the destroyed hook's.
 * A target is an id (state 1) or `{ id, state, flags, hailOnly }`; `state` 255 is "no change".
 */
type Alter = string | { id: string; state?: number; flags?: number };
const alterBlock = (a: Alter) => {
  const o = typeof a === 'string' ? { id: a } : a;
  return { class: 'AlterBlock', target: o.id, alter_state: o.state ?? 1, alter_flags: o.flags ?? 0, alter_reset: 0 };
};
export function rawObjects(spec: Record<string, { name: string; alters?: Alter[]; kill?: Alter[] }>): Pick<RawIR, 'objects'> {
  const objects = new Map<string, unknown>();
  for (const [id, { name, alters = [], kill }] of Object.entries(spec)) {
    objects.set(id, {
      id, name, use_entries: [alters.map(alterBlock)],
      ...(kill ? { phaser_data: { kill_entries: [kill.map(alterBlock)] } } : {}),
    });
  }
  return { objects } as unknown as Pick<RawIR, 'objects'>;
}
