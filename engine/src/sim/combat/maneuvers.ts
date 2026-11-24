// SPDX-License-Identifier: GPL-3.0-or-later
import { TACTIC } from '../../content/tactics';
import { scriptInt, tokenEnd } from './script';
import { cueId, playCue, warn, type BattleContext, type BattleState, type ManeuverItem, type TacticScript } from './types';

/**
 * The Enterprise's maneuvers (tactics.cpp:923-1054): engaging and disengaging its tactics, Delegate's jump to the
 * KERNEL page, and the Tactics page's menu of maneuvers, which the Enterprise's script builds (MENU and BUTTON).
 */

/** kNumManeuverRows (tactical.cpp:185): the Tactics page shows seven rows of the menu. */
export const MANEUVER_ROWS = 7;

/** Combat::resetScript (tactics.cpp:923-931): with somewhere to return to, the queues go and the script goes back to the bottom of its return stack. */
export function resetScript(s: TacticScript | null): void {
  if (!s || s.returns.length === 0) return;
  // (cleared in place: evalQueue holds on to a queue as it runs)
  for (const q of s.queues) q.length = 0;
  s.depth = 0;
  s.pc = s.returns[s.returns.length - 1]!;
  s.returns.length = 0;
}

/** Combat::kernelJump (tactics.cpp:933-942): Delegate's tactics start at the page named KERNEL. */
export function kernelJump(ctx: BattleContext, s: TacticScript | null): void {
  if (!s) return;
  if (!s.kernel) {
    warn(ctx, 'tactic: no kernel page for delegation');
    return;
  }
  s.pc = s.kernel;
  s.buffer = true;
}

/**
 * Combat::engage (tactics.cpp:944-971): 0 disengages the Enterprise's tactics and centres its controls, 1 engages
 * them (neither while locked), 2 locks them, 3 unlocks them, first jumping to the kernel if it is ready and the
 * power is at full (level 4).
 */
export function engage(ctx: BattleContext, b: BattleState, mode: number): void {
  const ship = b.ships[0];
  if (!ship) return;
  const c = b.console;
  switch (mode) {
    case 0:
    case 1:
      if (c.engageLock) return;
      c.engageButton = mode === 1;
      ship.engaged = mode === 1;
      resetScript(ship.script);
      if (!mode) ship.controls.yaw = ship.controls.pitch = ship.controls.roll = 0;
      return;
    case 2:
      c.engageLock = true;
      return;
    case 3:
      if (c.kernelReady && c.powerLevel === 4) kernelJump(ctx, ship.script);
      c.engageLock = false;
      return;
    default:
      warn(ctx, `tactic: bad engage mode ${mode}`);
  }
}

/** Combat::rebuildManeuvers (tactics.cpp:973-983): the rows are the headings, each followed by its buttons when it is open. menuRows holds [heading, button], button -1 for the heading itself. */
export function rebuildManeuvers(b: BattleState): void {
  const rows: [number, number][] = [];
  b.console.menu.forEach((heading, i) => {
    rows.push([i, -1]);
    if (heading.open) heading.buttons.forEach((_, j) => rows.push([i, j]));
  });
  b.console.menuRows = rows;
}

/** Combat::maneuverAt (tactics.cpp:985-988): the item on a row of the page, under the scroll; null past the end. */
export function maneuverAt(b: BattleState, row: number): ManeuverItem | null {
  const at = b.console.menuRows[b.console.menuScroll + row];
  if (row < 0 || !at) return null;
  const heading = b.console.menu[at[0]];
  return (at[1] < 0 ? heading : heading?.buttons[at[1]]) ?? null;
}

/**
 * Combat::clickManeuver (tactics.cpp:990-1002): a click on a row opens or closes a heading (closing scrolls back to
 * the top), disengages, and selects the row. Only the page's seven rows can be clicked (tactical.cpp:669-673): any
 * other row does nothing.
 */
export function clickManeuver(ctx: BattleContext, b: BattleState, row: number): void {
  if (!Number.isInteger(row) || row < 0 || row >= MANEUVER_ROWS) return;
  const item = maneuverAt(b, row);
  if (item && item.heading) {
    // headings open and close
    item.open = !item.open;
    // (a heading closed by a click scrolls back to the top; one closed by Engage keeps the scroll: tactics.cpp:996-997, 1036-1038)
    if (!item.open) b.console.menuScroll = 0;
    rebuildManeuvers(b);
  }
  engage(ctx, b, 0);
  b.console.menuSelected = row;
}

/** Combat::scrollManeuvers (tactics.cpp:1004-1016): the arrows scroll the menu, and at either end move the selection instead. */
export function scrollManeuvers(_ctx: BattleContext, b: BattleState, direction: number): void {
  const c = b.console;
  if (direction < 0) {
    if (c.menuScroll > 0) c.menuScroll--;
    else c.menuSelected = Math.max(c.menuSelected - 1, 0);
  } else {
    if (c.menuScroll + MANEUVER_ROWS < c.menuRows.length) c.menuScroll++;
    else if (c.menuSelected < 6) c.menuSelected++;
  }
}

/**
 * Combat::engageManeuver (tactics.cpp:1018-1054): Engage. Pressed while engaged, it disengages; on a heading, it opens
 * or closes it; on a maneuver, it engages and sends the Enterprise's script to the button's page, as a subroutine if
 * the button says GOSUB. A button's payload is its token's arguments: the kind first, the page third.
 */
export function engageManeuver(ctx: BattleContext, b: BattleState): void {
  const ship = b.ships[0];
  const c = b.console;
  if (c.menuSelected < 0 || !ship) {
    engage(ctx, b, 0);
    return;
  }
  if (c.engageButton) {
    engage(ctx, b, 0);
    // (the crew's cues as Engage is pressed: the maneuver called off, or begun: tactics.cpp:1026, 1029)
    playCue(b, cueId(ctx, 'disengage'));
    return;
  }
  playCue(b, cueId(ctx, 'engage'));
  const item = maneuverAt(b, c.menuSelected);
  if (!item) {
    engage(ctx, b, 0);
    return;
  }
  if (item.heading) {
    // (keeps the scroll, open or closed, where a click scrolls back as it closes: tactics.cpp:1036-1038, 996-997)
    item.open = !item.open;
    rebuildManeuvers(b);
    c.engageButton = true;
    return;
  }
  const s = ship.script;
  if (!s) return;
  // (debug(1, "tactic: branch %s") dropped: R3)
  // Quirk kept: engage(1) returns at the lock without engaging, yet the jump and engaged = true below still happen
  // (tactics.cpp:1046-1053), so a locked Enterprise is engaged with its Engage button up.
  engage(ctx, b, 1);
  // (to the maneuver, as a subroutine or not)
  if (scriptInt(s, item.payload) === TACTIC.gosub) s.returns.unshift(tokenEnd(s, s.pc));
  s.pc = scriptInt(s, item.payload + 8);
  s.buffer = true;
  ship.engaged = true;
}
