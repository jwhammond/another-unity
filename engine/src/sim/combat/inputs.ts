// SPDX-License-Identifier: GPL-3.0-or-later
import { CONSOLE_PAGES, type CombatCommand, type ConsolePage, type Held } from './commands';

/**
 * Combat input lines (docs/trace-format.md, "Space combat"): one grammar for the ScummVM harness's `at <step> <line>`,
 * the `input` events both engines' traces carry, and the port's scripted battles. Each line is one command, as a
 * player's key, button or click gives it (spec §4.5). Plan 23's walkthrough verb `combat <line>` reads the same lines.
 *
 *   steer <yaw> <pitch> <roll> <throttle>   each -1, 0 or 1: the flight keys held (0 lets go)
 *   orbit <-1|0|1>                          the camera's orbit keys
 *   stop                                    all stop
 *   fire phasers|torpedoes|both
 *   target next|prev|none|<ship index>
 *   delegate on|off
 *   maneuver <row 0-6>   scroll up|down   engage
 *   hail   bridge   engineering
 *   view <view> enterprise|target   cycle   zoom in|out   wide on|off
 *   page phasers|torpedoes|damage|conn|tactics|sensors
 *   set banks all|none   set bank <0-5> <0-100>   set salvo <0|1> <0-10>   set spread <0-9>
 *   set shields on|off   set lock on|off   set power <0-4>   set selfdestruct
 *
 * Numbers are decimal, with an optional sign where a direction is meant.
 *
 * This grammar is canonical, and a strict subset of what the harness (tools/scummvm-harness/harness.inc) accepts: the
 * harness reads atoi for numbers, treats any other word as off/none/both and ignores trailing tokens, where this
 * refuses them. Scripts are checked by `combat-script` (Task 7) with parseInputScript before any harness run, so the
 * harness's leniency never reaches a run. For the same reason a script is strict about its text: single spaces only (no
 * tabs, no doubled spaces), comments on lines of their own (an inline `#` is refused), and the input's raw text after
 * `at <step> ` is what the `input` event carries, as the harness traces it.
 */

/** A line read: its command, or why it isn't one. */
export type InputLine = { command: CombatCommand } | { error: string };

const int = (s: string | undefined): number | null => (s !== undefined && /^-?\d+$/.test(s) ? Number(s) : null);
const held = (s: string | undefined): Held | null => (s === '-1' || s === '0' || s === '1' ? (Number(s) as Held) : null);
const onOff = (s: string | undefined): boolean | null => (s === 'on' ? true : s === 'off' ? false : null);

/** One input line as a command. */
export function parseInputLine(line: string): InputLine {
  const w = line.split(' ');
  const bad = (): InputLine => ({ error: `not a combat input: "${line.trim()}"` });
  const ok = (command: CombatCommand): InputLine => ({ command });
  const [verb, a, b] = w;
  const n = w.length;
  switch (verb) {
    case 'steer': {
      const [yaw, pitch, roll, throttle] = w.slice(1).map(held);
      return n === 5 && yaw != null && pitch != null && roll != null && throttle != null ? ok({ type: 'steer', yaw, pitch, roll, throttle }) : bad();
    }
    case 'orbit': { const d = held(a); return n === 2 && d !== null ? ok({ type: 'orbit', direction: d }) : bad(); }
    case 'stop': return n === 1 ? ok({ type: 'allStop' }) : bad();
    case 'fire':
      return n === 2 && (a === 'phasers' || a === 'torpedoes' || a === 'both') ? ok({ type: 'fire', weapon: a }) : bad();
    case 'target': {
      if (n !== 2) return bad();
      if (a === 'next' || a === 'prev') return ok({ type: 'target', which: a });
      if (a === 'none') return ok({ type: 'target', ship: null });
      const i = int(a);
      return i !== null && i >= 0 ? ok({ type: 'target', ship: i }) : bad();
    }
    case 'delegate': { const on = onOff(a); return n === 2 && on !== null ? ok({ type: 'delegate', on }) : bad(); }
    case 'maneuver': { const r = int(a); return n === 2 && r !== null && r >= 0 && r < 7 ? ok({ type: 'maneuver', row: r }) : bad(); }
    case 'scroll': return n === 2 && (a === 'up' || a === 'down') ? ok({ type: 'scrollManeuvers', direction: a === 'up' ? -1 : 1 }) : bad();
    case 'engage': return n === 1 ? ok({ type: 'engage' }) : bad();
    case 'hail': return n === 1 ? ok({ type: 'hail' }) : bad();
    case 'bridge': return n === 1 ? ok({ type: 'bridge' }) : bad();
    case 'engineering': return n === 1 ? ok({ type: 'engineering' }) : bad();
    case 'view': {
      const v = int(a);
      return n === 3 && v !== null && v >= 0 && (b === 'enterprise' || b === 'target') ? ok({ type: 'view', view: v, ship: b }) : bad();
    }
    case 'cycle': return n === 1 ? ok({ type: 'cycleView' }) : bad();
    case 'zoom': return n === 2 && (a === 'in' || a === 'out') ? ok({ type: 'zoom', direction: a }) : bad();
    case 'wide': { const on = onOff(a); return n === 2 && on !== null ? ok({ type: 'wide', on }) : bad(); }
    case 'page': return n === 2 && (CONSOLE_PAGES as readonly string[]).includes(a!) ? ok({ type: 'page', page: a as ConsolePage }) : bad();
    case 'set': return parseSetting(w.slice(1)) ?? bad();
    default: return bad();
  }
}

function parseSetting(w: string[]): InputLine | null {
  const [what, a, b] = w;
  const n = w.length;
  const i = int(a), v = int(b);
  switch (what) {
    case 'banks': return n === 2 && (a === 'all' || a === 'none') ? { command: { type: 'banks', all: a === 'all' } } : null;
    case 'bank': return n === 3 && i !== null && i >= 0 && i < 6 && v !== null ? { command: { type: 'bank', bank: i, setting: v } } : null;
    case 'salvo': return n === 3 && (i === 0 || i === 1) && v !== null ? { command: { type: 'salvo', tube: i, setting: v } } : null;
    case 'spread': return n === 2 && i !== null && i >= 0 && i < 10 ? { command: { type: 'spread', cell: i } } : null;
    case 'shields': { const on = onOff(a); return n === 2 && on !== null ? { command: { type: 'shields', on } } : null; }
    case 'lock': { const on = onOff(a); return n === 2 && on !== null ? { command: { type: 'weaponsLock', on } } : null; }
    case 'power': return n === 2 && i !== null && i >= 0 && i < 5 ? { command: { type: 'powerLevel', level: i } } : null;
    case 'selfdestruct': return n === 1 ? { command: { type: 'selfDestruct' } } : null;
    default: return null;
  }
}

/** A scripted battle's inputs: `at <step> <line>` lines, in order of step; a line of its own starting `#` is a comment. `line` is the input's text as written. */
export interface ScriptedInput { step: number; line: string; command: CombatCommand }

/** Reads `at <step> <line>` lines; anything else, or a line parseInputLine refuses, is an error naming its line number. */
export function parseInputScript(text: string): { inputs: ScriptedInput[]; errors: string[] } {
  const inputs: ScriptedInput[] = [];
  const errors: string[] = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw;
    if (line.trim() === '' || line.trim().startsWith('#')) return;
    if (line !== line.trim()) {
      errors.push(`line ${i + 1}: leading or trailing whitespace: "${line.trim()}"`);
      return;
    }
    const m = /^at ([0-9]+) (.+)$/.exec(line);
    if (!m || line.includes('\t')) {
      errors.push(`line ${i + 1}: expected "at <step> <input>": "${line}"`);
      return;
    }
    const step = Number(m[1]);
    const read = parseInputLine(m[2]!);
    if ('error' in read) errors.push(`line ${i + 1}: ${read.error}`);
    else if (inputs.length > 0 && step < inputs[inputs.length - 1]!.step) errors.push(`line ${i + 1}: step ${step} comes before step ${inputs[inputs.length - 1]!.step}`);
    else inputs.push({ step, line: m[2]!, command: read.command });
  });
  return { inputs, errors };
}
