// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { liftRules, liftStart } from './hardcoded';
import { miniRaw, obj, type J } from './testing/mini';
import { rawFromMini, testCtx } from './testing/ctx';
import { liftAdvice, liftTriggers } from './world';

describe('triggers', () => {
  it('lifts the triggers asked for', () => {
    const ctx = testCtx();
    expect(liftTriggers(ctx, t => t.target.startsWith('07'))).toEqual([
      { id: 't3', type: 'timer', context: 'away', target: 'horst3.setup_world', enabled: false, seconds: 30 },
      { id: 't4', type: 'normal', context: 'away', target: 'horst3.guard', enabled: true },
    ]);
  });

  it('keeps a proximity trigger as an inert record, and numbers a repeated id (M3 Decision 5)', () => {
    const ctx = testCtx(rawFromMini(miniRaw(files => {
      (files['triggers.json'] as J[]).push({ ...(files['triggers.json'] as J[])[1] });
    })));
    expect(liftTriggers(ctx, t => t.id !== 3)).toEqual([
      { id: 't4', type: 'normal', context: 'away', target: 'horst3.guard', enabled: true },
      {
        id: 't9', type: 'proximity', context: 'ship', target: 'ship.beacon', enabled: true,
        proximity: { dist: 5, from: 'ship.enterprise', to: 'ship.planet', reversed: false, instant: true },
      },
      ...[2, 8, 10, 21, 69, 71].map(id => ({ id: `t${id}`, type: 'normal', context: 'ship', target: 'ship.beacon', enabled: false })),
      { id: 't12', type: 'timer', context: 'ship', target: 'ship.beacon', enabled: false, seconds: 25 },
      { id: 't4.2', type: 'normal', context: 'away', target: 'horst3.guard', enabled: true },
    ]);
    expect(ctx.problems.errors).toEqual([]);
    expect(ctx.problems.warnings).toEqual(['triggers.json#/10: a second trigger 4, which TriggerBlocks never reach (getTrigger finds the first)']);
  });
});

describe('repeated trigger ids', () => {
  it('numbers a repeat by its place among all the triggers, whichever are lifted', () => {
    const ctx = testCtx(rawFromMini(miniRaw(files => {
      (files['triggers.json'] as J[]).push({ ...(files['triggers.json'] as J[])[1] });
    })));
    // (only the repeat is asked for: it is still the second trigger 4)
    expect(liftTriggers(ctx, t => t === ctx.raw.triggers[ctx.raw.triggers.length - 1]).map(t => t.id)).toEqual(['t4.2']);
  });
});

describe('advice', () => {
  it('keys each line by crew slug, the first per name, with anyone as $anyone', () => {
    const ctx = testCtx();
    expect(liftAdvice(ctx, ctx.raw.worlds.get('w_07')!)).toEqual({
      'horst3.a1': { easy: { picard: '@horst3.c000,1', $anyone: 'Look around.' }, hard: { data: '^1' } },
    });
  });
});

describe('the hard-coded rules', () => {
  it('names the items, the doctor, the fixed lines and the distances', () => {
    const ctx = testCtx();
    expect(liftRules(ctx, 0.0125)).toEqual({
      talkDistance: 2.25, stepIn: 0.375, doctor: 'crusher',
      items: { medicalTricorder: 'medical_tricorder', tricorder: 'tricorder', communicator: 'communicator', phaser: 'phaser', medkit: 'medkit' },
      lines: {
        failLook: { conversation: 'ship.c034', situation: 1 }, failTalk: { conversation: 'ship.c034', situation: 2 },
        failUse: { conversation: 'ship.c034', situation: 3 }, failOther: { conversation: 'ship.c034', situation: 4 },
        failPhaser: { conversation: 'ship.c034', situation: 5 }, tricorderNothing: { conversation: 'frigis.c015', situation: 23 },
        noAdvice: { conversation: 'ship.c034', situation: 42 },
        gameOver: { conversation: 'ship.c034', situation: 43 },
        medical: { conversation: 'ship.c034', order: ['picard', 'riker', 'data', 'troi', 'worf', 'crusher'] },
      },
    });
  });

  it('fails when a crew number is missing, since the medical lines count from it', () => {
    const ctx = testCtx(rawFromMini(miniRaw(files => {
      delete files['objects/o_000004.json'];
    })));
    liftRules(ctx, 0.0125);
    expect(ctx.problems.errors).toEqual(["hardcoded.ts: the medical lines need crew 0-5 without gaps, but crew member 4 isn't in the export"]);
  });

  it('starts with the first four crew at the first screen\'s entrance 0, Picard leading', () => {
    expect(liftStart(testCtx(), 'horst3.s01')).toEqual({
      screen: 'horst3.s01', entrance: 'entrance_0', awayTeam: ['picard', 'riker', 'data', 'troi'], leader: 'picard',
    });
  });
});
