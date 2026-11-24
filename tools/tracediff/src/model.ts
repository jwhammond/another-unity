// SPDX-License-Identifier: GPL-3.0-or-later
/** A value in the normalized state: what both engines' state keys hold. */
export type Value = string | number | boolean | null;

/**
 * The event model both traces are normalized into (Plan 6 Decision 4). Slugs, not original ids;
 * positions in metres ("x,z"); voices as file stems.
 */
export type Norm =
  | { k: 'step'; line: number; text: string }
  | { k: 'seed'; seed: number }
  | { k: 'action'; verb: string; target: string | null; who: string; other: string | null; depth: number }
  | { k: 'actionEnd'; verb: string; target: string | null; flags: number; depth: number }
  | { k: 'group'; key: string; passed: boolean }
  | { k: 'rng'; site: string; max: number; value: number }
  | { k: 'say'; who: string; voice: string; text: string }
  | { k: 'choice'; kind: 'menu' | 'box'; options: number; picked: number }
  | { k: 'movie'; file: string }
  | { k: 'screen'; screen: string }
  | { k: 'ship' }
  | { k: 'trigger'; id: string; target: string }
  | { k: 'timer'; object: string }
  | { k: 'refused'; who: string }
  | { k: 'error'; what: string }
  /** Content the export lacks, reached by the TypeScript engine (ScummVM fails there: M3 Decision 3). */
  | { k: 'missing'; kind: string; id: string }
  /** One state key's new value; `alter` marks a position an AlterBlock set (alter-stops-walk). */
  | { k: 'set'; key: string; value: Value; tag?: 'alter' }
  /** Every state key's value as the TypeScript world starts (the ScummVM side has none). */
  | { k: 'baseline'; values: Record<string, Value> }
  | { k: 'end' };

/**
 * What an ordered event is, for matching: the wording of lines (when there is a voice), random values
 * (compared apart, while aligned) and an action's actor (compared after pairing, as a difference of its own) are left out.
 */
export function streamKey(e: Norm): string {
  switch (e.k) {
    case 'step': return `step ${e.line}`;
    case 'seed': return `seed ${e.seed}`;
    case 'action': return `action ${e.verb} ${e.target ?? '-'} with ${e.other ?? '-'} @${e.depth}`;
    case 'actionEnd': return `actionEnd ${e.verb} ${e.target ?? '-'} -> ${e.flags} @${e.depth}`;
    case 'group': return `group ${e.key} ${e.passed ? 'passed' : 'failed'}`;
    case 'rng': return `rng ${e.site}/${e.max}`;
    case 'say': return `say ${e.who} ${e.voice || e.text}`;
    case 'choice': return `choice ${e.kind} ${e.picked} of ${e.options}`;
    case 'movie': return `movie ${e.file}`;
    case 'screen': return `screen ${e.screen}`;
    case 'ship': return 'ship';
    case 'trigger': return `trigger ${e.id} -> ${e.target}`;
    case 'timer': return `timer ${e.object}`;
    case 'refused': return `refused ${e.who}`;
    case 'error': return 'error';
    case 'missing': return `missing ${e.kind} ${e.id}`;
    case 'set': return `set ${e.key}`;
    case 'baseline': return 'baseline';
    case 'end': return 'end';
  }
}

/** An event as the report and the summary show it. */
export function describeNorm(e: Norm): string {
  switch (e.k) {
    case 'action': return `${e.verb} ${e.target ?? '-'} by ${e.who}${e.other ? ` with ${e.other}` : ''} (depth ${e.depth})`;
    case 'actionEnd': return `end of ${e.verb} ${e.target ?? '-'}: flags 0x${e.flags.toString(16)} (depth ${e.depth})`;
    case 'group': return `group ${e.key} ${e.passed ? 'passed' : 'failed'}`;
    case 'rng': return `draw ${e.site}/${e.max} = ${e.value}`;
    case 'say': return `${e.who} says ${e.voice ? `[${e.voice}] ` : ''}"${e.text}"`;
    case 'choice': return `${e.kind} picked ${e.picked} of ${e.options}`;
    case 'movie': return `movie ${e.file}`;
    case 'screen': return `screen ${e.screen}`;
    case 'ship': return 'back to the ship';
    case 'trigger': return `trigger ${e.id} fires ${e.target}`;
    case 'timer': return `timer ${e.object}`;
    case 'refused': return `${e.who} can't act (down)`;
    case 'error': return `error: ${e.what}`;
    case 'missing': return `content the export lacks: ${e.kind} ${e.id}`;
    case 'set': return `${e.key} = ${JSON.stringify(e.value)}`;
    default: return streamKey(e);
  }
}

export function toJsonl(events: Norm[]): string {
  return events.map(e => JSON.stringify(e)).join('\n') + '\n';
}

export function fromJsonl(text: string): Norm[] {
  return text.split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l) as Norm);
}
