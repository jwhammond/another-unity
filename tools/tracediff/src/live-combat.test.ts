// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCombatRolls, checkTrace, parseTrace } from '@another-unity/rawcheck/trace';
import { describe, expect, it } from 'vitest';
import { readBattles, replayBattle } from './combat';
import { diffBattle } from './combatDiff';
import { GameMaps } from './maps';

// COMBAT_PARITY_DIR=$HOME/pcode/unity-raw/runs/combat-parity, after tools/tracediff/combat-parity.sh (docs/tracediff.md)
const game = fileURLToPath(new URL('../../../games/unity', import.meta.url));
const dir = process.env.COMBAT_PARITY_DIR ?? '';
const lifted = existsSync(join(game, 'combat.yaml'));
const labels = dir && existsSync(dir) ? readdirSync(dir).filter(l => existsSync(join(dir, l, 'summary.txt'))).sort() : [];
if (!lifted || labels.length === 0) console.info('live-combat.test.ts: skipped; run npm run unity:build and tools/tracediff/combat-parity.sh, then set COMBAT_PARITY_DIR (docs/tracediff.md)');

/** A run's battles: each b<battle>/trace.jsonl, in battle order. */
function traces(label: string): { battle: number; text: string }[] {
  return readdirSync(join(dir, label)).filter(d => /^b\d+$/.test(d) && existsSync(join(dir, label, d, 'trace.jsonl')))
    .map(d => ({ battle: Number(d.slice(1)), text: readFileSync(join(dir, label, d, 'trace.jsonl'), 'utf8') }))
    .sort((a, b) => a.battle - b.battle);
}

/**
 * What holds of Plan 22's suite on every run (Task 8: combat-parity.sh, docs/tracediff.md): each label's battle
 * count, and for the hand-flown ones the end's reason (cap: 700 steps; leave: the battle left the screen). The end
 * steps and the atan2f counts aren't pinned: ScummVM's setup clock is the wall clock (combat.cpp:159), so the units'
 * timers start apart from run to run, and with them where a battle ends (docs/tracediff.md has one run's, measured
 * once). A run with another label is only checked clean, finished and well formed.
 */
const PINNED: Record<string, { battles: number; ends?: string }> = {
  'ensign': { battles: 39 },
  'lieutenant': { battles: 39 },
  'flight': { battles: 1, ends: '1:cap' },
  'console': { battles: 1, ends: '1:cap' },
  'selfdestruct': { battles: 1, ends: '1:leave' },
  'selfdestruct-conn': { battles: 1, ends: '1:leave' },
};

/** Long enough for a label of 39 battles, each loaded, replayed and compared (about 90 s for one on an idle Mac). */
const LABEL_TIMEOUT = 600_000;

describe.skipIf(!lifted || labels.length === 0)('the combat parity runs (Plan 22)', () => {
  it.each(labels)('%s: every trace is well formed, its draws replay from its seed, and the port fights each battle the same', async label => {
    const maps = await GameMaps.load(game);
    const hex = new Map(Object.entries(maps.ids.objects).map(([h, slug]) => [slug, h]));
    const lines: string[] = [];
    const differing: string[] = [];
    // (a battle ScummVM didn't finish, killed or hung with no combatEnd, compares as a clean prefix: it fails here, by name)
    const unfinished: string[] = [];
    let taken = 0;
    for (const { battle, text } of traces(label)) {
      const { events, problems } = parseTrace(text);
      expect(problems, `b${battle}`).toEqual([]);
      expect(checkTrace(events), `b${battle}`).toEqual([]);
      expect(checkCombatRolls(events), `b${battle}`).toEqual([]);
      const { battles } = readBattles(text);
      expect(battles.map(b => b.start.scenario)).toEqual([battle]);
      const t = battles[0]!;
      const r = replayBattle(maps.content, slug => hex.get(slug), t);
      const d = diffBattle(t.events, r.events);
      // (a difference, or a problem of the replay's or the diff's: PROBLEMS in combat-parity.sh, verdictOf)
      if (!d.clean || r.problems.length > 0 || d.problems.length > 0) differing.push(`b${battle}: ${d.first ?? [...r.problems, ...d.problems][0]}`);
      taken += Object.values(d.atan2).reduce((n, k) => n + k, 0);
      const end = t.events.at(-1);
      if (end?.ev !== 'combatEnd' || !r.finished) unfinished.push(`b${battle}`);
      lines.push(`${battle}:${end?.ev === 'combatEnd' ? `${end.reason}@${end.step}` : '?'}`);
    }
    console.info(`live-combat.test.ts: ${label}: ${lines.length} battles; ${differing.length} differ; ${unfinished.length} didn't finish; ScummVM's atan2f taken ${taken} times; ${lines.join(' ')}`);
    expect(differing).toEqual([]);
    expect(unfinished, 'battles ScummVM didn\'t finish').toEqual([]);
    const pinned = PINNED[label];
    if (pinned) {
      expect(lines.length, 'battles').toBe(pinned.battles);
      if (pinned.ends) expect(lines.map(l => l.split('@')[0]).join(' '), 'end reasons').toBe(pinned.ends);
    }
  }, LABEL_TIMEOUT);
});
