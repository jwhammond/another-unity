// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { combatSim, miniTacticsCombat } from '@another-unity/engine';
import { describe, expect, it } from 'vitest';
import { runTracediff } from './cli';
import { harnessScript } from './combatParity';

const HEX: Record<string, string> = { 'space.enterprise': '100300', 'space.chodak': '100301' };

describe('a parity run\'s harness script, and the hand-flown battles', () => {
  it('sets the difficulty, traces from the seed, makes the inactive ships active, plays the inputs, and fights to the cap', () => {
    const script = harnessScript(miniTacticsCombat(), s => HEX[s], s => s === 'space.enterprise', {
      battle: 3, difficulty: 1, seed: 7003, cap: 700, inputs: '# a comment\nat 1 delegate on\n\nat 30 fire both  # and another\n',
    });
    expect(script).toBe([
      'difficulty 1', 'wait 1000', 'trace @DIR@/trace.jsonl 7003', 'activate 100301 1', 'ship 7 3',
      'at 1 delegate on', 'at 30 fire both', 'fight 700', 'trace off', 'quit', '',
    ].join('\n'));
  });

  it('has no script for a battle the game lacks, or one with no Enterprise', () => {
    const combat = miniTacticsCombat();
    const run = { battle: 3, difficulty: 0 as const, seed: 1, cap: 1, inputs: '' };
    expect(harnessScript(combat, s => HEX[s], () => true, { ...run, battle: 9 })).toBeNull();
    combat.battles[3]!.ships = combat.battles[3]!.ships.filter(s => s.type !== combatSim.KIND.enterprise);
    expect(harnessScript(combat, s => HEX[s], () => true, run)).toBeNull();
  });

  it('refuses a script that presses Engineering, which the harness can\'t play, before it reads the game', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'combat-script-'));
    try {
      writeFileSync(join(dir, 'e.inputs'), 'at 3 delegate off\nat 9 engineering\n');
      const log: string[] = [];
      const argv = ['combat-script', '--game', join(dir, 'no-game'), '--battle', '3', '--difficulty', '0', '--seed', '1', '--cap', '700', '--inputs', join(dir, 'e.inputs'), '--out', join(dir, 'script.txt')];
      expect(await runTracediff(argv, line => log.push(line))).toBe(2);
      expect(log).toEqual([`tracediff combat-script: ${join(dir, 'e.inputs')}: at 9 engineering: the harness can't play it (the battle would wait on the engineering screen to its cap)`]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('says a bad trace\'s problems and notes for combat-states, and refuses it before it reads the game (Plan 25)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'combat-states-'));
    try {
      const trace = join(dir, 'trace.jsonl');
      const argv = ['combat-states', '--game', join(dir, 'no-game'), '--scummvm', trace, '--steps', '5', '--out', dir];
      // (a line that isn't JSON in the middle, and a half-written last line)
      writeFileSync(trace, '{"ev":"combat","scenario":3}\nnot json\n{"ev":"rng","site":"combatSeed","value":1}\n{"ev":"sh');
      const log: string[] = [];
      expect(await runTracediff(argv, line => log.push(line))).toBe(2);
      expect(log).toEqual([
        `tracediff combat-states: ${trace}: line 4: half-written, dropped: the run stopped part way through its battle`,
        `tracediff combat-states: ${trace}: line 2: not JSON`,
        `tracediff combat-states: ${trace}: battle 3: its trace has no seed, setup clock or ships`,
        `tracediff combat-states: ${trace} has no battle`,
      ]);
      // (no battle at all)
      writeFileSync(trace, '{"ev":"rng","site":"other","value":1}\n');
      log.length = 0;
      expect(await runTracediff(argv, line => log.push(line))).toBe(2);
      expect(log).toEqual([`tracediff combat-states: ${trace} has no battle`]);
      expect(readdirSync(dir).filter(f => f.startsWith('state-'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('has hand-flown battles whose every line the port reads', () => {
    const dir = fileURLToPath(new URL('../battles', import.meta.url));
    const files = readdirSync(dir).filter(f => f.endsWith('.inputs')).sort();
    expect(files).toEqual(['console.inputs', 'delegate.inputs', 'flight.inputs', 'selfdestruct-conn.inputs', 'selfdestruct.inputs', 'views.inputs']);
    for (const f of files) {
      const { inputs, errors } = combatSim.parseInputScript(readFileSync(`${dir}/${f}`, 'utf8'));
      expect(errors, f).toEqual([]);
      expect(inputs.length, f).toBeGreaterThan(0);
    }
  });
});
