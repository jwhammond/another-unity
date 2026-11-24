// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { miniShipContent } from '../testing/ship';
import { clickRow, COMPUTER_ROWS, entryForReading, isHidden, listRows, maxListScroll, newComputerState, openComputer, readingKey, recordReading, scrollList, setHidden } from './computer';
import { HeadlessPresenter } from './presenter';
import { createInitialState } from './state';
import { settle } from './settle';
import { tricorderReading } from './talk';
import { World } from './world';
import type { SimEvent } from './events';

function shipWorld() {
  const content = miniShipContent();
  const world = new World(content, createInitialState(content, 1, { onShip: true }), w => new HeadlessPresenter(w.clock));
  const events: SimEvent[] = [];
  world.bus.on(e => events.push(e));
  return { world, content, events };
}

describe('the computer', () => {
  it("a new game starts with compstat's hidden entries and readings", () => {
    const { world, content } = shipWorld();
    expect(world.state.computer).toEqual({ hidden: [3, 4], readings: [] });
    expect(isHidden(world, 3)).toBe(true);
    expect(isHidden(world, 2)).toBe(false);
    // (a copy: changing the state leaves the content alone)
    setHidden(world, 0, true);
    expect(content.ship!.computer.hidden).toEqual([3, 4]);
    expect(newComputerState({ ...content, ship: undefined })).toEqual({ hidden: [], readings: [] });
  });

  it('setHidden ignores entries from 2048, keeps the list ascending and says what changed', () => {
    const { world, events } = shipWorld();
    setHidden(world, 2048, true);
    setHidden(world, 5000, true);
    expect(world.state.computer.hidden).toEqual([3, 4]);
    setHidden(world, 1, true);
    setHidden(world, 2047, true);
    expect(world.state.computer.hidden).toEqual([1, 3, 4, 2047]);
    setHidden(world, 1, true);
    setHidden(world, 3, false);
    expect(world.state.computer.hidden).toEqual([1, 4, 2047]);
    expect(events.filter(e => e.type === 'computer')).toEqual([
      { type: 'computer', field: 'hidden', id: 1, to: true },
      { type: 'computer', field: 'hidden', id: 2047, to: true },
      { type: 'computer', field: 'hidden', id: 3, to: false },
    ]);
  });

  it('recordReading puts a key first once, and warns on an unknown key', () => {
    const { world, events } = shipWorld();
    recordReading(world, 1030);
    recordReading(world, 1031);
    recordReading(world, 1030);
    expect(world.state.computer.readings).toEqual([1031, 1030]);
    // (the reading's entry and its parent are unhidden)
    expect(world.state.computer.hidden).toEqual([]);
    recordReading(world, 77);
    expect(events).toContainEqual({ type: 'warning', message: 'no tricorder reading 77' });
    expect(world.state.computer.readings).toEqual([1031, 1030]);
  });

  it('a tricorder reading records keys 9..0 of its group that have entries, so index 0 ends up first', async () => {
    const { world } = shipWorld();
    void world.enqueue(() => tricorderReading(world, 3));
    await settle(world);
    expect(world.state.computer.readings).toEqual([1030, 1031]);
    expect(world.state.readings).toEqual([{ world: 'test', group: 3 }]);
    // (a negative reading records the same, silently)
    await tricorderReading(world, -4);
    expect(world.state.computer.readings).toEqual([1040, 1030, 1031]);
    // (the all-readings reading records nothing)
    void world.enqueue(() => tricorderReading(world, 0x8000));
    await settle(world);
    expect(world.state.computer.readings).toEqual([1040, 1030, 1031]);
  });

  it('finds an entry and a key through the lifted rows', () => {
    const { content } = shipWorld();
    expect(entryForReading(content, 1031)).toBe(3);
    expect(entryForReading(content, 5)).toBe(0);
    expect(readingKey(content, 'test', 3, 1)).toBe(1031);
    expect(readingKey(content, 'test', 3, 2)).toBeUndefined();
    expect(readingKey(content, 'other', 3, 1)).toBeUndefined();
  });
});

/** A tree for the screen: entry 0 holds 1, 2 and 5; entry 1 holds 2 and 3; the rest hold nothing. */
function tree() {
  const t = shipWorld();
  const entries = t.content.ship!.computer.entries;
  entries[0].subentries = [1, 2, 5];
  entries[1].subentries = [2, 3];
  return t;
}
const setLevel = (world: ReturnType<typeof shipWorld>['world'], level: number) => {
  const at = world.content.ship!.data.units.findIndex(u => u.type === 11);
  world.state.ship.systems.units[at]!.current = level;
};

describe('the computer screen', () => {
  it('at full power, every entry that is not hidden is visible', () => {
    const { world } = tree();
    const view = openComputer(world, 0);
    expect(view.level).toBe(100);
    expect(view.visible).toEqual([true, true, true, false, false, true]);
    expect(view.ancestors).toEqual([0]);
  });

  it('below full power, visibility follows AstroRandom from seed 313, drawing only for entries that are not hidden', () => {
    const { world } = tree();
    setLevel(world, 30);
    // (seed 313 gives 10, 26, 75, 38 for entries 0, 1, 2 and 5, each of them taken modulo 100, worked through the
    // generator's `state * 0x41c64e6d + 0x3039`, bits 16-30)
    expect(openComputer(world, 0).visible).toEqual([true, true, false, false, false, false]);
    setLevel(world, 0);
    expect(openComputer(world, 0).visible.every(v => !v)).toBe(true);
  });

  it('lists the ancestors, then the visible children, at most 15', () => {
    const { world, content } = tree();
    content.ship!.computer.entries = Array.from({ length: 40 }, (_, i) => ({ title: `E${i}`, heading: '', text: '', flags: 0, subentries: i === 0 ? Array.from({ length: 39 }, (_, j) => j + 1) : [] }));
    world.state.computer.hidden = [];
    const view = openComputer(world, 0);
    expect(listRows(world, view)).toHaveLength(COMPUTER_ROWS);
    expect(listRows(world, view)[0]).toEqual({ entry: 0, child: false });
    expect(listRows(world, view)[1]).toEqual({ entry: 1, child: true });
    // (1 ancestor + 39 children - 15 rows)
    expect(maxListScroll(world, view)).toBe(25);
    scrollList(world, view, -1);
    expect(view.listScroll).toBe(0);
    for (let i = 0; i < 40; i++) scrollList(world, view, 1);
    expect(view.listScroll).toBe(25);
    expect(listRows(world, view)[1]).toEqual({ entry: 26, child: true });
  });

  it('opens a child that has subentries, and cuts back to an ancestor', () => {
    const { world } = tree();
    const view = openComputer(world, 0);
    // rows: 0, then 1, 2 and 5 (3 and 4 are hidden)
    clickRow(world, view, 1);
    expect(view.ancestors).toEqual([0, 1]);
    expect(view.selected).toBe(1);
    expect(listRows(world, view).map(r => r.entry)).toEqual([0, 1, 2]);
    clickRow(world, view, 0);
    expect(view.ancestors).toEqual([0]);
    expect(view.selected).toBe(0);
  });

  it('selects a child without subentries without opening it', () => {
    const { world } = tree();
    const view = openComputer(world, 0);
    clickRow(world, view, 2);
    expect(view.ancestors).toEqual([0]);
    expect(view.selected).toBe(2);
    clickRow(world, view, 9);
    expect(view.selected).toBe(2);
  });

  it('opens entry 7 under the root when a script asks, and ignores one that is not there', () => {
    const { world, content } = tree();
    content.ship!.computer.entries = Array.from({ length: 9 }, (_, i) => ({ title: `E${i}`, heading: '', text: '', flags: 0, subentries: [] }));
    const view = openComputer(world, 7);
    expect(view.ancestors).toEqual([0, 7]);
    expect(view.selected).toBe(7);
    expect(openComputer(world, 99).ancestors).toEqual([0]);
  });
});
