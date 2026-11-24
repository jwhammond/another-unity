// SPDX-License-Identifier: GPL-3.0-or-later
import { checkTactics, tacticTokens, TOKEN } from '../content/tactics';
import { distance } from '../sim/combat/battle';
import { maneuverAt, MANEUVER_ROWS } from '../sim/combat/maneuvers';
import { scriptQueue } from '../sim/combat/script';
import type { BattleState, CombatShip, TacticScript } from '../sim/combat/types';

/**
 * What the debug view shows of the AI and tactics (Plan 21): the console's Delegate and script locks, each ship's
 * script (its page, PC, queue and stack) and its AI's timers, and the Tactics page's seven rows of maneuvers. Pure:
 * the panel renders these lines.
 */

const hex = (n: number) => `0x${(n >>> 0).toString(16)}`;
const on = (flag: boolean, name: string) => (flag ? name : `no ${name}`);
/** A file's pages, by its bytes' identity: a ship's script never moves its pages (SET writes only arguments). */
const pagesOf = new WeakMap<Uint8Array, { name: string; offset: number }[]>();

/** The page a script's PC is in: the last page token before it, by name (or its offset: a page under 0x18 bytes has none). */
export function scriptPage(s: TacticScript): string {
  let pages = pagesOf.get(s.data);
  if (!pages) {
    const named = new Map(checkTactics(s.data).pages.map(p => [p.offset, p.name]));
    pages = tacticTokens(s.data).filter(t => t.cls === TOKEN.page).map(t => ({ offset: t.offset, name: named.get(t.offset) ?? '' }));
    pagesOf.set(s.data, pages);
  }
  const page = pages.filter(p => p.offset < s.pc).at(-1);
  return page ? page.name || hex(page.offset) : '-';
}

/** How many of the tactics' warnings the view keeps. */
const WARNINGS = 5;

/** The latest few warnings, each once: a repeat moves to the end (a stuck script warns every step). */
export function keepWarning(list: string[], m: string): string[] {
  return [...list.filter(w => w !== m), m].slice(-WARNINGS);
}

/** Seconds until a battle time, or '-' once it has passed. */
function until(b: BattleState, time: number): string {
  return time > b.now ? `${((time - b.now) / 1000).toFixed(1)}s` : '-';
}

/** The console's line: Delegate, the kernel, the script and engage locks, the Engage button, the menu's size. */
export function consoleLine(b: BattleState): string {
  const c = b.console;
  return [
    on(c.delegate, 'delegate'), on(c.kernelReady, 'kernel ready'), on(c.scriptLock, 'script lock'), on(c.engageLock, 'engage lock'),
    c.engageButton ? 'engaged by button' : 'no engage button', `menu ${c.menu.length} headings, ${c.menuRows.length} rows`,
  ].join(' · ');
}

/** A ship's line: engaged, its script (page, PC, queue, stack, idle and kernel), its waypoint and its AI's timers. */
export function shipLine(b: BattleState, ship: CombatShip): string {
  const s = ship.script;
  const script = s
    ? `${s.file} ${scriptPage(s)} pc ${hex(s.pc)} ${s.buffer ? 'running' : 'testing'} queue ${s.depth}:${scriptQueue(s).length} returns ${s.returns.length} idle ${hex(s.idle)} kernel ${hex(s.kernel)}`
    : 'no script';
  const waypoint = ship.waypointActive ? `waypoint ${Math.round(Math.hypot(ship.pos.x - ship.waypoint.x, ship.pos.y - ship.waypoint.y, ship.pos.z - ship.waypoint.z))}` : 'no waypoint';
  const target = ship.target === null ? 'no target' : `target ${ship.target}${b.ships[ship.target] ? ` at ${Math.round(distance(ship, b.ships[ship.target]!))}` : ''}`;
  return [
    `${ship.index}`, on(ship.engaged, 'engaged'), script, waypoint, target,
    `fire ${until(b, ship.fireTime)}`, `strategy ${until(b, ship.strategyTime)}`, `hold ${until(b, ship.holdTime)}`, `freeze ${until(b, ship.freezeTime)}`,
  ].join(' · ');
}

/** The Tactics page's rows (tactical.cpp:1258-1279): each row's label, a heading marked open or closed, and whether it is selected. */
export function maneuverRows(b: BattleState): { label: string; selected: boolean }[] {
  return Array.from({ length: MANEUVER_ROWS }, (_, row) => {
    const item = maneuverAt(b, row);
    const label = !item ? '' : item.heading ? `${item.open ? '▾' : '▸'} ${item.label}` : `  ${item.label}`;
    return { label, selected: b.console.menuSelected === row };
  });
}
