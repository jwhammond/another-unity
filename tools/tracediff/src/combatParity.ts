// SPDX-License-Identifier: GPL-3.0-or-later
import { combatSim, type CombatData } from '@another-unity/engine';

/** What a parity run fights (docs/tracediff.md, "Space combat"): one battle, at a difficulty, from a seed, to a cap, with scripted inputs or none. */
export interface ParityRun {
  battle: number;
  difficulty: 0 | 1 | 2;
  /** The game's random seed the trace starts from (`trace <file> <seed>`): the battle's combatSeed is its first draw. */
  seed: number;
  /** The most steps the run takes (harness.inc `fight <cap>`). */
  cap: number;
  /** `at <step> <input>` lines (engine's parseInputScript), as a scripted battle has them. */
  inputs: string;
}

/**
 * The ScummVM harness script for a parity run (tools/scummvm-harness/harness.inc): the difficulty, the trace from the
 * seed, the battle's ships a new game has inactive made active (as the story makes them before their battles: a
 * battle with no Enterprise can't be fought, and setup refuses it), the battle, the scripted inputs, the fight to
 * its end or the cap, and the trace's end. `@DIR@` is the run's directory (run.sh). Null for a battle the lifted game
 * doesn't have or that has no Enterprise.
 */
export function harnessScript(combat: CombatData, hexOf: (slug: string) => string | undefined, activeAtStart: (slug: string) => boolean, run: ParityRun): string | null {
  const def = combat.battles[run.battle];
  if (!def || !def.ships.some(s => s.type === combatSim.KIND.enterprise)) return null;
  const lines = ['difficulty ' + run.difficulty, 'wait 1000', `trace @DIR@/trace.jsonl ${run.seed}`];
  for (const s of def.ships) {
    const id = hexOf(s.object);
    if (id && !activeAtStart(s.object)) lines.push(`activate ${id} 1`);
  }
  // (kShipTactical, unity.h:330; harness.inc's `ship <code> <battle>` sets the battle scenario first)
  lines.push(`ship 7 ${run.battle}`);
  for (const line of run.inputs.split('\n')) {
    const at = line.replace(/#.*$/, '').trim();
    if (at !== '') lines.push(at);
  }
  lines.push(`fight ${run.cap}`, 'trace off', 'quit');
  return lines.join('\n') + '\n';
}
