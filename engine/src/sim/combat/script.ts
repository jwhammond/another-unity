// SPDX-License-Identifier: GPL-3.0-or-later
import { checkTactics, readTacticInt, TACTICS_CODE_START, tacticsCode } from '../../content/tactics';
import { warn, type BattleContext, type BattleState, type CombatShip, type TacticScript } from './types';

/**
 * A ship's tactics script (TacticScript, combat.h:114-136): its own copy of the file's bytes, which WHEN DELTA writes
 * its deadlines into, and the token accessors the VM reads them with (combat.h:127-134, tactics.cpp:108-133).
 */

/** TacticScript::kNumQueues (combat.h:120): the WHEN queues' stack. */
export const NUM_QUEUES = 10;

/** TacticScript::readInt (tactics.cpp:108-112): a signed int32 at `offset`, or 0 outside the code. */
export function scriptInt(s: TacticScript, offset: number): number {
  return readTacticInt(s.data, offset);
}
/** TacticScript::tokenClass (combat.h:127). */
export function tokenClass(s: TacticScript, token: number): number {
  return scriptInt(s, token);
}
/** TacticScript::tokenOpcode (combat.h:128). */
export function tokenOpcode(s: TacticScript, token: number): number {
  return scriptInt(s, token + 4);
}
/** TacticScript::end (combat.h:129): the token after this one, in int32. */
export function tokenEnd(s: TacticScript, token: number): number {
  return (token + 12 + scriptInt(s, token + 8)) | 0;
}
/** TacticScript::arg (combat.h:130): the token's k-th argument. */
export function tokenArg(s: TacticScript, token: number, k: number): number {
  return scriptInt(s, token + 12 + 4 * k);
}
/** TacticScript::floatArg (tactics.cpp:114-119): the k-th argument's bits as a float. */
export function tokenFloat(s: TacticScript, token: number, k: number): number {
  const v = new DataView(new ArrayBuffer(4));
  v.setInt32(0, tokenArg(s, token, k), true);
  return v.getFloat32(0, true);
}
/** TacticScript::setArg (tactics.cpp:121-125): writes the k-th argument into the ship's copy, if it is inside the code. */
export function setTokenArg(s: TacticScript, token: number, k: number, value: number): void {
  const at = token + 12 + 4 * k;
  if (at < 0 || at + 4 > s.data.length) return;
  new DataView(s.data.buffer, s.data.byteOffset, s.data.byteLength).setInt32(at, value | 0, true);
}
/**
 * TacticScript::text (tactics.cpp:127-133): the text whose length is argument `lengthArg`, in the bytes after it; ''
 * when it doesn't fit. Common::String keeps a NUL inside it, but everything that shows the text (the log, the menu, a
 * trace) stops at it, so this does.
 */
export function tokenText(s: TacticScript, token: number, lengthArg: number): string {
  const length = tokenArg(s, token, lengthArg);
  const start = token + 12 + 4 * (lengthArg + 1);
  if (length <= 0 || start < 0 || start + length > s.data.length) return '';
  const bytes = s.data.subarray(start, start + length);
  const nul = bytes.indexOf(0);
  return String.fromCharCode(...(nul < 0 ? bytes : bytes.subarray(0, nul)));
}
/** TacticScript::queue (combat.h:133): the WHEN queue at the current depth. */
export function scriptQueue(s: TacticScript): number[] {
  return s.queues[s.depth]!;
}

/**
 * Combat::loadScript (tactics.cpp:157-183) and TacticScript::load (135-155): the ship's own copy of its tactics file,
 * which the lift has chosen (kTacticOverrides by the object, else its kind's `<base>.bin`: CombatShip.tactics), or
 * none. A file the game doesn't have gives no script and no warning (openFile fails, tactics.cpp:171-173); one load
 * refuses (under 0x6b bytes, or not "TACTICS") warns. A script that loads engages its ship: setup does this for every
 * ship, the Enterprise too (combat.cpp:259-262).
 */
export function loadScript(ctx: BattleContext, _b: BattleState, ship: CombatShip): void {
  ship.script = null;
  const file = ship.tactics;
  const lifted = file === null ? undefined : ctx.combat.tactics[file];
  if (file === null || !lifted) return;
  const data = tacticsCode(lifted);
  const check = checkTactics(data);
  if (!check.loads) {
    warn(ctx, `bad tactic file ${file}`);
    return;
  }
  ship.script = {
    file, data, pc: TACTICS_CODE_START, idle: 0, kernel: check.kernel, trace: 0,
    queues: Array.from({ length: NUM_QUEUES }, () => []), depth: 0, buffer: true, returns: [],
  };
  ship.engaged = true;
}
