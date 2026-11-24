// SPDX-License-Identifier: GPL-3.0-or-later
import type { FailureLines, GameRules, GameStart, ItemRoles, MissionDef } from '@another-unity/engine';
import type { LiftCtx } from './context';
import { conversationKey, hex2, screenKey, screenSlug, worldSlug } from './ids';
import { round3 } from './projection';

/** What the original executable hard-codes, with where ScummVM keeps it. */
export const HARDCODED = {
  /** kItem* (unity.h:59-63). */
  items: { medicalTricorder: '007000', tricorder: '007001', communicator: '007002', phaser: '007003', medkit: '007004' },
  /** The ship's triggers and battle that astrogation names (astrogation.cpp:76-97, kTriggerChatter aside: region chatter comes after M4). */
  astro: {
    starbaseBattle: 0x50,
    /** The battle a hail without a scenario starts (kDefaultBattle, tactical.cpp:206). */
    defaultBattle: 8,
    triggers: { arriveStarbase: 8, arriveStar: 10, firstVisit: 2, runAway: 21, secondVisitCheck: 69, secondVisit: 71 },
  },
  /** Dr. Crusher's medkit works better (useAwayTeamItem, awayteam.cpp:1293). */
  doctor: '000005',
  /** kTalkDistance (unity.cpp:1837), in pixels at full scale. */
  talkDistancePx: 180,
  /** placeAwayTeam's step-in: scaleAt * 30 / 256 pixels (awayteam.cpp:385), so 30 at full scale. */
  stepInPx: 30,
  /** [world, conversation, situation]: sayFailure (awayteam.cpp:424-462) and the no-advice line (talk.cpp:303). */
  lines: {
    failLook: [0x5f, 34, 1], failTalk: [0x5f, 34, 2], failUse: [0x5f, 34, 3], failOther: [0x5f, 34, 4],
    failPhaser: [0x5f, 34, 5], tricorderNothing: [5, 15, 23], noAdvice: [0x5f, 34, 42],
    // endGame's kGameOverConversation and kGameOverSituation (unity.h)
    gameOver: [0x5f, 34, 43],
  },
  /** The medical tricorder's and medkit's lines (useAwayTeamItem, awayteam.cpp:1301). */
  medical: [0x5f, 34],
  /** Without the transporter room, the first four crew go (startAwayTeam, awayteam.cpp:257-268). */
  teamSize: 4,
  /**
   * Where each away mission beams down, in the order the bridge stub offers them: Horst III, the opening, then
   * worlds 2-6 (M3 Plan 8 R6, R7). The ship scripts' BeamBlocks set _beam_world and _beam_screen; beamDown starts
   * entrance 0. World 6 beams down without the effect or the beam-down piece (TransporterScreen::energize).
   */
  missions: [
    { world: 7, screen: 1, source: 'o_5f037a, w05fc033' },
    { world: 2, screen: 1, source: 'o_5f0321, o_5f0324' },
    { world: 3, screen: 3, source: 'o_5f0335, w05fc003' },
    { world: 4, screen: 1, source: 'o_5f0340' },
    { world: 5, screen: 1, source: 'o_5f0358 (world 5; world 8 is its return)' },
    { world: 6, screen: 1, beamEffect: false, source: 'w05fc006 (response 44)' },
  ],
} as const;

/** The world a lift starts in without --start: the first mission of the original's order among those lifted (R7). */
export function defaultStart(worlds: readonly number[]): number {
  return HARDCODED.missions.find(m => worlds.includes(m.world))?.world ?? worlds[0];
}

/** game.yaml's missions, for the lifted worlds whose beam-down screen the export locates. */
export function liftMissions(ctx: LiftCtx, worlds: readonly number[], located: (key: string) => boolean): MissionDef[] {
  const out: MissionDef[] = [];
  for (const m of HARDCODED.missions) {
    if (!worlds.includes(m.world)) continue;
    const key = screenKey(m.world, m.screen);
    if (!located(key)) {
      ctx.problems.warn('hardcoded.ts missions', `no located ${key} for world ${m.world}'s beam-down (${m.source}): the mission is left out`);
      continue;
    }
    out.push({ world: worldSlug(m.world), number: m.world, screen: screenSlug(m.world, m.screen), entrance: 'entrance_0', ...('beamEffect' in m ? { beamEffect: false as const } : {}) });
  }
  return out;
}

/** The conversations the fixed lines use, which every lift includes. */
export function hardcodedConversations(): string[] {
  const keys = Object.values(HARDCODED.lines).map(([w, c]) => conversationKey(w, c));
  keys.push(conversationKey(HARDCODED.medical[0], HARDCODED.medical[1]));
  return [...new Set(keys)].sort();
}

export function liftRules(ctx: LiftCtx, metersPerPixel: number): GameRules {
  const where = 'hardcoded.ts';
  const items: ItemRoles = {};
  for (const [role, id] of Object.entries(HARDCODED.items)) {
    if (ctx.raw.objects.has(id)) items[role as keyof ItemRoles] = ctx.ids.object(id, where);
  }
  const lines: FailureLines = {};
  const conversation = (world: number, conv: number) => {
    if (ctx.raw.conversations.has(conversationKey(world, conv))) return ctx.ids.conversation(world, conv, where);
    ctx.problems.warn(where, `no conversation ${conversationKey(world, conv)} for a hard-coded line`);
    return undefined;
  };
  for (const [name, [world, conv, situation]] of Object.entries(HARDCODED.lines)) {
    const c = conversation(world, conv);
    if (c) lines[name as Exclude<keyof FailureLines, 'medical'>] = { conversation: c, situation };
  }
  const medical = conversation(HARDCODED.medical[0], HARDCODED.medical[1]);
  // (the medical lines' situations count from the patient's crew number, so order[n] must be crew member n)
  const numbers = [...ctx.crew.keys()].sort((a, b) => a - b);
  const gap = numbers.findIndex((n, i) => n !== i);
  if (gap >= 0) ctx.problems.error(where, `the medical lines need crew 0-${numbers[numbers.length - 1]} without gaps, but crew member ${gap} isn't in the export`);
  const order = numbers.map(n => ctx.crew.get(n) ?? '');
  if (medical && gap < 0) lines.medical = { conversation: medical, order };
  return {
    talkDistance: round3(HARDCODED.talkDistancePx * metersPerPixel),
    stepIn: round3(HARDCODED.stepInPx * metersPerPixel),
    ...(ctx.raw.objects.has(HARDCODED.doctor) ? { doctor: ctx.ids.object(HARDCODED.doctor, where) } : {}),
    items,
    lines,
  };
}

/** game.yaml's start: crew 0-3 at the screen's entrance 0, Picard (object 0, whom triggers act as) leading. */
export function liftStart(ctx: LiftCtx, screen: string): GameStart {
  const team: string[] = [];
  for (let i = 0; i < HARDCODED.teamSize; i++) {
    if (ctx.raw.objects.has(`0000${hex2(i)}`)) team.push(ctx.ids.object(`0000${hex2(i)}`, 'hardcoded.ts start'));
  }
  return { screen, entrance: 'entrance_0', awayTeam: team, leader: team[0] ?? '' };
}
