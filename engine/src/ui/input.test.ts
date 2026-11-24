// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import type { ObjectDef } from '../content/types';
import type { HeadlessPresenter } from '../sim/presenter';
import { flush, settle } from '../sim/settle';
import type { World } from '../sim/world';
import { makeWorld } from '../testing/fixture';
import { COMBADGE_QUESTION, Input } from './input';
import { actionLine, TRANSCRIPT_LIMIT, UiStore } from './store';

const panel: ObjectDef = { id: 'panel', name: 'Panel', screen: 'room', at: 'panel', description: { text: 'A panel.' } };
const crate: ObjectDef = { id: 'crate', name: 'Crate', screen: 'room', at: 'center' };
const tricorder: ObjectDef = { id: 'tricorder', name: 'Tricorder', screen: null, inventory: true };
const phaser: ObjectDef = { id: 'phaser', name: 'Phaser', screen: null, inventory: true };
const communicator: ObjectDef = {
  id: 'communicator', name: 'Combadge', screen: null,
  on: { use: [{ do: [{ say: { who: 'picard', text: 'Away team here.' } }] }] },
};

function setup() {
  const world = makeWorld([panel, crate, tricorder, phaser, communicator], {
    rules: { items: { tricorder: 'tricorder', phaser: 'phaser', communicator: 'communicator' }, lines: {} },
  });
  const store = new UiStore();
  const skipped: number[] = [];
  const sounds: string[] = [];
  const input = new Input(world, store, { skipLine: () => skipped.push(1), playSound: s => sounds.push(s) });
  const act = vi.spyOn(world, 'act');
  return { world, store, input, skipped, sounds, act };
}

const log = (w: World) => (w.presenter as HeadlessPresenter).log;

describe('UiStore', () => {
  it('asks one thing at a time, and clears the dialog when it is answered', async () => {
    const store = new UiStore();
    const answer = store.ask<0 | 1>({ kind: 'choice', question: 'Go?', options: ['Yes', 'No'] });
    expect(store.state.dialog).toEqual({ kind: 'choice', question: 'Go?', options: ['Yes', 'No'] });
    expect(() => store.ask({ kind: 'menu', options: ['A'] })).toThrow('a choice dialog is already up');
    store.answer(1);
    expect(await answer).toBe(1);
    expect(store.state.dialog).toBeNull();
  });

  it('keeps the last lines in the transcript, and a reset drops a dialog unanswered', () => {
    const store = new UiStore();
    for (let i = 0; i < TRANSCRIPT_LIMIT + 5; i++) store.say({ who: 'picard', name: 'Picard', text: `line ${i}` });
    expect(store.state.transcript).toHaveLength(TRANSCRIPT_LIMIT);
    expect(store.state.transcript[0].text).toBe('line 5');
    expect(store.state.subtitle?.text).toBe(`line ${TRANSCRIPT_LIMIT + 4}`);
    void store.ask({ kind: 'tricorder', reading: 1, pages: [], index: 0 });
    store.reset();
    expect(store.state).toMatchObject({ dialog: null, subtitle: null, transcript: [] });
    expect(() => store.ask({ kind: 'tricorder', reading: 2, pages: [], index: 0 })).not.toThrow();
  });

  it('says what a click will do', () => {
    expect(actionLine('look', null, 'Panel')).toBe('Look at Panel');
    expect(actionLine('use', 'Tricorder', null)).toBe('Use Tricorder with …');
    expect(actionLine('use', 'Tricorder', 'Panel')).toBe('Use Tricorder with Panel');
    expect(actionLine('walk', null, null)).toBe('Walk to');
  });
});

describe('Input', () => {
  it("turns a click into the verb mode's action on what was clicked", async () => {
    const { world, store, input, act } = setup();
    store.set({ mode: 'look' });
    expect(input.click({ kind: 'object', id: 'panel' })).toBe(true);
    expect(act).toHaveBeenCalledWith('look', { target: 'panel' });
    await settle(world);
    expect(log(world)).toEqual(['say picard: A panel.']);
  });

  it('walks to the floor only in Walk mode; elsewhere a click on nothing only cancels queued actions', () => {
    const { world, store, input, act } = setup();
    const cancel = vi.spyOn(world, 'cancelQueuedActions');
    store.set({ mode: 'talk' });
    expect(input.click({ kind: 'floor', at: { x: 3, z: 1 } })).toBe(false);
    expect(input.click(null)).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledWith('picard');
    expect(act).not.toHaveBeenCalled();
    store.set({ mode: 'walk' });
    expect(input.click({ kind: 'floor', at: { x: 3, z: 1 } })).toBe(true);
    expect(act).toHaveBeenCalledWith('walk', { to: { x: 3, z: 1 } });
  });

  it("leaves a downed member's queued actions alone on a click on nothing (awayteam.cpp:606-611)", () => {
    const { world, store, input } = setup();
    const cancel = vi.spyOn(world, 'cancelQueuedActions');
    world.state.phaser.picard.health = 0;
    expect(world.isIncapacitated('picard')).toBe(true);
    store.set({ mode: 'look' });
    expect(input.click(null)).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('uses a held item with what is clicked, and keeps holding it (awayteam.cpp:402-416)', () => {
    const { store, input, act } = setup();
    store.set({ mode: 'use' });
    expect(input.clickItem('tricorder')).toBe(false);
    expect(store.state.held).toBe('tricorder');
    expect(input.click({ kind: 'object', id: 'panel' })).toBe(true);
    expect(act).toHaveBeenCalledWith('use', { target: 'panel', other: 'tricorder' });
    expect(store.state.held).toBe('tricorder');
  });

  it('looks at an item, opens the tricorder when looking at it, or uses one held item with another', async () => {
    const { world, store, input, act } = setup();
    store.set({ mode: 'look' });
    expect(input.clickItem('tricorder')).toBe(true);
    await settle(world);
    expect(log(world)).toEqual(['tricorder 32768']);
    expect(input.clickItem('phaser')).toBe(true);
    expect(act).toHaveBeenCalledWith('look', { target: 'phaser' });
    await settle(world);
    store.set({ mode: 'use' });
    input.clickItem('tricorder');
    expect(input.clickItem('phaser')).toBe(true);
    expect(act).toHaveBeenLastCalledWith('use', { target: 'phaser', other: 'tricorder' });
    // (the original never lets go of the item after a use: awayteam.cpp:762-781)
    expect(store.state.held).toBe('tricorder');
    await settle(world);
    expect(world.errors).toEqual([]);
  });

  it('stops a walk for the tricorder in the inventory, which opens straight away', async () => {
    const { world, store, input } = setup();
    input.click({ kind: 'floor', at: { x: 10, z: 0 } });
    await flush();
    world.clock.advanceTo(world.clock.now + 60);
    await flush();
    store.set({ mode: 'look' });
    expect(input.clickItem('tricorder')).toBe(true);
    await settle(world);
    expect(world.obj('picard').pos).toEqual({ x: 2, z: 0 });
    expect(log(world)).toEqual(['walk picard -> 10,0', 'tricorder 32768']);
  });

  it('does not switch verbs from the HUD while a dialog is up or input is blocked, like the keys', () => {
    const { world, store, input } = setup();
    void store.ask<void>({ kind: 'tricorder', reading: 1, pages: [], index: 0 });
    input.setMode('look');
    expect(store.state.mode).toBe('walk');
    store.answer(undefined);
    world.state.awayFlags.inputBlocked = true;
    input.setMode('look');
    expect(store.state.mode).toBe('walk');
    world.state.awayFlags.inputBlocked = false;
    input.setMode('look');
    expect(store.state.mode).toBe('look');
  });

  it('switches verbs with keys and the right button, and Escape lets go of the item', () => {
    const { store, input } = setup();
    expect(input.key('l')).toBe(true);
    expect(store.state.mode).toBe('look');
    input.cycleMode();
    expect(store.state.mode).toBe('use');
    input.clickItem('tricorder');
    expect(input.key('Escape')).toBe(true);
    expect(store.state.held).toBeNull();
    expect(input.key('x')).toBe(false);
  });

  it('opens the admin console with Escape when nothing else takes it: away, on the bridge and on the game-over screen (phase4_rest.md §6.1)', () => {
    const world = makeWorld([panel, tricorder], { rules: { items: { tricorder: 'tricorder' }, lines: {} } });
    const store = new UiStore();
    const admin = vi.fn(() => true);
    const input = new Input(world, store, { skipLine: () => {}, admin });
    // (the held item goes first, then an open panel, each with its own press)
    input.setMode('use');
    input.clickItem('tricorder');
    store.set({ panel: 'transcript' });
    expect([input.key('Escape'), store.state.held, admin.mock.calls.length]).toEqual([true, null, 0]);
    expect([input.key('Escape'), store.state.panel, admin.mock.calls.length]).toEqual([true, 'none', 0]);
    expect([input.key('Escape'), admin.mock.calls.length]).toEqual([true, 1]);
    // (not while away input is blocked: unity.cpp:1335)
    world.state.awayFlags.inputBlocked = true;
    expect([input.key('Escape'), admin.mock.calls.length]).toEqual([false, 1]);
    world.state.awayFlags.inputBlocked = false;
    // aboard: the bridge, not the other stations (Tactical's Escape is its assists panel), and the game-over screen
    world.state.onShip = { gameOver: null };
    world.state.ship.station = 'bridge';
    expect([input.key('Escape'), admin.mock.calls.length]).toEqual([true, 2]);
    world.state.ship.station = 'tactical';
    expect([input.key('Escape'), admin.mock.calls.length]).toEqual([false, 2]);
    world.state.onShip = { gameOver: 2 };
    expect([input.key('Escape'), admin.mock.calls.length]).toEqual([true, 3]);
    // (refused, as while a warp is pending: the key did nothing)
    admin.mockReturnValue(false);
    world.state.onShip = { gameOver: null };
    world.state.ship.station = 'bridge';
    expect(input.key('Escape')).toBe(false);
  });

  it('toggles the log with L aboard; away L is Look (metaengine.cpp:104) and Shift+L the log', () => {
    const { world, store, input } = setup();
    expect([input.key('L'), store.state.panel, store.state.mode]).toEqual([true, 'transcript', 'walk']);
    expect([input.key('L'), store.state.panel]).toEqual([true, 'none']);
    expect([input.key('l'), store.state.panel, store.state.mode]).toEqual([true, 'none', 'look']);
    world.state.onShip = { gameOver: null };
    expect([input.key('l'), store.state.panel]).toEqual([true, 'transcript']);
    expect([input.key('l'), store.state.panel]).toEqual([true, 'none']);
  });

  it("leaves Escape to a dialog that is up: the tricorder's reading closes, the held item stays held", () => {
    const { store, input } = setup();
    input.setMode('use');
    input.clickItem('tricorder');
    store.set({ panel: 'transcript' });
    void store.ask<void>({ kind: 'tricorder', reading: 1, pages: [], index: 0 });
    expect(input.key('Escape')).toBe(false);
    expect(store.state.held).toBe('tricorder');
    expect(store.state.panel).toBe('transcript');
  });

  it('ignores the right button and verb keys while a dialog is up or input is blocked (unity.cpp:1328-1354)', () => {
    const { world, store, input } = setup();
    store.set({ mode: 'look' });
    void store.ask({ kind: 'tricorder', reading: 1, pages: [], index: 0 });
    input.cycleMode();
    expect(input.key('w')).toBe(false);
    expect(store.state.mode).toBe('look');
    store.answer(undefined);
    world.state.awayFlags.inputBlocked = true;
    input.cycleMode();
    expect(input.key('w')).toBe(false);
    expect(store.state.mode).toBe('look');
    world.state.awayFlags.inputBlocked = false;
    input.cycleMode();
    expect(store.state.mode).toBe('use');
    expect(input.key('w')).toBe(true);
    expect(store.state.mode).toBe('walk');
  });

  it("cycles the right button through the original's modes, and has no Get mode or key", () => {
    const { store, input } = setup();
    const seen: string[] = [];
    store.set({ mode: 'look' });
    for (let i = 0; i < 4; i++) {
      input.cycleMode();
      seen.push(store.state.mode);
    }
    expect(seen).toEqual(['use', 'walk', 'talk', 'look']);
    expect(input.key('g')).toBe(false);
    expect(store.state.mode).toBe('look');
  });

  describe('in Use mode with nothing held, a press waits for the release (handleAwayTeamMouseDown/Up)', () => {
    it('uses the object when released on it', () => {
      const { store, input, act } = setup();
      store.set({ mode: 'use' });
      expect(input.press({ kind: 'object', id: 'panel' })).toBe(false);
      expect(act).not.toHaveBeenCalled();
      expect(input.release({ kind: 'object', id: 'panel' })).toBe(true);
      expect(act).toHaveBeenCalledWith('use', { target: 'panel' });
    });

    it('uses it with another object it is dropped on', () => {
      const { store, input, act } = setup();
      store.set({ mode: 'use' });
      input.press({ kind: 'object', id: 'crate' });
      expect(input.release({ kind: 'object', id: 'panel' })).toBe(true);
      // (handleUse(pressed, target): the pressed object, with the one it was dropped on)
      expect(act).toHaveBeenCalledWith('use', { target: 'crate', other: 'panel' });
    });

    it('gets it when dropped on the inventory', () => {
      const { store, input, act } = setup();
      store.set({ mode: 'use' });
      input.press({ kind: 'object', id: 'crate' });
      expect(input.release('inventory')).toBe(true);
      expect(act).toHaveBeenCalledWith('get', { target: 'crate' });
    });

    it('does nothing when dropped on the floor or nothing, or released after a press on nothing', () => {
      const { store, input, act } = setup();
      store.set({ mode: 'use' });
      input.press({ kind: 'object', id: 'crate' });
      expect(input.release({ kind: 'floor', at: { x: 1, z: 1 } })).toBe(false);
      input.press({ kind: 'object', id: 'crate' });
      expect(input.release(null)).toBe(false);
      input.press(null);
      expect(input.release('inventory')).toBe(false);
      // (each release lets go: a second one does nothing)
      input.press({ kind: 'object', id: 'crate' });
      input.release({ kind: 'floor', at: { x: 1, z: 1 } });
      expect(input.release({ kind: 'object', id: 'crate' })).toBe(false);
      expect(act).not.toHaveBeenCalled();
    });

    it('says what the drag will do once it has moved, and forgets it on release', () => {
      const { store, input } = setup();
      store.set({ mode: 'use' });
      input.press({ kind: 'object', id: 'crate' });
      expect(store.state.dragging).toBeNull();
      input.dragged();
      expect(store.state.dragging).toBe('crate');
      input.release(null);
      expect(store.state.dragging).toBeNull();
      // (without a press, a move drags nothing)
      input.dragged();
      expect(store.state.dragging).toBeNull();
    });

    it('takes no press while the world is busy', async () => {
      const { world, store, input, act } = setup();
      store.set({ mode: 'look' });
      input.click({ kind: 'object', id: 'panel' });
      await flush();
      store.set({ mode: 'use' });
      input.press({ kind: 'object', id: 'crate' });
      expect(input.release('inventory')).toBe(false);
      await settle(world);
      expect(input.release('inventory')).toBe(false);
      expect(act).toHaveBeenCalledTimes(1);
    });
  });

  it('acts on the press in the other modes, and with an item held; the release does nothing then', () => {
    const { store, input, act } = setup();
    store.set({ mode: 'talk' });
    expect(input.press({ kind: 'object', id: 'panel' })).toBe(true);
    expect(act).toHaveBeenLastCalledWith('talk', { target: 'panel' });
    expect(input.release('inventory')).toBe(false);
    expect(act).toHaveBeenCalledTimes(1);
  });

  it('counts the actions it starts, and none it refuses', async () => {
    const { world, store, input } = setup();
    store.set({ mode: 'look' });
    input.click({ kind: 'object', id: 'panel' });
    expect(input.started).toBe(1);
    await flush();
    expect(input.click({ kind: 'object', id: 'panel' })).toBe(false);
    expect(input.started).toBe(1);
    await settle(world);
    input.click({ kind: 'object', id: 'panel' });
    expect(input.started).toBe(2);
  });

  it('refuses clicks while an action runs, a dialog is up, or input is blocked', async () => {
    const { world, store, input, act } = setup();
    store.set({ mode: 'look' });
    input.click({ kind: 'object', id: 'panel' });
    await flush();
    expect(world.interruptible).toBe(false);
    expect(input.click({ kind: 'object', id: 'panel' })).toBe(false);
    expect(input.clickItem('tricorder')).toBe(false);
    expect(act).toHaveBeenCalledTimes(1);
    await settle(world);
    void store.ask({ kind: 'tricorder', reading: 1, pages: [], index: 0 });
    expect(input.click({ kind: 'object', id: 'panel' })).toBe(false);
    store.answer(undefined);
    world.state.awayFlags.inputBlocked = true;
    expect(input.click({ kind: 'object', id: 'panel' })).toBe(false);
    world.state.awayFlags.inputBlocked = false;
    expect(input.click({ kind: 'object', id: 'panel' })).toBe(true);
    expect(act).toHaveBeenCalledTimes(2);
  });

  it('skips the line being said instead of acting', () => {
    const { store, input, skipped, act } = setup();
    store.say({ who: 'picard', name: 'Picard', text: 'Hm.' });
    expect(input.click({ kind: 'object', id: 'panel' })).toBe(false);
    expect(skipped).toHaveLength(1);
    expect(input.key(' ')).toBe(true);
    expect(skipped).toHaveLength(2);
    expect(act).not.toHaveBeenCalled();
  });

  it('skips a voiced line said with text off (hidden) as one with its box', () => {
    const { store, input, skipped, act } = setup();
    store.say({ who: 'picard', name: 'Picard', text: 'Hm.' }, false);
    expect(store.state.subtitle?.hidden).toBe(true);
    expect(input.click({ kind: 'object', id: 'panel' })).toBe(false);
    expect(input.key(' ')).toBe(true);
    expect(skipped).toHaveLength(2);
    expect(act).not.toHaveBeenCalled();
  });

  it('Escape skips a line being said (shown or hidden) instead of opening the console; an item held or a panel open goes first, as before', () => {
    const { store, world, skipped } = setup();
    const admin = vi.fn(() => true);
    const input = new Input(world, store, { skipLine: () => skipped.push(1), admin });
    for (const show of [true, false]) {
      store.say({ who: 'picard', name: 'Picard', text: 'Hm.' }, show);
      store.set({ panel: 'transcript' });
      expect([input.key('Escape'), store.state.panel, skipped.length]).toEqual([true, 'none', show ? 0 : 1]);
      expect([input.key('Escape'), skipped.length, admin.mock.calls.length]).toEqual([true, show ? 1 : 2, 0]);
      store.endSay();
    }
    expect([input.key('Escape'), admin.mock.calls.length]).toEqual([true, 1]);
  });

  it('stops a walk for a new command, which runs straight away', async () => {
    const { world, store, input } = setup();
    input.click({ kind: 'floor', at: { x: 10, z: 0 } });
    await flush();
    world.clock.advanceTo(world.clock.now + 60);
    await flush();
    expect(input.canAct).toBe(true);
    store.set({ mode: 'look' });
    expect(input.click({ kind: 'object', id: 'panel' })).toBe(true);
    await settle(world);
    expect(world.obj('picard').pos).toEqual({ x: 2, z: 0 });
    expect(log(world)).toEqual(['walk picard -> 10,0', 'say picard: A panel.']);
  });

  it('selects a member and sets the phaser only when free to', () => {
    const { world, store, input } = setup();
    const revision = store.state.revision;
    expect(input.selectMember('data')).toBe(true);
    expect(world.state.currentActor).toBe('data');
    expect(input.setPhaser(2)).toBe(true);
    expect(world.state.phaserSetting).toBe(2);
    expect(store.state.revision).toBeGreaterThan(revision);
    world.state.awayFlags.inputBlocked = true;
    expect(input.setPhaser(3)).toBe(false);
    expect(input.selectMember('picard')).toBe(false);
  });

  it('says the phaser setting when it changes, as the gauge does (awayteam.cpp:788-793)', () => {
    const { world, store, input } = setup();
    expect(input.setPhaser(3)).toBe(true);
    expect(store.state.message).toBe('Phaser on high setting');
    store.set({ message: null });
    expect(input.setPhaser(3)).toBe(true);
    expect(store.state.message).toBeNull();
    expect(input.setPhaser(0)).toBe(true);
    expect(store.state.message).toBeNull();
    expect(input.setPhaser(1)).toBe(true);
    expect(store.state.message).toBe('Phaser on low setting');
    expect(input.setPhaser(7)).toBe(false);
    expect(world.state.phaserSetting).toBe(1);
    expect(store.state.message).toBe('Phaser on low setting');
  });

  it('asks before calling the ship from the combadge, and only while it is on', async () => {
    const { world, store, input, sounds } = setup();
    world.state.awayFlags.combadge = false;
    expect(input.combadgeReady).toBe(false);
    expect(await input.combadge()).toBe(false);
    expect(store.state.dialog).toBeNull();
    world.state.awayFlags.combadge = true;
    expect(input.combadgeReady).toBe(true);
    const ignored = input.combadge();
    expect(store.state.dialog).toEqual({ kind: 'prompt', text: COMBADGE_QUESTION, buttons: ['Hail', 'Ignore'] });
    store.answer(1);
    expect(await ignored).toBe(false);
    const hailed = input.combadge();
    store.answer(0);
    expect(await hailed).toBe(true);
    await settle(world);
    expect(log(world)).toEqual(['say picard: Away team here.']);
    expect(sounds).toEqual(['combadge', 'combadge']);
  });

  it('stops a walk to call the ship, which answers straight away', async () => {
    const { world, store, input } = setup();
    world.state.awayFlags.combadge = true;
    input.click({ kind: 'floor', at: { x: 10, z: 0 } });
    await flush();
    world.clock.advanceTo(world.clock.now + 60);
    await flush();
    const hailed = input.combadge();
    store.answer(0);
    expect(await hailed).toBe(true);
    await settle(world);
    expect(world.obj('picard').pos).toEqual({ x: 2, z: 0 });
    expect(log(world)).toEqual(['walk picard -> 10,0', 'say picard: Away team here.']);
  });
});
