// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { makeGame } from '../testing/fixture';
import { tricorderCue } from './cues';

describe('tricorderCue (object.cpp:1277-1279)', () => {
  it('chirps for a passed condition with the tricorder as the other object, and for nothing else', () => {
    const content = makeGame([], { rules: { items: { tricorder: 'tricorder' }, lines: {} } });
    expect(tricorderCue({ type: 'conditionPassed', group: 'panel/use/0', other: 'tricorder' }, content)).toBe(true);
    expect(tricorderCue({ type: 'conditionPassed', group: 'panel/use/0', other: 'phaser' }, content)).toBe(false);
    expect(tricorderCue({ type: 'conditionPassed', group: 'panel/use/0', other: null }, content)).toBe(false);
    expect(tricorderCue({ type: 'ruleRan', target: 'panel', verb: 'use', group: 'panel/use/0' }, content)).toBe(false);
  });
});
