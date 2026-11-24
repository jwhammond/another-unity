// SPDX-License-Identifier: GPL-3.0-or-later
import { SHIP_FLAGS } from '../../content/types';
import { liveShips, targetOutOfRange, updateBattle } from './battle';
import { bindContext } from './libm';
import { setupBattle, type BattleInput, type SetupResult } from './setup';
import { combatTicks } from './time';
import { GAME_OVER_EXIT, NO_EXIT, type BattleContext, type BattleState, type CombatShip } from './types';

/**
 * TacticalScreen's part in a battle that isn't drawing (tactical.cpp:257-337, 364-375, 456-482): how a battle starts
 * (Delegate at Ensign, the red alert, the power level, Worf getting ready) and what the screen does after each update
 * (leave on an exit code, stand down). The world's part (the Enter object's USE, processHails, endCombat, leave's
 * screen change) is the game's (Plan 23).
 */

/** kDefaultBattle and kStarbaseBattle (tactical.cpp:206-207): the battles fought without a red alert. */
export const DEFAULT_BATTLE = 8;
export const STARBASE_BATTLE = 0x50;
/** TacticalScreen::_lastDifficulty before any battle (the constructor's 0xff, tactical.cpp:247). */
export const NO_DIFFICULTY = 0xff;
/** UnityEngine::_battleScenario's "none" (tactical.cpp:311-312, 365): a start without one fights the default battle. */
export const NO_BATTLE = 0xffff;
/** UnityEngine::kShipBridge (unity.h:325): the exit code a hail's 0xd ends the battle with (tactical.cpp:403). */
export const BRIDGE_EXIT = 0;

export interface StartInput extends Omit<BattleInput, 'delegate'> {
  /** UnityEngine::_battleScenario: the battle to fight, NO_BATTLE for the default (tactical.cpp:310-313). */
  scenario: number;
  /** TacticalScreen::_lastDifficulty (tactical.cpp:305-308): the difficulty the last battle started at, NO_DIFFICULTY before the first. */
  lastDifficulty: number;
  /** An object's state: the Enterprise's, `_combat->enterprise()->source->state` after setup (tactical.cpp:322-323), is 1 to 5 for the power level plus one; anything else, level 0. */
  objectState(object: string): number;
}

/** What TacticalScreen::start left: setup's result, the battle it fought (NO_BATTLE is the default), and the difficulty the next start compares with (`_lastDifficulty`, set before setup, tactical.cpp:308). */
export interface StartResult extends SetupResult { scenario: number; lastDifficulty: number }

/**
 * TacticalScreen::start's battle (tactical.cpp:301-336). A new battle opens on the CONN page (:301). Ensigns have
 * Worf fight for them, at first: Delegate goes on at Ensign and off at any other difficulty, but only when the
 * difficulty has changed since the last battle; else it stays as the last battle left it (Combat lives for the
 * session). Then setup; a red alert unless the battle is the default or the starbase's; the lock off, the power
 * level from the Enterprise object's state (forced); and with Delegate on and an enemy present, Worf locks the
 * weapons and goes to level 4. At level 4 the Enterprise script's ENGAGE 3 calls kernelJump (tactics.cpp:962-965),
 * but the interpreter moves the pc past the ENGAGE token after its verb (tactics.cpp:245-247, "which overrides
 * wherever the verb went"), so the jump is lost and the script's next ENGAGE 0 disengages the Enterprise at the first
 * step the AI lets the script run: a quirk, kept (Plan 22's R5).
 */
export function startBattle(ctx: BattleContext, input: StartInput): StartResult {
  bindContext(ctx);
  const delegate = input.difficulty !== input.lastDifficulty ? input.difficulty === 0 : (input.previous?.console.delegate ?? false);
  // (the last difficulty is the start's, set before setup and kept if setup fails: tactical.cpp:308)
  const lastDifficulty = input.difficulty;
  // (no scenario is the default battle: tactical.cpp:311-313)
  const scenario = input.scenario === NO_BATTLE ? DEFAULT_BATTLE : input.scenario;
  const result = setupBattle(ctx, { ...input, scenario, delegate });
  const b = result.battle;
  // (no battle, as setup found no Enterprise: the world resets the scenario and goes back to the bridge, tactical.cpp:314-318)
  if (!b) return { ...result, scenario, lastDifficulty };
  b.console.connPage = true;
  b.console.redAlert = scenario !== DEFAULT_BATTLE && scenario !== STARBASE_BATTLE;
  b.console.weaponsLock = false;
  b.console.powerLevel = -1;
  const state = input.objectState(b.ships[0]!.object);
  ctx.seams.setPowerLevel(ctx, b, state >= 1 && state <= 5 ? state - 1 : 0, true);
  if (b.console.delegate && b.ships.slice(1).some(s => !(s.flags & SHIP_FLAGS.friendly))) {
    ctx.seams.setWeaponsLock(ctx, b, true);
    ctx.seams.setPowerLevel(ctx, b, 4, true);
  }
  return { ...result, scenario, lastDifficulty };
}

/**
 * drawScanner's log, after it has drawn a ship's lines (tactical.cpp:1250-1255): a new line scrolls in each 0x48 ticks while
 * the scanner shows the ship, to the newest. `now` is the battle's (`_combat->now()`). The two fields are the console's: no
 * step reads them, and logMessage moves the line read down as old lines fall off (damage.cpp:85-90). Plan 27 R6.
 */
export function scrollLog(ship: CombatShip, now: number): void {
  if (now < ship.logScrollTime) return;
  if (ship.logRead + 1 < ship.log.length) ship.logRead++;
  ship.logScrollTime = now + combatTicks(0x48);
}

/** What TacticalScreen::update did after the battle's update: the code it leaves by (or null), and where it stood down. */
export interface TacticalResult {
  leave: number | null;
  standDowns: string[];
}

/**
 * TacticalScreen::leave's part in the battle (tactical.cpp:369-375): the exit code is spent, and leaving with the
 * self-destruct armed is the end. Returns the ship screen's code the battle leaves for (the screen change is the world's).
 */
export function leaveCode(b: BattleState, code: number): number {
  b.exitCode = NO_EXIT;
  return b.console.selfDestructTime ? GAME_OVER_EXIT : code;
}

/** TacticalScreen::standDown's part in the battle (tactical.cpp:364-367): the red alert off. The battle scenario's reset is the world's. */
export function standDown(b: BattleState): void {
  b.console.redAlert = false;
}

/**
 * processHails' 0x10, its battle half (tactical.cpp:420-429): everyone blows up in turn, each ship not already due to
 * go removed (3 - i) * 0x5af ticks on, the later ships first. ScummVM takes `g_system->getMillis()`, the wall clock,
 * which the port can't reproduce: it takes `now`, the battle's clock (Plan 23 R6, a kept-in-spirit deviation). From the
 * fifth ship (i > 3) the count goes below zero, so combatTicks of a uint32 near 2^32 puts the time hours on: kept.
 */
export function blowUpInTurn(b: BattleState, now: number): void {
  b.ships.forEach((ship, i) => {
    if (!ship.removeTime) ship.removeTime = (now + combatTicks((3 - i) * 0x5af)) >>> 0;
  });
}

/**
 * TacticalScreen::update's battle (tactical.cpp:470-482): the battle's update to `now` (the page, which _connPage
 * follows each frame, is the console's: the `page` command), then leave on an exit code (leave resets it as the screen goes: the world's), else
 * stand down when the target is out of range or only one ship is left at a red alert. A won battle stands down here,
 * and only here: the sim sets no exit for it (the player then leaves by the Bridge button).
 */
export function tacticalUpdate(ctx: BattleContext, b: BattleState, now: number): TacticalResult {
  bindContext(ctx);
  updateBattle(ctx, b, now);
  if (b.exitCode !== NO_EXIT) return { leave: leaveCode(b, b.exitCode), standDowns: [] };
  // (each stand-down named by the line that calls it, as ScummVM's trace names its sites)
  const standDowns: string[] = [];
  if (b.console.redAlert && targetOutOfRange(b)) {
    standDown(b);
    standDowns.push('tactical.cpp:480');
  }
  if (liveShips(b) < 2 && b.console.redAlert) {
    standDown(b);
    standDowns.push('tactical.cpp:482');
  }
  return { leave: null, standDowns };
}
