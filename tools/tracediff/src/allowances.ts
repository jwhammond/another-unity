// SPDX-License-Identifier: GPL-3.0-or-later
/** How an allowance treats a known divergence (Plan 6 Decision 6). */
export type AllowanceKind = 'forgive' | 'explain' | 'unreachable' | 'refused' | 'retired';

export interface Allowance {
  id: string;
  kind: AllowanceKind;
  why: string;
  source: string;
}

/** Every known divergence between the engines. Adding one needs a ledger ruling with its cost (M3 Decision 14). */
export const ALLOWANCES = [
  {
    id: 'advice-timing', kind: 'forgive',
    why: 'ScummVM offers advice on a wall-clock timer and the sim on ticks, deferred behind the same tick\'s trigger work, so the advisor\'s draw and the one line it offers (said by one of the advice entry\'s advisors) land at different moments. Both are dropped from the stream, and random values are compared again from the next seed both engines log.',
    source: 'carry notes: "ScummVM advisor RNG draws are wall-clock-timed (updateAdvice)", "advice/health deferred behind same-tick trigger work"; talk.cpp:421',
  },
  {
    id: 'phaser-regen-timing', kind: 'forgive',
    why: 'The sim skips health regeneration on busy ticks and defers it behind trigger work; ScummVM regenerates on its frame clock. In a step that fires no phaser, health values on the same side of the object\'s down threshold play the same.',
    source: 'carry notes: "health/regen skipped on busy ticks", "advice/health deferred behind same-tick trigger work"',
  },
  {
    id: 'timer-cadence', kind: 'forgive',
    why: 'Timers and triggers fire on each engine\'s own clock: ScummVM runs them through walks and waits, the sim freezes them while an action runs, and tracing slows ScummVM in long runs. A firing one engine logs pairs with the same timer\'s or trigger\'s firing in the other engine\'s next step, one for one; the state keys it set are compared at the later step. A real ordering bug inside that window is hidden (Decision 16).',
    source: 'carry notes: "triggers/timers frozen during walks (one-at-a-time queue)", "tracing overhead (snapshot per entry) may shift ScummVM\'s wall-clock timers"; Plan 6 Decision 16',
  },
  {
    id: 'idle-timer-firing', kind: 'forgive',
    why: 'A timer that fires more often in one engine than in the other (timer-cadence pairs them one for one) may leave a surplus firing whose every group failed, which changed nothing. Only a whole firing with no passed group, no change and no other event is dropped; a surplus firing that does anything is still a difference.',
    source: 'Plan 9 Task 5 ruling: the zoo\'s 1 s timers fire on every long step in ScummVM and not in the sim, which freezes them while an action runs',
  },
  {
    id: 'arrival-order',
    kind: 'forgive',
    why: 'Several crew members walking to one place at once arrive in the order of a race: ScummVM walks them together, the sim in its own order. A step whose only difference is that the same members did the same use of the same target, at depth 1, in another order is not one. A member missing from one side is still a difference. Also, with action squares (Task 2b): walkers who each arrive at the same action squares (whole depth-1 `use` blocks) in another interleaving, each walker\'s own arrivals in the same order and with the same events; the sim walks one walker at a time, ScummVM all at once, so who arrives first is a race. The end flags of those uses are compared as a set (the first to run gets the changed-state flag). A block missing from one side, or run by another walker, is still a difference.',
    source: 'Plan 9 Task 5 ruling: the zoo shuttle bay (o_030502) sends the whole team to its exit; Plan 10 Task 2b ruling: the unity shuttle squares (o_06040x) and the s0e step-in',
  },
  {
    id: 'same-tick-screen-timers', kind: 'forgive',
    why: 'When a trigger changes the screen on the tick a timer is due, the sim drops the timer, whose object has left the screen; ScummVM may still run it.',
    source: 'carry note: "same-tick trigger-screen-change drops timers"; engine/src/sim/timers.ts (the screenChanges guard)',
  },
  {
    id: 'walk-end-position', kind: 'forgive',
    why: 'On a screen without a pixel metric, the original walks to the clicked point through its own path finder while the sim walks to the target\'s marker, stopping short by stopWithin. On a screen with one, the sim ports the path finder and the TALK walk-up\'s raw pixel width, so walks there end where the original\'s do and this is a safety net only. The step\'s own actor\'s position after a step that can walk, and doesn\'t change screen (or goes on to a close-up, which places no one), is the same within rules.talkDistance.',
    source: 'Plan 5 Decision 3; Plan 4 Decision 8',
  },
  {
    id: 'sprite-state', kind: 'forgive',
    why: 'ScummVM\'s sprite scripts set an object\'s state while it animates (SpriteEntryStateSet), and the export carries no sprites, so the sim can\'t. A step whose only differences are the state keys of objects some lifted rule plays an animation on, or switches on or off, is forgiven, one count per key. Nothing else in the step may differ: one other difference of any kind and every state key shows. Cost: a wrong state alter on an animated object hides in such a step (its rule outcomes stay compared).',
    source: 'engines/unity/sprite_player.cpp (se_StateSet); Plan 9 ledger ruling (M3 Decision 14)',
  },
  {
    id: 'unlifted-triggers', kind: 'forgive',
    why: 'Only the triggers in Horst III\'s scope are lifted. A ScummVM change to a trigger the lift didn\'t name, which triggers.json says is unused (type 3: it can never fire) or the ship\'s, has nothing to compare with.',
    source: 'Plan 4 Decision 14 (unused triggers lift to nothing) and Decision 6 (the bounded scope)',
  },
  {
    id: 'proximity-threshold', kind: 'explain',
    why: 'Near tests are circles in pixels in the original. On a screen with a pixel metric the sim measures near in the same pixels, so a near check passing in one engine only there is a real difference, not this. On a screen without one the sim measures metres, and one pixel row is coords.yaml\'s depthFactor columns deep, so a near check can pass in one engine only. The one fix, for a screen without a metric only: an overrides/objects patch of that group\'s near dist (Discovery Protocol).',
    source: 'carry note: "distance anisotropy … trace diff must account for near/TALK walk-up threshold differences"; Plan 4 Decision 8',
  },
  {
    id: 'talk-walkup-threshold', kind: 'explain',
    why: 'TALK walks up when the talker is farther than the talk distance, in pixels in the original; the sim measures it in metres on a screen without a pixel metric, so one engine can walk (or talk at once) where the other doesn\'t. On a screen with one, the sim measures the same pixels, so a walk-up there that only one engine makes is a real difference, not this. Fix: an overrides/game.yaml patch of rules.talkDistance only if every TALK in every walk agrees with it; otherwise report it to the user.',
    source: 'the same carry note (near/TALK walk-up thresholds); Plan 2 Decision 7',
  },
  {
    id: 'alter-stops-walk', kind: 'explain',
    why: 'An AlterBlock that moves a walker stops its walk: the sim drops the walk\'s queued action, while ScummVM leaves it in _walkQueue to run after that walker\'s next arrival.',
    source: 'Plan 5 Decision 4',
  },
  {
    id: 'new-command-stops-walk', kind: 'unreachable',
    why: 'A new command stops the member\'s walk in the sim; the original\'s mouse-down only cancels queued actions and the walk goes on. A walkthrough step starts only once nobody walks, so no step meets a walk in progress.',
    source: 'Plan 5 Decision 4; awayteam.cpp:610-611; docs/trace-format.md "Walkthroughs"',
  },
  {
    id: 'combadge-behind-walk', kind: 'unreachable',
    why: 'The sim queues the combadge\'s action behind a pending walk-then-act; the original runs it at once. A walkthrough step starts only once nothing is queued.',
    source: 'carry note: "combadge action queued behind pending walk-then-act (original runs immediately)"',
  },
  {
    id: 'member-waits-behind-walk', kind: 'unreachable',
    why: 'A command for one member waits behind another member\'s walk on the sim\'s single queue; the original acts at once. A walkthrough step starts only once nobody walks.',
    source: 'carry note: "a command for member B waits behind member A\'s walk (serialized queue); original acts at once"',
  },
  {
    id: 'partial-walk-position', kind: 'unreachable',
    why: 'The browser\'s stage leaves an actor removed mid-walk where it had got to; the headless presenter ends the walk at its `to`. The diff runs headless only.',
    source: 'carry note: "browser stage resolves a mid-walk actor removal with the partial position; headless ends at \'to\'"',
  },
  {
    id: 'trace-across-load', kind: 'refused',
    why: 'A ScummVM trace across a load loses the changes since the last checkpoint and may misreport conversation reloads. Walkthroughs never load; normalizeScummvm refuses such a trace.',
    source: 'carry notes: "ScummVM trace loses changes since the last checkpoint across a load", "traces spanning a save-restore may misreport conversation reloads"',
  },
  {
    id: 'killed-at-timeout', kind: 'refused',
    why: 'The walkthrough\'s settle timeout can\'t fire while a step blocks, so the harness kills ScummVM, and the trace has no end; normalizeScummvm refuses it.',
    source: 'carry note: "walkthrough settle timeout doesn\'t fire while a step blocks (harness kill marks it)"',
  },
  {
    id: 'libm-atan2f', kind: 'forgive',
    why: 'Apple\'s atan2f is not Math.atan2 rounded to a float: about 6% of results are a float apart, and angleFromSinCos\'s whole angle moves on 26 of 2,000,000 inputs (a battle of 9000 steps meets a dozen to a hundred). ScummVM\'s combat trace logs each such call (`atan2`: the inputs, its angle and the rounded one), and the parity replay takes ScummVM\'s angle for exactly those inputs at that step; the report counts each by call site. Cost: outside a replay, the game\'s angle can be a unit off ScummVM\'s on those inputs.',
    source: 'space3d.cpp:47-49 (angleFromSinCos), called from combat.cpp:647-650 (fly), ai.cpp:57-58 and 72 (steering), weapons.cpp:83-84 (aim), damage.cpp:440-441 (the shield); Plan 22 R1',
  },
  {
    id: 'halt-before-walk-ends', kind: 'retired',
    why: 'Headless walks used to finish before a halt took effect; Plan 5 made them stop part way (StopSignal), so the engines agree.',
    source: 'carry note: "headless walks complete before halt takes effect"; Plan 5 Decision 4 (walks stop part way on a halt)',
  },
] as const satisfies readonly Allowance[];

export type AllowanceId = (typeof ALLOWANCES)[number]['id'];
