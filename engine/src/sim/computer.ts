// SPDX-License-Identifier: GPL-3.0-or-later
import type { GameContent } from '../content/types';
import { AstroRandom, computerPercent } from './shipSystems';
import type { World } from './world';

/** kNumHiddenBits (computer.cpp:84-85): entries from here on can't be hidden. */
export const HIDDEN_BITS = 2048;

/** ComputerScreen::reset (computer.cpp:192-204): compstat's hidden entries and recorded readings. */
export function newComputerState(c: GameContent): { hidden: number[]; readings: number[] } {
  return { hidden: [...(c.ship?.computer.hidden ?? [])], readings: [...(c.ship?.computer.startReadings ?? [])] };
}

/** ComputerScreen::isHidden (computer.cpp:215-217). */
export function isHidden(world: World, entry: number): boolean {
  return entry < HIDDEN_BITS && world.state.computer.hidden.includes(entry);
}

/** ComputerScreen::setHidden (computer.cpp:206-213): ignores entries >= 2048. */
export function setHidden(world: World, entry: number, hidden: boolean): void {
  if (entry < 0 || entry >= HIDDEN_BITS) return;
  const list = world.state.computer.hidden;
  const at = list.indexOf(entry);
  if (hidden === (at !== -1)) return;
  if (hidden) {
    // (kept ascending, as a bit set reads)
    let i = list.findIndex(e => e > entry);
    if (i === -1) i = list.length;
    list.splice(i, 0, entry);
  } else {
    list.splice(at, 1);
  }
  world.bus.emit({ type: 'computer', field: 'hidden', id: entry, to: hidden });
}

/** ComputerScreen::recordReading (computer.cpp:219-231): unhides the parent and the entry, and puts the key first once. */
export function recordReading(world: World, key: number): void {
  const row = world.content.ship?.computer.readings.find(r => r.key === key);
  if (!row) {
    world.bus.emit({ type: 'warning', message: `no tricorder reading ${key}` });
    return;
  }
  setHidden(world, row.parent, false);
  setHidden(world, row.entry, false);
  const list = world.state.computer.readings;
  if (!list.includes(key)) {
    list.unshift(key);
    world.bus.emit({ type: 'computer', field: 'reading', id: key, to: true });
  }
}

/** ComputerScreen::entryForReading (computer.cpp:237-244): the reading's entry, or 0. */
export function entryForReading(c: GameContent, key: number): number {
  return c.ship?.computer.readings.find(r => r.key === key)?.entry ?? 0;
}

/** The key for a world slug, group and index, from the lifted rows (the engine never builds keys from numbers). */
export function readingKey(c: GameContent, world: string, group: number, index: number): number | undefined {
  return c.ship?.computer.readings.find(r => r.world === world && r.group === group && r.index === index)?.key;
}

// ---- the screen (computer.cpp:258-444) ---------------------------------------------------------------------------

/** kNumRows (computer.cpp:32). */
export const COMPUTER_ROWS = 15;
/** kVisibilitySeed (computer.cpp:84): with less power, entries are hidden at random, but the same each time. */
export const VISIBILITY_SEED = 313;

/**
 * The open screen: `level` is computerPercent, `visible` is by entry, `ancestors` the entries opened on the way down
 * (the root first), `selected` the entry shown. (The text's lines and its scroll are presentation: the panel wraps
 * and scrolls it itself.)
 */
export interface ComputerView { level: number; visible: boolean[]; ancestors: number[]; selected: number; listScroll: number }

/**
 * What the computer says as its screen opens (ComputerScreen::update, computer.cpp:306-316), in order: "online" unless it is at 0, then
 * its state: full at 100 or more, offline at 0, else partial.
 */
export function computerVoices(level: number): ('computerOnline' | 'computerFull' | 'computerPartial' | 'computerOffline')[] {
  return [...(level > 0 ? ['computerOnline' as const] : []), level >= 100 ? 'computerFull' : level === 0 ? 'computerOffline' : 'computerPartial'];
}

/** ComputerScreen::start (computer.cpp:258-293): visibility by computerPercent, then the entry a script asked for. */
export function openComputer(world: World, entry: number): ComputerView {
  const tree = world.content.ship?.computer;
  const entries = tree?.entries ?? [];
  // (the voices and the music, 295-318, are presentation: `computerVoices`, and the station's music)
  const level = world.content.ship ? computerPercent(world.content.ship, world.state.ship.systems) : 0;
  const random = new AstroRandom();
  random.seed(VISIBILITY_SEED);
  const visible = entries.map((_, i) => {
    if (isHidden(world, i)) return false;
    if (level >= 100) return true;
    return random.next() % 100 < level;
  });
  const view: ComputerView = { level, visible, ancestors: [0], selected: 0, listScroll: 0 };
  if (entry && entry < entries.length) {
    view.ancestors.push(entry);
    view.selected = entry;
  }
  return view;
}

function visibleChildren(world: World, view: ComputerView, entry: number): number[] {
  const subs = world.content.ship?.computer.entries[entry]?.subentries ?? [];
  return subs.filter(s => view.visible[s]);
}

/** ComputerScreen::maxListScroll (computer.cpp:329-333). */
export function maxListScroll(world: World, view: ComputerView): number {
  const children = visibleChildren(world, view, view.ancestors[view.ancestors.length - 1]);
  return Math.max(0, children.length + view.ancestors.length - COMPUTER_ROWS);
}

/** ComputerScreen::listRows (computer.cpp:335-346): the ancestors, then the visible children from listScroll, up to 15 rows. */
export function listRows(world: World, view: ComputerView): { entry: number; child: boolean }[] {
  const rows: { entry: number; child: boolean }[] = [];
  for (let i = 0; i < view.ancestors.length && rows.length < COMPUTER_ROWS; i++) rows.push({ entry: view.ancestors[i], child: false });
  const children = visibleChildren(world, view, view.ancestors[view.ancestors.length - 1]);
  for (let i = view.listScroll; i < children.length && rows.length < COMPUTER_ROWS; i++) rows.push({ entry: children[i], child: true });
  return rows;
}

/** ComputerScreen::clickRow (computer.cpp:363-380): back up to an ancestor, or open a child with subentries; selects it. */
export function clickRow(world: World, view: ComputerView, index: number): void {
  const rows = listRows(world, view);
  if (index < 0 || index >= rows.length) return;
  const row = rows[index];
  if (!row.child) {
    view.ancestors.length = index + 1;
    view.listScroll = 0;
  } else if ((world.content.ship?.computer.entries[row.entry]?.subentries.length ?? 0) > 0) {
    view.ancestors.push(row.entry);
    view.listScroll = 0;
  }
  view.selected = row.entry;
}

/** The list's up and down buttons (computer.cpp:394-409): 0..maxListScroll. */
export function scrollList(world: World, view: ComputerView, by: -1 | 1): void {
  if (by < 0) {
    if (view.listScroll) view.listScroll--;
  } else if (view.listScroll < maxListScroll(world, view)) {
    view.listScroll++;
  }
}
