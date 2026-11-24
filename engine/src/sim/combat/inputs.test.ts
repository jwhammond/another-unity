// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { CONSOLE_PAGES } from './commands';
import { parseInputLine, parseInputScript } from './inputs';

describe('combat input lines (docs/trace-format.md, "Space combat")', () => {
  it('reads each command the harness plays', () => {
    const read = (line: string) => {
      const r = parseInputLine(line);
      return 'command' in r ? r.command : r.error;
    };
    expect([
      'steer 1 -1 0 1', 'orbit -1', 'stop', 'fire both', 'target next', 'target none', 'target 2', 'delegate on', 'maneuver 6',
      'scroll up', 'engage', 'hail', 'bridge', 'engineering', 'view 12 target', 'cycle', 'zoom out', 'wide on', ...CONSOLE_PAGES.map(p => `page ${p}`),
    ].map(read)).toEqual([
      { type: 'steer', yaw: 1, pitch: -1, roll: 0, throttle: 1 }, { type: 'orbit', direction: -1 }, { type: 'allStop' },
      { type: 'fire', weapon: 'both' }, { type: 'target', which: 'next' }, { type: 'target', ship: null }, { type: 'target', ship: 2 },
      { type: 'delegate', on: true }, { type: 'maneuver', row: 6 }, { type: 'scrollManeuvers', direction: -1 }, { type: 'engage' },
      { type: 'hail' }, { type: 'bridge' }, { type: 'engineering' }, { type: 'view', view: 12, ship: 'target' }, { type: 'cycleView' },
      { type: 'zoom', direction: 'out' }, { type: 'wide', on: true }, ...CONSOLE_PAGES.map(page => ({ type: 'page', page })),
    ]);
    expect([
      'set banks all', 'set bank 5 40', 'set salvo 1 10', 'set spread 9', 'set shields off', 'set lock on', 'set power 4', 'set selfdestruct',
    ].map(read)).toEqual([
      { type: 'banks', all: true }, { type: 'bank', bank: 5, setting: 40 }, { type: 'salvo', tube: 1, setting: 10 }, { type: 'spread', cell: 9 },
      { type: 'shields', on: false }, { type: 'weaponsLock', on: true }, { type: 'powerLevel', level: 4 }, { type: 'selfDestruct' },
    ]);
  });

  it('refuses what the harness would: a wrong count, a direction past 1, a setting out of range, an unknown word', () => {
    for (const line of ['steer 1 0 0', 'steer 2 0 0 0', 'fire', 'target -1', 'delegate yes', 'set bank 6 10', 'set salvo 2 1', 'set spread 10', 'set power 5', 'page bridge', 'warp', 'maneuver 7', 'stop  ', 'fire  both', 'fire\tboth', '']) {
      expect(parseInputLine(line)).toEqual({ error: `not a combat input: "${line.trim()}"` });
    }
  });

  it('reads a scripted battle: at <step> <input> lines, comments and blanks, in order of step', () => {
    expect(parseInputScript('# a turn\nat 0 delegate off\n\nat 30 steer 1 0 0 1\n  # on a line of its own\nat 30 fire phasers\n')).toEqual({
      inputs: [
        { step: 0, line: 'delegate off', command: { type: 'delegate', on: false } },
        { step: 30, line: 'steer 1 0 0 1', command: { type: 'steer', yaw: 1, pitch: 0, roll: 0, throttle: 1 } },
        { step: 30, line: 'fire phasers', command: { type: 'fire', weapon: 'phasers' } },
      ],
      errors: [],
    });
    expect(parseInputScript('at 5 stop\nat 4 stop\nfire both\nat 6 jump\n').errors).toEqual([
      'line 2: step 4 comes before step 5',
      'line 3: expected "at <step> <input>": "fire both"',
      'line 4: not a combat input: "jump"',
    ]);
  });

  it('refuses what the harness could not read as the port does: inline comments, tabs, doubled spaces, a step with a tail', () => {
    for (const text of ['at 30 steer 1 0 0 1 # x', 'at\t30 stop', 'at 30 stop\t1', 'at 30\tstop', 'at 30  stop', 'at 30 fire  both', 'at 5x stop']) {
      const r = parseInputScript(text);
      expect([text, r.inputs, r.errors.length]).toEqual([text, [], 1]);
    }
  });

  it('refuses a line with leading or trailing whitespace, as the harness traces its text raw; blank and comment lines may have it', () => {
    expect(parseInputScript(' at 3 stop\nat 4 stop \nat 5 stop\r\n   \n  # note\n').errors).toEqual([
      'line 1: leading or trailing whitespace: "at 3 stop"',
      'line 2: leading or trailing whitespace: "at 4 stop"',
      'line 3: leading or trailing whitespace: "at 5 stop"',
    ]);
  });
});
