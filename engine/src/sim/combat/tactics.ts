// SPDX-License-Identifier: GPL-3.0-or-later
import { TACTIC, TACTICS_CODE_START, TOKEN } from '../../content/tactics';
import { condition } from './conditions';
import { roll } from './effects';
import { clickManeuver, engage, engageManeuver, rebuildManeuvers, scrollManeuvers } from './maneuvers';
import { loadScript, scriptQueue, tokenArg, tokenClass, tokenEnd, tokenOpcode, tokenText } from './script';
import { hex } from './math';
import { verb } from './verbs';
import { isEnterprise, warn, type BattleContext, type BattleState, type CombatSeams, type CombatShip, type TacticScript } from './types';

/**
 * The tactics VM (tactics.cpp:185-556): a script runs a token at a time, from its page's code ("buffered"), queueing
 * each WHEN it passes; at the end of a page it tests the queue instead, running the action of each WHEN that holds.
 * The original's interpreter, quirks and all, since the scripts were written against it.
 */

/** runScript's guard (tactics.cpp:199): the Enterprise's setup runs at most this many tokens at once. */
const SETUP_GUARD = 100000;
/** evalQueue's limit on a queued token's opcode (tactics.cpp:379). */
const MAX_WHEN = 0x32;

/**
 * Combat::runScript (tactics.cpp:185-201): a token, or a test of the queue. The Enterprise's setup (before its kernel
 * is ready) locks the script and runs all at once, until ENGAGE 3 lets go. A lock left on by the Enterprise's setup
 * makes any ship's run all at once too (ScummVM's _scriptLock is the battle's, not the ship's): kept.
 */
export function runScript(ctx: BattleContext, b: BattleState, ship: CombatShip): void {
  const s = ship.script;
  if (!s) return;
  // the Enterprise's setup runs all at once
  if (isEnterprise(ship) && !b.console.kernelReady) b.console.scriptLock = true;
  if (!s.buffer && scriptQueue(s).length > 0) {
    evalQueue(ctx, b, s, ship);
    return;
  }
  s.buffer = true;
  let guard = 0;
  do scriptStep(ctx, b, s, ship);
  while (b.console.scriptLock && ++guard < SETUP_GUARD);
}

/** Combat::scriptStep (tactics.cpp:203-295): one token. Past the code, back to the return stack's top, or the queue, or the start. */
export function scriptStep(ctx: BattleContext, b: BattleState, s: TacticScript, ship: CombatShip): void {
  if (s.pc >= s.data.length) {
    if (s.returns.length > 0) {
      s.pc = s.returns.shift()!;
      return;
    }
    s.buffer = false;
    if (scriptQueue(s).length > 0) return;
    // (debug: "tactic: queue empty")
    s.pc = TACTICS_CODE_START;
    return;
  }
  const token = s.pc;
  const opcode = tokenOpcode(s, token);
  switch (tokenClass(s, token)) {
    case TOKEN.when:
      whenBuffered(ctx, b, s, ship, token);
      return;
    case TOKEN.do:
      switch (opcode) {
        case TACTIC.push: scriptPush(ctx, s); s.pc = token + 12; return;
        case TACTIC.pop: scriptPop(ctx, s); s.pc = token + 12; return;
        case TACTIC.flush: scriptFlush(s, token); s.pc = tokenEnd(s, token); return;
        case TACTIC.clear: ship.waypointActive = false; s.pc = token + 12; return;
        // (with nothing to return to, this runs again and again: tactics.cpp:241-242)
        case TACTIC.return: scriptReturn(s); return;
        default:
          verb(ctx, b, s, ship, token);
          // (which overrides wherever the verb went)
          s.pc = tokenEnd(s, token);
          return;
      }
    case TOKEN.branch:
      switch (opcode) {
        case TACTIC.button: scriptButton(ctx, b, s, ship, token); return;
        case TACTIC.goto:
        case TACTIC.once: scriptGoto(ctx, s, token); return;
        case TACTIC.one:
        case TACTIC.random:
        case TACTIC.skill: scriptSwitch(ctx, b, s, token); return;
        case TACTIC.gosub:
        case TACTIC.onceGosub: scriptGosub(s, token); return;
        case TACTIC.idle: scriptIdle(s, token); s.pc = tokenEnd(s, token); return;
        case TACTIC.oppose: s.pc = tokenEnd(s, token); return;
        // (the PC stays: the same token again next time)
        default: warn(ctx, `tactic: unknown branch ${hex(opcode)}`); return;
      }
    case TOKEN.page:
      // the end of a page (debug, with nothing to return to or test: "tactic: no event queue for the page")
      s.pc = tokenEnd(s, token);
      s.buffer = false;
      if (s.returns.length > 0) s.pc = s.returns.shift()!;
      return;
    default:
      warn(ctx, 'tactic: unknown token');
      s.pc = tokenEnd(s, token);
  }
}

/** Combat::whenBuffered (tactics.cpp:297-369): a WHEN met in the code joins the queue, and if it holds now, its action runs. */
function whenBuffered(ctx: BattleContext, b: BattleState, s: TacticScript, ship: CombatShip, when: number): void {
  const action = tokenEnd(s, when);
  scriptQueue(s).unshift(when);
  if (!condition(ctx, b, s, ship, when)) {
    s.pc = tokenEnd(s, action);
    return;
  }
  const opcode = tokenOpcode(s, action);
  switch (tokenClass(s, action)) {
    case TOKEN.do:
      // (these leave the PC on the WHEN)
      switch (opcode) {
        case TACTIC.push: scriptPush(ctx, s); return;
        case TACTIC.pop: scriptPop(ctx, s); return;
        case TACTIC.flush: scriptFlush(s, action); return;
        case TACTIC.clear: ship.waypointActive = false; return;
        case TACTIC.return: scriptReturn(s); return;
        default:
          verb(ctx, b, s, ship, action);
          s.pc = tokenEnd(s, action);
          return;
      }
    case TOKEN.branch:
      s.pc = action;
      switch (opcode) {
        case TACTIC.button: scriptButton(ctx, b, s, ship, action); return;
        case TACTIC.goto: scriptGoto(ctx, s, action); return;
        case TACTIC.once: dequeue(s, when); scriptGoto(ctx, s, action); return;
        case TACTIC.one:
        case TACTIC.skill: scriptSwitch(ctx, b, s, action); return;
        case TACTIC.gosub: scriptGosub(s, action); return;
        case TACTIC.onceGosub: dequeue(s, when); scriptGosub(s, action); return;
        case TACTIC.idle: scriptIdle(s, action); return;
        case TACTIC.oppose: return;
        // (including a random switch, oddly: tactics.cpp:358-361)
        default: warn(ctx, `tactic: unknown branch ${hex(opcode)} after a WHEN`); return;
      }
    default:
      warn(ctx, 'tactic: unknown code after a WHEN');
      s.pc = tokenEnd(s, action);
  }
}

/**
 * Combat::evalQueue (tactics.cpp:371-455): each queued WHEN at this depth, newest first, is tested, and the action
 * of each that holds runs. It stops once the queue changes under the WHEN it is on, after a POP or a FLUSH ALL, or
 * once a ONCE has removed its own WHEN.
 */
function evalQueue(ctx: BattleContext, b: BattleState, s: TacticScript, ship: CombatShip): void {
  if (scriptQueue(s).length === 0) {
    s.buffer = true;
    return;
  }
  const level = s.depth;
  const q = s.queues[level]!;
  for (let k = 0; k < q.length; k++) {
    const when = q[k]!;
    if (tokenOpcode(s, when) > MAX_WHEN) {
      warn(ctx, 'tactic: illegal jump address');
      return;
    }
    if (condition(ctx, b, s, ship, when)) {
      const action = tokenEnd(s, when);
      const opcode = tokenOpcode(s, action);
      const cls = tokenClass(s, action);
      if (cls === TOKEN.branch) {
        s.pc = action;
        let removed = false;
        switch (opcode) {
          case TACTIC.button: scriptButton(ctx, b, s, ship, action); break;
          case TACTIC.goto: scriptGoto(ctx, s, action); break;
          case TACTIC.once:
            removed = level === s.depth && dequeue(s, when);
            scriptGoto(ctx, s, action);
            break;
          case TACTIC.one:
          case TACTIC.random:
          case TACTIC.skill: scriptSwitch(ctx, b, s, action); break;
          case TACTIC.gosub: scriptGosub(s, action); break;
          case TACTIC.onceGosub:
            removed = level === s.depth && dequeue(s, when);
            scriptGosub(s, action);
            break;
          case TACTIC.idle: scriptIdle(s, action); break;
          case TACTIC.oppose: break;
          default: warn(ctx, `tactic: unknown branch ${hex(opcode)} in the queue`); break;
        }
        s.buffer = true;
        // (the original stops once the node it's on has gone: tactics.cpp:422-423)
        if (removed) return;
      } else if (cls === TOKEN.do) {
        // (and these leave it testing the queue)
        switch (opcode) {
          case TACTIC.push: scriptPush(ctx, s); break;
          case TACTIC.pop: scriptPop(ctx, s); return;
          case TACTIC.flush: if (scriptFlush(s, action)) return; break;
          case TACTIC.clear: ship.waypointActive = false; break;
          case TACTIC.return: scriptReturn(s); break;
          default: verb(ctx, b, s, ship, action); break;
        }
      } else {
        warn(ctx, 'tactic: unknown code in the queue');
      }
    }
    if (k >= q.length || q[k] !== when) return;
  }
}

/** Combat::dequeue (tactics.cpp:457-466): the WHEN leaves the queue at the current depth. */
function dequeue(s: TacticScript, when: number): boolean {
  const q = scriptQueue(s);
  const i = q.indexOf(when);
  if (i < 0) return false;
  q.splice(i, 1);
  return true;
}

/** Combat::scriptGoto (tactics.cpp:468-477): to argument 1's page, or with -2 in argument 2, the idle page. */
function scriptGoto(ctx: BattleContext, s: TacticScript, token: number): void {
  if (tokenArg(s, token, 2) === -2) {
    if (s.idle) s.pc = s.idle;
    else warn(ctx, 'tactic: no idle page');
  } else {
    s.pc = tokenArg(s, token, 1);
  }
}

/** Combat::scriptGosub (tactics.cpp:479-482): returning after the token the PC is on. */
function scriptGosub(s: TacticScript, token: number): void {
  s.returns.unshift(tokenEnd(s, s.pc));
  s.pc = tokenArg(s, token, 1);
}

/**
 * Combat::scriptSwitch (tactics.cpp:484-499): ONE takes the first page, SKILL the difficulty's, RANDOM a roll's
 * (rnd(total - 1), tactics.cpp:490); a GOSUB in argument 2 returns. An index out of the table goes on to the next token.
 */
function scriptSwitch(ctx: BattleContext, b: BattleState, s: TacticScript, token: number): void {
  const kind = tokenArg(s, token, 0), total = tokenArg(s, token, 3);
  let index = 0;
  if (kind === TACTIC.skill) index = b.difficulty;
  else if (kind === TACTIC.random) index = roll(ctx, b, total - 1, 'tactics.cpp:490');
  if (index < 0 || index >= total || index >= 10) {
    warn(ctx, 'tactic: bad branch address');
    s.pc = tokenEnd(s, token);
    return;
  }
  if (tokenArg(s, token, 2) === TACTIC.gosub) s.returns.unshift(tokenEnd(s, s.pc));
  s.pc = tokenArg(s, token, 4 + index);
}

/** Combat::scriptIdle (tactics.cpp:501-506): the idle page, which is also where the bottom of the return stack goes. */
function scriptIdle(s: TacticScript, token: number): void {
  const page = tokenArg(s, token, 1);
  s.returns.push(page);
  s.idle = page;
}

/** Combat::scriptReturn (tactics.cpp:508-515): to the return stack's top, else the idle page, else (tracing) the start; else nowhere. */
function scriptReturn(s: TacticScript): void {
  if (s.returns.length > 0) s.pc = s.returns.shift()!;
  else if (s.idle) s.pc = s.idle;
  else if (s.trace) s.pc = TACTICS_CODE_START;
}

/** Combat::scriptPush (tactics.cpp:517-524): a new, empty queue, at most 9 deep. */
function scriptPush(ctx: BattleContext, s: TacticScript): void {
  s.depth++;
  if (s.depth > 8) {
    warn(ctx, 'tactic: event queue stack overflow');
    s.depth = 9;
  }
  scriptQueue(s).length = 0;
}

/** Combat::scriptPop (tactics.cpp:526-532): the queue is emptied, and the one under it is back. */
function scriptPop(ctx: BattleContext, s: TacticScript): void {
  scriptQueue(s).length = 0;
  if (!s.depth) warn(ctx, 'tactic: event queue stack underflow');
  else s.depth--;
}

/** Combat::scriptFlush (tactics.cpp:534-540): FLUSH ALL empties the queue; flushing anything else does nothing. */
function scriptFlush(s: TacticScript, token: number): boolean {
  if (tokenArg(s, token, 0) !== TACTIC.all) return false;
  scriptQueue(s).length = 0;
  return true;
}

/** Combat::scriptButton (tactics.cpp:542-556): the Enterprise's script adds a maneuver, labelled, under the last heading. */
function scriptButton(ctx: BattleContext, b: BattleState, s: TacticScript, ship: CombatShip, token: number): void {
  if (ship === b.ships[0] && isEnterprise(ship) && tokenArg(s, token, 3)) {
    const last = b.console.menu[b.console.menu.length - 1];
    if (!last || !last.heading) {
      warn(ctx, 'tactic: no current menu heading');
    } else {
      last.buttons.push({ heading: false, open: false, payload: token + 12, label: tokenText(s, token, 3), buttons: [] });
      rebuildManeuvers(b);
    }
  }
  s.pc = tokenEnd(s, token);
}

/** tactics.cpp's seams (types.ts CombatSeams), for a context: `{ ...NO_SEAMS, ...TACTICS_SEAMS }`, or SIM_SEAMS for them all. */
export const TACTICS_SEAMS: Pick<CombatSeams, 'loadScript' | 'runScript' | 'engage' | 'clickManeuver' | 'scrollManeuvers' | 'engageManeuver'> =
  Object.freeze({ loadScript, runScript, engage, clickManeuver, scrollManeuvers, engageManeuver });
