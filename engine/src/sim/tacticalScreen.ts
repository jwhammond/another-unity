// SPDX-License-Identifier: GPL-3.0-or-later
import { SHIP_FLAGS } from '../content/types';
import type { ActionContext } from './world';
import { perform } from './actions';
import { battleDifficulty } from './combat/assists';
import { copyBattle, restoreBattle } from './combat/clone';
import { applyCommand, type CombatCommand, type ConsolePage } from './combat/commands';
import { hailBucket } from './combat/damage';
import { SIM_SEAMS } from './combat/seams';
import { blowUpInTurn, BRIDGE_EXIT, leaveCode, NO_DIFFICULTY, standDown as standDownBattle, startBattle, tacticalUpdate, type StartResult, type TacticalResult } from './combat/tactical';
import { combatTicks, MAX_GAP, shipTickToMs, STEP_TIME, systemsToBattleClock, systemsToShipClock } from './combat/time';
import {
  cueId, GAME_OVER_EXIT, NO_HOOK, NO_SEAMS, playCue, playCueAfter, SHIP_STATE,
  type BattleContext, type BattleState, type CombatSeams, type CombatShip, type CueRequest, type HookResult,
} from './combat/types';
import { TICKS_PER_SECOND } from './clock';
import { runKillList } from './combat';
import { runGroupAt, runList } from './rules';
import { NO_SCENARIO, STATION_CODE, type CombatState } from './ship';
import { requestScriptedWarp } from './shipFx';
import type { SystemsState } from './shipSystems';
import { gotoShipScreen, runViewscreen } from './stations';
import type { World } from './world';

/**
 * TacticalScreen's world half for a real battle (tactical.cpp:257-500): the battle set up from the world, run a frame at
 * a time on its own clock while the ship is at tactical, its hooks into the world's scripts, and handed back to the
 * world as it ends. The sim's half is combat/tactical.ts. Not saved: nothing saves during a battle (save.cpp:156-159).
 */

/**
 * The world calls the sim made in the run being made (Plan 23 R7). The sim is synchronous and the world's scripts are
 * not: a call that has to wait for a script throws Suspend out of the sim, the world's task runs the script on the
 * battle as the sim left it, and the run starts again from its beginning, each call before given what it gave the
 * first time and the script's call what it left. The sim is deterministic, so the run comes back to the same point,
 * and goes on from there.
 */
export interface Journal {
  entries: { call: string; value: unknown; effect?: HookEffect }[];
  cursor: number;
  /** The ship screen the run leaves for (TacticalScreen::leave's gotoShipScreen, or Engineering's): changed once the run goes through. */
  leave: number | null;
}

/** What a script left the battle: what processHails sets (tactical.cpp:377-436), its cues, and the Enterprise's systems, which a script's repair can reset. */
export interface HookEffect { exitCode: number; redAlert: boolean; removeTimes: number[]; cues: CueRequest[]; systems: SystemsState }

/** A world call that has to wait for the world: thrown out of the sim, caught by the run (R7). */
export class Suspend {
  constructor(readonly call: string, readonly b: BattleState, readonly work: () => Promise<HookResult>) {}
}

/** A battle the world is fighting (TacticalScreen's _combat while _inCombat). */
export interface WorldBattle {
  ctx: BattleContext;
  b: BattleState;
  /**
   * The battle's clock, ms (g_system->getMillis() in ScummVM): it follows the world's tick wherever the ship is, as
   * ScummVM's does (Plan 23 R8). `tick` is the world tick it last caught up with, `owed` what it owes in sixtieths of a ms.
   */
  clock: number;
  tick: number;
  owed: number;
  /** The orders given since the last frame, in order: applied before the next (Plan 23 R9). */
  queue: CombatCommand[];
  /** _enterPending: the Enter object's USE and processHails, before the first update (tactical.cpp:458-466). */
  enterPending: boolean;
  /**
   * The frame's button was let go during its update (start's `_pressedButton = -1`, tactical.cpp:282, as a conversation
   * comes back to tactical: returnToTactical), so it doesn't act after the update (:495-499). Cleared as each frame starts.
   */
  buttonDropped: boolean;
  /**
   * The frame's run has reached its button (`_pressedButton = -1` before buttonAction, tactical.cpp:497-498): a
   * conversation the button's own script has comes back to tactical too late to drop it. Cleared as each run starts.
   */
  buttonTaken: boolean;
  journal: Journal;
  /** The tactics' warnings this battle has given, each told once. */
  warned: Set<string>;
  /** Whether the last frame flashed the bridge red (tactical.cpp:484-487), for the view: the battle's own flag is cleared. */
  redFlash: boolean;
  /**
   * The warp overlay's time left, battle ms (showWarp, tactical.cpp:840-842): ScummVM draws only the overlay meanwhile and
   * runs no update, its clock running through it. showWarp has already moved the battle's clock on by the overlay's time,
   * so the world's ticks go to the overlay until it has run out (syncBattleClock) and no frame runs meanwhile
   * (tacticalFrame); the next update then skips ahead, as ScummVM's does after the overlay. The view draws the overlay while
   * it lasts (M8). When the steps fall, not what they do.
   */
  warpHold: number;
  /** The pause assist (spec §5): the clock stops and the orders wait, while the console stays live. */
  paused: boolean;
  /**
   * The console's page (TacticalScreen::_page): CONN as a battle starts (tactical.cpp:301), kept while the battle goes on
   * across Engineering and conversations (start()'s _inCombat return comes first, :289-291), changed by consolePage (Plan 27 R4).
   */
  page: ConsolePage;
  /** Auto-resolve's result, shown until the player goes on (finishResolved): the battle waits meanwhile. */
  resolved: BattleResult | null;
  /**
   * A walk's `combat at <step>` (Play.untilStep, Plan 23 Task 11): no frame takes the battle past this many steps, at any
   * speed (syncBattleClock). Not ScummVM's: a test's hold, which changes only where a frame ends.
   */
  holdAt?: number;
  /**
   * The view's wait (Plan 34 Task 8): `viewShown` once the space view has drawn the battle (World.battleView) or the wait
   * gave up at VIEW_WAIT_CAP; `viewWait`, the world ticks waited so far. Not ScummVM's, whose battle loaded before it began.
   */
  viewShown?: boolean;
  viewWait?: number;
}

/**
 * How an auto-resolved battle came out (spec §5): `left`, it left the screen by its exit code (`leave`: the Enterprise
 * lost is the game's end, a hail's 0xd the bridge, a retreat astrogation); `stoodDown`, the red alert is off (won, or
 * nothing in range to fight), so the Bridge button leaves; `undecided`, still fighting at the cap, handed back;
 * `ended`, a script ended the battle itself (endCombat ran, the ship is where the script took it), so nothing waits.
 */
export interface BattleResult { outcome: 'left' | 'stoodDown' | 'undecided' | 'ended'; leave: number | null; steps: number; log: string[] }
/** Auto-resolve's cap: Plan 22's suite's, 9000 steps (about ten minutes of battle). */
export const AUTO_RESOLVE_CAP = 9000;
/** Auto-resolve hands the host a turn (World.yieldToHost) every this many steps, so the page can paint while it runs. */
export const AUTO_RESOLVE_YIELD = 200;

/** What TacticalScreen keeps from one battle to the next for the session: _lastDifficulty, and the Combat object (setup's carryOver). */
export interface CombatMemory { lastDifficulty: number; previous: BattleState | null }
export const newCombatMemory = (): CombatMemory => ({ lastDifficulty: NO_DIFFICULTY, previous: null });

/** No hail is pending (UnityEngine::PendingHail's 0xff). */
const NO_HAIL = 0xff;
/** combatTicks(0x369): showWarp's wait (waitAndDraw, tactical.cpp:841), which ScummVM's clock runs through. */
export const WARP_WAIT = combatTicks(0x369);
/** A world tick's worth of battle clock, in sixtieths of a ms: 1000 ms a second over TICKS_PER_SECOND ticks. */
const OWED_PER_TICK = 1000 * 60 / TICKS_PER_SECOND;

/**
 * The battle's clock caught up with the world's tick: 1000/60 ms a tick, times the fast-forward; paused, the ticks are let go.
 * The fast-forward scales the ticks, not MAX_GAP, which is battle time (combat/battle.ts updateBattle): ticks the world spent busy
 * (a script waiting on the world's clock) come as one gap, skipped past MAX_GAP's 1000 ms, which at 8x is about 125 ms of
 * the world's time where at 1x it is a second.
 */
export function syncBattleClock(world: World, run: WorldBattle): number {
  const ticks = world.state.tick - run.tick;
  run.tick = world.state.tick;
  // (the view readying the battle (its set, its chunk, its warm-up): the ticks are let go, as paused, until it first draws)
  if (viewWaiting(world, run, ticks)) return run.clock;
  if (!run.paused) run.owed += ticks * OWED_PER_TICK * world.assists.speed;
  const ms = Math.floor(run.owed / 60);
  run.owed -= ms * 60;
  // (the warp overlay's time goes to the overlay, not the battle: showWarp's waitAndDraw runs no update, tactical.cpp:841)
  const held = Math.min(ms, run.warpHold);
  run.warpHold -= held;
  run.clock += ms - held;
  // (a walk's hold: the clock stops at the held step's due time and the rest stays owed, for the next frame. A battle is
  // the same however its frames fall (combat/battle.ts updateBattle, Plan 23 R10), so only where this frame ends moves.
  // A gap past MAX_GAP is one step, as it is live, so it is left alone.)
  if (run.holdAt !== undefined) {
    const due = run.b.lastStep + Math.max(0, run.holdAt - run.b.steps) * STEP_TIME;
    if (run.clock > due && ((run.clock - run.b.lastStep) >>> 0) <= MAX_GAP) {
      run.owed += (run.clock - due) * 60;
      run.clock = due;
    }
  }
  return run.clock;
}

/** The longest the battle's clock waits for its view to first draw (syncBattleClock): 10 s of world ticks. */
export const VIEW_WAIT_CAP = 10 * TICKS_PER_SECOND;

/**
 * Whether the battle waits for its view (World.battleView) this sync, `ticks` more having passed: until the view first
 * draws it, or until it has waited VIEW_WAIT_CAP, so a view that never draws never freezes a battle. With no view, never.
 */
function viewWaiting(world: World, run: WorldBattle, ticks: number): boolean {
  if (run.viewShown || !world.battleView) return false;
  if (world.battleView()) {
    run.viewShown = true;
    return false;
  }
  run.viewWait = (run.viewWait ?? 0) + ticks;
  if (run.viewWait > VIEW_WAIT_CAP) {
    run.viewShown = true;
    return false;
  }
  return true;
}

/** A world call from inside the sim that needs no script: made and kept the first time, given back on a re-run (R7). */
function journaled<T>(j: Journal, call: string, live: () => T): T {
  const e = j.entries[j.cursor];
  if (e) {
    if (e.call !== call) throw new Error(`the battle went another way on its re-run: ${call}, not ${e.call}`);
    j.cursor++;
    return e.value as T;
  }
  const value = live();
  j.entries.push({ call, value });
  j.cursor++;
  return value;
}

/** A world call that runs a script: on a re-run, what it gave and what it left the battle; else it waits for the world (Suspend). */
function hooked(j: Journal, call: string, b: BattleState, work: () => Promise<HookResult>): HookResult {
  const e = j.entries[j.cursor];
  if (!e) throw new Suspend(call, b, work);
  if (e.call !== call) throw new Error(`the battle went another way on its re-run: ${call}, not ${e.call}`);
  j.cursor++;
  applyEffect(b, e.effect!);
  return e.value as HookResult;
}

function captureEffect(b: BattleState, cuesFrom: number): HookEffect {
  return {
    exitCode: b.exitCode, redAlert: b.console.redAlert, removeTimes: b.ships.map(s => s.removeTime),
    cues: b.cues.slice(cuesFrom), systems: structuredClone(b.ships[0]!.systems),
  };
}

function applyEffect(b: BattleState, e: HookEffect): void {
  b.exitCode = e.exitCode;
  b.console.redAlert = e.redAlert;
  e.removeTimes.forEach((t, i) => { if (b.ships[i]) b.ships[i]!.removeTime = t; });
  b.cues.push(...structuredClone(e.cues));
  const systems = b.ships[0]!.systems;
  const { units, ...rest } = structuredClone(e.systems);
  Object.assign(systems, rest);
  units.forEach((u, i) => { if (systems.units[i]) Object.assign(systems.units[i]!, u); });
}

/** Runs the script a Suspend waits for, on the battle as the sim left it, and keeps what it gave and left. */
async function resolve(j: Journal, s: Suspend): Promise<void> {
  const cuesFrom = s.b.cues.length;
  const value = await s.work();
  j.entries.push({ call: s.call, value, effect: captureEffect(s.b, cuesFrom) });
}

const leaderDoes = (world: World, verb: 'use' | 'look', target: string): ActionContext => ({ verb, target, who: world.content.start.leader, other: null, walked: false });
/** What a hook's processHails left: a viewscreen hail still waiting (it bailed: damage.cpp:474) and whether one was answered. */
const hookResult = (world: World, answered: boolean): HookResult => ({ hailPending: world.state.pendingHail?.type === 7, answered });

/** Combat::runEventHook's script (damage.cpp:660-672): LOOK group `hook`, if the object has one, then processHails. */
async function eventScript(world: World, b: BattleState, ship: CombatShip, hook: number): Promise<HookResult> {
  const look = world.content.objects[ship.object]?.on?.look ?? [];
  // (no group to run, but destroy reads the global after runEventHook all the same: a 7 an earlier script left as it
  // bailed holds the explosion back, damage.cpp:472-474)
  if (hook >= look.length) return hookResult(world, false);
  await runGroupAt(world, look, hook, leaderDoes(world, 'look', ship.object), `${ship.object}/look`);
  return hookResult(world, await battleHails(world, b));
}

/** Combat::hailResponse's script (damage.cpp:683-693): USE group `bucket - 1`, if there are that many, then processHails. */
async function hailScript(world: World, b: BattleState, ship: CombatShip, bucket: number): Promise<HookResult> {
  const use = world.content.objects[ship.object]?.on?.use ?? [];
  if (bucket < 1 || bucket > use.length) return NO_HOOK;
  await runGroupAt(world, use, bucket - 1, leaderDoes(world, 'use', ship.object), `${ship.object}/use`);
  return hookResult(world, await battleHails(world, b));
}

/** Combat::afterHit's hull-low script (damage.cpp:701-714): the stun list once, if the object isn't stunned, then processHails. */
async function hullLowScript(world: World, b: BattleState, ship: CombatShip): Promise<HookResult> {
  const id = ship.object;
  const stun = world.content.objects[id]?.phaser?.on?.stun ?? [];
  const pd = world.state.phaser[id];
  const o = world.state.objects[id];
  if (!pd || pd.stunned || stun.length === 0 || o?.stunned) return NO_HOOK;
  await runList(world, stun, leaderDoes(world, 'use', id), `${id}/phaser/stun`);
  if (o) o.stunned = true;
  pd.stunned = true;
  return hookResult(world, await battleHails(world, b));
}

/** Combat::runDestroyedHook (damage.cpp:718-732): the kill list once, the object inactive, then processHails. */
async function destroyedScript(world: World, b: BattleState, ship: CombatShip): Promise<HookResult> {
  if (!(await runKillList(world, ship.object))) return NO_HOOK;
  return hookResult(world, await battleHails(world, b));
}

/**
 * TacticalScreen::hail (tactical.cpp:438-453): no answer from a target that isn't there or is dying; with no hail
 * pending, how the battle's going chooses the target's answer (hailResponse, damage.cpp:675-694); a viewscreen hail,
 * or one they're making, is taken (as 7) and processHails runs it. "No response" (0x5b) when nobody answered.
 */
function hailTarget(world: World, j: Journal, ctx: BattleContext, b: BattleState): void {
  const target = b.target === null ? null : b.ships[b.target] ?? null;
  const noAnswer = () => playCue(b, cueId(ctx, 'noAnswer'));
  if (!target || target.destroyed || (target.flags & SHIP_STATE.dying)) return noAnswer();
  const type = journaled(j, 'pendingHail', () => world.state.pendingHail?.type ?? NO_HAIL);
  let answered = false;
  if (type === NO_HAIL) {
    const bucket = hailBucket(ctx, b, target);
    answered = bucket !== null && ctx.seams.hailScript(ctx, b, target, bucket).answered;
  } else if (type === 7 || type === 8 || type === 0xe) {
    answered = hooked(j, 'answer', b, async () => {
      world.state.pendingHail!.type = 7;
      return { hailPending: false, answered: await battleHails(world, b) };
    }).answered;
  }
  if (!answered) noAnswer();
}

/** TacticalScreen::leave (tactical.cpp:369-375): the exit code spent, the game's end if the self-destruct is armed; the screen changes once the run goes through. */
function leaveFor(j: Journal, b: BattleState, code: number): void {
  const to = leaveCode(b, code);
  journaled(j, `leave ${to}`, () => { j.leave = to; });
}

/** The seams the game's battle takes from the world, every call journaled (R7). */
function worldSeams(world: World, j: Journal): Partial<CombatSeams> {
  return {
    // (`ship->source`: the space object, which every lifted ship has; content, which no script changes)
    hasSource: (_c, _b, ship) => world.content.objects[ship.object] !== undefined,
    // (`ship->source->flags &= ~OBJFLAG_ACTIVE` as it is destroyed: damage.cpp:519-520)
    deactivate: (_c, _b, ship) => journaled(j, `deactivate ${ship.index}`, () => { const o = world.state.objects[ship.object]; if (o) o.active = false; }),
    eventScript: (_c, b, ship, hook) => hooked(j, `event ${ship.index} ${hook}`, b, () => eventScript(world, b, ship, hook)),
    hailScript: (_c, b, ship, bucket) => hooked(j, `hail ${ship.index} ${bucket}`, b, () => hailScript(world, b, ship, bucket)),
    hullLowScript: (_c, b, ship) => hooked(j, `hullLow ${ship.index}`, b, () => hullLowScript(world, b, ship)),
    destroyedScript: (_c, b, ship) => hooked(j, `destroyed ${ship.index}`, b, () => destroyedScript(world, b, ship)),
    // TacticalScreen::buttonAction (tactical.cpp:503-521): Bridge is the hail at a red alert, else the way out; Engineering leaves the battle waiting
    hail: (ctx, b) => hailTarget(world, j, ctx, b),
    bridge: (ctx, b) => (b.console.redAlert ? hailTarget(world, j, ctx, b) : leaveFor(j, b, BRIDGE_EXIT)),
    engineering: (_c, b) => {
      const e = b.ships[0];
      if (!e || e.destroyed) leaveFor(j, b, GAME_OVER_EXIT);
      else journaled(j, 'engineering', () => { j.leave = STATION_CODE.engineering; });
    },
    // TacticalScreen::showWarp (tactical.cpp:818-850): the overlay for 0x369 ticks, which ScummVM's clock runs through, so the next
    // update skips ahead (combat.cpp:409-419); the keys let go (:843-846). The overlay is the presentation's (M8): `battleWarp`.
    showWarp: (_c, b) => {
      journaled(j, 'warp', () => {
        if (world.battle) {
          world.battle.clock += WARP_WAIT;
          world.battle.warpHold = WARP_WAIT;
        }
        world.bus.emit({ type: 'battleWarp', ms: WARP_WAIT });
      });
      b.input.held = 0;
      // (and the pressed button let go, `_pressedButton = -1` (:846): the frame's Hail, Bridge or Engineering doesn't act after
      // the update, as the update it waits for showed the overlay first. Outside the journal: a re-run lets it go again)
      if (world.battle) world.battle.buttonDropped = true;
    },
    // (astrogation's _x, _y, _z, the ship's place in space: ai.cpp:292-293)
    astrogationPosition: () => journaled(j, 'astrogation', () => [world.state.ship.pos.x, world.state.ship.pos.y, world.state.ship.pos.z] as const),
    // (Astrogation::scriptedWarp, astrogation.cpp:633-647)
    scriptedWarp: (_c, _b, code, speed) => journaled(j, `scriptedWarp ${code}`, () => { requestScriptedWarp(world, code, speed); }),
  };
}

/**
 * TacticalScreen::processHails for a real battle (tactical.cpp:377-436). 7: the conversation on the viewscreen, from the
 * middle of the battle (unless the Enterprise is gone or dying), then back to tactical, where 0xd ends the battle and
 * 0xc, 0xf and 0x10 are taken at once; 0xd: the battle is over, for the bridge; 8: they're hailing, until answered;
 * 0xb and 0xc stand down; 0xf is a red alert; 0x10 blows everyone up in turn (blowUpInTurn, on the battle's clock: R6).
 * Returns whether a conversation was had.
 */
export async function battleHails(world: World, b: BattleState): Promise<boolean> {
  const hail = world.state.pendingHail;
  const type = hail?.type ?? NO_HAIL;
  const clear = () => { world.state.pendingHail = null; };
  const standDownBoth = () => { standDownBattle(b); world.state.ship.battleScenario = NO_SCENARIO; };
  switch (type) {
    case 7: {
      const e = b.ships[0];
      if (!e || (e.flags & SHIP_STATE.dying)) return false;
      let talked = false;
      while (world.state.pendingHail?.type === 7) {
        await runViewscreen(world, true, world.state.pendingHail.from);
        talked = true;
      }
      await gotoShipScreen(world, STATION_CODE.tactical);
      const next = world.state.pendingHail?.type ?? NO_HAIL;
      if (next !== 0xd) {
        // (the original leaves these until the next hook)
        if (next === 0xc || next === 0xf || next === 0x10) await battleHails(world, b);
        return talked;
      }
      // (falls through to 0xd)
      clear();
      standDownBoth();
      b.exitCode = BRIDGE_EXIT;
      return talked;
    }
    case 0xd:
      clear();
      standDownBoth();
      b.exitCode = BRIDGE_EXIT;
      return false;
    case 8:
      playCueAfter(b, cueId({ combat: battleData(world) }, 'hailing'));
      return false;
    case 0xb:
    case 0xc:
      clear();
      standDownBoth();
      return false;
    case 0xe:
    case NO_HAIL:
      return false;
    case 0xf:
      clear();
      b.console.redAlert = true;
      return false;
    case 0x10:
      clear();
      standDownBoth();
      blowUpInTurn(b, b.now);
      return false;
    default:
      clear();
      return false;
  }
}

/** The game's combat.yaml, which a real battle has (startWorldBattle refuses one without): a throw if it hasn't. */
function battleData(world: World): BattleContext['combat'] {
  const combat = world.content.ship?.combat;
  if (!combat) throw new Error('this game has no combat.yaml');
  return combat;
}

/**
 * TacticalScreen::start's resets before its `_inCombat` return (tactical.cpp:281-284, 290-291), as the ship comes back to
 * a battle that goes on: from Engineering, or processHails' gotoShipScreen after a conversation (tactical.cpp:391), whose
 * runViewscreen changed the screen (unity.cpp:700), so changeToScreen starts tactical again (unity.cpp:1257-1295).
 * - `_wide = false` (:281): the view is split again, so the radar shows (if open) and the steps ask the sensors (R10).
 * - `_held = 0` (:284): the keys let go. Combat::_held follows at the next update's setHeld (tactical.cpp:470).
 * - `_pressedButton = -1` (:282): a button waiting is dropped, the frame's own included (buttonDropped).
 * The wide and held resets are orders put at the end of the queue, so they act before the next update as ScummVM's do
 * (the draw after the update, setHeld before the next), whether the return came between frames or in the middle of a
 * step's script, which the journal runs again (R7) and which must not change the battle under it.
 * Kept in spirit: a script's gotoShipScreen(tactical) at tactical with no screen between doesn't start() in ScummVM
 * (changeToScreen's same-screen return, unity.cpp:1258-1259), but resets here; no lifted script does it.
 */
export function returnToTactical(world: World): void {
  const run = world.battle;
  if (!run) return;
  run.queue = run.queue.filter(cmd => !isButton(cmd));
  if (!run.buttonTaken) run.buttonDropped = true;
  run.queue.push(
    { type: 'wide', on: false },
    { type: 'steer', yaw: 0, pitch: 0, roll: 0, throttle: 0 },
    { type: 'orbit', direction: 0 },
  );
}

/** The worlds whose battle is starting, its start's scripts running (see startWorldBattle). */
const starting = new WeakSet<World>();

/**
 * TacticalScreen::start's battle in the world (tactical.cpp:300-336): the seed from the game's random source
 * (combat.cpp:164, drawn whether or not setup finds an Enterprise), the Enterprise's systems moved onto the battle's
 * clock (shipTickToMs of the world's tick), the session's last difficulty and last battle, the Enterprise object's
 * state. Worf's weapons lock runs the target's hook 0 (weapons.cpp:624-625): a script that waits runs, and the start is
 * made again (R7). Without a battle (no combat.yaml, no Enterprise) the scenario resets and the bridge comes back
 * (:314-318).
 */
export async function startWorldBattle(world: World): Promise<void> {
  // (a conversation the start's hook 0 raised, come back to tactical: the battle being started goes on. Kept in spirit:
  // ScummVM's start sets _inCombat only at its end (tactical.cpp:335), so processHails' return to tactical
  // (tactical.cpp:391, changeToScreen's start(), unity.cpp:1295) starts the battle again, whose hook 0 raises the hail
  // again, without end. Here the return finds the battle starting, as start's _inCombat check would (tactical.cpp:289-290).)
  if (starting.has(world)) return;
  const ship = world.state.ship;
  const content = world.content.ship;
  const combat = content?.combat;
  if (!content || !combat) {
    world.bus.emit({ type: 'warning', message: 'this game has no combat.yaml: there is no battle to fight' });
    ship.battleScenario = NO_SCENARIO;
    await gotoShipScreen(world, STATION_CODE.bridge);
    return;
  }
  const memory = world.combatMemory;
  const seed = world.rng.next(0x7fffffff, 'combatSeed');
  const tick = world.state.tick;
  const now = shipTickToMs(tick);
  systemsToBattleClock(ship.systems, tick, now);
  const systems = structuredClone(ship.systems);
  const journal: Journal = { entries: [], cursor: 0, leave: null };
  const warned = new Set<string>();
  const ctx: BattleContext = {
    combat, enterpriseUnits: content.data.units,
    seams: { ...NO_SEAMS, ...SIM_SEAMS, ...worldSeams(world, journal) },
    assists: { ...world.assists },
    // (ScummVM's warning(): a debug log, each once a battle, as a stuck script warns every step)
    onWarning: message => {
      if (warned.has(message)) return;
      warned.add(message);
      world.bus.emit({ type: 'warning', message: `combat: ${message}` });
    },
  };
  const start = (): StartResult => {
    journal.cursor = 0;
    return startBattle(ctx, {
      scenario: ship.battleScenario, seed, now, difficulty: battleDifficulty(world.assists, world.difficulty),
      active: id => journaled(journal, `active ${id}`, () => world.state.objects[id]?.active ?? false), enterprise: ship.systems,
      ...(memory.previous ? { previous: memory.previous } : {}),
      lastDifficulty: memory.lastDifficulty, objectState: id => journaled(journal, `state ${id}`, () => world.state.objects[id]?.state ?? 0),
    });
  };
  let r: StartResult;
  starting.add(world);
  try {
    for (;;) {
      try {
        r = start();
        break;
      } catch (e) {
        if (!(e instanceof Suspend)) throw e;
        await resolve(journal, e);
        // (setup starts again from the systems as they were)
        restoreSystems(ship.systems, systems);
      }
    }
  } finally {
    starting.delete(world);
  }
  journal.entries = [];
  memory.lastDifficulty = r.lastDifficulty;
  for (const message of r.warnings) world.bus.emit({ type: 'warning', message });
  const b = r.battle;
  if (!b) {
    systemsToShipClock(ship.systems, now, tick);
    ship.battleScenario = NO_SCENARIO;
    await gotoShipScreen(world, STATION_CODE.bridge);
    return;
  }
  ship.combat = combatState(b);
  world.battle = { ctx, b, clock: now, tick, owed: 0, queue: [], enterPending: true, buttonDropped: false, buttonTaken: false, journal, warned, redFlash: false, warpHold: 0, paused: false, resolved: null, page: 'conn' };
  world.bus.emit({ type: 'combat', on: true, scenario: b.scenario });
}

/** Puts systems' copied values back into the live object, in place. */
function restoreSystems(live: SystemsState, copy: SystemsState): void {
  const { units, ...rest } = structuredClone(copy);
  Object.assign(live, rest);
  live.units = units;
}

/** The world's record of a battle (ShipState.combat, _inCombat): who is in it, as the dialog has it too. */
function combatState(b: BattleState): CombatState {
  const others = b.ships.slice(1);
  return {
    scenario: b.scenario, enterprise: b.ships[0]!.object,
    enemies: others.filter(s => !(s.flags & SHIP_FLAGS.friendly)).map(s => s.object),
    friends: others.filter(s => s.flags & SHIP_FLAGS.friendly).map(s => s.object),
    destroyed: [], warped: false, redAlert: b.console.redAlert,
  };
}

/** An order for the battle (spec §4.5): applied before the next frame, in the order given. */
export function battleCommand(world: World, cmd: CombatCommand): void {
  const run = world.battle;
  if (!run) throw new Error('there is no battle');
  // (the warp overlay up, the order is dropped: showWarp's waitAndDraw drains the events unseen (unity.cpp:1002-1003) and
  // lets go of the keys, the drag and the pressed button after (tactical.cpp:843-846), so nothing given meanwhile is
  // applied. Every CombatCommand is an input of the original's tactical screen. The assists (pauseBattle, the speed,
  // autoResolve) aren't orders and stay live: ScummVM's own pause, its main menu, is taken in pollEvent there too.)
  if (run.warpHold > 0) return;
  run.queue.push(cmd);
}

/**
 * A tab of the console clicked (mouseClick, tactical.cpp:655-658): the page shown at once, as `_page` is, and the sim's
 * `_connPage` from the next update (tactical.cpp:471), as an order: paused, it waits with the others. The warp overlay up,
 * nothing changes: mouseClick returns while it shows (:647-648). Plan 27 R4.
 */
export function consolePage(world: World, page: ConsolePage): void {
  const run = world.battle;
  if (!run) throw new Error('there is no battle');
  if (run.warpHold > 0) return;
  run.page = page;
  run.queue.push({ type: 'page', page });
}

/**
 * Runs `f`, a stretch of the battle the sim makes in one go, journaled (R7): `then` takes its result. When a script
 * has to wait, the world's task runs it, puts the battle back as it was before `f` and runs `f` again, until `f` goes
 * through; `then` runs there. False when the run waits for the world.
 */
function runJournaled<T>(world: World, run: WorldBattle, f: () => T, then: (value: T) => void): boolean {
  const copy = copyBattle(run.b);
  const first = attempt(run, f, then);
  if (first === null) return true;
  void world.enqueue(() => rerun(world, run, f, then, copy, first));
  return false;
}

/** runJournaled from inside the world's own task, which can't wait behind itself: the scripts run here. */
async function runJournaledNow<T>(world: World, run: WorldBattle, f: () => T, then: (value: T) => void): Promise<void> {
  const copy = copyBattle(run.b);
  const first = attempt(run, f, then);
  if (first !== null) await rerun(world, run, f, then, copy, first);
}

/** The first try: null when it went through, else the Suspend it waits on. */
function attempt<T>(run: WorldBattle, f: () => T, then: (value: T) => void): Suspend | null {
  const j = run.journal;
  j.entries = [];
  j.cursor = 0;
  j.leave = null;
  try {
    then(f());
    j.entries = [];
    return null;
  } catch (e) {
    if (!(e instanceof Suspend)) throw e;
    return e;
  }
}

/** Runs the script the run waits on, puts the battle back as it was, and runs `f` again, until it goes through. */
async function rerun<T>(world: World, run: WorldBattle, f: () => T, then: (value: T) => void, copy: BattleState, first: Suspend): Promise<void> {
  const j = run.journal;
  let waiting = first;
  for (;;) {
    await resolve(j, waiting);
    // (a script that ended the battle leaves nothing to run again)
    if (world.battle !== run) return;
    restoreBattle(run.b, copy);
    j.cursor = 0;
    try {
      then(f());
      j.entries = [];
      return;
    } catch (next) {
      if (!(next instanceof Suspend)) throw next;
      waiting = next;
    }
  }
}

/**
 * One frame's run of the sim (R7): the orders, the update to `now` (its steps ask the sensors while the radar shows:
 * R10), and the console's button after it. The orders up to the first Hail, Bridge or Engineering act at once, as pressButton and
 * actionStart do; that button acts after the update, as buttonAction does (tactical.cpp:489-494), one a frame; the rest
 * wait for the next. A battle that has left takes no button: leave returns first (:475-478), and start() forgets the
 * press (:283).
 */
function frameRun(run: WorldBattle, now: number): () => TacticalResult {
  const { ctx, b } = run;
  const at = run.queue.findIndex(isButton);
  const orders = run.queue.splice(0, at < 0 ? run.queue.length : at);
  const button = at < 0 ? null : run.queue.shift()!;
  run.buttonDropped = false;
  return () => {
    run.buttonTaken = false;
    for (const cmd of orders) applyCommand(ctx, b, cmd);
    const r = tacticalUpdate(ctx, b, now);
    // (a conversation in the update came back to tactical, whose start() let the button go: returnToTactical)
    if (button && r.leave === null && !run.buttonDropped) {
      run.buttonTaken = true;
      applyCommand(ctx, b, button);
    }
    return r;
  };
}

/**
 * A frame at tactical (TacticalScreen::update, tactical.cpp:456-500). The first runs the Enter object's USE and
 * processHails (:458-466). Then the orders given since the last frame, the battle's update to its clock (each step asks
 * the sensors first while the radar shows, as the radar's draw did: Plan 23 R10), then leave on an exit code or stand
 * down. Called by the ship's tick while the world is idle at tactical.
 */
export function tacticalFrame(world: World): void {
  const run = world.battle;
  if (!run) return;
  const now = syncBattleClock(world, run);
  // (nothing runs while the view readies the battle, the Enter object's USE included: the player hasn't seen it yet)
  if (!run.viewShown && world.battleView) return;
  if (run.enterPending) {
    run.enterPending = false;
    void world.enqueue(() => enterBattle(world, run));
    // (kept in spirit: ScummVM's first update runs the Enter USE and processHails and then, in the same update,
    // _combat->update(now) (tactical.cpp:458-472). Here the Enter frame returns before the first update, which waits for
    // the next world tick. The steps are due by the battle's clock (combat/battle.ts updateBattle), so the next frame
    // makes the same steps at the same times: no step's state differs, only the frame the first one falls in.)
    return;
  }
  // (paused, the orders wait for the next step: spec §5; an auto-resolved battle waits for the player to go on; the warp
  // overlay runs no update until it has gone, tactical.cpp:840-842)
  if (run.paused || run.resolved || run.warpHold > 0) return;
  runJournaled(world, run, frameRun(run, now), r => afterUpdate(world, run, r));
}

/**
 * The pause assist (spec §5): the battle's clock stops and the orders given meanwhile wait, to be applied before the
 * next step exactly as if given then, so a paused battle never goes another way than the same orders given live. The
 * ticks since the last frame are credited first (the world may have been busy, or at another station). Every order
 * waits, the view's too (wide and the radar decide whether the sensors roll, R10).
 */
export function pauseBattle(world: World, on: boolean): void {
  const run = world.battle;
  if (!run) throw new Error('there is no battle');
  syncBattleClock(world, run);
  run.paused = on;
}

/**
 * Auto-resolve (spec §5): Delegate on, as the player's button turns it on, then the battle run with nothing drawn (its
 * steps ask the sensors as the radar was left: R10), a step a frame, to its end: it leaves the screen, or stands down, or reaches `cap`
 * steps still fighting. Its scripts run as they come, conversations included. A real battle, which can be lost. The
 * result and the Enterprise's log wait in `resolved` for the player to go on (finishResolved), which ends it through
 * endCombat; undecided, the battle is handed back, Delegate on; a script that ended the battle itself is `ended`.
 *
 * - The battle's clock drives it, a step on at a time, so showWarp's jump (WARP_WAIT) carries into the next update,
 *   which skips the gap as it does live (combat/battle.ts updateBattle).
 * - It is silent (M8 spec §6.3): the steps' cues and sounds are dropped, and no `battleAudio` is sent.
 * - Every AUTO_RESOLVE_YIELD steps it awaits world.yieldToHost, so the page paints meanwhile; the world stays busy, so
 *   its ticks run no frame, and the battle doesn't take them.
 * - It runs as the world's task, so the caller must keep the world's clock going while it waits: a conversation or a
 *   line a script raises waits on world.clock. The browser's loop ticks it; Plan 23 Task 11's `combat auto`
 *   (Play.autoBattle) runs settle() beside it, which advances the clock to each timer while the world is busy.
 * - It lifts a player's pause, and leaves it lifted when the battle is handed back undecided.
 */
export async function autoResolve(world: World, cap = AUTO_RESOLVE_CAP): Promise<BattleResult> {
  const run = world.battle;
  if (!run) throw new Error('there is no battle');
  let result: BattleResult | null = null;
  await world.enqueue(async () => {
    const b = run.b;
    const ended = (): BattleResult => ({ outcome: 'ended', leave: null, steps: b.steps, log: [...(b.ships[0]?.log ?? [])] });
    run.paused = false;
    // (the Enter object's USE comes first: tactical.cpp:458-466)
    if (run.enterPending) {
      run.enterPending = false;
      await enterBattle(world, run);
      if (world.battle !== run) {
        result = ended();
        return;
      }
    }
    run.queue.push({ type: 'delegate', on: true });
    let leave: number | null = null;
    // (a step a frame: the next is due STEP_TIME on; showWarp adds its wait to run.clock in the middle of a step)
    run.clock = b.lastStep;
    for (let i = 0; i < cap && world.battle === run; i++) {
      if (i > 0 && i % AUTO_RESOLVE_YIELD === 0) {
        await world.yieldToHost();
        if (world.battle !== run) break;
      }
      run.clock += STEP_TIME;
      await runJournaledNow(world, run, frameRun(run, run.clock), r => {
        leave = r.leave ?? run.journal.leave;
        // (silent: M8 spec §6.3)
        b.cues.length = 0;
        b.sounds.length = 0;
        takeAfterUpdate(world, run, r);
      });
      if (leave !== null || !b.console.redAlert) break;
    }
    // (a script that ended the battle, endCombat run in the middle of a step: nothing is left to finish)
    if (world.battle !== run) {
      result = ended();
      return;
    }
    // (the clock goes on from where the battle is: the world's ticks while it ran aren't the battle's; nothing was drawn, so no
    // warp overlay waits)
    run.tick = world.state.tick;
    run.owed = 0;
    run.warpHold = 0;
    const outcome = leave !== null ? 'left' : !b.console.redAlert ? 'stoodDown' : 'undecided';
    result = { outcome, leave, steps: b.steps, log: [...(b.ships[0]?.log ?? [])] };
    if (outcome !== 'undecided') run.resolved = result;
  });
  if (!result) throw new Error('auto-resolve did not run');
  return result;
}

/**
 * The player goes on from auto-resolve's result: the battle leaves as it ended, or by the Bridge button once stood down.
 * A battle a script already ended (`ended`) has nothing to finish.
 */
export async function finishResolved(world: World): Promise<void> {
  const run = world.battle;
  if (!run) return;
  const result = run.resolved;
  if (!result) throw new Error('no battle waits to be finished');
  run.resolved = null;
  const code = result.leave ?? leaveCode(run.b, BRIDGE_EXIT);
  await world.enqueue(() => gotoShipScreen(world, code));
}

/** The console's Hail, Bridge and Engineering: TacticalScreen::buttonAction's (tactical.cpp:503-521). */
const isButton = (cmd: CombatCommand) => cmd.type === 'hail' || cmd.type === 'bridge' || cmd.type === 'engineering';

/** The first update's Enter (tactical.cpp:458-466): its USE, if it has one, then processHails. */
async function enterBattle(world: World, run: WorldBattle): Promise<void> {
  const enter = run.b.enter;
  if (enter !== null && (world.content.objects[enter]?.on?.use?.length ?? 0) > 0) await perform(world, leaderDoes(world, 'use', enter));
  if (world.battle !== run) return;
  await battleHails(world, run.b);
}

/**
 * What the world does after each update: the frame's audio handed on, then leave (the screen change), which returns before the
 * stand-downs' scenario reset (tactical.cpp:366) and the red flash taken (tactical.cpp:475-478).
 */
function afterUpdate(world: World, run: WorldBattle, r: TacticalResult): void {
  const { b } = run;
  // (the crew's cues and the battle's sounds are the presentation's to play: handed on every frame, with the clock the update
  // ran to, as _cues->update() runs after every update and before the exit check, tactical.cpp:473-474. Auto-resolve's frames
  // don't come here: they are silent, M8 spec §6.3. Plan 28 R3)
  world.bus.emit({ type: 'battleAudio', now: run.clock, silenced: b.silenced, cues: b.cues.splice(0), sounds: b.sounds.splice(0) });
  takeAfterUpdate(world, run, r);
  const code = r.leave ?? run.journal.leave;
  if (code !== null) void world.enqueue(() => gotoShipScreen(world, code));
}

/** afterUpdate's own, and auto-resolve's: (unless an exit code left) the stand-downs' scenario reset and the red flash. */
function takeAfterUpdate(world: World, run: WorldBattle, r: TacticalResult): void {
  const { b } = run;
  // (the world's record lists the sim's losses, as the dialog's destroyShip does, for the ship list: session.ts's combat())
  const combat = world.state.ship.combat;
  if (combat) for (const s of b.ships) if (s.destroyed && !combat.destroyed.includes(s.object)) combat.destroyed.push(s.object);
  // (an exit code's leave returns before the stand-downs and the red flash: tactical.cpp:475-478)
  if (r.leave !== null) return;
  if (r.standDowns.length > 0) world.state.ship.battleScenario = NO_SCENARIO;
  if (world.state.ship.combat) world.state.ship.combat.redAlert = b.console.redAlert;
  // (the bridge flashes red for a frame: tactical.cpp:484-487)
  run.redFlash = b.console.redFlash;
  b.console.redFlash = false;
  // (a button's leave is the update's last act, after those: buttonAction, tactical.cpp:489-494; afterUpdate takes it)
}

/**
 * endCombat's battle (tactical.cpp:344-362): the red alert off, the destroyed ships' scripts (:349-353, the scripts the
 * battle hasn't run: runDestroyedHook runs each once), the Enterprise's systems back on the ship's clock, and the
 * battle kept for the next one's carryOver (the Combat object lives for the session). Returns whether it warped.
 */
export async function endWorldBattle(world: World): Promise<boolean> {
  const run = world.battle;
  if (!run) return false;
  standDownBattle(run.b);
  // (runDestroyedHook's `ship->source` check, damage.cpp:719, as the sim's makes it: damage.ts runDestroyedHook)
  for (const ship of run.b.ships) if (ship.destroyed && run.ctx.seams.hasSource(run.ctx, run.b, ship)) await destroyedScript(world, run.b, ship);
  systemsToShipClock(world.state.ship.systems, syncBattleClock(world, run), world.state.tick);
  world.combatMemory.previous = run.b;
  world.battle = null;
  return run.b.console.warped;
}
