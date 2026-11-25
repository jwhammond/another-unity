// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment happy-dom
import { IDBFactory } from 'fake-indexeddb';
import { Mesh, MeshStandardMaterial, Object3D, PerspectiveCamera, Scene, Texture } from 'three';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import type { LoopShape, Mixer, Playing } from '../audio/mixer';
import { COMBAT_SAVE_REFUSED, SaveError } from '../sim/save';
import { settle } from '../sim/settle';
import { STATION_CODE } from '../sim/ship';
import { UNIT_COMPUTER } from '../sim/shipSystems';
import { gotoShipScreen } from '../sim/stations';
import { pauseBattle } from '../sim/tacticalScreen';
import { miniCombat, miniEnterpriseUnits } from '../testing/combat';
import { GameUi } from '../ui/app';
import { hotspotLabels, setHotspotLabels } from '../ui/hotspotLabels';
import { SaveSlots } from '../ui/saves';
import { AssetIndex } from '../view/assets';
import { writeImagePack } from '../view/imagePack';
import { consolePalette, drawConsole } from '../view/combat/consoleFrame';
import { COMBAT_STILLS } from '../view/combat/files';
import { writePack } from '../view/indexed';
import { BrowserPresenter } from '../view/browserPresenter';
import { RuleTrace } from '../dev/trace';
import { parsePresentation, type GamePackage } from '../view/package';
import { VoiceTable } from '../view/voices';
import type { SpaceSceneModule } from './combatView';
import { AUTOSAVE_SLOT, CHANGE_REFUSED, JUMP_REFUSED, SAVE_REFUSED, Session, SWAP_FAILED, type SessionParts } from './session';
import { DEFAULT_SETTINGS, SETTINGS_KEY, type Settings } from './settings';
import type { FeedbackReport, FeedbackTransport } from './feedback';
import { planetColours } from './viewscreenImage';
import type { SpaceView } from '../view/space';

const PANEL = 'id: panel\nname: Panel\nscreen: room\nat: panel\ndescription: { text: "A panel." }\n';
const FILES: Record<string, string> = {
  'game.yaml': 'id: mini\nstart: { screen: room, entrance: door, awayTeam: [picard, data], leader: picard }\nrules:\n  items: { communicator: communicator }\n',
  'screens/room.yaml': 'id: room\nmarkers: { door: { x: 0, z: 0 }, panel: { x: 3, z: 0 } }\nstartup: { combadge: true }\n',
  'objects/communicator.yaml': 'id: communicator\nname: Combadge\nscreen: null\non:\n  use:\n    - do:\n        - say: { who: picard, text: "Away team here." }\n',
  'screens/hall.yaml': 'id: hall\nmarkers: { entry: { x: 0, z: 0 } }\n',
  'objects/crew/00-picard.yaml': 'id: picard\nname: Picard\nscreen: room\ncrew: true\n',
  'objects/crew/01-data.yaml': 'id: data\nname: Data\nscreen: room\ncrew: true\n',
  'objects/panel.yaml': PANEL,
  'objects/beam.yaml': 'id: beam\nname: Beam\nscreen: room\nat: panel\non:\n  use:\n    - do:\n        - screen: { to: $ship }\n',
  'objects/broken.yaml': 'id: broken\nname: Broken\nscreen: room\nat: panel\non:\n  use:\n    - do:\n        - call: { hook: nope }\n',
};

function pkg(over: Record<string, string> = {}): GamePackage {
  const files = { ...FILES, ...over };
  return {
    id: 'mini',
    files: Object.entries(files).map(([path, text]) => ({ path, text })),
    assets: new AssetIndex(),
    voices: new VoiceTable(),
    presentation: { music: {}, ambience: {}, intro: {}, arrival: {}, sounds: {}, art: { rooms: {}, cards: {}, ship: {} } },
  };
}

async function start(over: Record<string, string> = {}) {
  const logs: string[] = [];
  const saves = await SaveSlots.open('mini', new IDBFactory());
  const s = await Session.start(pkg(over), { saves, log: (level, m) => logs.push(`${level}: ${m}`) });
  return { s, logs, saves };
}

/** The settings side of Mixer (Plan 32: the levels, the master and the console's pause), for a fake that only records what plays. */
const LEVELS = { setMaster: () => {}, setLevel: () => {}, pauseLoops: () => {} };

/** Runs the game for a while: six sim ticks and one 0.1 s frame at a time. */
async function run(s: Session, seconds: number): Promise<void> {
  for (let t = 0; t < seconds; t += 0.1) {
    for (let i = 0; i < 6; i++) s.tick();
    s.frame(0.1);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

describe('Session', () => {
  it('starts the game, and plays a click through the browser presenter', async () => {
    const { s } = await start();
    expect(s.stage.actorIds()).toEqual(['picard', 'data']);
    s.store.set({ mode: 'look' });
    expect(s.input.click({ kind: 'object', id: 'panel' })).toBe(true);
    await run(s, 0.3);
    expect(s.store.state.subtitle?.text).toBe('A panel.');
    await run(s, 2);
    expect(s.world.busy).toBe(false);
    expect(s.store.state.transcript.map(l => l.text)).toEqual(['A panel.']);
  });

  it('saves under a typed name, cut to 30 characters, or Save Game N when blank, through the saves port', async () => {
    const { s, saves } = await start();
    const port = s.uiPort().saves!;
    await port.save(9, 'Before the @Cardassians' + 'x'.repeat(30));
    await port.save(6, '  ');
    const list = await saves.list();
    expect(list.map(m => [m.slot, m.label])).toEqual([[6, 'Save Game 6'], [9, 'Before the Cardassians' + 'x'.repeat(8)]]);
    expect(list[1].label).toHaveLength(30);
  });

  it('the saves port takes slots 1-9 only, and loads the autosave (slot 0) but never saves to it', async () => {
    const { s, saves } = await start();
    const port = s.uiPort().saves!;
    for (const bad of [0, 10, -1, 1.5, NaN]) await expect(port.save(bad, 'x')).rejects.toThrow('no such save slot');
    for (const bad of [10, -1, 1.5, NaN]) await expect(port.load(bad)).rejects.toThrow('no such save slot');
    await port.save(9, 'nine');
    await expect(port.load(9)).resolves.toBeUndefined();
    await s.autosave();
    await expect(port.load(0)).resolves.toBeUndefined();
    expect((await saves.list()).map(m => m.slot)).toEqual([0, 9]);
  });

  it('saves to a slot, and loads it back into a new world', async () => {
    const { s, saves } = await start();
    s.input.selectMember('data');
    await s.saveTo(1, 0);
    expect((await saves.list())[0]).toMatchObject({ slot: 1, screen: 'room', savedAt: 0 });
    s.input.selectMember('picard');
    const before = s.world;
    await s.loadSlot(1);
    expect(s.world).not.toBe(before);
    expect(s.world.state.currentActor).toBe('data');
    expect(s.stage.actorIds()).toEqual(['picard', 'data']);
  });

  it('autosaves to the reserved slot, outside the save menu\'s, and Continue starts a new session exactly there', async () => {
    const { s, saves } = await start();
    s.input.selectMember('data');
    s.world.state.objects.communicator!.inventory = true;
    s.world.state.screen = 'hall';
    expect(await s.autosave(5)).toBe(true);
    expect(await saves.list()).toEqual([{ slot: AUTOSAVE_SLOT, label: expect.stringContaining('Autosave'), screen: 'hall', savedAt: 5 }]);
    expect(AUTOSAVE_SLOT).toBeLessThan(1);
    // (the page is gone: a new one reads the slot, as the loading screen's Continue does)
    const text = await saves.get(AUTOSAVE_SLOT);
    const resumed = await Session.start(pkg(), { saves }, text);
    expect(resumed.world.state.screen).toBe('hall');
    expect(resumed.world.state.currentActor).toBe('data');
    expect(resumed.world.state.awayTeam).toEqual(s.world.state.awayTeam);
    expect(resumed.world.state.objects.communicator!.inventory).toBe(true);
    expect(JSON.parse(resumed.world.save())).toEqual(JSON.parse(s.world.save()));
    // (a resumed game opens with no movies)
    expect(resumed.store.state.dialog).toBeNull();
  });

  it('autosaves only when idle: not mid-scene, not under a movie or a question', async () => {
    const { s, saves } = await start();
    s.store.set({ mode: 'look' });
    s.input.click({ kind: 'object', id: 'panel' });
    await run(s, 0.2);
    expect(s.canAutosave).toBe(false);
    expect(await s.autosave()).toBe(false);
    expect(await saves.get(AUTOSAVE_SLOT)).toBeUndefined();
    await run(s, 2);
    expect(s.canAutosave).toBe(true);
    expect(await s.autosave()).toBe(true);
    void s.input.combadge();
    expect(await s.autosave()).toBe(false);
  });

  it('reports a new screen in whereabouts, which is when the autosave is due', async () => {
    const { s } = await start();
    const before = s.whereabouts;
    s.world.state.screen = 'hall';
    expect(s.whereabouts).not.toBe(before);
  });

  it('refuses a bad save, keeping the game as it was', async () => {
    const { s } = await start();
    const before = s.world;
    await expect(s.load('{"version": 99}')).rejects.toThrow(SaveError);
    await expect(s.load('not json')).rejects.toThrow('save is not valid JSON');
    expect(s.world).toBe(before);
  });

  it('refuses to save in the middle of something', async () => {
    const { s } = await start();
    s.store.set({ mode: 'look' });
    s.input.click({ kind: 'object', id: 'panel' });
    await run(s, 0.2);
    await expect(s.saveTo(1)).rejects.toThrow(SAVE_REFUSED);
  });

  it('refuses to save during a battle, in ScummVM\'s words, and writes no autosave (save.cpp:156-159; Plan 23 R4)', async () => {
    const { s } = await start();
    s.world.state.ship.combat = { scenario: 8, enterprise: 'panel', enemies: [], friends: [], destroyed: [], warped: false, redAlert: true };
    await expect(s.saveTo(1)).rejects.toThrow(COMBAT_SAVE_REFUSED);
    expect(s.canAutosave).toBe(false);
    expect(await s.autosave()).toBe(false);
    s.world.state.ship.combat = null;
    expect(s.canAutosave).toBe(true);
  });

  it('says on the admin console why SAVE is refused during a battle, in ScummVM\'s words (savesPort canSave and refusal)', async () => {
    const { s } = await start();
    const root = document.body.appendChild(document.createElement('div'));
    s.store.set({ mode: 'look', panel: 'admin' });
    act(() => render(h(GameUi, { ui: s.uiPort() }), root));
    const save = () => root.querySelector<HTMLButtonElement>('button[aria-label="SAVE"]')!;
    const page = () => root.querySelector<HTMLElement>('.au-admin-console')!.dataset.page;
    await act(async () => { await Promise.resolve(); });
    expect(root.textContent).not.toContain(COMBAT_SAVE_REFUSED);
    s.world.state.ship.combat = { scenario: 8, enterprise: 'panel', enemies: [], friends: [], destroyed: [], warped: false, redAlert: true };
    act(() => s.store.bump());
    act(() => save().click());
    expect([page(), root.textContent?.includes(COMBAT_SAVE_REFUSED)]).toEqual(['paused', true]);
    s.world.state.ship.combat = null;
    act(() => s.store.bump());
    act(() => save().click());
    expect(page()).toBe('save');
    act(() => render(null, root));
    root.remove();
  });

  it('holds a hot reload until a battle is over, instead of throwing every frame', async () => {
    const { s } = await start();
    s.world.state.ship.combat = { scenario: 8, enterprise: 'panel', enemies: [], friends: [], destroyed: [], warped: false, redAlert: true };
    s.reloadContent(pkg({ 'objects/panel.yaml': PANEL.replace('A panel.', 'A shiny panel.') }));
    await run(s, 0.2);
    expect(s.world.content.objects.panel.description?.text).toBe('A panel.');
    s.world.state.ship.combat = null;
    await run(s, 0.2);
    expect(s.world.content.objects.panel.description?.text).toBe('A shiny panel.');
  });

  it('tells the player when the team goes back to the ship', async () => {
    const { s } = await start();
    s.store.set({ mode: 'use' });
    s.input.click({ kind: 'object', id: 'beam' });
    await run(s, 0.5);
    expect(s.store.state.message).toBe('The away team is back aboard the ship.');
  });

  it('refuses to load or restart in the middle of something', async () => {
    const { s } = await start();
    await s.saveTo(1, 0);
    s.store.set({ mode: 'look' });
    s.input.click({ kind: 'object', id: 'panel' });
    await run(s, 0.2);
    const before = s.world;
    await expect(s.loadSlot(1)).rejects.toThrow(CHANGE_REFUSED);
    await expect(s.restart()).rejects.toThrow(CHANGE_REFUSED);
    expect(s.world).toBe(before);
  });

  it('holds the world and presentation time while the combadge question is up', async () => {
    const { s } = await start();
    const asked = s.input.combadge();
    expect(s.store.state.dialog?.kind).toBe('prompt');
    const tick = s.world.clock.now;
    const time = s.clock.now;
    await run(s, 1);
    expect(s.world.clock.now).toBe(tick);
    expect(s.clock.now).toBe(time);
    s.store.answer(1);
    expect(await asked).toBe(false);
    await run(s, 0.5);
    expect(s.world.clock.now).toBeGreaterThan(tick);
  });

  it('logs a failed action instead of throwing it', async () => {
    const { s, logs } = await start();
    s.store.set({ mode: 'use' });
    s.input.click({ kind: 'object', id: 'broken' });
    await run(s, 0.3);
    expect(logs).toContain('error: hook not ported: nope');
    expect(s.world.busy).toBe(false);
  });

  it("keeps presentation time at the loop's speed", async () => {
    const saves = await SaveSlots.open('mini', new IDBFactory());
    const s = await Session.start(pkg(), { saves, speed: 4, log: () => {} });
    expect(s.loop.speed).toBe(4);
    expect(s.clock.speed).toBe(4);
    s.speed = 2;
    expect(s.loop.speed).toBe(2);
    expect(s.clock.speed).toBe(2);
    // (whoever drives the loop may set its speed directly: the next frame brings the clock along)
    s.loop.speed = 3;
    s.loop.advance(0);
    s.loop.advance(50);
    expect(s.clock.speed).toBe(3);
    expect(s.clock.now).toBeCloseTo(0.15);
  });

  it('tears the old game down before building the new one', async () => {
    const { s } = await start();
    const order: string[] = [];
    const oldWorld = s.world;
    const oldPresenter = s.presenter;
    vi.spyOn(oldPresenter, 'dispose').mockImplementation(function (this: BrowserPresenter) {
      order.push('dispose');
      (BrowserPresenter.prototype.dispose as () => void).call(this);
    });
    const reset = s.store.reset.bind(s.store);
    vi.spyOn(s.store, 'reset').mockImplementation(keep => {
      order.push('reset');
      reset(keep);
    });
    const build = s.newWorld.bind(s);
    vi.spyOn(s, 'newWorld').mockImplementation(() => {
      order.push('build');
      return build();
    });
    await s.restart();
    expect(order).toEqual(['dispose', 'reset', 'build']);
    expect(s.world).not.toBe(oldWorld);
    expect(s.clock.pending).toBe(0);

    // nothing of the old game reaches the new one: its events, its presenter's lines, its waits
    oldWorld.bus.emit({ type: 'leftAwayMission', gameOver: null });
    expect(s.store.state.message).toBeNull();
    void oldPresenter.say('picard', 'Old line.');
    expect(s.store.state.subtitle).toBeNull();
    expect(s.clock.pending).toBe(0);
    expect(s.stage.actorIds()).toEqual(['picard', 'data']);
  });

  it('loads a slot the same way: the old presenter and store go first, and nothing of them stays', async () => {
    const { s } = await start();
    await s.saveTo(1, 0);
    const oldWorld = s.world;
    const oldPresenter = s.presenter;
    const order: string[] = [];
    vi.spyOn(oldPresenter, 'dispose').mockImplementation(() => order.push('dispose'));
    const reset = s.store.reset.bind(s.store);
    vi.spyOn(s.store, 'reset').mockImplementation(keep => {
      // (the new world isn't in place yet)
      order.push(s.world === oldWorld ? 'reset' : 'reset late');
      reset(keep);
    });
    await s.loadSlot(1);
    expect(order).toEqual(['dispose', 'reset']);
    oldWorld.bus.emit({ type: 'leftAwayMission', gameOver: null });
    expect(s.store.state.message).toBeNull();
  });

  it('begins a new game at a mission\'s screen, before the loop has run, and refuses while it runs', async () => {
    const { s } = await start();
    // (dirty the world: begin must leave nothing of it)
    const dirty = () => {
      for (let i = 0; i < 12; i++) s.tick();
      s.world.state.readings.push({ world: 'mini', group: 3 });
      s.world.state.awayFlags.combadge = false;
      s.world.state.awayFlags.inputBlocked = true;
      s.world.state.objects.picard.pos = { x: 9, z: 9 };
      s.world.state.onShip = { gameOver: 4 };
      s.store.say({ who: 'picard', name: 'Picard', text: 'Hm.' });
    };
    dirty();
    expect(s.world.clock.now).toBeGreaterThan(0);
    const before = s.world;
    await s.begin({ screen: 'hall', entrance: 'entry' });
    const fresh = () => {
      expect(s.world).not.toBe(before);
      expect(s.world.state.screen).toBe('hall');
      expect(s.world.state.objects.picard).toMatchObject({ screen: 'hall', pos: { x: 0, z: 0 } });
      expect(s.world.clock.now).toBe(0);
      expect(s.world.state.readings).toEqual([]);
      expect(s.world.state.awayFlags).toEqual({ inputBlocked: false, combadge: true });
      expect(s.world.state.onShip).toBeNull();
      expect(s.store.state.subtitle).toBeNull();
    };
    fresh();
    // (and a second mission after the first)
    dirty();
    const second = s.world;
    await s.begin({ screen: 'hall', entrance: 'entry' });
    expect(s.world).not.toBe(second);
    fresh();
    await expect(s.begin({ screen: 'hall', entrance: 'nowhere' })).rejects.toThrow(/nowhere/);
    s.loop.start();
    await expect(s.begin({ screen: 'room', entrance: 'door' })).rejects.toThrow(CHANGE_REFUSED);
    s.loop.stop();
  });

  it('a dev start can name its own away team, and refuses an unknown member', async () => {
    const { s } = await start();
    await s.begin({ screen: 'hall', entrance: 'entry', awayTeam: ['data'], leader: 'data' });
    expect(s.world.state.awayTeam).toEqual(['data']);
    expect(s.world.state.currentActor).toBe('data');
    expect(s.world.state.objects.data.screen).toBe('hall');
    await expect(s.begin({ screen: 'hall', entrance: 'entry', awayTeam: ['nobody'] })).rejects.toThrow(/nobody/);
  });

  describe('refuses to load, restart or import unless the game is idle', () => {
    const cases: [string, (s: Session) => void][] = [
      ['a dialog is up', s => void s.input.combadge()],
      ['input is blocked', s => { s.world.state.awayFlags.inputBlocked = true; }],
      ['a line is being said', s => s.store.say({ who: 'picard', name: 'Picard', text: 'Hm.' })],
      ['a presentation is still running', s => void s.clock.after(5)],
    ];
    for (const [why, busy] of cases) {
      it(`while ${why}`, async () => {
        const { s } = await start();
        await s.saveTo(1, 0);
        const text = s.world.save();
        const port = s.uiPort().saves!;
        busy(s);
        const before = s.world;
        expect(port.canSave()).toBe(false);
        await expect(s.loadSlot(1)).rejects.toThrow(CHANGE_REFUSED);
        await expect(s.restart()).rejects.toThrow(CHANGE_REFUSED);
        await expect(port.importText(text)).rejects.toThrow(CHANGE_REFUSED);
        await expect(port.load(1)).rejects.toThrow(CHANGE_REFUSED);
        expect(s.world).toBe(before);
      });
    }
  });

  it('lets the player save, load or restart once the team is back aboard the ship', async () => {
    const { s, saves } = await start();
    s.store.set({ mode: 'use' });
    s.input.click({ kind: 'object', id: 'beam' });
    await run(s, 0.5);
    expect(s.world.state.onShip).not.toBeNull();
    expect(s.uiPort().saves!.canSave()).toBe(true);
    await s.saveTo(2, 0);
    expect((await saves.list()).map(m => m.slot)).toEqual([2]);
    await s.loadSlot(2);
    expect(s.world.state.onShip).not.toBeNull();
    const before = s.world;
    await s.restart();
    expect(s.world).not.toBe(before);
    expect(s.world.state.onShip).toBeNull();
  });

  it("runs the new game's startup exactly once on a restart", async () => {
    const { s } = await start({
      'screens/room.yaml': 'id: room\nmarkers: { door: { x: 0, z: 0 }, panel: { x: 3, z: 0 } }\nstartup: { combadge: true, action: { verb: look, target: panel } }\n',
    });
    await run(s, 3);
    expect(s.store.state.transcript.map(l => l.text)).toEqual(['A panel.']);
    await s.restart();
    await run(s, 3);
    expect(s.world.busy).toBe(false);
    expect(s.store.state.transcript.map(l => l.text)).toEqual(['A panel.']);
  });

  it('refuses a second load or restart while one is under way', async () => {
    const { s } = await start();
    await s.saveTo(1, 0);
    const text = s.world.save();
    const port = s.uiPort().saves!;
    // (all asked for at once, while the first restart is still showing its new world)
    const first = s.restart();
    const again = [s.restart(), s.load(text), port.importText(text)];
    expect(port.canSave()).toBe(false);
    for (const p of again) await expect(p).rejects.toThrow(CHANGE_REFUSED);
    await first;
    expect(port.canSave()).toBe(true);
    await s.restart();
  });

  it('says to reload the page when the new game fails after the old one is gone', async () => {
    const { s, logs } = await start();
    vi.spyOn(s, 'newWorld').mockImplementation(() => {
      throw new Error('boom');
    });
    await expect(s.restart()).rejects.toThrow(`${SWAP_FAILED} (boom)`);
    expect(logs).toContain(`error: ${SWAP_FAILED} (boom)`);
  });

  it('reloads changed content once idle, keeping the game going and its transcript', async () => {
    const { s } = await start();
    s.input.selectMember('data');
    s.store.say({ who: 'picard', name: 'Picard', text: 'Kept.' });
    s.reloadContent(pkg({ 'objects/panel.yaml': PANEL.replace('A panel.', 'A shiny panel.') }));
    await run(s, 0.1);
    expect(s.world.content.objects.panel.description?.text).toBe('A shiny panel.');
    expect(s.world.state.currentActor).toBe('data');
    expect(s.store.state.transcript.map(l => l.text)).toEqual(['Kept.']);
    expect(s.problems).toEqual([]);
  });

  it('keeps the game on content with problems, and lists them', async () => {
    const { s } = await start();
    const before = s.world;
    s.reloadContent(pkg({ 'objects/panel.yaml': 'id: [unclosed\n' }));
    await run(s, 0.1);
    expect(s.world).toBe(before);
    expect(s.problems[0]).toMatch(/^objects\/panel\.yaml: YAML error/);
  });

  it('asks for a restart when the game no longer fits the content, and restarts into it', async () => {
    const { s } = await start();
    s.reloadContent(pkg({ 'objects/crate.yaml': 'id: crate\nname: Crate\nscreen: room\n' }));
    await run(s, 0.1);
    expect(s.problems[0]).toMatch(/restart/);
    expect(s.world.state.objects.crate).toBeUndefined();
    await s.restart();
    expect(s.world.state.objects.crate).toBeDefined();
    expect(s.problems).toEqual([]);
  });

  it('keeps asking for a restart until a newer reload has actually been swapped in', async () => {
    const { s } = await start();
    s.reloadContent(pkg({ 'objects/crate.yaml': 'id: crate\nname: Crate\nscreen: room\n' }));
    await run(s, 0.1);
    expect(s.problems[0]).toMatch(/restart/);
    void s.world.enqueue(() => s.world.clock.wait(30));
    s.reloadContent(pkg({ 'objects/panel.yaml': PANEL.replace('A panel.', 'A shiny panel.') }));
    s.frame(0.1);
    expect(s.problems[0]).toMatch(/restart/);
    await run(s, 1);
    expect(s.world.content.objects.panel.description?.text).toBe('A shiny panel.');
    expect(s.problems).toEqual([]);
  });

  it('lists a hot reload that failed before it reached the session, and drops a pending one', async () => {
    const { s, logs } = await start();
    const before = s.world;
    void s.world.enqueue(() => s.world.clock.wait(30));
    s.reloadContent(pkg({ 'objects/panel.yaml': PANEL.replace('A panel.', 'A shiny panel.') }));
    const bump = vi.spyOn(s.store, 'bump');
    s.reloadFailed(new Error('demo.ts: boom'));
    expect(bump).toHaveBeenCalled();
    expect(s.problems).toEqual(['demo.ts: boom']);
    expect(logs.at(-1)).toMatch(/^warn: the changed content has 1 problem/);
    await run(s, 1);
    expect(s.world).toBe(before);
  });

  it("doesn't re-render the UI for events only the rule trace reads", async () => {
    const { s } = await start();
    const bump = vi.spyOn(s.store, 'bump');
    s.world.bus.emit({ type: 'ruleSkipped', target: 'panel', verb: 'look', group: 'g', result: 0 });
    s.world.bus.emit({ type: 'effectRan', group: 'g', effect: 'say', result: 0 });
    s.world.bus.emit({ type: 'actionStarted', verb: 'look', target: 'panel', who: 'picard', other: null, depth: 1 });
    s.world.bus.emit({ type: 'actionEnded', verb: 'look', target: 'panel', result: 0, depth: 1 });
    s.world.bus.emit({ type: 'triggerFired', id: 't', target: 'panel' });
    s.world.bus.emit({ type: 'timerFired', object: 'panel' });
    s.world.bus.emit({ type: 'rng', site: 'skill', max: 255, value: 1 });
    s.world.bus.emit({ type: 'conditionPassed', group: 'g', other: null });
    expect(bump).not.toHaveBeenCalled();
    s.world.bus.emit({ type: 'warning', message: 'w' });
    expect(bump).toHaveBeenCalledOnce();
  });

  it('swaps a reloaded world in the way a load does, and traces only the running world', async () => {
    const { s } = await start();
    const oldWorld = s.world;
    const oldPresenter = s.presenter;
    const dispose = vi.spyOn(oldPresenter, 'dispose');
    s.reloadContent(pkg({ 'objects/panel.yaml': PANEL.replace('A panel.', 'A shiny panel.') }));
    await run(s, 0.1);
    expect(s.world).not.toBe(oldWorld);
    expect(dispose).toHaveBeenCalledOnce();
    s.trace.clear();
    oldWorld.bus.emit({ type: 'warning', message: 'old world' });
    expect(s.store.state.message).toBeNull();
    s.world.bus.emit({ type: 'warning', message: 'new world' });
    expect(s.trace.entries.map(e => e.text)).toEqual(['warning: new world']);
  });

  it('holds a reload until the world is idle, and jumps only while idle', async () => {
    const { s } = await start();
    const before = s.world;
    const dev = s.devPort();
    void s.world.enqueue(() => s.world.clock.wait(30));
    s.reloadContent(pkg({ 'objects/panel.yaml': PANEL.replace('A panel.', 'A shiny panel.') }));
    expect(() => dev.jump('hall', 'entry')).toThrow(JUMP_REFUSED);
    s.frame(0.1);
    expect(s.world).toBe(before);
    await run(s, 1);
    expect(s.world).not.toBe(before);
    expect(s.world.content.objects.panel.description?.text).toBe('A shiny panel.');
    // (a line on screen is enough to refuse a jump)
    s.store.say({ who: 'picard', name: 'Picard', text: 'Hm.' });
    expect(() => dev.jump('hall', 'entry')).toThrow(JUMP_REFUSED);
    s.store.set({ subtitle: null });
    dev.jump('hall', 'entry');
    expect(s.world.state.screen).toBe('hall');
    expect(dev.world()).toBe(s.world);
  });

  it('lets a second reload supersede a pending one', async () => {
    const { s } = await start();
    void s.world.enqueue(() => s.world.clock.wait(30));
    s.reloadContent(pkg({ 'objects/panel.yaml': PANEL.replace('A panel.', 'A first panel.') }));
    s.reloadContent(pkg({ 'objects/panel.yaml': PANEL.replace('A panel.', 'A second panel.') }));
    await run(s, 1);
    expect(s.world.content.objects.panel.description?.text).toBe('A second panel.');
  });

  it('drops a pending reload when a newer one has problems', async () => {
    const { s } = await start();
    const before = s.world;
    void s.world.enqueue(() => s.world.clock.wait(30));
    s.reloadContent(pkg({ 'objects/panel.yaml': PANEL.replace('A panel.', 'A shiny panel.') }));
    s.reloadContent(pkg({ 'objects/panel.yaml': 'id: [unclosed\n' }));
    await run(s, 1);
    expect(s.world).toBe(before);
    expect(s.content.objects.panel.description?.text).toBe('A panel.');
    expect(s.problems[0]).toMatch(/^objects\/panel\.yaml: YAML error/);
  });

  it('keeps the running content when the game no longer fits a reload, so a load still works', async () => {
    const { s } = await start();
    const original = s.pkg;
    s.reloadContent(pkg({ 'objects/crate.yaml': 'id: crate\nname: Crate\nscreen: room\n' }));
    await run(s, 0.1);
    expect(s.problems[0]).toMatch(/restart/);
    expect(s.pkg).toBe(original);
    expect(s.content.objects.crate).toBeUndefined();
    s.input.selectMember('data');
    const text = s.world.save();
    s.input.selectMember('picard');
    await s.load(text);
    expect(s.world.state.currentActor).toBe('data');
    expect(s.problems).toEqual([]);
    // (the load ran the content the save was made in; the changed content waits for its next edit)
    await s.restart();
    expect(s.world.state.objects.crate).toBeUndefined();
  });

  it('only follows the rule trace once the dev tools ask for it', async () => {
    const attach = vi.spyOn(RuleTrace.prototype, 'attach');
    try {
      const { s } = await start();
      await s.restart();
      expect(attach).not.toHaveBeenCalled();
      const dev = s.devPort();
      expect(attach).toHaveBeenCalledOnce();
      expect(attach).toHaveBeenLastCalledWith(s.world);
      s.devPort();
      expect(attach).toHaveBeenCalledOnce();
      await s.restart();
      expect(attach).toHaveBeenCalledTimes(2);
      expect(attach).toHaveBeenLastCalledWith(s.world);
      s.world.bus.emit({ type: 'warning', message: 'traced' });
      expect(dev.trace.entries.at(-1)?.text).toBe('warning: traced');
    } finally {
      attach.mockRestore();
    }
  });

  it('enables the controls again when an action ends without an event', async () => {
    const { s } = await start();
    const root = document.body.appendChild(document.createElement('div'));
    act(() => render(h(GameUi, { ui: s.uiPort() }), root));
    const data = () => [...root.querySelectorAll('button')].find(b => b.textContent === 'Data')!;
    expect(data().disabled).toBe(false);
    void s.world.enqueue(() => s.world.clock.wait(3));
    act(() => s.frame(0.1));
    expect(data().disabled).toBe(true);
    await act(() => run(s, 0.5));
    expect(s.input.canAct).toBe(true);
    expect(data().disabled).toBe(false);
    act(() => render(null, root));
    root.remove();
  });

  it('saves from the admin console only once the last presentation wait is over (the console stops that clock while it is up)', async () => {
    const { s } = await start();
    const root = document.body.appendChild(document.createElement('div'));
    void s.clock.after(0.1);
    act(() => render(h(GameUi, { ui: s.uiPort() }), root));
    const save = () => root.querySelector<HTMLButtonElement>('button[aria-label="SAVE"]')!;
    const page = () => root.querySelector<HTMLElement>('.au-admin-console')!.dataset.page;
    act(() => s.store.set({ panel: 'admin' }));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    // (the wait doesn't run out behind the console)
    act(() => s.frame(0.2));
    act(() => save().click());
    expect(page()).toBe('paused');
    act(() => s.store.set({ panel: 'none' }));
    act(() => s.frame(0.2));
    act(() => s.store.set({ panel: 'admin' }));
    act(() => save().click());
    expect(page()).toBe('save');
    act(() => render(null, root));
    root.remove();
  });

  describe('bound to the page', () => {
    async function bound(parts: { audio?: Mixer } = {}) {
      const saves = await SaveSlots.open('mini', new IDBFactory());
      const s = await Session.start(pkg(), { saves, log: () => {}, ...parts });
      const canvas = document.body.appendChild(document.createElement('div'));
      const root = document.body.appendChild(document.createElement('div'));
      act(() => render(h(GameUi, { ui: s.uiPort() }), root));
      const unbind = s.bind(canvas);
      const done = () => {
        unbind();
        act(() => render(null, root));
        root.remove();
        canvas.remove();
      };
      return { s, root, done };
    }

    it('lets one Escape answer a dialog and do nothing else', async () => {
      const { s, done } = await bound();
      s.store.set({ mode: 'use', held: 'communicator', panel: 'transcript' });
      let closed = false;
      act(() => { void s.store.ask<void>({ kind: 'tricorder', reading: 1, pages: [], index: 0 }).then(() => { closed = true; }); });
      act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
      await Promise.resolve();
      expect(closed).toBe(true);
      expect(s.store.state.held).toBe('communicator');
      expect(s.store.state.panel).toBe('transcript');
      done();
    });

    it("presses, drags and lets go in the room: an object dropped on the inventory is got, as the original's is", async () => {
      const { s, root, done } = await bound();
      const canvas = document.body.children[0] as HTMLElement;
      canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 480, right: 640, bottom: 480, x: 0, y: 0, toJSON: () => ({}) });
      const pick = vi.spyOn(s.stage, 'pick').mockReturnValue({ kind: 'object', id: 'panel' });
      const act = vi.spyOn(s.world, 'act');
      const inventory = root.querySelector('[data-drop="inventory"]')!;
      expect(inventory).not.toBeNull();
      let under: Element | null = inventory;
      const at = vi.spyOn(document, 'elementFromPoint').mockImplementation(() => under);
      s.store.set({ mode: 'use' });

      canvas.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 100, clientY: 100, bubbles: true }));
      expect(act).not.toHaveBeenCalled();
      // (a drag starts 16 of the original's pixels from the press: kDragDistance)
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 110, clientY: 100 }));
      expect(s.store.state.dragging).toBeNull();
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 116, clientY: 100 }));
      expect(s.store.state.dragging).toBe('panel');
      window.dispatchEvent(new PointerEvent('pointerup', { button: 0, clientX: 300, clientY: 470 }));
      expect(act).toHaveBeenCalledWith('get', { target: 'panel' });
      expect(s.store.state.dragging).toBeNull();
      await run(s, 1);

      // (let go on the room: the stage says what is there)
      under = canvas;
      canvas.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 100, clientY: 100, bubbles: true }));
      window.dispatchEvent(new PointerEvent('pointerup', { button: 0, clientX: 100, clientY: 100 }));
      expect(act).toHaveBeenLastCalledWith('use', { target: 'panel' });
      // (two presses, and the release on the room)
      expect(pick).toHaveBeenCalledTimes(3);
      at.mockRestore();
      done();
    });

    it('takes no click in the room while the frame left is held on show, and acts on one after the swap (B5)', async () => {
      const { s, done } = await bound();
      const canvas = document.body.children[0] as HTMLElement;
      canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 480, right: 640, bottom: 480, x: 0, y: 0, toJSON: () => ({}) });
      const pick = vi.spyOn(s.stage, 'pick').mockReturnValue({ kind: 'object', id: 'panel' });
      const press = vi.spyOn(s.input, 'press');
      const act = vi.spyOn(s.world, 'act');
      const at = vi.spyOn(document, 'elementFromPoint').mockImplementation(() => canvas);
      const holding = vi.spyOn(s.stage, 'inputHeld', 'get').mockReturnValue(true);
      s.store.set({ mode: 'use' });
      canvas.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 100, clientY: 100, bubbles: true }));
      window.dispatchEvent(new PointerEvent('pointerup', { button: 0, clientX: 100, clientY: 100 }));
      // (dropped, not queued: not even the click's own cancel of the member's queued actions)
      expect([pick.mock.calls.length, press.mock.calls.length, act.mock.calls.length]).toEqual([0, 0, 0]);
      holding.mockReturnValue(false);
      canvas.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 100, clientY: 100, bubbles: true }));
      window.dispatchEvent(new PointerEvent('pointerup', { button: 0, clientX: 100, clientY: 100 }));
      expect(act).toHaveBeenLastCalledWith('use', { target: 'panel' });
      at.mockRestore();
      done();
    });

    it('a load whose room model never resolves: at the cap, a click reaches input.press, and an inventory drag still drops', async () => {
      const { s, done } = await bound();
      const canvas = document.body.children[0] as HTMLElement;
      canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 480, right: 640, bottom: 480, x: 0, y: 0, toJSON: () => ({}) });
      const shelf = document.body.appendChild(document.createElement('div'));
      shelf.dataset.drop = 'inventory';
      let under: Element = canvas;
      const at = vi.spyOn(document, 'elementFromPoint').mockImplementation(() => under);
      const loads = vi.spyOn(s.stage as unknown as { loadRoom: () => Promise<never> }, 'loadRoom').mockReturnValue(new Promise<never>(() => {}));
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        // (never settles: the new game's room is never in)
        void s.restart();
        expect(loads).toHaveBeenCalled();
        vi.spyOn(s.stage, 'pick').mockReturnValue({ kind: 'object', id: 'panel' });
        const press = vi.spyOn(s.input, 'press');
        const release = vi.spyOn(s.input, 'release');
        const drag = (to: Element) => {
          canvas.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 100, clientY: 100, bubbles: true }));
          under = to;
          window.dispatchEvent(new PointerEvent('pointerup', { button: 0, clientX: 300, clientY: 300 }));
          under = canvas;
        };
        drag(canvas);
        expect(press).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1500);
        // (the picture left stays, as the room isn't in; the press goes through)
        expect([s.stage.holding, s.stage.inputHeld]).toEqual([true, false]);
        drag(canvas);
        expect(press).toHaveBeenCalledOnce();
        drag(shelf);
        expect(press).toHaveBeenCalledTimes(2);
        expect(release).toHaveBeenLastCalledWith('inventory');
      } finally {
        vi.useRealTimers();
        at.mockRestore();
        shelf.remove();
        done();
      }
    });

    it('a swap whose build throws ends the hold and input works again', async () => {
      const { s, done } = await bound();
      const canvas = document.body.children[0] as HTMLElement;
      canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 480, right: 640, bottom: 480, x: 0, y: 0, toJSON: () => ({}) });
      vi.spyOn(s.stage, 'pick').mockReturnValue({ kind: 'object', id: 'panel' });
      const press = vi.spyOn(s.input, 'press');
      const at = vi.spyOn(document, 'elementFromPoint').mockImplementation(() => canvas);
      const click = () => {
        canvas.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 100, clientY: 100, bubbles: true }));
        window.dispatchEvent(new PointerEvent('pointerup', { button: 0, clientX: 100, clientY: 100 }));
      };
      vi.spyOn(s, 'newWorld').mockImplementation(() => {
        throw new Error('boom');
      });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        await expect(s.restart()).rejects.toThrow(`${SWAP_FAILED} (boom)`);
        // (the frame on show is held for the game that never came)
        expect(s.stage.holding).toBe(true);
        click();
        expect(press).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1499);
        expect(s.stage.holding).toBe(true);
        // (no longer than the hold's cap: then the held frame goes, and clicks reach the game again)
        vi.advanceTimersByTime(1);
        expect(s.stage.holding).toBe(false);
        click();
        expect(press).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
        at.mockRestore();
        done();
      }
    });

    it('drops a press that is cancelled, or whose window loses focus, so a later release elsewhere does nothing', async () => {
      const { s, root, done } = await bound();
      const canvas = document.body.children[0] as HTMLElement;
      canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 480, right: 640, bottom: 480, x: 0, y: 0, toJSON: () => ({}) });
      vi.spyOn(s.stage, 'pick').mockReturnValue({ kind: 'object', id: 'panel' });
      const act = vi.spyOn(s.world, 'act');
      const inventory = root.querySelector('[data-drop="inventory"]')!;
      const at = vi.spyOn(document, 'elementFromPoint').mockImplementation(() => inventory);
      s.store.set({ mode: 'use' });
      for (const [target, event] of [[window, 'blur'], [window, 'pointercancel']] as const) {
        canvas.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 100, clientY: 100, bubbles: true }));
        target.dispatchEvent(new Event(event));
        // (an unrelated release, as on a HUD button, is not the end of that press)
        window.dispatchEvent(new PointerEvent('pointerup', { button: 0, clientX: 300, clientY: 470 }));
        expect(act).not.toHaveBeenCalled();
      }
      at.mockRestore();
      done();
    });

    it('starts the sound on a key as well as a click', async () => {
      const resume = vi.fn(async () => {});
      const audio = { ...LEVELS, resume, setLoop: async () => {}, keep: () => {}, release: () => {}, preload: async () => {}, play: async () => undefined } as unknown as Mixer;
      const { done } = await bound({ audio });
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x' }));
      expect(resume).toHaveBeenCalledOnce();
      window.dispatchEvent(new PointerEvent('pointerdown'));
      expect(resume).toHaveBeenCalledTimes(2);
      done();
    });
  });

  /** The parts of Mixer the session uses, recording what plays; end(bus) finishes what plays there. */
  class FakeMixer {
    readonly played: [string, string][] = [];
    readonly loops: unknown[][] = [];
    private readonly enders = new Map<string, (() => void)[]>();
    private readonly counts = new Map<string, number>();
    async play(url: string | undefined, bus: string, loop = false): Promise<Playing | null> {
      if (url === undefined) return null;
      this.played.push([bus, url]);
      const ended = new Promise<void>(resolve => this.enders.set(bus, [...(this.enders.get(bus) ?? []), resolve]));
      if (!loop) {
        this.counts.set(bus, this.playing(bus) + 1);
        void ended.then(() => this.counts.set(bus, this.playing(bus) - 1));
      }
      return { ended, duration: 1, stop: () => {} };
    }
    playing(bus: string): number {
      return this.counts.get(bus) ?? 0;
    }
    end(bus: string): void {
      for (const resolve of this.enders.get(bus) ?? []) resolve();
      this.enders.set(bus, []);
    }
    async setLoop(bus: string, url: string | undefined, shape?: LoopShape): Promise<void> {
      this.loops.push(shape ? [bus, url, shape] : [bus, url]);
    }
    async preload(): Promise<void> {}
    keep(): void {}
    release(): void {}
    async resume(): Promise<void> {}
    setMaster(): void {}
    setLevel(): void {}
    pauseLoops(): void {}
  }

  /** The mini game with sounds: a loop, a beam-down piece, the tricorder's chirp, and a scanner it works on. */
  function soundPkg(): GamePackage {
    const base = pkg({
      'game.yaml': 'id: mini\nstart: { screen: room, entrance: door, awayTeam: [picard, data], leader: picard }\nrules:\n  items: { communicator: communicator, tricorder: tricorder }\n',
      'objects/tricorder.yaml': 'id: tricorder\nname: Tricorder\nscreen: null\ninventory: true\n',
      'objects/scanner.yaml': 'id: scanner\nname: Scanner\nscreen: room\nat: panel\non:\n  use:\n    - when: { other: tricorder }\n      do: []\n',
    });
    return {
      ...base,
      assets: new AssetIndex([
        ['audio/music/hum.ogg', 'u:hum'], ['audio/music/h3int01.ogg', 'u:intro'], ['audio/sfx/chirp7.wav', 'u:chirp'],
        ['audio/sfx/badge2.wav', 'u:badge'], ['audio/sfx/zap.wav', 'u:zap'], ['audio/sfx/shimmer.wav', 'u:shimmer'],
      ]),
      presentation: {
        music: { mini: 'hum' }, ambience: {}, intro: { mini: ['h3int01'] }, arrival: {},
        sounds: { combadge: 'badge2', tricorderChirp: 'chirp7', phaserCrew: 'zap', beamOut: 'shimmer' },
        art: { rooms: {}, cards: {}, ship: {} },
      },
    };
  }

  it('starts the screen\'s loops without a beam-down piece where the mission has no beam effect', async () => {
    const audio = new FakeMixer();
    const s = await Session.start(soundPkg(), { audio: audio as unknown as Mixer, holdMusic: true });
    await s.playIntro(false);
    expect(audio.played).toEqual([]);
    expect(audio.loops).toContainEqual(['music', 'u:hum']);
  });

  it("plays the presentation's sounds for a phaser shot and a beam, and nothing for one it doesn't name", async () => {
    const audio = new FakeMixer();
    const s = await Session.start(soundPkg(), { audio: audio as unknown as Mixer });
    audio.played.length = 0;
    void s.presenter.show({ kind: 'phaserShot', from: 'picard', to: 'panel' });
    void s.presenter.show({ kind: 'beam', objects: ['data'], out: true, chodak: false });
    void s.presenter.show({ kind: 'beam', objects: ['data'], out: false, chodak: false });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(audio.played).toEqual([['sfx', 'u:zap'], ['sfx', 'u:shimmer']]);
  });

  it('plays the world\'s beam-down piece once, then the screen\'s loops (playIntroMusic, updateMusic)', async () => {
    const audio = new FakeMixer();
    const s = await Session.start(soundPkg(), { audio: audio as unknown as Mixer });
    audio.loops.length = 0;
    const intro = s.playIntro();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(audio.loops).toEqual([['music', undefined]]);
    expect(audio.played).toEqual([['music', 'u:intro']]);
    audio.end('music');
    await intro;
    expect(audio.loops).toContainEqual(['music', 'u:hum']);
  });

  it('starts the screen\'s loop with its loop point and gain', async () => {
    const audio = new FakeMixer();
    const base = soundPkg();
    await Session.start({ ...base, presentation: { ...base.presentation, loops: { hum: { gain: 0.5, loopStart: 2 } } } }, { audio: audio as unknown as Mixer });
    expect(audio.loops).toContainEqual(['music', 'u:hum', { gain: 0.5, loopStart: 2 }]);
  });

  it('starts no screen\'s music loop while the beam-down piece plays (updateMusic waits for it)', async () => {
    const audio = new FakeMixer();
    const s = await Session.start(soundPkg(), { audio: audio as unknown as Mixer });
    const intro = s.playIntro();
    await new Promise(resolve => setTimeout(resolve, 0));
    audio.loops.length = 0;
    s.world.jump('hall', 'entry');
    await run(s, 0.2);
    expect(audio.loops.filter(([bus]) => bus === 'music')).toEqual([]);
    audio.end('music');
    await intro;
    expect(audio.loops).toContainEqual(['music', 'u:hum']);
  });

  it('holds the screen\'s music on the bridge until the team beams down', async () => {
    const audio = new FakeMixer();
    const s = await Session.start(soundPkg(), { audio: audio as unknown as Mixer, holdMusic: true });
    expect(audio.loops.filter(([bus]) => bus === 'music')).toEqual([]);
    s.world.jump('hall', 'entry');
    await run(s, 0.2);
    expect(audio.loops.filter(([bus]) => bus === 'music')).toEqual([]);
    const intro = s.playIntro();
    await new Promise(resolve => setTimeout(resolve, 0));
    audio.end('music');
    await intro;
    expect(audio.loops).toContainEqual(['music', 'u:hum']);
  });

  it('plays the beam-down piece once however often playIntro is called while it plays', async () => {
    const audio = new FakeMixer();
    const s = await Session.start(soundPkg(), { audio: audio as unknown as Mixer, holdMusic: true });
    const first = s.playIntro();
    expect(s.playIntro()).toBe(first);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(audio.played).toEqual([['music', 'u:intro']]);
    audio.end('music');
    await first;
    expect(audio.played).toEqual([['music', 'u:intro']]);
  });

  it('holds the music and the ambience again for the bridge, so the next beam-down plays its piece again', async () => {
    const audio = new FakeMixer();
    const ambient = { ...soundPkg(), presentation: { ...soundPkg().presentation, ambience: { mini: 'hum' } } };
    const s = await Session.start(ambient, { audio: audio as unknown as Mixer, holdMusic: true });
    expect(audio.loops).toEqual([]);
    const intro = s.playIntro();
    await new Promise(resolve => setTimeout(resolve, 0));
    audio.end('music');
    await intro;
    expect(audio.loops).toContainEqual(['ambience', 'u:hum']);
    expect(audio.loops).toContainEqual(['music', 'u:hum']);

    audio.loops.length = 0;
    s.holdMusic();
    expect(audio.loops).toEqual([['music', undefined], ['ambience', undefined]]);
    await s.restart();
    s.world.jump('hall', 'entry');
    await run(s, 0.2);
    expect(audio.loops.filter(([, url]) => url !== undefined)).toEqual([]);
    audio.played.length = 0;
    const again = s.playIntro();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(audio.played).toEqual([['music', 'u:intro']]);
    audio.end('music');
    await again;
    expect(audio.loops).toContainEqual(['ambience', 'u:hum']);
    expect(audio.loops).toContainEqual(['music', 'u:hum']);
  });

  it('keeps the hold when a beam-down piece from before it ends', async () => {
    const audio = new FakeMixer();
    const s = await Session.start(soundPkg(), { audio: audio as unknown as Mixer, holdMusic: true });
    const intro = s.playIntro();
    await new Promise(resolve => setTimeout(resolve, 0));
    s.holdMusic();
    audio.loops.length = 0;
    audio.end('music');
    await intro;
    expect(audio.loops.filter(([, url]) => url !== undefined)).toEqual([]);
  });

  it('starts the screen\'s music at once when the world has no beam-down piece', async () => {
    const audio = new FakeMixer();
    const s = await Session.start({ ...soundPkg(), presentation: { music: { mini: 'hum' }, ambience: {}, intro: {}, arrival: {}, sounds: {}, art: { rooms: {}, cards: {}, ship: {} } } }, { audio: audio as unknown as Mixer, holdMusic: true });
    await s.playIntro();
    expect(audio.loops.filter(([bus]) => bus === 'music')).toEqual([['music', 'u:hum']]);
  });

  it('chirps when a condition passes with the tricorder, unless any sound effect is playing (object.cpp:1277-1279)', async () => {
    const audio = new FakeMixer();
    const s = await Session.start(soundPkg(), { audio: audio as unknown as Mixer });
    const chirps = () => audio.played.filter(([, url]) => url === 'u:chirp').length;
    const use = async () => {
      void s.world.act('use', { target: 'scanner', who: 'picard', other: 'tricorder' });
      await run(s, 0.5);
    };
    await use();
    expect(chirps()).toBe(1);
    // (the first chirp still sounds: an effect is playing, so no second one)
    await use();
    expect(chirps()).toBe(1);
    audio.end('sfx');
    await run(s, 0.1);
    await use();
    expect(chirps()).toBe(2);
    // (any effect blocks it, not only a chirp)
    audio.end('sfx');
    await audio.play('u:other', 'sfx');
    await use();
    expect(chirps()).toBe(2);
  });

  it('plays the engine\'s own sounds by presentation.yaml\'s names, and none it doesn\'t name', async () => {
    const audio = new FakeMixer();
    const s = await Session.start(soundPkg(), { audio: audio as unknown as Mixer });
    s.world.state.awayFlags.combadge = true;
    const asked = s.input.combadge();
    s.store.answer(1);
    await asked;
    expect(audio.played).toContainEqual(['sfx', 'u:badge']);

    const silent = new FakeMixer();
    const t = await Session.start({ ...soundPkg(), presentation: { ...soundPkg().presentation, sounds: {} } }, { audio: silent as unknown as Mixer });
    t.world.state.awayFlags.combadge = true;
    const again = t.input.combadge();
    t.store.answer(1);
    await again;
    void t.world.act('use', { target: 'scanner', who: 'picard', other: 'tricorder' });
    await run(t, 0.5);
    expect(silent.played.filter(([bus]) => bus === 'sfx')).toEqual([]);
  });
});

describe('a new game on the ship', () => {
  const SHIP: Record<string, string> = {
    'objects/ship/ent.yaml': 'id: w.ent\nname: Ent\nscreen: null\nuniverse: { x: 90, y: 90, z: 90 }\n',
    'triggers.yaml': '- { id: t1, type: normal, context: ship, target: w.ent, enabled: true }\n',
    'universe.yaml': 'sectors: []\nstars: []\nphenomena: []\nstations: []\nspecials: []\nflags: []\nregionChatter: []\nwarpSpeeds: [1]\nimpulseSpeeds: [1]\nscriptedWarps: []\nplanetOrbits: []\nreveals: []\n',
    'ship.yaml': `bridge: { items: [], objects: [], turbolift: [] }
transporter: { exits: [], teams: [{ world: 1, members: [picard], items: [] }], targets: [], pads: [] }
crew: { leaderOrder: [picard], voices: [] }
speeds: { warp: [1], impulse: [1] }
units: []
astro:
  enterprise: w.ent
  starbaseBattle: 80
  defaultBattle: 8
  triggers: { arriveStarbase: t1, arriveStar: t1, firstVisit: t1, runAway: t1, secondVisitCheck: t1, secondVisit: t1 }
equipment: []
contacts: { comms: [], lounge: [] }
`,
    'computer.yaml': 'entries: []\nentryIds: []\nreadingParents: {}\nhidden: []\nstartReadings: []\nreadings: []\n',
  };

  const withMovies = (): GamePackage => ({
    ...pkg(SHIP),
    assets: new AssetIndex([['movies/a.webm', '/a.webm'], ['movies/b.webm', '/b.webm']]),
    presentation: { music: {}, ambience: {}, intro: {}, arrival: {}, sounds: {}, art: { rooms: {}, cards: {}, ship: {} }, opening: ['a', 'b', 'gone'] },
  });
  const shown = async (s: Session) => {
    await new Promise(resolve => setTimeout(resolve, 0));
    const d = s.store.state.dialog;
    return d?.kind === 'movie' ? d.title : null;
  };

  it('a new game plays the opening movies, then the bridge; a load plays none', async () => {
    const saves = await SaveSlots.open('mini', new IDBFactory());
    const s = await Session.start(withMovies(), { saves });
    // (in order, each skippable; a stem with no film is left out; the world waits behind the dialog)
    expect(await shown(s)).toBe('a');
    s.store.answer(undefined);
    expect(await shown(s)).toBe('b');
    s.store.answer(undefined);
    expect(await shown(s)).toBeNull();
    expect(s.store.state.dialog).toBeNull();
    expect(s.world.state.ship.station).toBe('bridge');
    await s.saveTo(1, 0);
    const loaded = await Session.start(withMovies(), { saves }, s.world.save());
    expect(await shown(loaded)).toBeNull();
    // (a restart is no new run of the program: no movies)
    await s.restart();
    expect(await shown(s)).toBeNull();
    // (a dev start somewhere else begins over at once)
    const dev = await Session.start(withMovies(), { saves, opening: false });
    expect(await shown(dev)).toBeNull();
  });

  it('nothing advances while a movie plays: the sim and the presentation clock stand still, and no line is said, until it is skipped', async () => {
    const saves = await SaveSlots.open('mini', new IDBFactory());
    const s = await Session.start(withMovies(), { saves });
    expect(await shown(s)).toBe('a');
    const ticks = vi.spyOn(s.world, 'tick');
    let spoken = false;
    void s.clock.after(0.5).then(() => { spoken = true; });
    for (let i = 0; i < 120; i++) {
      s.tick();
      s.frame(1 / 60);
    }
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(ticks).not.toHaveBeenCalled();
    expect(spoken).toBe(false);
    expect(s.store.state.subtitle).toBeNull();
    // (a skip goes on to the next movie, and the last one's end hands the game over to the loop, with no line spoken by the skip)
    s.store.answer(undefined);
    expect(await shown(s)).toBe('b');
    s.tick();
    s.frame(1);
    expect(ticks).not.toHaveBeenCalled();
    s.store.answer(undefined);
    expect(await shown(s)).toBeNull();
    expect(s.store.state.subtitle).toBeNull();
    s.tick();
    s.frame(1);
    expect(ticks).toHaveBeenCalledTimes(1);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(spoken).toBe(true);
  });

  it('with the opening deferred, no movie is up until beginOpening, and then only once', async () => {
    const s = await Session.start(withMovies(), { deferOpening: true });
    expect(await shown(s)).toBeNull();
    s.beginOpening();
    expect(await shown(s)).toBe('a');
    s.store.answer(undefined);
    expect(await shown(s)).toBe('b');
    s.store.answer(undefined);
    s.beginOpening();
    expect(await shown(s)).toBeNull();
  });

  // (the opening's bootup trigger plays the Enterprise's animation 774, the warbird's view: t03, object.cpp:1392-1423)
  const BOOT: Record<string, string> = {
    ...SHIP,
    'objects/ship/boot.yaml': 'id: w.boot\nname: Boot\nscreen: null\nactive: false\non:\n  use:\n    - do:\n        - alter: { object: w.ent, anim: { play: 774 } }\n        - trigger: { id: t3, enabled: false }\n',
    // (first: a ship trigger that fires stops the check, and t1 always would)
    'triggers.yaml': '- { id: t3, type: normal, context: ship, target: w.boot, enabled: true }\n' + SHIP['triggers.yaml'],
    'ship.yaml': SHIP['ship.yaml'] + 'viewscreenSprites: { 774: vwsttrac }\n',
  };

  it("a new game's viewscreen is sprite vwsttrac", async () => {
    const { s } = await start(BOOT);
    await run(s, 0.5);
    expect(s.world.state.objects['w.ent']!.anim).toBe(774);
    expect(s.shipPort().viewscreenImage()).toEqual({ kind: 'sprite', sprite: 'vwsttrac' });
  });

  it('a loaded save mid-transit shows space, and keeps the Enterprise\'s view for after', async () => {
    const { s } = await start(BOOT);
    await run(s, 0.5);
    s.world.state.ship.transit = {
      from: { x: 90, y: 90, z: 90 }, to: { x: 91, y: 90, z: 90 }, orbit: 0, destination: { ...s.world.state.ship.location }, destType: 0, destStarId: -1,
      warp: false, speed: 1, startTick: s.world.clock.now, ticks: 100000,
    };
    const loaded = (await start(BOOT)).s;
    await loaded.load(s.world.save());
    expect(loaded.world.state.ship.transit).not.toBeNull();
    expect(loaded.world.state.objects['w.ent']!.anim).toBe(774);
    expect(loaded.shipPort().viewscreenImage()).toEqual({ kind: 'space' });
  });

  it('New game after Continue starts over with the opening again', async () => {
    const saves = await SaveSlots.open('mini', new IDBFactory());
    const first = await Session.start(withMovies(), { saves, opening: false });
    await first.autosave();
    const resumed = await Session.start(withMovies(), { saves, deferOpening: true }, await saves.get(AUTOSAVE_SLOT));
    resumed.beginOpening();
    expect(resumed.store.state.dialog).toBeNull();
    await resumed.newGame();
    resumed.beginOpening();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(resumed.store.state.dialog).toMatchObject({ kind: 'movie', title: 'a' });
  });

  it('a slot loaded before the opening begins goes without the opening', async () => {
    const saves = await SaveSlots.open('mini', new IDBFactory());
    const first = await Session.start(withMovies(), { saves, opening: false });
    await first.saveTo(1);
    const s = await Session.start(withMovies(), { saves, deferOpening: true });
    await s.loadSlot(1);
    s.beginOpening();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(s.store.state.dialog).toBeNull();
  });

  it('the opening holds the bridge\'s music until the movies are over', async () => {
    const loops: [string, string | undefined][] = [];
    const audio = {
      ...LEVELS,
      loops,
      setLoop: async (bus: string, url: string | undefined) => void loops.push([bus, url]),
      keep: () => {}, release: () => {}, preload: async () => {},      resume: async () => {},
      play: async () => null,
      playing: () => 0,
    };
    const base = withMovies();
    const pkg2 = { ...base, assets: new AssetIndex([['movies/a.webm', '/a.webm'], ['movies/b.webm', '/b.webm'], ['audio/music/hum.ogg', '/hum.ogg']]), presentation: { ...base.presentation, music: { mini: 'hum' } } };
    const s = await Session.start(pkg2, { audio: audio as unknown as Mixer });
    expect(await shown(s)).toBe('a');
    audio.loops.length = 0;
    s.store.answer(undefined);
    await shown(s);
    expect(audio.loops.filter(([, url]) => url !== undefined)).toEqual([]);
    s.store.answer(undefined);
    await shown(s);
    expect(audio.loops.filter(([bus, url]) => bus === 'music' && url !== undefined)).toHaveLength(1);
  });

  it('a load or restart during the opening ends it: not refused, and no later movie plays', async () => {
    const saves = await SaveSlots.open('mini', new IDBFactory());
    const s = await Session.start(withMovies(), { saves });
    expect(await shown(s)).toBe('a');
    await s.load(s.world.save());
    expect(await shown(s)).toBeNull();
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(s.store.state.dialog).toBeNull();
    const r = await Session.start(withMovies(), { saves });
    expect(await shown(r)).toBe('a');
    await r.restart();
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(r.store.state.dialog).toBeNull();
  });

  it("a v3 save's queued ship effects are applied once the session listens, so their warnings are logged", async () => {
    const logs: string[] = [];
    const s = await Session.start(pkg(SHIP), { log: (level, m) => logs.push(`${level}: ${m}`) });
    const v4 = JSON.parse(s.world.save()) as Record<string, unknown> & { ship: Record<string, unknown> };
    for (const k of ['computer', 'adviceMode', 'conversationLog', 'beamWorld']) delete v4[k];
    for (const k of ['bridgeUse', 'warpPending', 'scriptedWarp', 'warpSpeed', 'universeMoves', 'awaySince', 'newWarpMovie', 'warpMoviesSeen', 'combat']) delete v4.ship[k];
    const v3 = JSON.stringify({ ...v4, version: 3, shipQueue: [{ computer: 'show', entry: 4242 }] });
    await s.load(v3);
    expect(logs.filter(l => l === 'warn: unknown computer entry 4242')).toHaveLength(1);
    expect(s.world.queuedShipFx).toEqual([]);
  });

  it('a restart keeps the difficulty and the dev ship start (M11)', async () => {
    const files = { ...SHIP, 'triggers.yaml': SHIP['triggers.yaml'] + '- { id: t2, type: normal, context: ship, target: w.ent, enabled: false }\n' };
    const s = await Session.start({ ...pkg(files), presentation: pkg().presentation }, { difficulty: 2, devShip: ['t2'] });
    expect(s.world.difficulty).toBe(2);
    expect(s.world.state.triggers.t2.enabled).toBe(true);
    await s.restart();
    expect(s.world.difficulty).toBe(2);
    expect(s.world.state.triggers.t2.enabled).toBe(true);
  });

  it('the difficulty is a setting: stored, changed only with no team away, and applied to the running world', async () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
    const slots = await SaveSlots.open('mini', new IDBFactory());
    const s = await Session.start(pkg(SHIP), { saves: slots });
    expect(s.difficulty).toBe(1);
    const settings = s.uiPort().settings!;
    expect(settings.canChangeDifficulty()).toBe(true);
    settings.set({ difficulty: 0 });
    expect(s.world.difficulty).toBe(0);
    // (the next page starts with it)
    const again = await Session.start(pkg(SHIP), {});
    expect(again.difficulty).toBe(0);
    await s.load(s.world.save());
    expect(s.world.difficulty).toBe(0);
    s.world.state.onShip = null;
    expect(settings.canChangeDifficulty()).toBe(false);
    expect(() => settings.set({ difficulty: 2 })).toThrow('while no team is away');
    expect(s.world.difficulty).toBe(0);
    vi.unstubAllGlobals();
  });

  it('keeps the combat assists with the settings, and gives each world them and how tactical fights (spec §5; Plan 23 R2)', async () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
    const s = await Session.start(pkg(SHIP), { realCombat: true });
    expect([s.assists, s.world.assists, s.world.combatMode]).toEqual([{ difficulty: 'game', speed: 1 }, { difficulty: 'game', speed: 1 }, 'real']);
    s.setAssists({ difficulty: 'story', speed: 4 });
    expect(s.world.assists).toEqual({ difficulty: 'story', speed: 4 });
    expect((JSON.parse(store.get(SETTINGS_KEY)!) as Settings).assists).toEqual({ difficulty: 'story', speed: 4 });
    // (the next page starts with them; a player's game fights the dialog until M8)
    const again = await Session.start(pkg(SHIP), {});
    expect([again.world.assists, again.world.combatMode]).toEqual([{ difficulty: 'story', speed: 4 }, 'dialog']);
    // (with no battle at tactical, the battle view has nothing)
    expect(s.battlePort().battle()).toBeNull();
    vi.unstubAllGlobals();
  });

  it('carries the last difficulty and the last battle across a load and a restart, as ScummVM\'s TacticalScreen outlives them (Plan 23 R8)', async () => {
    const { s } = await start(SHIP);
    const memory = { lastDifficulty: 0, previous: null };
    s.world.combatMemory = memory;
    await s.load(s.world.save());
    expect(s.world.combatMemory).toBe(memory);
    await s.restart();
    expect(s.world.combatMemory).toBe(memory);
  });

  /** SHIP with miniCombat's battle 3 as its default battle 8, the Enterprise and a made-up enemy, fought in the combat sim. */
  const battleShip = async (o: { lazy?: () => unknown; parts?: Partial<SessionParts>; assets?: AssetIndex } = {}) => {
    const combat = miniCombat({ screen: 'room', enterprise: 'w.ent', enemy: 'w.foe' });
    // (no tactics scripts: mini.bin takes its steps slowly)
    for (const ship of combat.battles[3]!.ships) ship.tactics = null;
    combat.battles[8] = combat.battles[3]!;
    const files: Record<string, string> = {
      ...SHIP, 'objects/ship/foe.yaml': 'id: w.foe\nname: Foe\nscreen: null\n', 'combat.yaml': stringify(combat),
      'ship.yaml': SHIP['ship.yaml']!.replace('units: []', `units: ${JSON.stringify(miniEnterpriseUnits())}`),
    };
    // (`lazy`: combat.yaml left out of the files and read from the package, as the web app's is: M8 spec §8; `lazy` counts the reads)
    const text = files['combat.yaml']!;
    if (o.lazy) delete files['combat.yaml'];
    const p = { ...pkg(files), ...(o.assets ? { assets: o.assets } : {}), ...(o.lazy ? { combat: async () => { await o.lazy!(); return text; } } : {}) };
    const s = await Session.start(p, { realCombat: true, opening: false, ...o.parts });
    const fight = async () => {
      s.world.state.ship.battleScenario = 8;
      await s.world.enqueue(() => gotoShipScreen(s.world, STATION_CODE.tactical));
      await run(s, 0.3);
      return s.world.battle!;
    };
    return { s, fight };
  };

  it('ends a battle a load interrupts between frames, as endCombat(false) does, its console kept for the next (save.cpp:195-197, combat.cpp:140-155; Plan 23 R4, R8)', async () => {
    const { s, fight } = await battleShip();
    const save = s.world.save();
    const old = await fight();
    expect(old.b.steps).toBeGreaterThan(0);
    expect(s.world.state.ship.combat?.redAlert).toBe(true);
    const memory = s.world.combatMemory;
    const lastDifficulty = memory.lastDifficulty;
    // (between frames the world is idle: the load goes ahead)
    await s.load(save);
    expect([s.world.battle, s.world.state.ship.combat]).toEqual([null, null]);
    expect(s.world.combatMemory).toBe(memory);
    expect([memory.previous, memory.lastDifficulty, old.b.console.redAlert]).toEqual([old.b, lastDifficulty, false]);
  });

  it('plays a real battle\'s cues and effects through the mixer as its frames hand them on, and stops the crew\'s as it ends (Plan 28)', async () => {
    // (a mixer that records what starts and what loads; nothing it plays ends by itself)
    const played: [string, string][] = [];
    const preloaded: string[][] = [];
    const audio = {
      ...LEVELS,
      play: async (url: string | undefined, bus: string): Promise<Playing | null> => {
        if (url === undefined) return null;
        played.push([bus, url]);
        return { ended: new Promise<void>(() => {}), duration: 1, stop: () => {} };
      },
      setLoop: async () => {}, keep: () => {}, release: () => {}, preload: async (urls: string[]) => void preloaded.push(urls), resume: async () => {}, playing: () => 0,
    };
    // (miniCombat's one cue file and its effect sounds, as the game's audio has them)
    const assets = new AssetIndex([['audio/voice/mini.opus', 'u:mini'], ['audio/sfx/beep7.opus', 'u:beep'], ['audio/sfx/__phaser.opus', 'u:phaser']]);
    const { s, fight } = await battleShip({ assets, parts: { audio: audio as unknown as Mixer } });
    const save = s.world.save();
    const run = await fight();
    // (as it started, its effect sounds loaded: miniCombat's media.sounds)
    expect(preloaded).toContainEqual(['u:beep']);
    // (its first steps fired a phaser, which the sim asked for and a frame handed on: on the first effect channel)
    expect([played, s.battleSoundState()!.channels]).toEqual([[['sfx', 'u:phaser']], [false, false, false, true, false, false, false, false]]);
    played.length = 0;
    // (a frame of our own: cue 0, mini.vac, speaker 2's, on the voice bus; a phaser 1300 from the camera on the next effect channel)
    s.world.bus.emit({ type: 'battleAudio', now: run.clock, silenced: false, cues: [{ cue: 0, delay: 0, interrupt: false }], sounds: [{ sound: '__phaser.mac', ship: 0, distance: 1300 }] });
    expect(played).toEqual([['voice', 'u:mini'], ['sfx', 'u:phaser']]);
    expect(s.battleSoundState()).toEqual({ channels: [true, false, false, true, true, false, false, false], silenced: false });
    // (a load ends the battle as endCombat does: the crew's channel stops, the effects ring on, tactical.cpp:361)
    await s.load(save);
    expect(s.battleSoundState()).toEqual({ channels: [false, false, false, true, true, false, false, false], silenced: false });
  });

  it('leaving a battle releases its sounds, as it ends and as a load replaces it (Plan 34)', async () => {
    const released: string[][] = [];
    const audio = {
      ...LEVELS,
      play: async (url: string | undefined): Promise<Playing | null> =>
        url === undefined ? null : { ended: new Promise<void>(() => {}), duration: 1, stop: () => {} },
      setLoop: async () => {}, keep: () => {}, release: (urls: string[]) => void released.push([...urls]),
      preload: async () => {}, resume: async () => {}, playing: () => 0,
    };
    const assets = new AssetIndex([['audio/voice/mini.opus', 'u:mini'], ['audio/sfx/beep7.opus', 'u:beep'], ['audio/sfx/__phaser.opus', 'u:phaser']]);
    const { s, fight } = await battleShip({ assets, parts: { audio: audio as unknown as Mixer } });
    const save = s.world.save();
    const run = await fight();
    s.world.bus.emit({ type: 'battleAudio', now: run.clock, silenced: false, cues: [{ cue: 0, delay: 0, interrupt: false }], sounds: [{ sound: '__phaser.mac', ship: 0, distance: 1300 }] });
    released.length = 0;
    s.world.bus.emit({ type: 'combat', on: false, scenario: run.b.scenario });
    expect(released.length).toBeGreaterThan(0);
    for (const urls of released) expect(urls).toEqual(expect.arrayContaining(['u:beep', 'u:mini', 'u:phaser']));
    released.length = 0;
    await s.load(save);
    expect(released.length).toBeGreaterThan(0);
    expect(released.at(-1)).toEqual(expect.arrayContaining(['u:beep', 'u:mini', 'u:phaser']));
  });

  it('keeps the computer\'s cues quiet while the Enterprise\'s computer has no power, the crew\'s still playing (cues.cpp:65; Plan 28 R10)', async () => {
    const played: [string, string][] = [];
    const audio = {
      ...LEVELS,
      play: async (url: string | undefined, bus: string): Promise<Playing | null> => {
        if (url === undefined) return null;
        played.push([bus, url]);
        return { ended: new Promise<void>(() => {}), duration: 1, stop: () => {} };
      },
      setLoop: async () => {}, keep: () => {}, release: () => {}, preload: async () => {}, resume: async () => {}, playing: () => 0,
    };
    const assets = new AssetIndex([['audio/voice/mini.opus', 'u:mini'], ['audio/voice/comp.opus', 'u:comp']]);
    const { s, fight } = await battleShip({ assets, parts: { audio: audio as unknown as Mixer } });
    const run = await fight();
    // (a made-up cue 2: the computer's, speaker 7, read lazily as it is asked for)
    const cues = s.content.ship!.combat!.cues;
    cues[2] = { speaker: 7, file: 'comp.vac', gap: 0 };
    // (the Enterprise's computers cut to 0%: the battle's systems are the ship's)
    const units = s.content.ship!.data.units;
    const systems = s.world.state.ship.systems;
    units.forEach((u, i) => { if (u.type === UNIT_COMPUTER) systems.units[i]!.current = 0; });
    played.length = 0;
    s.world.bus.emit({ type: 'battleAudio', now: run.clock, silenced: false, cues: [{ cue: 2, delay: 0, interrupt: false }, { cue: 0, delay: 0, interrupt: false }], sounds: [] });
    expect(played).toEqual([['voice', 'u:mini']]);
    // (power back on one computer: the computer speaks)
    const first = units.findIndex(u => u.type === UNIT_COMPUTER);
    systems.units[first]!.current = systems.units[first]!.max;
    s.world.bus.emit({ type: 'battleAudio', now: run.clock, silenced: false, cues: [{ cue: 2, delay: 0, interrupt: false }], sounds: [] });
    expect(played).toEqual([['voice', 'u:mini'], ['voice', 'u:comp']]);
  });

  it('starts the crew afresh when auto-resolve hands a battle back, so no later cue it left waiting plays on the first frame back (Plan 28 final review; §6.3)', async () => {
    const played: [string, string][] = [];
    const audio = {
      ...LEVELS,
      play: async (url: string | undefined, bus: string): Promise<Playing | null> => {
        if (url === undefined) return null;
        played.push([bus, url]);
        return { ended: new Promise<void>(() => {}), duration: 1, stop: () => {} };
      },
      setLoop: async () => {}, keep: () => {}, release: () => {}, preload: async () => {}, resume: async () => {}, playing: () => 0,
    };
    const assets = new AssetIndex([['audio/voice/mini.opus', 'u:mini']]);
    const { s, fight } = await battleShip({ assets, parts: { audio: audio as unknown as Mixer } });
    const run = await fight();
    // (cue 0 asked for 100 ms on, as damage.cpp:523-526's later cues are)
    s.world.bus.emit({ type: 'battleAudio', now: run.clock, silenced: false, cues: [{ cue: 0, delay: 100, interrupt: false }], sounds: [] });
    const before = run.clock;
    played.length = 0;
    await s.battlePort().autoResolve();
    // (no tactics, so nothing decides it: handed back undecided, its clock well past the later cue's time)
    expect([s.world.battle, run.resolved, run.clock > before + 100]).toEqual([run, null, true]);
    // (the first frame back: nothing it asks for, and the later cue forgotten, so nothing plays)
    s.world.bus.emit({ type: 'battleAudio', now: run.clock, silenced: false, cues: [], sounds: [] });
    expect([played, s.battleSoundState()!.channels.slice(0, 3)]).toEqual([[], [false, false, false]]);
  });

  it('neither starts the crew afresh nor loads the effect sounds for the dialog\'s battle, which has no frames (Plan 28 R13)', async () => {
    const played: [string, string][] = [];
    const preloaded: string[][] = [];
    const audio = {
      ...LEVELS,
      play: async (url: string | undefined, bus: string): Promise<Playing | null> => {
        if (url === undefined) return null;
        played.push([bus, url]);
        return { ended: new Promise<void>(() => {}), duration: 1, stop: () => {} };
      },
      setLoop: async () => {}, keep: () => {}, release: () => {}, preload: async (urls: string[]) => void preloaded.push(urls), resume: async () => {}, playing: () => 0,
    };
    const assets = new AssetIndex([['audio/voice/mini.opus', 'u:mini'], ['audio/sfx/beep7.opus', 'u:beep']]);
    const { s } = await battleShip({ assets, parts: { audio: audio as unknown as Mixer, realCombat: false } });
    // (a crew line still playing on the first cue channel as the battle comes)
    s.world.bus.emit({ type: 'battleAudio', now: 0, silenced: false, cues: [{ cue: 0, delay: 0, interrupt: false }], sounds: [] });
    expect(s.battleSoundState()!.channels[0]).toBe(true);
    s.world.state.ship.battleScenario = 8;
    await s.world.enqueue(() => gotoShipScreen(s.world, STATION_CODE.tactical));
    await run(s, 0.3);
    // (the M4 dialog's battle is on, with no world.battle: its combat on neither stops the line nor loads miniCombat's effect sound;
    // the session's other sounds may preload)
    expect([s.world.state.ship.combat?.scenario, s.world.battle]).toEqual([8, null]);
    expect([s.battleSoundState()!.channels[0], preloaded.flat().includes('u:beep')]).toEqual([true, false]);
  });

  it('has no battle sound without Web Audio', async () => {
    const { s } = await battleShip();
    expect(s.battleSoundState()).toBeNull();
  });

  it('refuses a load while auto-resolve runs (Plan 23 R4)', async () => {
    const { s, fight } = await battleShip();
    const save = s.world.save();
    await fight();
    const resolving = s.battlePort().autoResolve();
    await expect(s.load(save)).rejects.toThrow(CHANGE_REFUSED);
    await resolving;
    // (no tactics, so nothing decides it: handed back undecided, the battle on and the world idle again, so the load goes ahead)
    expect([s.world.battle?.resolved, s.world.state.ship.station]).toEqual([null, 'tactical']);
    await s.load(save);
    expect(s.world.battle).toBeNull();
  });

  it('starts auto-resolve once: a second ask while it runs does nothing', async () => {
    const { s, fight } = await battleShip();
    await fight();
    const port = s.battlePort();
    const first = port.autoResolve();
    await port.autoResolve();
    expect(port.battle()!.resolving).toBe(true);
    await first;
    expect(port.battle()!.resolving).toBe(false);
  });

  it('gives the console the orders waiting and what is over tactical, one port for every asker, and a ship on the view by the space view\'s pick (Plan 29 R2, R3, R6)', async () => {
    const { s, fight } = await battleShip();
    await fight();
    const port = s.battlePort();
    expect(s.battlePort()).toBe(port);
    // (paused, an order waits for the next frame, and the console reads it)
    port.pause(true);
    port.command({ type: 'shields', on: true });
    expect([port.battle()!.queued, port.battle()!.overlay]).toEqual([[{ type: 'shields', on: true }], null]);
    s.store.set({ panel: 'transcript' });
    expect(port.battle()!.overlay).toBe('panel');
    // (the admin console takes every key: the battle's are off, as under a dialog)
    s.store.set({ panel: 'admin' });
    expect(port.battle()!.overlay).toBe('dialog');
    s.store.set({ dialog: { kind: 'prompt', text: 'Made-up words', buttons: ['OK'] } });
    expect(port.battle()!.overlay).toBe('dialog');
    // (nothing drawn: the tests have no renderer, so no ship is under any point)
    expect(port.pick(0.5, 0.5)).toBeNull();
  });

  it('credits the battle the ticks it is owed at the old speed before a new speed (as pauseBattle does)', async () => {
    const { s, fight } = await battleShip();
    const r = await fight();
    const clock = r.clock;
    // (60 ticks the battle hasn't been given yet, as while a script held the world: 1000 ms at 1x, 8000 at 8x)
    s.world.state.tick += 60;
    s.setAssists({ difficulty: 'game', speed: 8 });
    expect([r.clock - clock, r.tick]).toEqual([1000, s.world.state.tick]);
  });

  it('reads the package\'s combat.yaml once, when a battle scenario is set or a game is loaded with one, and fights with it (M8 spec §8)', async () => {
    let reads = 0;
    const { s, fight } = await battleShip({ lazy: () => reads++ });
    expect([reads, s.content.ship!.combat]).toEqual([0, undefined]);
    // (a game loaded with a battle coming reads it as the world is put in place)
    s.world.state.ship.battleScenario = 8;
    await s.load(s.world.save());
    await run(s, 0.1);
    expect(reads).toBe(1);
    expect(Object.keys(s.content.ship!.combat!.battles)).toContain('8');
    // (a hail's scenario, once read, reads nothing again; and the battle fights with it)
    s.world.bus.emit({ type: 'battleScenario', scenario: 3 });
    expect((await fight()).b.scenario).toBe(8);
    expect(reads).toBe(1);
  });

  it('loads a real battle\'s models as it starts and frees them as a load ends it; the dialog\'s battle loads none (M8 spec §8)', async () => {
    // (every model of miniCombat in the game, each a mesh with an 8x8 map, as GLTFLoader gives a .glb)
    const assets = new AssetIndex(Object.values(miniCombat().models).map(m => [m.url, `/a/${m.url}`] as [string, string]));
    const model = async () => {
      const root = new Object3D();
      root.add(new Mesh(undefined, new MeshStandardMaterial({ map: new Texture({ width: 8, height: 8 } as unknown as HTMLImageElement) })));
      return root;
    };
    const parts = { artLoaders: { texture: async () => new Texture(), model } };
    const { s, fight } = await battleShip({ assets, parts });
    const save = s.world.save();
    expect(s.battleAssetState()).toBeNull();
    await fight();
    await run(s, 0.1);
    // (the Enterprise and the foe: miniCombat's 14 models for two ships; this game has no sprites or stills, said once)
    expect(s.battleAssetState()).toMatchObject({ scenario: 8, state: 'ready', models: 14, sprites: 0, stills: false, textures: 14 });
    await s.load(save);
    expect(s.battleAssetState()).toBeNull();
    // (the M4 dialog's battle draws nothing: players' until M8's switch-on)
    const dialog = await battleShip({ assets, parts: { ...parts, realCombat: false } });
    dialog.s.world.state.ship.battleScenario = 8;
    await dialog.s.world.enqueue(() => gotoShipScreen(dialog.s.world, STATION_CODE.tactical));
    await run(dialog.s, 0.3);
    expect(dialog.s.world.state.ship.combat?.scenario).toBe(8);
    expect(dialog.s.battleAssetState()).toBeNull();
  });

  it('loads the art\'s packs for a real battle only with the art on, halved at a low resolution (Plan 30 R15, R16)', async () => {
    const files = new Map<string, string>(Object.values(miniCombat().models).map(m => [m.url, `/a/${m.url}`] as [string, string]));
    files.set('art/space/kind2.pack', '/a/kind2.pack');
    const assets = new AssetIndex([...files]);
    const model = async () => {
      const root = new Object3D();
      const m = new MeshStandardMaterial({ map: new Texture({ width: 8, height: 8 } as unknown as HTMLImageElement) });
      m.userData = { texture: 'hull.gif' };
      root.add(new Mesh(undefined, m));
      return root;
    };
    const pack = writeImagePack([{ name: 'tex:hull.gif', type: 'image/webp', width: 32, height: 32, bytes: Uint8Array.of(1) }]);
    vi.stubGlobal('fetch', async (url: string) => (url === '/a/kind2.pack' ? new Response(pack as BlobPart) : new Response('', { status: 404 })));
    const sizes: [number, number][] = [];
    const artImage = async (_b: Uint8Array, _t: string, size: [number, number]) => { sizes.push(size); return new Texture({ width: size[0], height: size[1] } as unknown as HTMLImageElement); };
    const space = { kinds: { 2: 'art/space/kind2.pack' }, backdrops: [] };
    const fought = async (parts: Partial<SessionParts>) => {
      const { s, fight } = await battleShip({ assets, parts: { artLoaders: { texture: async () => new Texture(), model }, artImage, ...parts } });
      s.pkg = { ...s.pkg, presentation: { ...s.pkg.presentation, art: { ...s.pkg.presentation.art, space } } };
      await fight();
      await run(s, 0.1);
      return s;
    };
    const on = await fought({});
    expect(sizes).toEqual([[32, 32]]);
    expect(on.battleAssetState()).toMatchObject({ state: 'ready', art: { packs: 1, swapped: 14, sheets: 0 } });
    sizes.length = 0;
    await fought({ lowRes: true });
    expect(sizes).toEqual([[16, 16]]);
    sizes.length = 0;
    const off = await fought({ artOff: true });
    expect(sizes).toEqual([]);
    expect(off.battleAssetState()!.art).toBeNull();
    vi.unstubAllGlobals();
  });

  it('draws a real battle at tactical in the Split rectangle of the tactical box once its set and the combat chunk are in, and frees the scene as the battle ends (M8 spec §3, §8)', async () => {
    const assets = new AssetIndex(Object.values(miniCombat().models).map(m => [m.url, `/a/${m.url}`] as [string, string]));
    const made: string[] = [];
    const flashes: number[] = [];
    /** The combat chunk's scene, as a stand-in that says what was done to it. */
    class FakeScene {
      scene = new Scene();
      camera = new PerspectiveCamera();
      constructor() { made.push('made'); }
      setOptions(o: { flash?: number }) { flashes.push(o.flash ?? 0); }
      setPixelScale() {}
      update(b: { steps: number }) { made.push('update'); return b; }
      drawn() { return []; }
      effectsDrawn() { return []; }
      dispose() { made.push('dispose'); }
    }
    let arrive!: (m: unknown) => void;
    const chunk = new Promise(r => { arrive = r; });
    const draws: unknown[] = [];
    const parts: Partial<SessionParts> = {
      artLoaders: { texture: async () => new Texture(), model: async () => new Object3D() },
      combatView: () => chunk as Promise<SpaceSceneModule>,
      render: (_stage, over) => { draws.push(over); },
    };
    const { s, fight } = await battleShip({ assets, parts });
    const save = s.world.save();
    const canvas = document.createElement('canvas');
    const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top }) as DOMRect;
    canvas.getBoundingClientRect = () => rect(0, 0, 800, 600);
    s.bind(canvas);
    s.battlePort().viewBox(() => rect(80, 60, 640, 480));
    await fight();
    await run(s, 0.1);
    // (the set is in and the chunk asked for once: nothing drawn over the stage until it comes)
    expect([s.combatViewState().module, draws.at(-1), s.shipPort().shipArt('tactical')]).toEqual(['loading', undefined, false]);
    /** The warp overlay, as a stand-in that says how far into it it was drawn. */
    class FakeWarp {
      scene = new Scene();
      camera = new PerspectiveCamera();
      problems: string[] = [];
      update(ms: number) { made.push(`warp ${ms}`); }
      dispose() {}
    }
    arrive({ SpaceScene: FakeScene, WarpOverlay: FakeWarp });
    await new Promise(r => setTimeout(r, 0));
    // (the panel goes transparent as the view starts drawing: the store says so, with nothing else changed)
    let heard = 0;
    const stop = s.shipPort().subscribe(() => heard++);
    s.frame(0.1);
    stop();
    expect(heard).toBeGreaterThan(0);
    // (the box is (80, 60) to (720, 540) of an 800 x 600 canvas, y up from the bottom: 60 to 540; Split's (319, 23) to (639, 243) of it)
    expect((draws.at(-1) as { viewport: unknown }).viewport).toEqual({ x: 399, y: 297, width: 320, height: 220 });
    // (the stage's room is not drawn under the view: the frame is cleared, Plan 25 review #1; the bloom goes over it after)
    expect(draws.at(-1)).toMatchObject({ clear: true, after: expect.any(Function) });
    // (a frame with the view drawing on and nothing else changed says nothing)
    heard = 0;
    const stop2 = s.shipPort().subscribe(() => heard++);
    s.frame(0.1);
    stop2();
    expect(heard).toBe(0);
    expect([made[0], s.shipPort().shipArt('tactical'), s.combatViewState()]).toMatchObject(['made', true, { module: 'ready', drawing: true, scenario: 8, wide: false }]);
    // (a hit's red flash shows; a pause in its step doesn't hold space red: the flag stays the battle's while the update
    // waits, and the view's hold ends, review #4)
    const live = s.world.battle!;
    live.b.console.redFlash = true;
    s.tick();
    s.frame(0.1);
    expect([live.redFlash, flashes.at(-1)]).toEqual([true, 1]);
    pauseBattle(s.world, true);
    s.tick();
    s.frame(0.1);
    expect([live.redFlash, flashes.at(-1)]).toEqual([true, 0]);
    pauseBattle(s.world, false);
    // (the Enterprise warps away: the overlay over the whole box, 1000 ms into its 3000, until it has gone)
    s.world.battle!.warpHold = 2000;
    s.frame(0.1);
    expect([made.at(-1), (draws.at(-1) as { viewport: unknown }).viewport, s.combatViewState().overlay]).toEqual(['warp 1000', { x: 80, y: 60, width: 640, height: 480 }, 'warp']);
    s.world.battle!.warpHold = 0;
    s.frame(0.1);
    expect(s.combatViewState().overlay).toBeNull();
    // (a load ends the battle: the scene is freed, and the stage alone is drawn)
    await s.load(save);
    s.frame(0.1);
    expect([made.at(-1), draws.at(-1), s.combatViewState().drawing]).toEqual(['dispose', undefined, false]);
  });

  it('gives the console its battle: the page at once, the set\'s stills with combat.yaml\'s words, the view\'s flash, the log, the view\'s box (Plan 27)', async () => {
    const plate = { width: 640, height: 480, pixels: new Uint8Array(640 * 480) };
    const mrg = { width: 2, height: 2, pixels: new Uint8Array(4).fill(9) };
    const files: Record<string, Uint8Array> = {
      [COMBAT_STILLS.console]: writePack([plate, mrg]), [COMBAT_STILLS.warp]: writePack([plate]),
      [COMBAT_STILLS.palette]: new Uint8Array(768).fill(3), [COMBAT_STILLS.warpPalette]: new Uint8Array(768),
    };
    vi.stubGlobal('fetch', async (url: string) => new Response((files[url.replace('/a/', '')] ?? null) as BodyInit | null, { status: url.replace('/a/', '') in files ? 200 : 404 }));
    try {
      const assets = new AssetIndex([...Object.values(miniCombat().models).map(m => m.url), ...Object.keys(files)].map(u => [u, `/a/${u}`] as [string, string]));
      const draws: unknown[] = [];
      class FakeScene {
        scene = new Scene();
        camera = new PerspectiveCamera();
        setOptions() {}
        setPixelScale() {}
        update() {}
        drawn() { return []; }
        effectsDrawn() { return []; }
        dispose() {}
      }
      const chunk = { SpaceScene: FakeScene } as unknown as SpaceSceneModule;
      const logs: string[] = [];
      const { s, fight } = await battleShip({ assets, parts: {
        artLoaders: { texture: async () => new Texture(), model: async () => new Object3D() },
        combatView: async () => chunk, render: (_stage, over) => { draws.push(over); }, log: (_level, text) => { logs.push(text); },
      } });
      const port = s.battlePort();
      expect([port.battle(), port.consoleArt(), port.chunk(), port.flash()]).toEqual([null, null, null, 0]);
      const canvas = document.createElement('canvas');
      const rect = (left: number, width: number) => ({ left, top: 0, width, height: 480, right: left + width, bottom: 480, x: left, y: 0 }) as DOMRect;
      canvas.getBoundingClientRect = () => rect(0, 800);
      s.bind(canvas);
      // (the console's box is (80, 0) 640 x 480; wide, the frame, (0, 0) 800 x 480)
      port.viewBox(wide => (wide ? rect(0, 800) : rect(80, 640)));
      const run0 = await fight();
      await run(s, 0.1);
      s.frame(0.1);
      await new Promise(r => setTimeout(r, 0));
      s.frame(0.1);
      expect(port.chunk()).toBe(chunk);
      expect((draws.at(-1) as { viewport: unknown }).viewport).toEqual({ x: 399, y: 237, width: 320, height: 220 });
      port.command({ type: 'wide', on: true });
      s.tick();
      s.frame(0.1);
      expect((draws.at(-1) as { viewport: unknown }).viewport).toEqual({ x: 0, y: 0, width: 800, height: 480 });
      // (the art: the set's plate and space.mrg's pictures, the space palette, combat.yaml's words; no fonts published, said once)
      const art = port.consoleArt()!;
      expect([art.plate.width, art.images.length, art.images[0]!.pixels[0], art.palette[0], art.fonts, art.text]).toEqual([640, 1, 9, 3, null, null]);
      expect(port.consoleArt()).toBe(art);
      expect(logs.filter(l => l.includes('art.fonts')).length).toBe(1);
      // (a tab: the page at once, CONN's order queued for the next frame)
      expect(port.battle()!.page).toBe('conn');
      port.page('sensors');
      expect([port.battle()!.page, run0.queue.at(-1)]).toEqual(['sensors', { type: 'page', page: 'sensors' }]);
      // (the scanner showed the Enterprise's log: it scrolls on by the battle's clock)
      const e = run0.b.ships[0]!;
      e.log.push('-a-', '-b-');
      e.logScrollTime = 0;
      port.logShown(0);
      expect(e.logRead).toBe(1);
      // (the flash the view holds is the console's too)
      run0.b.console.redFlash = true;
      port.command({ type: 'wide', on: false });
      s.tick();
      s.frame(0.1);
      expect(port.flash()).toBe(1);
      expect([port.radar(), port.radar()].every(m => m === port.radar())).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('with the radar off the HUD boxes are not read (the target\'s arrow is the radar\'s)', async () => {
    const plate = { width: 640, height: 480, pixels: new Uint8Array(640 * 480) };
    const mrg = { width: 2, height: 2, pixels: new Uint8Array(4) };
    const files: Record<string, Uint8Array> = {
      [COMBAT_STILLS.console]: writePack([plate, mrg]), [COMBAT_STILLS.warp]: writePack([plate]),
      [COMBAT_STILLS.palette]: new Uint8Array(768), [COMBAT_STILLS.warpPalette]: new Uint8Array(768),
    };
    vi.stubGlobal('fetch', async (url: string) => new Response((files[url.replace('/a/', '')] ?? null) as BodyInit | null, { status: url.replace('/a/', '') in files ? 200 : 404 }));
    try {
      const assets = new AssetIndex([...Object.values(miniCombat().models).map(m => m.url), ...Object.keys(files)].map(u => [u, `/a/${u}`] as [string, string]));
      class FakeScene {
        scene = new Scene();
        camera = new PerspectiveCamera();
        setOptions() {}
        setPixelScale() {}
        update() {}
        drawn() { return []; }
        effectsDrawn() { return []; }
        dispose() {}
      }
      const chunk = { SpaceScene: FakeScene } as unknown as SpaceSceneModule;
      const { s, fight } = await battleShip({ assets, parts: {
        artLoaders: { texture: async () => new Texture(), model: async () => new Object3D() },
        combatView: async () => chunk, render: () => {}, log: () => {},
      } });
      const port = s.battlePort();
      const canvas = document.createElement('canvas');
      const rect = { left: 0, top: 0, width: 800, height: 480, right: 800, bottom: 480, x: 0, y: 0 } as DOMRect;
      canvas.getBoundingClientRect = () => rect;
      s.bind(canvas);
      port.viewBox(() => rect);
      const hud = vi.fn(() => []);
      port.hudBoxes(hud);
      await fight();
      await run(s, 0.1);
      s.frame(0.1);
      await new Promise(r => setTimeout(r, 0));
      port.command({ type: 'wide', on: true });
      s.tick();
      s.frame(0.1);
      expect(hud).toHaveBeenCalled();
      hud.mockClear();
      const settings = s.uiPort().settings!;
      settings.set({ combat: { ...settings.get().combat, radar: false } });
      s.frame(0.1);
      s.frame(0.1);
      expect(hud).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('lets the console\'s pictures go with the battle\'s set, wherever the set is freed (M8 spec §8: a battle frees them all on leaving)', async () => {
    const plate = { width: 640, height: 480, pixels: new Uint8Array(640 * 480) };
    const mrg = { width: 2, height: 2, pixels: new Uint8Array(4) };
    const files: Record<string, Uint8Array> = {
      [COMBAT_STILLS.console]: writePack([plate, mrg]), [COMBAT_STILLS.warp]: writePack([plate]),
      [COMBAT_STILLS.palette]: new Uint8Array(768), [COMBAT_STILLS.warpPalette]: new Uint8Array(768),
    };
    vi.stubGlobal('fetch', async (url: string) => new Response((files[url.replace('/a/', '')] ?? null) as BodyInit | null, { status: url.replace('/a/', '') in files ? 200 : 404 }));
    try {
      const assets = new AssetIndex([...Object.values(miniCombat().models).map(m => m.url), ...Object.keys(files)].map(u => [u, `/a/${u}`] as [string, string]));
      const { s } = await battleShip({ assets, parts: { artLoaders: { texture: async () => new Texture(), model: async () => new Object3D() } } });
      // (the art the console was last given, which holds the set's stills: the session's own, read through its private parts)
      const held = () => (s as unknown as { consoleArtFor: unknown }).consoleArtFor;
      const draw = () => (s as unknown as { consoleArt(): unknown }).consoleArt();
      await s.loadBattleAssetsFor(8);
      expect(draw()).not.toBeNull();
      expect(held()).not.toBeNull();
      s.freeBattleAssets();
      expect(held()).toBeNull();
      // (a preview's set, freed as the preview ends)
      await s.previewBattle(8);
      expect(draw()).not.toBeNull();
      expect(held()).not.toBeNull();
      s.endPreview();
      expect(held()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('frees the console\'s repaint with the battle\'s set (Plan 31 R3)', async () => {
    const files: Record<string, Uint8Array> = {
      'art/space/console/plate.webp': Uint8Array.of(1), 'art/space/console.pack': writeImagePack([{ name: '0', type: 'image/webp', width: 4, height: 3, bytes: Uint8Array.of(1) }]),
    };
    vi.stubGlobal('fetch', async (url: string) => new Response((files[url.replace('/a/', '')] ?? null) as BodyInit | null, { status: url.replace('/a/', '') in files ? 200 : 404 }));
    try {
      const assets = new AssetIndex([...Object.values(miniCombat().models).map(m => m.url), ...Object.keys(files)].map(u => [u, `/a/${u}`] as [string, string]));
      const { s } = await battleShip({ assets, parts: {
        artLoaders: { texture: async () => new Texture(), model: async () => new Object3D() },
        artPicture: async (_b, _t, size) => ({ width: size[0], height: size[1] }), loadPlate: async () => {},
      } });
      s.pkg = { ...s.pkg, presentation: parsePresentation('art:\n  space:\n    console: { plate: art/space/console/plate.webp, pack: art/space/console.pack, scale: 4, areas: { radar: [5, 21, 310, 275] } }\n') };
      const loader = (s as unknown as { consoleRepaint: { repaint(): unknown; bytes(): number } }).consoleRepaint;
      loader.repaint();
      await new Promise(r => setTimeout(r, 0));
      expect(loader.bytes()).toBe(4 * 3 * 4);
      s.freeBattleAssets();
      expect(loader.bytes()).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('starts the console\'s repaint as a battle starts, before the console asks for it, and not with the art off (Plan 31 final review)', async () => {
    const files: Record<string, Uint8Array> = {
      'art/space/console/plate.webp': Uint8Array.of(1), 'art/space/console.pack': writeImagePack([{ name: '0', type: 'image/webp', width: 4, height: 3, bytes: Uint8Array.of(1) }]),
    };
    vi.stubGlobal('fetch', async (url: string) => new Response((files[url.replace('/a/', '')] ?? null) as BodyInit | null, { status: url.replace('/a/', '') in files ? 200 : 404 }));
    try {
      const assets = new AssetIndex([...Object.values(miniCombat().models).map(m => m.url), ...Object.keys(files)].map(u => [u, `/a/${u}`] as [string, string]));
      // (the plates asked for as a battle starts, with the art on or off; nothing draws the console, so consoleArt never runs)
      const started = async (art: boolean): Promise<string[]> => {
        const plates: string[] = [];
        const { s, fight } = await battleShip({ assets, parts: {
          artLoaders: { texture: async () => new Texture(), model: async () => new Object3D() },
          artPicture: async (_b, _t, size) => ({ width: size[0], height: size[1] }), loadPlate: async u => void plates.push(u),
        } });
        s.pkg = { ...s.pkg, presentation: parsePresentation('art:\n  space:\n    console: { plate: art/space/console/plate.webp, pack: art/space/console.pack, scale: 4, areas: { radar: [5, 21, 310, 275] } }\n') };
        (s as unknown as { stage: { setDebug(d: { art: boolean }): void } }).stage.setDebug({ art });
        await fight();
        return plates;
      };
      expect(await started(true)).toEqual(['/a/art/space/console/plate.webp']);
      expect(await started(false)).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('draws a preview\'s console as the original\'s at a battle\'s start, its view clear, for the screenshot check (Plan 27 R17)', async () => {
    // (a plate of colour 5 and a palette whose entry 5 is (50, 60, 70))
    const plate = { width: 640, height: 480, pixels: new Uint8Array(640 * 480).fill(5) };
    const palette = new Uint8Array(768);
    palette.set([50, 60, 70], 15);
    const files: Record<string, Uint8Array> = {
      [COMBAT_STILLS.console]: writePack([plate, { width: 1, height: 1, pixels: new Uint8Array(1) }]), [COMBAT_STILLS.warp]: writePack([plate]),
      [COMBAT_STILLS.palette]: palette, [COMBAT_STILLS.warpPalette]: new Uint8Array(768),
      // (the console's repaint, for the art-on shot: Plan 30 R17)
      'art/space/console/plate.webp': Uint8Array.of(1), 'art/space/console.pack': writeImagePack([{ name: '0', type: 'image/webp', width: 1, height: 1, bytes: Uint8Array.of(1) }]),
    };
    vi.stubGlobal('fetch', async (url: string) => new Response((files[url.replace('/a/', '')] ?? null) as BodyInit | null, { status: url.replace('/a/', '') in files ? 200 : 404 }));
    try {
      const assets = new AssetIndex([...Object.values(miniCombat().models).map(m => m.url), ...Object.keys(files)].map(u => [u, `/a/${u}`] as [string, string]));
      class FakeScene {
        scene = new Scene();
        camera = new PerspectiveCamera();
        setOptions() {}
        setPixelScale() {}
        update() {}
        drawn() { return []; }
        effectsDrawn() { return []; }
        dispose() {}
      }
      const { s } = await battleShip({ assets, parts: {
        artLoaders: { texture: async () => new Texture(), model: async () => new Object3D() },
        combatView: async () => ({ SpaceScene: FakeScene, drawConsole, consolePalette }) as unknown as SpaceSceneModule, render: () => {}, log: () => {},
        artPicture: async (_b, _t, size) => ({ width: size[0], height: size[1] }), loadPlate: async () => {},
      } });
      const canvas = document.createElement('canvas');
      canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 480, right: 640, bottom: 480, x: 0, y: 0 }) as DOMRect;
      s.bind(canvas);
      expect(s.previewConsole()).toBeNull();
      await s.previewBattle(8);
      s.frame(0.1);
      await new Promise(r => setTimeout(r, 0));
      // (no fonts published: nothing to wait for, so the console is drawn, without text)
      const shot = s.previewConsole()!;
      const px = (x: number, y: number) => [...shot.rgba.subarray((y * 640 + x) * 4, (y * 640 + x) * 4 + 4)];
      // (the plate where nothing is drawn over it, opaque; the view's rectangle clear)
      expect([shot.rgba.length, px(639, 470), px(400, 100)[3], shot.repaint]).toEqual([640 * 480 * 4, [50, 60, 70, 255], 0, null]);
      s.endPreview();
      expect(s.previewConsole()).toBeNull();
      // (with the console's repaint published and the art on, as the game draws it: the frame clear where it is still the plate's, so
      // the plate and the art layer under it show, and the pictures it drew for the art layer: Plan 30 R17)
      s.pkg = { ...s.pkg, presentation: parsePresentation('art:\n  space:\n    console: { plate: art/space/console/plate.webp, pack: art/space/console.pack, scale: 4, areas: { radar: [5, 21, 310, 275] } }\n') };
      await s.previewBattle(8);
      s.previewConsole();
      await new Promise(r => setTimeout(r, 0));
      const art = s.previewConsole()!;
      const at = (x: number, y: number) => art.rgba[(y * 640 + x) * 4 + 3];
      expect([art.repaint?.plate, at(639, 470), at(100, 100), Array.isArray(art.blits)]).toEqual(['/a/art/space/console/plate.webp', 0, 255, true]);
      s.endPreview();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('draws a ?dev preview of a battle apart from the world on the whole canvas, in the parity mode if asked, and frees it at endPreview (Plan 25)', async () => {
    const assets = new AssetIndex(Object.values(miniCombat().models).map(m => [m.url, `/a/${m.url}`] as [string, string]));
    const made: string[] = [];
    class FakeScene {
      scene = new Scene();
      camera = new PerspectiveCamera();
      constructor(_a: unknown, _c: unknown, _seed: number, o: { parity: boolean }) { made.push(`made parity ${o.parity}`); }
      setOptions() {}
      setPixelScale() {}
      update(b: { steps: number; lastStep: number }) { made.push(`step ${b.steps}`); clocks.push(b.lastStep); }
      drawn() { return []; }
      effectsDrawn() { return []; }
      dispose() { made.push('dispose'); }
    }
    const clocks: number[] = [];
    const draws: unknown[] = [];
    const { s } = await battleShip({ assets, parts: {
      artLoaders: { texture: async () => new Texture(), model: async () => new Object3D() },
      combatView: async () => ({ SpaceScene: FakeScene }) as unknown as SpaceSceneModule,
      render: (_stage, over) => { draws.push(over); },
    } });
    const canvas = document.createElement('canvas');
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 480, right: 640, bottom: 480, x: 0, y: 0 }) as DOMRect;
    s.bind(canvas);
    const save = s.world.save();
    const objects = structuredClone(s.world.state.objects);
    const state = structuredClone(s.world.state);
    s.setCombatParity(true);
    // (battle 8 of this game, its ships all active whatever the world says, 10 steps on; the world fights nothing)
    expect(await s.previewBattle(8, { steps: 10 })).toEqual({ battle: true, warnings: [] });
    // (the world's state, the ship's systems with it, as it was: the battle fought a copy, review #1)
    expect(s.world.state).toEqual(state);
    s.frame(0.1);
    await new Promise(r => setTimeout(r, 0));
    s.frame(0.1);
    expect([made.slice(0, 2), (draws.at(-1) as { viewport: unknown }).viewport]).toEqual([['made parity true', 'step 10'], { x: 319, y: 237, width: 320, height: 220 }]);
    expect([s.world.battle, s.world.state.objects]).toEqual([null, objects]);
    expect(s.battleAssetState()).toMatchObject({ scenario: 8, state: 'ready' });
    // (?dev steps the preview on, Plan 26; no world battle to warp)
    s.stepPreview(5);
    s.frame(0.1);
    expect([made.at(-1), s.battleWarp()]).toEqual(['step 15', false]);
    s.endPreview();
    expect([made.at(-1), s.battleAssetState(), s.combatViewState().drawing]).toEqual(['dispose', null, false]);
    // (a battle with no Enterprise: setup's failure, nothing drawn)
    const none = await s.previewBattle(99);
    expect(none.battle).toBe(false);
    // (a load frees the set the preview draws from: the preview ends with it, its scene freed, review #2)
    await s.previewBattle(8);
    s.frame(0.1);
    expect(s.combatViewState().drawing).toBe(true);
    await s.load(save);
    s.frame(0.1);
    expect([made.at(-1), s.combatViewState().drawing, s.battleAssetState()]).toEqual(['dispose', false, null]);
    // (a set loaded since the preview's, as a world battle's start loads one, is not the preview's to free, review #3)
    await s.previewBattle(8);
    await s.loadBattleAssetsFor(8);
    s.endPreview();
    expect(s.battleAssetState()).toMatchObject({ scenario: 8, state: 'ready' });
    // (a preview taken to start at a tick of its own has the same clock whenever it is called; the world's moves on, Plan 26)
    const clockOf = async (o: { tick?: number }) => {
      s.world.state.tick += 500;
      await s.previewBattle(8, o);
      s.frame(0.1);
      const clock = clocks.at(-1)!;
      s.endPreview();
      return clock;
    };
    const pinned = [await clockOf({ tick: 3600 }), await clockOf({ tick: 3600 })];
    const own = [await clockOf({}), await clockOf({})];
    expect([pinned[0] === pinned[1], own[0] === own[1]]).toEqual([true, false]);
  });

  it('sizes the space view in the renderer\'s pixels, not the device\'s, when the renderer\'s ratio is capped (Plan 25 final review I1)', async () => {
    // (a 3x phone whose renderer runs at 2: device.ts pixelRatioFor)
    vi.stubGlobal('devicePixelRatio', 3);
    try {
      const assets = new AssetIndex(Object.values(miniCombat().models).map(m => [m.url, `/a/${m.url}`] as [string, string]));
      class FakeScene {
        scene = new Scene();
        camera = new PerspectiveCamera();
        setOptions() {}
        setPixelScale() {}
        update() {}
        drawn() { return []; }
        effectsDrawn() { return []; }
        dispose() {}
      }
      const draws: unknown[] = [];
      const { s, fight } = await battleShip({ assets, parts: {
        artLoaders: { texture: async () => new Texture(), model: async () => new Object3D() },
        combatView: async () => ({ SpaceScene: FakeScene }) as unknown as SpaceSceneModule,
        render: (_stage, over) => { draws.push(over); },
        pixelRatio: () => 2,
      } });
      const canvas = document.createElement('canvas');
      const rect = { left: 0, top: 0, width: 640, height: 480, right: 640, bottom: 480, x: 0, y: 0 } as DOMRect;
      canvas.getBoundingClientRect = () => rect;
      s.bind(canvas);
      // (a preview: the canvas is 1280 x 960 at 2, Split's (319, 23) 320 x 220 of it twice over, y up)
      await s.previewBattle(8);
      s.frame(0.1);
      await new Promise(r => setTimeout(r, 0));
      s.frame(0.1);
      expect((draws.at(-1) as { viewport: unknown }).viewport).toEqual({ x: 638, y: 474, width: 640, height: 440 });
      s.endPreview();
      // (the world's battle at tactical, in a console box that is the whole canvas: the same)
      s.battlePort().viewBox(() => rect);
      await fight();
      await run(s, 0.1);
      s.frame(0.1);
      expect([s.combatViewState().drawing, (draws.at(-1) as { viewport: unknown }).viewport]).toEqual([true, { x: 638, y: 474, width: 640, height: 440 }]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('previews nothing when a restart replaces the world while combat.yaml is read (Plan 25 Task 6 review #4)', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const assets = new AssetIndex(Object.values(miniCombat().models).map(m => [m.url, `/a/${m.url}`] as [string, string]));
    const parts = { artLoaders: { texture: async () => new Texture(), model: async () => new Object3D() } };
    const { s } = await battleShip({ assets, parts, lazy: () => gate });
    const save = s.world.save();
    const previewing = s.previewBattle(8);
    await s.load(save);
    release();
    expect(await previewing).toEqual({ battle: false, warnings: [] });
    expect([s.battleAssetState(), s.combatViewState().drawing]).toEqual([null, false]);
  });

  it('loads no set for the dev hook when a restart replaces the world while combat.yaml is read (Task 6 review #1)', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const assets = new AssetIndex(Object.values(miniCombat().models).map(m => [m.url, `/a/${m.url}`] as [string, string]));
    const parts = { artLoaders: { texture: async () => new Texture(), model: async () => new Object3D() } };
    const { s } = await battleShip({ assets, parts, lazy: () => gate });
    const save = s.world.save();
    const loading = s.loadBattleAssetsFor(8);
    await s.load(save);
    release();
    expect(await loading).toBeNull();
    expect(s.battleAssetState()).toBeNull();
  });

  it('reads it as the scenario is set, before tactical opens', async () => {
    let reads = 0;
    const { s } = await battleShip({ lazy: () => reads++ });
    s.world.bus.emit({ type: 'battleScenario', scenario: 0xffff });
    expect(reads).toBe(0);
    s.world.bus.emit({ type: 'battleScenario', scenario: 8 });
    expect(reads).toBe(1);
  });

  it('opens on the bridge with no away team, and a restart does the same', async () => {
    const { s } = await start(SHIP);
    expect(s.world.state.onShip).toEqual({ gameOver: null });
    expect(s.world.state.ship.station).toBe('bridge');
    expect(s.world.state.awayTeam).toEqual([]);
    await s.restart();
    expect(s.world.state.onShip).toEqual({ gameOver: null });
  });

  it('saves on the ship when idle, and loads the ship back', async () => {
    const { s, saves } = await start(SHIP);
    expect(s.uiPort().saves!.canSave()).toBe(true);
    s.world.state.ship.pos = { x: 91, y: 90, z: 90 };
    await s.saveTo(1, 0);
    expect((await saves.list()).map(m => m.slot)).toEqual([1]);
    s.world.state.ship.pos = { x: 5, y: 5, z: 5 };
    await s.loadSlot(1);
    expect(s.world.state.onShip).toEqual({ gameOver: null });
    expect(s.world.state.ship.pos).toEqual({ x: 91, y: 90, z: 90 });
  });

  it('restarts to a new game on the bridge, from the ship or from a mission', async () => {
    const { s } = await start(SHIP);
    s.world.state.ship.station = 'astrogation';
    await s.restart();
    expect(s.world.state.onShip).toEqual({ gameOver: null });
    expect(s.world.state.ship.station).toBe('bridge');
  });

  it('holds the music when the team comes back aboard, and puts the ship on the bridge', async () => {
    const { s } = await start(SHIP);
    await s.begin({ screen: 'hall', entrance: 'entry' });
    const hold = vi.spyOn(s, 'holdMusic');
    s.world.state.pendingScreen = { to: '$ship', entrance: '' };
    s.world.applyScreenChange();
    expect(hold).toHaveBeenCalledTimes(1);
    expect(s.world.state.onShip).toEqual({ gameOver: null });
    expect(s.world.state.ship.station).toBe('bridge');
    expect(s.shipPort().ship()?.station).toBe('bridge');
  });

  it('keeps the away start for a dev start at a screen, and for a game without a ship', async () => {
    const { s } = await start(SHIP);
    await s.begin({ screen: 'hall', entrance: 'entry' });
    expect(s.world.state.onShip).toBeNull();
    expect(s.world.state.screen).toBe('hall');
    expect((await start()).s.world.state.onShip).toBeNull();
  });

  it("gives the ship's panels a port that changes station, and refuses while busy or away", async () => {
    const files = {
      ...SHIP,
      'ship.yaml': SHIP['ship.yaml'].replace('bridge: { items: [], objects: [], turbolift: [] }',
        'bridge: { items: [{ object: w.ent, x: 1, y: 2, width: 3, height: 4, action: 4, depth: 0, description: "-Seat-" }, { object: w.ent, x: 0, y: 0, width: 1, height: 1, action: 2, depth: 0, description: "-Comms-" }], objects: [], turbolift: [{ code: 1, text: "-Down-" }] }'),
    };
    const { s } = await start(files);
    const port = s.shipPort();
    expect(port.ship()?.station).toBe('bridge');
    expect(port.bridgeItems().map(i => [i.label, i.action])).toEqual([['-Seat-', 'astrogation'], ['-Comms-', 'comms']]);
    expect(port.turbolift()).toEqual([{ code: 1, label: '-Down-' }]);
    let heard = 0;
    port.subscribe(() => heard++);
    await port.station('transporter');
    expect(s.world.state.ship.station).toBe('transporter');
    expect(heard).toBeGreaterThan(0);
    // (not idle: a line on screen)
    s.store.set({ dialog: { kind: 'menu', options: ['a'] } });
    await expect(port.station('bridge')).rejects.toThrow('Wait until nothing is happening');
    s.store.set({ dialog: null });
    await s.begin({ screen: 'hall', entrance: 'entry' });
    expect(s.shipPort().ship()).toBeNull();
  });

  it('opens the transporter room on the map, scanning, and holds the energize until the scan has locked on; Lists lets it go at once', async () => {
    const files = { ...SHIP, 'ship.yaml': SHIP['ship.yaml'].replace('targets: [], pads: []', 'targets: [{ x: 418, y: 415 }, { x: 418, y: 415 }, { x: 213, y: 339 }], pads: []') };
    const { s } = await start(files);
    const port = s.shipPort();
    // (a beam to world 2, whose target is on the map: the room's team is the picard of the fixture's world 1, so choose by hand)
    s.world.state.beamTarget = 'hall';
    s.world.state.beamWorld = 2;
    await port.station('transporter');
    expect(port.transporter()!.room.target).toBe('hall');
    await port.pad('picard');
    expect(port.transporter()!.map).toMatchObject({ showing: true, hasTarget: true, world: 2, locked: false });
    // (nobody has asked the room for time yet, so nothing holds; the first frame does)
    s.frame(0.001);
    expect(port.transporter()!.canEnergize).toBe(false);
    s.frame(1.5);
    expect(port.transporter()!.map.down).not.toBeNull();
    expect(port.transporter()!.canEnergize).toBe(false);
    await expect(port.energize()).rejects.toThrow('no transporter target, or nobody');
    // (3.7 s more: the column line has crossed)
    for (let i = 0; i < 40; i++) s.frame(0.1);
    expect(port.transporter()!.map).toMatchObject({ locked: true, blip: [194, 320, 38, 38] });
    expect(port.transporter()!.canEnergize).toBe(true);
    // (Lists puts the map away; Map starts it again and holds again)
    port.transporterShowMap(false);
    expect(port.transporter()!.map.showing).toBe(false);
    expect(port.transporter()!.canEnergize).toBe(true);
    port.transporterShowMap(true);
    expect(port.transporter()!.map).toMatchObject({ showing: true, locked: false, down: null });
    expect(port.transporter()!.canEnergize).toBe(false);
    port.transporterShowMap(false);
    expect(port.transporter()!.canEnergize).toBe(true);
  });

  it('gives the transporter room through the port: only at the transporter, and no energize without a target', async () => {
    const { s } = await start(SHIP);
    const port = s.shipPort();
    expect(port.transporter()).toBeNull();
    await expect(port.recommend()).rejects.toThrow('not at the transporter room');
    await port.station('transporter');
    const view = port.transporter()!;
    expect(view.room.target).toBeNull();
    expect(view.canEnergize).toBe(false);
    await port.pad('picard');
    expect(port.transporter()!.room.pads[0]).toBe('picard');
    await port.unpad(0);
    expect(port.transporter()!.room.pads[0]).toBeNull();
    await expect(port.energize()).rejects.toThrow('no transporter target');
    await port.leave(0);
    expect(s.world.state.ship.station).toBe('bridge');
    expect(port.transporter()).toBeNull();
  });

  it('plots and engages through the port only at astrogation, with names for charted things only', async () => {
    const star = '{ id: 7, type: 0, seed: 0, x: 90, y: 90, z: 90, name: -Sol-, range: 0, flags: 4, spectralClass: 0, magnitude: 0, orbitScale: 10, systemName: "", scriptedName: "", scriptedDescription: "", special: -1 }';
    const files = {
      ...SHIP,
      'universe.yaml': SHIP['universe.yaml']
        .replace('sectors: []', 'sectors: [{ numStars: 1, numPhenomena: 0, alignment: 0, firstStar: 0, firstPhenomenon: 0, station: -1, description: "", name: -Area-, region: 0 }]')
        .replace('stars: []', `stars: [${star}]`).replace('flags: []', 'flags: [0, 0, 0, 0, 0, 0, 0, 0]').replace('impulseSpeeds: [1]', 'impulseSpeeds: [1, 2, 3]').replace('planetOrbits: []', 'planetOrbits: [100000]'),
    };
    const { s } = await start(files);
    const port = s.shipPort();
    expect(port.impulseSteps()).toBe(3);
    expect(port.sectors()).toEqual([{ index: 0, label: 'Sector 0', charted: false }]);
    expect(port.stars(0)[0].label).toBe('Star 1');
    const course = { sector: 0, star: 0, planet: 0, warp: false, speed: 1 };
    await expect(port.engage(course)).rejects.toThrow('not at astrogation');
    await port.station('astrogation');
    port.select({ sector: 0, star: 0 });
    expect(port.selection()).toEqual({ sector: 0, star: 0 });
    expect(port.preview(course)).not.toBe('nothing there');
    expect(port.transit()).toBeNull();
    // (a refused course stays at astrogation)
    expect(await port.engage({ ...course, star: 4 })).toBe('nothing there');
    expect(s.world.state.ship.station).toBe('astrogation');
    // (a course taken goes to the bridge, as the original's Engage does)
    expect(await port.engage(course)).toBeNull();
    await vi.waitFor(() => expect(s.world.state.ship.station).toBe('bridge'));
    expect(port.transit()?.progress).toBe(0);
  });

  it('gives the ship panel the astrogation sprites that are published, and none with the art off', async () => {
    const names = ['faster_warp', 'faster_warp_down', 'faster_impulse', 'faster_impulse_down', 'slower', 'slower_down', 'engage', 'engage_down', 'stop', 'stop_down'];
    const withAstro = (): GamePackage => ({
      ...pkg(SHIP),
      assets: new AssetIndex(names.map(n => [`art/astro/${n}.webp`, `/a/${n}.webp`])),
      presentation: {
        music: {}, ambience: {}, intro: {}, arrival: {}, sounds: {},
        art: { rooms: {}, cards: {}, ship: {}, astro: { scale: 4, sprites: Object.fromEntries(names.map(n => [n, { image: `art/astro/${n}.webp`, rect: [392, 161, 245, 29] as [number, number, number, number] }])) } },
      },
    });
    const on = await Session.start(withAstro(), { opening: false });
    expect(on.shipPort().astroSprites()?.sprite('stop_down').url).toBe('/a/stop_down.webp');
    const off = await Session.start(withAstro(), { opening: false, artOff: true });
    expect(off.shipPort().astroSprites()).toBeNull();
    const none = await Session.start(pkg(SHIP), { opening: false });
    expect(none.shipPort().astroSprites()).toBeNull();
  });

  it('gives the ship panel the transporter sprites and the items\' icons that are published, and none with the art off', async () => {
    const names = ['up', 'up_grey', 'down', 'down_grey', 'left', 'left_grey', 'right', 'right_grey', 'kit_slot', 'lists', 'lists_on', 'map', 'map_on'];
    const withArt = (): GamePackage => ({
      ...pkg(SHIP),
      assets: new AssetIndex([...names.map(n => [`art/transporter/${n}.webp`, `/t/${n}.webp`] as [string, string]), ['art/icons/phaser.webp', '/i/phaser.webp']]),
      presentation: {
        music: {}, ambience: {}, intro: {}, arrival: {}, sounds: {},
        art: {
          rooms: {}, cards: {}, ship: {}, icons: { phaser: 'art/icons/phaser.webp' },
          transporter: { scale: 4, sprites: Object.fromEntries(names.map(n => [n, { image: `art/transporter/${n}.webp`, rect: [7, 300, 42, 58] as [number, number, number, number] }])) },
        },
      },
    });
    const on = await Session.start(withArt(), { opening: false });
    expect(on.shipPort().transporterSprites()?.sprite('kit_slot').url).toBe('/t/kit_slot.webp');
    expect(on.shipPort().itemIcon('phaser')).toBe('/i/phaser.webp');
    expect(on.shipPort().itemIcon('hypo')).toBeUndefined();
    const off = await Session.start(withArt(), { opening: false, artOff: true });
    expect(off.shipPort().transporterSprites()).toBeNull();
    expect(off.shipPort().itemIcon('phaser')).toBeUndefined();
    const none = await Session.start(pkg(SHIP), { opening: false });
    expect(none.shipPort().transporterSprites()).toBeNull();
  });

  it('gives the ship panel the bridge strip\'s Viewscreen pictures when published, and none with the art off', async () => {
    const names = ['viewscreen', 'viewscreenDown'];
    const withArt = (): GamePackage => ({
      ...pkg(SHIP),
      assets: new AssetIndex(names.map(n => [`art/sensor/${n}.webp`, `/s/${n}.webp`] as [string, string])),
      presentation: {
        music: {}, ambience: {}, intro: {}, arrival: {}, sounds: {},
        art: { rooms: {}, cards: {}, ship: {}, sensor: { scale: 4, sprites: Object.fromEntries(names.map(n => [n, { image: `art/sensor/${n}.webp`, rect: [484, 426, 121, 42] as [number, number, number, number] }])) } },
      },
    });
    const on = await Session.start(withArt(), { opening: false });
    expect(on.shipPort().sensorSprites()?.sprite('viewscreenDown')).toEqual({ url: '/s/viewscreenDown.webp', rect: [484, 426, 121, 42] });
    const off = await Session.start(withArt(), { opening: false, artOff: true });
    expect(off.shipPort().sensorSprites()).toBeNull();
    const none = await Session.start(pkg(SHIP), { opening: false });
    expect(none.shipPort().sensorSprites()).toBeNull();
  });

  describe('the bridge set (Plan 16 R4)', () => {
    const withShipArt = (): GamePackage => ({
      ...pkg(SHIP),
      assets: new AssetIndex([['art/ship/bridge.glb', '/bridge.glb']]),
      presentation: { music: {}, ambience: {}, intro: {}, arrival: {}, sounds: {}, art: { rooms: {}, cards: {}, ship: { bridge: { gltf: 'art/ship/bridge.glb', camera: 'camera:main', areas: {}, crew: [] } } } },
    });
    const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top }) as DOMRect;
    const setup = async (opts: { fail?: boolean; artOff?: boolean } = {}) => {
      const draws: { over: { viewport?: { x: number; y: number; width: number; height: number } } | undefined }[] = [];
      const logs: string[] = [];
      const loaders = {
        texture: async () => new Texture(),
        model: async () => {
          if (opts.fail) throw new Error('404');
          const root = new Object3D();
          const camera = new PerspectiveCamera(60, 4 / 3);
          camera.name = 'camera:main';
          camera.userData = { shiftY: 100, fovY: 1, width: 640, height: 480 };
          root.add(camera);
          return root;
        },
      };
      const s = await Session.start(withShipArt(), { opening: false, ship3d: true, artLoaders: loaders, artOff: opts.artOff, log: (level, m) => logs.push(`${level}: ${m}`), render: (_stage, over) => draws.push({ over }) });
      const canvas = document.createElement('canvas');
      canvas.getBoundingClientRect = () => rect(0, 0, 800, 600);
      s.bind(canvas);
      const port = s.shipPort();
      port.screenRect(() => rect(80, 60.4, 640, 480));
      return { s, draws, logs, port };
    };
    const settle = () => new Promise(resolve => setTimeout(resolve, 0));

    it('renders the set with the box viewport once it has loaded; the stage alone before', async () => {
      const { s, draws, port } = await setup();
      s.frame(0.1);
      expect(draws.at(-1)?.over).toBeUndefined();
      await settle();
      expect(port.shipArt('bridge')).toBe(true);
      s.frame(0.1);
      expect(draws.at(-1)?.over?.viewport).toEqual({ x: 80, y: 600 - 540, width: 640, height: 480 });
    });

    it('renders the stage as before with art off, and when no box is registered', async () => {
      const off = await setup({ artOff: true });
      off.s.frame(0.1);
      await settle();
      off.s.frame(0.1);
      expect(off.draws.every(d => d.over === undefined)).toBe(true);
      expect(off.port.shipArt('bridge')).toBe(false);
      const none = await setup();
      none.port.screenRect(null);
      none.s.frame(0.1);
      await settle();
      none.s.frame(0.1);
      expect(none.draws.every(d => d.over === undefined)).toBe(true);
    });

    it('stands the crew cards on the set, takes them off with the viewscreen and puts them back', async () => {
      const objects = '[{ object: data, x: 1, y: 2, depth: 0, file: d.spr }]';
      const ship = { ...SHIP, 'ship.yaml': SHIP['ship.yaml'].replace('objects: []', `objects: ${objects}`) };
      const base = withShipArt();
      const shipPkg: GamePackage = {
        ...pkg(ship),
        assets: new AssetIndex([['art/ship/bridge.glb', '/bridge.glb'], ['art/ship/crew/d.webp', '/d.webp']]),
        presentation: {
          ...base.presentation,
          art: { ...base.presentation.art, cards: { 'bridge.data': { image: 'art/ship/crew/d.webp', frames: 1, anchor: [0.5, 1], anims: {} } } },
        },
      };
      const loaders = {
        texture: async () => { const t = new Texture(); t.image = { width: 98, height: 176 }; return t; },
        model: async () => {
          const root = new Object3D();
          const camera = new PerspectiveCamera(60, 4 / 3);
          camera.name = 'camera:main';
          camera.position.set(0, 0, 10);
          camera.userData = { shiftY: 0, fovY: 1, width: 640, height: 480 };
          root.add(camera);
          for (const object of ['data']) {
            const a = new Object3D();
            a.name = `card${object}`;
            a.userData = { name: `card:${object}`, object, depth: 0 };
            root.add(a);
          }
          return root;
        },
      };
      const scenes: Object3D[] = [];
      const s = await Session.start(shipPkg, { opening: false, ship3d: true, artLoaders: loaders, render: (_stage, over) => { if (over?.scene) scenes.push(over.scene); } });
      const canvas = document.createElement('canvas');
      canvas.getBoundingClientRect = () => rect(0, 0, 800, 600);
      s.bind(canvas);
      const port = s.shipPort();
      port.screenRect(() => rect(80, 60, 640, 480));
      s.frame(0.1);
      await settle();
      const card = (object: string) => scenes.at(-1)!.getObjectByName(`card:${object}`);
      s.frame(0.1);
      expect(port.crewOnBridge()).toEqual(['data']);
      expect(card('data')?.visible).toBe(true);
      port.toggleViewscreen();
      s.frame(0.1);
      expect(card('data')?.visible).toBe(false);
      port.toggleViewscreen();
      s.frame(0.1);
      expect(card('data')?.visible).toBe(true);
    });

    it('warns once when the glb fails to load and keeps the flat panel', async () => {
      const { s, draws, logs, port } = await setup({ fail: true });
      for (let i = 0; i < 3; i++) {
        s.frame(0.1);
        await settle();
      }
      expect(port.shipArt('bridge')).toBe(false);
      expect(draws.every(d => d.over === undefined)).toBe(true);
      expect(logs.filter(l => l.startsWith('warn') && l.includes('flat panel'))).toHaveLength(1);
    });
  });
  describe('the bridge plate (R14)', () => {
    const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top }) as DOMRect;
    const settle = () => new Promise(resolve => setTimeout(resolve, 0));
    const objects = '[{ object: data, x: 1, y: 2, depth: 7, file: d.spr }]';
    const ship = { ...SHIP, 'ship.yaml': SHIP['ship.yaml'].replace('objects: []', `objects: ${objects}`) };
    const plateEntry = { plate: 'art/ship/bridge/plate.webp', areas: {}, crew: [{ object: 'data', at: [240, 365] as [number, number], depth: 7 }], camera: 'camera:main', gltf: 'art/ship/bridge.glb' };
    const plateGame = (entry: object = plateEntry): GamePackage => {
      const base = pkg(ship);
      return {
        ...base,
        assets: new AssetIndex([['art/ship/bridge/plate.webp', '/p.webp'], ['art/ship/bridge.glb', '/bridge.glb'], ['art/ship/crew/d.webp', '/d.webp']]),
        presentation: {
          ...base.presentation,
          art: { rooms: {}, cards: { 'bridge.data': { image: 'art/ship/crew/d.webp', frames: 1, anchor: [0.5, 1], pixelHeight: 282, anims: {} } }, ship: { bridge: entry as never } },
        },
      };
    };
    const start = async (parts: Partial<SessionParts> = {}, entry?: object, game?: GamePackage) => {
      const calls: string[] = [];
      const draws: { scene: Object3D; camera: unknown; viewport?: { x: number; y: number; width: number; height: number } }[] = [];
      const logs: string[] = [];
      const loaders = {
        texture: async (url: string) => {
          calls.push(`texture ${url}`);
          if (url === '/bad.webp') throw new Error('404');
          const t = new Texture();
          t.image = { width: 98, height: 282 };
          return t;
        },
        model: async (url: string) => {
          calls.push(`model ${url}`);
          const root = new Object3D();
          const camera = new PerspectiveCamera(60, 4 / 3);
          camera.name = 'camera:main';
          camera.userData = { shiftY: 0, fovY: 1, width: 640, height: 480 };
          root.add(camera);
          return root;
        },
      };
      const s = await Session.start(game ?? plateGame(entry), { opening: false, artLoaders: loaders, log: (level, m) => logs.push(`${level}: ${m}`), render: (_stage, over) => { if (over) draws.push(over as never); }, ...parts });
      const canvas = document.createElement('canvas');
      canvas.getBoundingClientRect = () => rect(0, 0, 800, 600);
      s.bind(canvas);
      const port = s.shipPort();
      port.screenRect(() => rect(80, 60, 640, 480));
      return { s, port, calls, draws, logs };
    };

    it('on the bridge with a plate, frame() renders the plate scene with the box viewport and places a card per art.ship.bridge.crew entry with art', async () => {
      const { s, port, draws } = await start();
      s.frame(0.1);
      expect(draws).toHaveLength(0);
      await settle();
      expect(port.shipArt('bridge')).toBe(true);
      expect(port.shipPlate('bridge')).toEqual({ areas: {} });
      s.frame(0.1);
      const last = draws.at(-1)!;
      expect(last.viewport).toEqual({ x: 80, y: 600 - 540, width: 640, height: 480 });
      expect((last.camera as { isOrthographicCamera?: boolean }).isOrthographicCamera).toBe(true);
      const card = last.scene.getObjectByName('card:data')!;
      expect(card.renderOrder).toBe(1000 - 7);
      expect(card.position.x).toBeCloseTo(240);
      expect(card.position.y - (card.scale.y / 2)).toBeCloseTo(-365);
    });

    describe('moving between stations (B5)', () => {
      /** The bridge's plate and the transporter's, which loads when the test says. */
      const twoStations = (): GamePackage => {
        const base = plateGame();
        return {
          ...base,
          assets: new AssetIndex([['art/ship/bridge/plate.webp', '/p.webp'], ['art/ship/crew/d.webp', '/d.webp'], ['art/ship/transporter/plate.webp', '/tp.webp']]),
          presentation: { ...base.presentation, art: { ...base.presentation.art!, ship: { bridge: plateEntry as never, transporter: { plate: 'art/ship/transporter/plate.webp', areas: {}, crew: [], camera: 'camera:main' } as never } } },
        };
      };
      const begin = async (parts: Partial<SessionParts> = {}) => {
        let release: () => void = () => {};
        const gate = new Promise<void>(r => { release = r; });
        const calls: string[] = [];
        const texture = async (url: string) => {
          calls.push(`texture ${url}`);
          if (url === '/tp.webp') await gate;
          const t = new Texture();
          t.image = { width: 98, height: 282 };
          return t;
        };
        const run = await start({ artLoaders: { texture, model: async () => new Object3D() }, ...parts }, undefined, twoStations());
        run.s.frame(0.1);
        await settle();
        run.s.frame(0.1);
        return { ...run, release, calls, bridge: run.draws.at(-1)!.scene };
      };

      it('a turbolift move keeps the old station drawn until the new one is ready', async () => {
        const { s, port, draws, release, bridge } = await begin();
        expect(bridge.getObjectByName('card:data')).toBeDefined();
        await port.station('transporter');
        // (the transporter's flat panel has no picture box: the bridge's goes, and its place is kept)
        port.screenRect(null);
        const before = draws.length;
        s.frame(0.1);
        // (the bridge's picture, as it was, in the box; the transporter's panel hidden over it, not its flat look)
        expect(draws).toHaveLength(before + 1);
        expect(draws.at(-1)!.scene).toBe(bridge);
        expect(draws.at(-1)!.viewport).toEqual({ x: 80, y: 600 - 540, width: 640, height: 480 });
        expect([port.shipHeld(), port.shipArt('transporter')]).toEqual([true, false]);
        release();
        await settle();
        port.screenRect(() => rect(80, 60, 640, 480));
        s.frame(0.1);
        expect(draws.at(-1)!.scene).not.toBe(bridge);
        expect([port.shipHeld(), port.shipArt('transporter')]).toEqual([false, true]);
        // (on a desktop the bridge's set was kept: back there it shows at once, the same set)
        await port.station('bridge');
        s.frame(0.1);
        expect(draws.at(-1)!.scene).toBe(bridge);
        expect(port.shipHeld()).toBe(false);
      });

      it("lets the held station go after 1.5 s: the new station's panel shows, and its picture comes when it loads", async () => {
        const { s, port, draws, release, bridge } = await begin();
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
          await port.station('transporter');
          port.screenRect(null);
          s.frame(0.1);
          expect([port.shipHeld(), draws.at(-1)!.scene === bridge]).toEqual([true, true]);
          vi.advanceTimersByTime(1499);
          s.frame(0.1);
          expect(port.shipHeld()).toBe(true);
          vi.advanceTimersByTime(1);
          const before = draws.length;
          s.frame(0.1);
          // (the flat panel, with no box: nothing is drawn in one)
          expect([port.shipHeld(), draws.length]).toEqual([false, before]);
        } finally {
          vi.useRealTimers();
        }
        release();
        await settle();
        port.screenRect(() => rect(80, 60, 640, 480));
        s.frame(0.1);
        expect([port.shipArt('transporter'), draws.at(-1)!.scene !== bridge]).toEqual([true, true]);
      });

      it("the hold's 1.5 s counts from the change, not from the next render", async () => {
        const { s, port, draws, bridge } = await begin();
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
          await port.station('transporter');
          port.screenRect(null);
          // (no frame and no panel look for a second after the move)
          vi.advanceTimersByTime(1000);
          s.frame(0.1);
          expect([port.shipHeld(), draws.at(-1)!.scene === bridge]).toEqual([true, true]);
          vi.advanceTimersByTime(499);
          expect(port.shipHeld()).toBe(true);
          vi.advanceTimersByTime(1);
          expect(port.shipHeld()).toBe(false);
        } finally {
          vi.useRealTimers();
        }
      });

      it("lets the held station go at once when the new station's picture fails", async () => {
        const { s, port, calls } = await begin({ artLoaders: { texture: async (url: string) => { if (url === '/tp.webp') throw new Error('404'); const t = new Texture(); t.image = { width: 98, height: 282 }; return t; }, model: async () => new Object3D() } });
        await port.station('transporter');
        s.frame(0.1);
        await settle();
        s.frame(0.1);
        expect([port.shipHeld(), port.shipArt('transporter')]).toEqual([false, false]);
        void calls;
      });

      it("on a phone the last station's set is held while the next loads, then freed as today", async () => {
        const { s, port, draws, release, bridge } = await begin({ lowRes: true });
        await port.station('transporter');
        const before = draws.length;
        s.frame(0.1);
        expect(draws).toHaveLength(before + 1);
        expect(draws.at(-1)!.scene).toBe(bridge);
        release();
        await settle();
        s.frame(0.1);
        expect(draws.at(-1)!.scene).not.toBe(bridge);
        expect(bridge.children).toHaveLength(0);
      });

      it("opening the turbolift's list starts loading its stations, but not on a phone", async () => {
        const desk = await begin();
        desk.port.preloadStations(['transporter']);
        expect(desk.calls).toContain('texture /tp.webp');
        const phone = await begin({ lowRes: true });
        phone.port.preloadStations(['transporter']);
        expect(phone.calls).not.toContain('texture /tp.webp');
      });
    });

    it('without ship3d, a station with a plate and a gltf never calls loaders.model; with ship3d it loads the set', async () => {
      const plain = await start();
      plain.s.frame(0.1);
      await settle();
      expect(plain.calls.some(c => c.startsWith('model'))).toBe(false);
      const dev = await start({ ship3d: true });
      dev.s.frame(0.1);
      await settle();
      expect(dev.calls).toContain('model /bridge.glb');
      expect(dev.calls.some(c => c.includes('p.webp'))).toBe(false);
      expect(dev.port.shipPlate('bridge')).toBeNull();
    });

    it('the crew cards hide while the viewscreen is up and come back after', async () => {
      const { s, port, draws } = await start();
      s.frame(0.1);
      await settle();
      const card = () => draws.at(-1)!.scene.getObjectByName('card:data');
      s.frame(0.1);
      expect(card()?.visible).toBe(true);
      port.toggleViewscreen();
      s.frame(0.1);
      expect(card()?.visible).toBe(false);
      port.toggleViewscreen();
      s.frame(0.1);
      expect(card()?.visible).toBe(true);
    });

    it('a plate that fails to load warns once and the flat panel stays', async () => {
      const bad = await start({ artLoaders: { texture: async () => { throw new Error('404'); }, model: async () => new Object3D() } });
      for (let i = 0; i < 3; i++) {
        bad.s.frame(0.1);
        await settle();
      }
      expect(bad.port.shipArt('bridge')).toBe(false);
      expect(bad.draws).toHaveLength(0);
      expect(bad.logs.filter(l => l.startsWith('warn') && l.includes('flat panel'))).toHaveLength(1);
    });

    it("frees the plate when the team leaves the ship's picture: art off drops it", async () => {
      const { s, port, draws } = await start();
      s.frame(0.1);
      await settle();
      s.frame(0.1);
      const scene = draws.at(-1)!.scene;
      expect(scene.children.length).toBeGreaterThan(0);
      s.stage.setDebug({ art: false });
      s.frame(0.1);
      expect(scene.children).toHaveLength(0);
      expect(port.shipArt('bridge')).toBe(false);
    });

    describe('the transporter plate and the padded crew (R16)', () => {
      const pads = '[{ rect: [225, 85, 276, 231], stand: [250, 231], scale: 240 }, { rect: [378, 85, 429, 231], stand: [404, 231], scale: 240 }, { rect: [276, 87, 327, 233], stand: [300, 229], scale: 236 }, { rect: [327, 87, 378, 233], stand: [348, 229], scale: 236 }]';
      const withPads = { ...SHIP, 'ship.yaml': SHIP['ship.yaml'].replace('targets: [], pads: []', `targets: [], pads: ${pads}`) };
      // (the standing animation's cell is 4x the original's pixels: 150 px high here)
      const standing = { url: 'art/cards/picard/24.webp', frames: 2, cell: [400, 600] as [number, number], anchor: [0.5, 1] as [number, number], delays: [100, 100], loop: true };
      // (the executable's own walk: in from the door at the left, and out again)
      const walk = 'walkOn: [{ x: 38, y: 289, direction: 0, scale: 256 }, { x: 290, y: 277, direction: 3, scale: 256 }, { x: 326, y: 248, direction: 3, scale: 256 }, { x: 326, y: 243, direction: 0, scale: 256 }, { x: 0, y: 0, direction: 0, scale: 244 }, { x: 0, y: 0, direction: 0, scale: 244 }], walkOff: [{ x: 0, y: 0, direction: 0, scale: 0 }, { x: 326, y: 248, direction: 9, scale: 244 }, { x: 290, y: 277, direction: 9, scale: 256 }, { x: 38, y: 289, direction: 9, scale: 256 }]';
      const withWalk = { ...SHIP, 'ship.yaml': SHIP['ship.yaml'].replace('targets: [], pads: []', `targets: [], pads: ${pads}, ${walk}`) };
      const transporterGame = (cards: Record<string, object>, files = withPads): GamePackage => {
        const base = pkg(files);
        return {
          ...base,
          assets: new AssetIndex([['art/ship/transporter/plate.webp', '/tp.webp'], ['art/cards/picard/24.webp', '/p24.webp'], ['art/cards/picard.png', '/picard.png']]),
          presentation: {
            ...base.presentation,
            art: { rooms: {}, cards: cards as never, ship: { transporter: { plate: 'art/ship/transporter/plate.webp', areas: {}, crew: [], camera: 'camera:main' } as never } },
          },
        };
      };
      const picardCard = { image: 'art/cards/picard.png', frames: 1, anchor: [0.5, 1], pixelHeight: 150, anims: { 24: standing } };
      const begin = async (cards: Record<string, object>, files = withPads) => {
        const draws: { scene: Object3D }[] = [];
        const loaders = { texture: async () => { const t = new Texture(); t.image = { width: 98, height: 282 }; return t; }, model: async () => new Object3D() };
        const s = await Session.start(transporterGame(cards, files), { opening: false, artLoaders: loaders, render: (_stage, over) => { if (over) draws.push(over as never); } });
        const canvas = document.createElement('canvas');
        canvas.getBoundingClientRect = () => rect(0, 0, 800, 600);
        s.bind(canvas);
        const port = s.shipPort();
        port.screenRect(() => rect(80, 60, 640, 480));
        await port.station('transporter');
        const frame = async () => { s.frame(0.1); await settle(); await settle(); s.frame(0.1); return draws.at(-1)!.scene; };
        await frame();
        return { s, port, frame };
      };

      it('lists the pads read-only, with the crew on them', async () => {
        const { port } = await begin({});
        expect(port.transporterPads().map(p => [p.pad, p.stand, p.scale, p.crew])).toEqual([[0, [250, 231], 240, null], [1, [404, 231], 240, null], [2, [300, 229], 236, null], [3, [348, 229], 236, null]]);
        await port.pad('picard');
        expect(port.transporterPads()[0]).toEqual({ pad: 0, rect: [225, 85, 276, 231], stand: [250, 231], scale: 240, crew: 'picard' });
      });

      it('a padded crew member with a card stands on that pad at pixelHeight * scale / 256 original px, playing anim 0x18; unpadding removes the card', async () => {
        const { port, frame } = await begin({ picard: picardCard });
        expect((await frame()).getObjectByName('card:pad.0')).toBeUndefined();
        await port.pad('picard');
        const scene = await frame();
        const card = scene.getObjectByName('card:pad.0') as Mesh;
        expect(card).toBeDefined();
        expect(card.renderOrder).toBe(1000 - 231);
        // (150 px of the card's pixelHeight, at 240/256)
        expect(card.scale.y).toBeCloseTo((150 * 240) / 256);
        expect(card.position.x).toBeCloseTo(250);
        expect(card.position.y - card.scale.y / 2).toBeCloseTo(-231);
        await port.unpad(0);
        expect((await frame()).getObjectByName('card:pad.0')).toBeUndefined();
      });

      it('a crew member put on a pad walks in from the door to it, drawn at the door end of the room first, and walks out again when dismissed (transporter.cpp walk)', async () => {
        const { s, port, frame } = await begin({ picard: picardCard }, withWalk);
        await port.pad('picard');
        let scene = await frame();
        const card = scene.getObjectByName('card:pad.0') as Mesh;
        expect(card).toBeDefined();
        // (the door's end: the first waypoint, a moment into the walk, and not yet on the pad at (250, 231))
        expect(card.position.x).toBeLessThan(120);
        expect(card.position.y - card.scale.y / 2).toBeLessThan(-270);
        expect(port.transporter()!.walking).toEqual([0]);
        expect(port.transporter()!.room.pads[0]).toBe('picard');
        // (the doorway's wall is over them)
        expect(scene.getObjectByName('occluder')).toBeDefined();
        for (let i = 0; i < 50; i++) s.frame(0.1);
        scene = await frame();
        const there = scene.getObjectByName('card:pad.0') as Mesh;
        expect(there.position.x).toBeCloseTo(250);
        expect(there.position.y - there.scale.y / 2).toBeCloseTo(-231);
        expect(there.scale.y).toBeCloseTo((150 * 240) / 256);
        expect(port.transporter()!.walking).toEqual([]);
        // (dismissed: still on the pad, walking, and back in the list only when they have gone)
        await port.unpad(0);
        expect(port.transporter()!.room.pads[0]).toBe('picard');
        expect(port.transporter()!.walking).toEqual([0]);
        for (let i = 0; i < 50; i++) s.frame(0.1);
        scene = await frame();
        expect(port.transporter()!.room.pads[0]).toBeNull();
        expect(port.transporter()!.room.crew).toContain('picard');
        expect(scene.getObjectByName('card:pad.0')).toBeUndefined();
      });

      it('a crew member without a card gets none and is still listed', async () => {
        const { port, frame } = await begin({ picard: picardCard });
        await port.pad('data');
        const scene = await frame();
        expect(scene.getObjectByName('card:pad.0')).toBeUndefined();
        expect(port.transporterPads()[0].crew).toBe('data');
        expect(port.transporter()!.room.pads[0]).toBe('data');
      });
    });

    describe('the viewscreen plate and its window (R15)', () => {
      const vsEntry = { plate: 'art/ship/viewscreen/plate.webp', window: 'art/ship/viewscreen/window.webp', areas: { name: [66, 386, 460, 90], window: [59, 69, 521, 240] }, crew: [], camera: 'camera:main' };
      const withViewscreen = (): GamePackage => {
        const base = plateGame();
        return {
          ...base,
          assets: new AssetIndex([['art/ship/bridge/plate.webp', '/p.webp'], ['art/ship/bridge.glb', '/bridge.glb'], ['art/ship/crew/d.webp', '/d.webp'], ['art/ship/viewscreen/plate.webp', '/vp.webp'], ['art/ship/viewscreen/window.webp', '/vw.webp'], ['art/ship/view/viewfere.webp', '/viewfere.webp']]),
          presentation: { ...base.presentation, art: { ...base.presentation.art, ship: { ...base.presentation.art.ship, viewscreen: vsEntry as never } } },
        };
      };
      /** A renderer that only records: the targets it was given and what it drew into them. */
      const fakeRenderer = () => {
        const targets: unknown[] = [];
        const renders: { target: unknown; scene: Object3D }[] = [];
        let current: unknown = null;
        const r = {
          getRenderTarget: () => current,
          setRenderTarget: (t: unknown) => { current = t; if (t !== null && !targets.includes(t)) targets.push(t); },
          render: (scene: Object3D) => renders.push({ target: current, scene }),
        };
        return { r: r as never, targets: targets as { width: number; height: number; dispose(): void; texture: Texture }[], renders };
      };
      const begin = async (game: GamePackage = withViewscreen()) => {
        const draws: { scene: Object3D; before?: (r: never) => void; viewport?: { width: number; height: number } }[] = [];
        const textures: string[] = [];
        const byUrl = new Map<string, Texture>();
        const loaders = {
          texture: async (url: string) => {
            textures.push(url);
            const t = new Texture();
            byUrl.set(url, t);
            t.image = { width: 98, height: 282 };
            return t;
          },
          model: async () => new Object3D(),
        };
        const s = await Session.start(game, { opening: false, artLoaders: loaders, render: (_stage, over) => { if (over) draws.push(over as never); } });
        const canvas = document.createElement('canvas');
        const boxes = { current: rect(80, 60, 640, 480) };
        canvas.getBoundingClientRect = () => rect(0, 0, 800, 600);
        s.bind(canvas);
        const port = s.shipPort();
        port.screenRect(() => boxes.current);
        return { s, port, draws, boxes, textures, byUrl };
      };
      /**
       * The viewscreen's game with a view of the Enterprise's (sprite vwtest, animation 0 a 3-frame sheet of 4x2 cells on 100 ms delays, in two
       * pages: frames 0 and 2 side by side on page 0, frame 1 on page 1); `sheet` false leaves its pages out of the assets.
       */
      const withView = (sheet: boolean): GamePackage => {
        const base = withViewscreen();
        const views = {
          vwtest: {
            0: {
              images: ['art/ship/view/vwtest.0.0.webp', 'art/ship/view/vwtest.0.1.webp'], pages: [[8, 2], [4, 2]], cells: [[0, 0, 0, 4, 2, 0, 0], [1, 0, 0, 4, 2, 0, 0], [0, 4, 0, 4, 2, 0, 0]],
              frames: 3, scale: 1, cell: [4, 2], anchor: [0.5, 1], delays: [100, 100, 100], loop: true,
            },
          },
        };
        return {
          ...base,
          assets: new AssetIndex([...['art/ship/bridge/plate.webp', 'art/ship/bridge.glb', 'art/ship/crew/d.webp', 'art/ship/viewscreen/plate.webp', 'art/ship/viewscreen/window.webp', 'art/ship/view/vwtest.webp'].map(p => [p, `/${p}`] as [string, string]), ...(sheet ? [['art/ship/view/vwtest.0.0.webp', '/vwtest.0.0.webp'], ['art/ship/view/vwtest.0.1.webp', '/vwtest.0.1.webp']] as [string, string][] : [])]),
          presentation: { ...base.presentation, art: { ...base.presentation.art, ship: { ...base.presentation.art.ship, viewscreen: { ...vsEntry, views } as never } } },
        };
      };
      /** Puts the view up on the bridge's viewscreen: the Enterprise playing its animation 774, which is sprite vwtest. */
      const viewUp = async (game: GamePackage) => {
        const b = await begin(game);
        const data = b.s.world.content.ship!.data;
        data.viewscreenSprites = { 774: 'vwtest' };
        b.s.world.state.objects[data.astro.enterprise]!.anim = 774;
        b.s.frame(0.1);
        await settle();
        b.port.toggleViewscreen();
        b.s.frame(0.1);
        await settle();
        // (the window layer, drawn once the plates are in, chooses the picture; its files come in after)
        b.s.frame(0.1);
        await settle();
        const space = (b.s as unknown as { space: SpaceView }).space;
        return { ...b, space };
      };

      it('the viewscreen steps through the view\'s frames, on the sprite\'s own delays', async () => {
        const { s, port, space, textures } = await viewUp(withView(true));
        expect(port.viewscreenImage()).toEqual({ kind: 'sprite', sprite: 'vwtest' });
        expect(textures).toEqual(expect.arrayContaining(['/vwtest.0.0.webp', '/vwtest.0.1.webp']));
        expect(textures).not.toContain('/art/ship/view/vwtest.webp');
        expect(space.shown()).toBe('sprite');
        expect(space.sheetFrame()).toEqual({ anim: 0, index: 0 });
        const seen: number[] = [];
        for (let i = 0; i < 4; i++) {
          s.frame(0.1);
          seen.push(space.sheetFrame()!.index);
        }
        // (100 ms a frame, and the animation jumps to itself: round again)
        expect(seen).toEqual([1, 2, 0, 1]);
      });

      /** The viewscreen's sprite quad (the mesh drawn first over the picture) and its map. */
      const spriteQuad = (space: SpaceView) => space.scene.children.flatMap(c => c.children).find(o => o.renderOrder === 1) as unknown as { material: { map: Texture | null }; visible: boolean };

      it('the viewscreen draws the frame from the page that holds it', async () => {
        const { s, space, byUrl } = await viewUp(withView(true));
        const [page0, page1] = [byUrl.get('/vwtest.0.0.webp')!, byUrl.get('/vwtest.0.1.webp')!];
        const quad = spriteQuad(space);
        // frame 0: the left half of page 0
        expect(quad.material.map).toBe(page0);
        expect([page0.offset.x, page0.repeat.x]).toEqual([0, 0.5]);
        // frame 1: all of page 1
        s.frame(0.1);
        expect(quad.material.map).toBe(page1);
        expect([page1.offset.x, page1.repeat.x]).toEqual([0, 1]);
        // frame 2: the right half of page 0
        s.frame(0.1);
        expect(quad.material.map).toBe(page0);
        expect([page0.offset.x, page0.repeat.x]).toEqual([0.5, 0.5]);
        expect(quad.visible).toBe(true);
      });

      it('pages are freed when the view changes', async () => {
        const { s, space, byUrl } = await viewUp(withView(true));
        const pages = [byUrl.get('/vwtest.0.0.webp')!, byUrl.get('/vwtest.0.1.webp')!];
        const spies = pages.map(p => vi.spyOn(p, 'dispose'));
        // the Enterprise's animation stops: the viewscreen shows what the ship is doing, and the view's pages go
        s.world.state.objects[s.world.content.ship!.data.astro.enterprise]!.anim = 0xffff;
        s.frame(0.1);
        await settle();
        expect(space.shown()).not.toBe('sprite');
        for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
        expect(spriteQuad(space).material.map).toBeNull();
        expect(space.sheetFrame()).toBeNull();
      });

      it('a missing sheet falls back to the first frame', async () => {
        const { space, textures } = await viewUp(withView(false));
        expect(textures).toContain('/art/ship/view/vwtest.webp');
        expect(space.shown()).toBe('sprite');
        expect(space.sheetFrame()).toBeNull();
      });

      it('one target is allocated when a window first shows, rendered only while one shows, resized only on a size change, and freed when the team leaves the ship', async () => {
        const { s, port, draws, boxes } = await begin();
        const gl = fakeRenderer();
        s.frame(0.1);
        await settle();
        s.frame(0.1);
        // (the bridge alone: no window, nothing to draw into a target)
        expect(draws.at(-1)!.before).toBeUndefined();
        port.toggleViewscreen();
        s.frame(0.1);
        await settle();
        s.frame(0.1);
        const before = draws.at(-1)!.before!;
        expect(before).toBeDefined();
        before(gl.r);
        before(gl.r);
        expect(gl.targets).toHaveLength(1);
        expect(gl.renders).toHaveLength(2);
        expect(gl.renders.every(x => x.target === gl.targets[0])).toBe(true);
        // the window's box is 521x240 of 640x480, drawn in 640x480 pixels
        expect([gl.targets[0]!.width, gl.targets[0]!.height]).toEqual([521, 240]);
        // (the same size: the same target, not reallocated)
        for (let i = 0; i < 3; i++) s.frame(0.1);
        draws.at(-1)!.before!(gl.r);
        expect(gl.targets).toHaveLength(1);
        // a larger box resizes the same target
        boxes.current = rect(0, 0, 1280, 960);
        const big = { ...gl };
        s.frame(0.1);
        draws.at(-1)!.before!(big.r);
        expect(gl.targets).toHaveLength(1);
        expect([gl.targets[0]!.width, gl.targets[0]!.height]).toEqual([1042, 480]);
        // (a resize reallocates the GPU side inside three's setSize, so the spy starts after it)
        const dispose = vi.spyOn(gl.targets[0]!, 'dispose');
        // the viewscreen goes down: no window, no draw hook
        port.toggleViewscreen();
        s.frame(0.1);
        expect(draws.at(-1)!.before).toBeUndefined();
        expect(dispose).not.toHaveBeenCalled();
        // art off (as the team leaving does): the target is freed
        s.stage.setDebug({ art: false });
        s.frame(0.1);
        expect(dispose).toHaveBeenCalledTimes(1);
      });

      it('on the bridge with the viewscreen up and both plates, the frame layer is set and the crew are hidden', async () => {
        const { s, port, draws } = await begin();
        s.frame(0.1);
        await settle();
        s.frame(0.1);
        expect(draws.at(-1)!.scene.getObjectByName('frame')).toBeUndefined();
        port.toggleViewscreen();
        s.frame(0.1);
        await settle();
        s.frame(0.1);
        const scene = draws.at(-1)!.scene;
        expect(scene.getObjectByName('frame')).toBeDefined();
        expect(scene.getObjectByName('window')).toBeDefined();
        expect(scene.getObjectByName('card:data')?.visible).toBe(false);
        port.toggleViewscreen();
        s.frame(0.1);
        expect(draws.at(-1)!.scene.getObjectByName('frame')).toBeUndefined();
        expect(draws.at(-1)!.scene.getObjectByName('card:data')?.visible).toBe(true);
      });

      it('a crew member saying a voiced line with text off (no box) still plays the talk animation (kAnimShipTalk)', async () => {
        const { s } = await begin();
        s.frame(0.1);
        await settle();
        s.frame(0.1);
        const sets = (s as unknown as { shipSets: Map<string, { station: string; set: { playCards(pick: (key: string) => number | null): void } | null }> }).shipSets;
        const bridge = [...sets.values()].find(e => e.station === 'bridge' && e.set)!.set!;
        const picks: (number | null)[] = [];
        const play = bridge.playCards.bind(bridge);
        bridge.playCards = pick => { picks.push(pick('data')); play(pick); };
        s.store.say({ who: 'data', name: 'Data', text: 'A synthetic line.' }, false);
        s.frame(0.1);
        s.store.endSay();
        s.frame(0.1);
        expect(picks.slice(-2)).toEqual([2, 0]);
      });

      it('a hail shows the viewscreen station\'s plate with its window, and the hailing frame is found by path in the asset index', async () => {
        const { s, port, draws } = await begin();
        s.world.content.ship!.data.contacts.comms.splice(0, 1, { object: 'w.planet', sprite: true, file: 'viewfere' });
        s.world.viewscreen = { target: 'w.planet' };
        s.frame(0.1);
        await settle();
        s.frame(0.1);
        expect(port.viewscreenImage()).toEqual({ kind: 'sprite', sprite: 'viewfere' });
        expect(draws.at(-1)!.scene.getObjectByName('window')).toBeDefined();
        expect(port.shipPlate('viewscreen')).toEqual({ areas: vsEntry.areas });
      });
    });

    describe('viewscreenImage (R7, unity.cpp:604-640)', () => {
      it('follows the sim: warp or space in transit, space without a sector, else a planet; a hailer\'s sprite on the viewscreen only', async () => {
        const { s, port } = await start();
        const ship = s.world.state.ship;
        expect(port.viewscreenImage()).toEqual({ kind: 'space' });
        ship.location = { ...ship.location, sector: 5, star: 2, planet: 1 };
        const planet = port.viewscreenImage();
        expect(planet.kind).toBe('planet');
        const transit = { from: { x: 0, y: 0, z: 0 }, to: { x: 1, y: 1, z: 1 }, orbit: 0, destination: ship.location, destType: 0, destStarId: 0, warp: true, speed: 100, startTick: 0, ticks: 10 };
        ship.transit = transit;
        expect(port.viewscreenImage()).toEqual({ kind: 'warp' });
        ship.transit = { ...transit, warp: false };
        expect(port.viewscreenImage()).toEqual({ kind: 'space' });
        ship.transit = null;
        // a hailer with a picture shows on the viewscreen's own station, not on the bridge's
        s.world.content.ship!.data.contacts.comms.splice(0, 1, { object: 'w.planet', sprite: true, file: 'viewadmr' });
        s.world.viewscreen = { target: 'w.planet' };
        expect(port.viewscreenImage()).toEqual({ kind: 'sprite', sprite: 'viewadmr' });
        s.world.viewscreen = null;
        expect(port.viewscreenImage()).toEqual(planet);
      });

      it('the planet colours are stable for a location and never touch the sim rng', async () => {
        const { s, port } = await start();
        const ship = s.world.state.ship;
        ship.location = { ...ship.location, sector: 5, star: 2, planet: 1 };
        const seed = s.world.state.rngSeed;
        const a = port.viewscreenImage();
        const b = port.viewscreenImage();
        expect(a).toEqual(b);
        expect(s.world.state.rngSeed).toBe(seed);
        expect(planetColours(5, 2, 1)).toEqual(planetColours(5, 2, 1));
        expect(planetColours(5, 2, 1)).not.toEqual(planetColours(6, 2, 1));
        // the brighter colour is first, and both are colours
        const lum = (c: string): number => parseInt(c.slice(1, 3), 16) + parseInt(c.slice(3, 5), 16) + parseInt(c.slice(5, 7), 16);
        for (let i = 0; i < 40; i++) {
          const [x, y] = planetColours(i, i * 3, i % 4);
          expect(x).toMatch(/^#[0-9a-f]{6}$/);
          expect(lum(x)).toBeGreaterThanOrEqual(lum(y));
        }
      });
    });
  });

  describe('the astrogation plate and its map window (R17)', () => {
    const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top }) as DOMRect;
    const settle = () => new Promise(resolve => setTimeout(resolve, 0));
    const MAP: [number, number, number, number] = [10, 19, 379, 348];
    const AREAS = { map: MAP, info: [391, 90, 247, 272] as [number, number, number, number], controls: [491, 373, 119, 100] as [number, number, number, number] };
    const star = (id: number, x: number, y: number, z: number) => `{ id: ${id}, type: 0, seed: 0, x: ${x}, y: ${y}, z: ${z}, name: -S${id}-, range: 0, flags: 4, spectralClass: 0, magnitude: 0, orbitScale: 10, systemName: "", scriptedName: "", scriptedDescription: "", special: -1 }`;
    const files = {
      ...SHIP,
      'universe.yaml': SHIP['universe.yaml']
        .replace('sectors: []', 'sectors: [{ numStars: 3, numPhenomena: 0, alignment: 0, firstStar: 0, firstPhenomenon: 0, station: -1, description: "", name: -Area-, region: 0 }]')
        .replace('stars: []', `stars: [${star(7, 90, 90, 90)}, ${star(8, 60, 100, 70)}, ${star(9, 120, 80, 110)}]`).replace('flags: []', 'flags: [0, 0, 0, 0, 0, 0, 0, 1, 1, 1]').replace('planetOrbits: []', 'planetOrbits: [100000]'),
    };
    const game = (): GamePackage => {
      const base = pkg(files);
      return {
        ...base,
        assets: new AssetIndex([['art/ship/astrogation/plate.webp', '/a.webp']]),
        presentation: { ...base.presentation, art: { rooms: {}, cards: {}, ship: { astrogation: { plate: 'art/ship/astrogation/plate.webp', areas: AREAS, crew: [], camera: 'camera:main' } as never } } },
      };
    };
    type Draw = { scene: Object3D; camera: unknown; viewport?: { x: number; y: number; width: number; height: number }; after?: (r: unknown) => void };
    const begin = async (opts: { artOff?: boolean; dpr?: number; box?: DOMRect } = {}) => {
      if (opts.dpr) vi.stubGlobal('devicePixelRatio', opts.dpr);
      const draws: Draw[] = [];
      const loaders = { texture: async () => { const t = new Texture(); t.image = { width: 2560, height: 1920 }; return t; }, model: async () => new Object3D() };
      const s = await Session.start(game(), { opening: false, artOff: opts.artOff, artLoaders: loaders, render: (_stage, over) => { if (over) draws.push(over as never); } });
      const canvas = document.createElement('canvas');
      const dpr = opts.dpr ?? 1;
      canvas.getBoundingClientRect = () => rect(0, 0, 900, 700);
      Object.defineProperty(canvas, 'clientWidth', { value: 900 });
      Object.defineProperty(canvas, 'clientHeight', { value: 700 });
      s.bind(canvas);
      const port = s.shipPort();
      const box = opts.box ?? rect(130, 70, 640, 480);
      port.screenRect(() => box);
      await port.station('astrogation');
      for (let i = 0; i < 3; i++) { s.frame(0.1); await settle(); }
      s.frame(0.1);
      return { s, port, draws, canvas, dpr, box };
    };
    const pointer = (type: string, x: number, y: number, target: EventTarget) => target.dispatchEvent(Object.assign(new Event(type, { bubbles: true, cancelable: true }), { clientX: x, clientY: y, button: 0, pointerId: 1 }));
    const click = (canvas: HTMLElement, p: { x: number; y: number }) => { pointer('pointerdown', p.x, p.y, canvas); pointer('pointerup', p.x, p.y, window); };
    const wheel = (canvas: HTMLElement, x: number, y: number, deltaY: number) => canvas.dispatchEvent(Object.assign(new Event('wheel', { bubbles: true, cancelable: true }), { clientX: x, clientY: y, deltaY }));
    const camera = (s: Session) => (s as unknown as { map: { camera: { right: number; top: number } } }).map.camera;
    const zoomOf = (s: Session): number => (s as unknown as { map: { zoomFactor(): number } }).map.zoomFactor();

    it('does not start a station\'s load by being looked at: padBeams (the debug handle reads it each poll) leaves a transporter plate unloaded', async () => {
      const urls: string[] = [];
      const base = game();
      const withTransporter: GamePackage = {
        ...base,
        assets: new AssetIndex([['art/ship/astrogation/plate.webp', '/a.webp'], ['art/ship/transporter/plate.webp', '/t.webp']]),
        presentation: { ...base.presentation, art: { ...base.presentation.art!, ship: { ...base.presentation.art!.ship, transporter: { plate: 'art/ship/transporter/plate.webp', areas: AREAS, crew: [] } as never } } },
      };
      const loaders = { texture: async (url: string) => { urls.push(url); const t = new Texture(); t.image = { width: 2560, height: 1920 }; return t; }, model: async () => new Object3D() };
      const s = await Session.start(withTransporter, { opening: false, artLoaders: loaders, render: () => {} });
      s.bind(document.createElement('canvas'));
      for (let i = 0; i < 3; i++) { expect(s.padBeams()).toEqual({ cards: [], sparkles: [] }); s.frame(0.1); await settle(); }
      expect(urls.filter(u => u.includes('t.webp'))).toEqual([]);
    });

    it('draws the plate in the box, then the map in the map area alone, with the map\'s aspect following the area', async () => {
      const { s, port, draws } = await begin();
      expect(port.shipArt('astrogation')).toBe(true);
      expect(port.shipPlate('astrogation')).toEqual({ areas: AREAS });
      const last = draws.at(-1)!;
      expect((last.camera as { isOrthographicCamera?: boolean }).isOrthographicCamera).toBe(true);
      expect(last.viewport).toEqual({ x: 130, y: 700 - 550, width: 640, height: 480 });
      expect(last.after).toBeTypeOf('function');
      // (the plane of the window fills the camera: wide as the window is, 379 to 348)
      expect(camera(s).right / camera(s).top).toBeCloseTo(379 / 348, 5);
      // the hook draws the map in the area's rectangle of the buffer (x 140, y from the bottom 700 - 70 - 367 = 263), cleared with the map's background
      const calls: string[] = [];
      const r = {
        getPixelRatio: () => 1, autoClear: false,
        setViewport: (...a: number[]) => calls.push(`viewport ${a.join(' ')}`), setScissor: (...a: number[]) => calls.push(`scissor ${a.join(' ')}`),
        setScissorTest: (on: boolean) => calls.push(`test ${on}`), render: () => calls.push(`render clear=${r.autoClear}`),
      };
      last.after!(r);
      expect(calls).toEqual(['viewport 140 263 379 348', 'scissor 140 263 379 348', 'test true', 'render clear=true']);
      expect(r.autoClear).toBe(false);
    });

    it('with the plate, a pointer at a star\'s projected point inside the map area picks that star; with art off the same star at its own point', async () => {
      const on = await begin();
      const at = on.s.astroPoint(0, 1)!;
      expect(at).not.toBeNull();
      // (inside the map area, which is not the whole canvas)
      expect(at.x).toBeGreaterThan(140);
      expect(at.x).toBeLessThan(140 + 379);
      click(on.canvas, at);
      expect(on.port.selection()).toEqual({ sector: 0, star: 1 });
      const other = on.s.astroPoint(0, 2)!;
      click(on.canvas, other);
      expect(on.port.selection()).toEqual({ sector: 0, star: 2 });
      const off = await begin({ artOff: true });
      expect(off.port.shipArt('astrogation')).toBe(false);
      click(off.canvas, off.s.astroPoint(0, 1)!);
      expect(off.port.selection()).toEqual({ sector: 0, star: 1 });
    });

    it('picks the same star at dpr 2 and with a fractional box', async () => {
      const on = await begin({ dpr: 2, box: rect(130.3, 70.6, 640, 480) });
      for (const star of [0, 1, 2]) {
        click(on.canvas, on.s.astroPoint(0, star)!);
        expect(on.port.selection()).toEqual({ sector: 0, star });
      }
      vi.unstubAllGlobals();
    });

    it('a pointer outside the map area picks nothing, does not orbit, and the wheel does not zoom', async () => {
      const { s, port, canvas } = await begin();
      const chosen = port.selection();
      const turned = port.mapCamera();
      // (the info area is right of the map window: no star is near, so this is about the press itself)
      const outside = { x: 130 + 500, y: 70 + 200 };
      pointer('pointerdown', outside.x, outside.y, canvas);
      pointer('pointermove', outside.x + 40, outside.y + 30, canvas);
      pointer('pointerup', outside.x + 40, outside.y + 30, window);
      expect([port.mapCamera().azimuth, port.mapCamera().elevation]).toEqual([turned.azimuth, turned.elevation]);
      expect(port.selection()).toEqual(chosen);
      // (a press that starts in the map and is let go outside it picks nothing either)
      const star = s.astroPoint(0, 0)!;
      pointer('pointerdown', star.x, star.y, canvas);
      pointer('pointerup', outside.x, outside.y, window);
      expect(port.selection()).toEqual(chosen);
      wheel(canvas, outside.x, outside.y, 100);
      s.frame(0.1);
      expect(zoomOf(s)).toBe(1);
      // inside it the wheel zooms and a drag orbits
      wheel(canvas, star.x, star.y, 100);
      s.frame(0.1);
      expect(zoomOf(s)).toBeGreaterThan(1);
      const before = port.mapCamera().azimuth;
      pointer('pointerdown', star.x, star.y, canvas);
      pointer('pointermove', star.x + 40, star.y + 30, canvas);
      pointer('pointerup', star.x + 40, star.y + 30, window);
      s.frame(0.1);
      expect(port.mapCamera().azimuth).not.toBe(before);
    });

    it('opens on the Info tab with the sector the ship is in chosen, and shows a place the ship is at close up (AstrogationScreen::start)', async () => {
      const first = await begin();
      expect(first.port.mapCamera().panel).toBe('info');
      expect(first.port.mapCamera().view).toBe('galaxy');
      expect(first.port.selection()).toEqual({ sector: 292 });
      expect(first.port.astroText().title).toMatch(/ \d-\d-\d$/);
      // at a star: the sector view, with the star chosen and the cursor on it
      const draws: Draw[] = [];
      const loaders = { texture: async () => { const t = new Texture(); t.image = { width: 2560, height: 1920 }; return t; }, model: async () => new Object3D() };
      const s = await Session.start(game(), { opening: false, artLoaders: loaders, render: (_stage, over) => { if (over) draws.push(over as never); } });
      s.world.state.ship.location = { sector: 0, star: 1, planet: -1, moon: -1, station: -1, phenomenon: -1 };
      const canvas = document.createElement('canvas');
      canvas.getBoundingClientRect = () => rect(0, 0, 900, 700);
      s.bind(canvas);
      const port = s.shipPort();
      port.screenRect(() => rect(130, 70, 640, 480));
      await port.station('astrogation');
      for (let i = 0; i < 3; i++) { s.frame(0.1); await settle(); }
      expect(port.mapCamera().view).toBe('sector');
      expect(port.selection()).toEqual({ sector: 0, star: 1 });
      expect(port.mapCamera().cursorSector).toEqual([0, 0, 0]);
      expect(port.mapCamera().cursor).toEqual([60 % 20, 100 % 20, 70 % 20]);
      // (what is chosen is written up: the star's own paragraph)
      expect(port.selectionInfo().title).toBe('-S8-');
      expect(port.selectionInfo().lines[0]).toMatch(/^This is a class O0 star with an absolute magnitude of 0\.0\./);
    });

    it('chooses what a click lands on, moves the cursor to it, and the cursor arrows choose the sector they stop on in the galaxy view', async () => {
      const { s, port, canvas } = await begin();
      const at = s.astroPoint(0, 2)!;
      expect(at).not.toBeNull();
      click(canvas, at);
      expect(port.selection()).toEqual({ sector: 0, star: 2 });
      expect(port.mapCamera().cursor).toEqual([120 % 20, 80 % 20, 110 % 20]);
      // (the galaxy view's arrows move the sector: what is chosen is the sector alone)
      port.mapCursor(0, 1);
      expect(port.selection()).toEqual({ sector: 1 });
      expect(port.mapCamera().cursorSector).toEqual([1, 0, 0]);
      // (and the system view of a star that has not been scanned has nothing to choose, the star stays chosen)
      port.select({ sector: 0, star: 0 });
      port.mapView('system');
      s.frame(0.1);
      expect(port.selection()).toEqual({ sector: 0, star: 0 });
      expect(port.mapCamera().view).toBe('system');
    });

    it('with art off or no box the map fills the canvas as before: no `after`, the map itself is drawn', async () => {
      const { draws } = await begin({ artOff: true });
      const last = draws.at(-1)!;
      expect(last.viewport).toBeUndefined();
      expect(last.after).toBeUndefined();
      expect((last.camera as { isOrthographicCamera?: boolean }).isOrthographicCamera).toBe(true);
    });

    it('with a computer plate, the open computer draws it in the box (no map), and shipPlate gives its areas', async () => {
      const base = game();
      const cAreas = { rows: [14, 54, 155, 346] as [number, number, number, number], entry: [190, 53, 450, 305] as [number, number, number, number] };
      const withComputer: GamePackage = {
        ...base,
        assets: new AssetIndex([['art/ship/astrogation/plate.webp', '/a.webp'], ['art/ship/computer/plate.webp', '/c.webp']]),
        presentation: { ...base.presentation, art: { rooms: {}, cards: {}, ship: { astrogation: { plate: 'art/ship/astrogation/plate.webp', areas: AREAS, crew: [], camera: 'camera:main' }, computer: { plate: 'art/ship/computer/plate.webp', areas: cAreas, crew: [], camera: 'camera:main' } } as never } },
      };
      const draws: Draw[] = [];
      const loaders = { texture: async () => { const t = new Texture(); t.image = { width: 2560, height: 1920 }; return t; }, model: async () => new Object3D() };
      const s = await Session.start(withComputer, { opening: false, artLoaders: loaders, render: (_stage, over) => { if (over) draws.push(over as never); } });
      const canvas = document.createElement('canvas');
      canvas.getBoundingClientRect = () => rect(0, 0, 900, 700);
      s.bind(canvas);
      const port = s.shipPort();
      port.screenRect(() => rect(130, 70, 640, 480));
      await port.station('astrogation');
      s.world.computer = { rows: [], scroll: 0, selected: 0 } as never;
      for (let i = 0; i < 3; i++) { s.frame(0.1); await settle(); }
      s.frame(0.1);
      const last = draws.at(-1)!;
      expect(last.viewport).toEqual({ x: 130, y: 150, width: 640, height: 480 });
      expect(last.after).toBeUndefined();
      expect(port.shipPlate('computer')).toEqual({ areas: cAreas });
      s.world.computer = null;
    });

    it('the computer draws its own plate, not the map, while it is open from astrogation', async () => {
      const { s, draws } = await begin();
      expect(draws.at(-1)!.after).toBeTypeOf('function');
      const drawn = draws.length;
      s.world.computer = { rows: [], scroll: 0, selected: 0 } as never;
      s.frame(0.1);
      // (no computer plate in this game: the flat panel, and the map isn't drawn behind it)
      expect(draws).toHaveLength(drawn);
      s.world.computer = null;
    });
  });

  describe('the ship\'s music, voices and button sounds', () => {
    /** A mixer that records what plays; a voice's `ended` is held until `finish()`, when `hold` is set. */
    function recorder(hold = false) {
      const played: [string, string][] = [];
      const loops: [string, string | undefined, LoopShape | undefined][] = [];
      const waiting: (() => void)[] = [];
      const audio = {
        ...LEVELS,
        played, loops,
        play: async (url: string | undefined, bus: string): Promise<Playing | null> => {
          if (url === undefined) return null;
          played.push([bus, url]);
          const ended = hold && bus === 'voice' ? new Promise<void>(resolve => waiting.push(resolve)) : Promise.resolve();
          return { ended, duration: 0.01, stop: () => {} };
        },
        setLoop: async (bus: string, url: string | undefined, shape?: LoopShape) => void loops.push([bus, url, shape]),
        keep: () => {}, release: () => {}, preload: async () => {},        resume: async () => {},
        playing: () => 0,
        finish: () => { for (const r of waiting.splice(0)) r(); },
      };
      return audio;
    }
    const withUnits = { ...SHIP, 'ship.yaml': SHIP['ship.yaml']!.replace('units: []', 'units:\n  - { name: C, type: 11, current: 100, target: 100, max: 100, chargeTicks: 0, dischargeTicks: 0, damage: 0, repair: 0, baseDamage: 0, maxDamage: 0, efficiency: 0 }') };
    const sounding = (files = withUnits): GamePackage => ({
      ...pkg(files),
      assets: new AssetIndex([
        ['audio/music/bridgamb.ogg', 'u:bridge'], ['audio/music/astro.ogg', 'u:astro'], ['audio/music/compute.ogg', 'u:compute'],
        ['audio/sfx/beep7.opus', 'u:beep'], ['audio/sfx/tactical.opus', 'u:tactical'], ['audio/sfx/holodoor.opus', 'u:holodoor'], ['audio/sfx/holoon.opus', 'u:holoon'],
        ['audio/voice/fe090081.opus', 'u:online'], ['audio/voice/fe090082.opus', 'u:full'],
      ]),
      presentation: {
        music: {}, ambience: {}, intro: {}, arrival: {}, sounds: {},
        shipMusic: { bridge: 'bridgamb', astrogation: 'astro', computer: 'compute', transporter: 'bridgamb' },
        shipSounds: { shipBeep: 'beep7', tacticalAlert: 'tactical', holodeckDoor: 'holodoor', holodeckOn: 'holoon', computerOnline: 'fe090081', computerFull: 'fe090082' },
        loops: { bridgamb: { gain: 1, loopStart: 0 }, astro: { gain: 1.508, loopStart: 5.03 }, compute: { gain: 1, loopStart: 4.728 } },
        art: { rooms: {}, cards: {}, ship: {} },
      },
    });
    const music = (a: ReturnType<typeof recorder>) => a.loops.filter(([bus]) => bus === 'music');

    it('loops the bridge\'s music as the game opens on it, and each station\'s as the ship goes there, with the original\'s volume and loop point', async () => {
      const audio = recorder();
      const s = await Session.start(sounding(), { audio: audio as unknown as Mixer, opening: false });
      expect(music(audio).at(-1)).toEqual(['music', 'u:bridge', { gain: 1, loopStart: 0 }]);
      await s.shipPort().station('astrogation');
      expect(music(audio).at(-1)).toEqual(['music', 'u:astro', { gain: 1.508, loopStart: 5.03 }]);
      await s.shipPort().station('bridge');
      expect(music(audio).at(-1)?.[1]).toBe('u:bridge');
    });

    it('holds the bridge\'s music until the opening movies are over', async () => {
      const audio = recorder();
      const base = sounding();
      const withOpening = { ...base, assets: new AssetIndex([['movies/a.webm', '/a.webm'], ['audio/music/bridgamb.ogg', 'u:bridge']]), presentation: { ...base.presentation, opening: ['a'] } };
      const s = await Session.start(withOpening, { audio: audio as unknown as Mixer });
      expect(await shown(s)).toBe('a');
      expect(music(audio).filter(([, url]) => url !== undefined)).toEqual([]);
      s.store.answer(undefined);
      await shown(s);
      await vi.waitFor(() => expect(music(audio).filter(([, url]) => url === 'u:bridge')).toHaveLength(1));
    });

    it('plays the console\'s beep going to astrogation and the tactical alert going to tactical, and stays quiet with no audio', async () => {
      const audio = recorder();
      const s = await Session.start(sounding(), { audio: audio as unknown as Mixer, opening: false });
      await s.shipPort().station('astrogation');
      expect(audio.played).toContainEqual(['sfx', 'u:beep']);
      await s.shipPort().station('bridge');
      s.shipPort().sound('tacticalAlert');
      expect(audio.played.at(-1)).toEqual(['sfx', 'u:tactical']);
      const quiet = await Session.start(sounding(), { opening: false });
      await expect(quiet.shipPort().station('astrogation')).resolves.toBeUndefined();
      quiet.shipPort().sound('shipBeep');
    });

    it('has the computer say how it is, one line after another, and starts its music once it has', async () => {
      const audio = recorder(true);
      const s = await Session.start(sounding(), { audio: audio as unknown as Mixer, opening: false });
      await s.shipPort().station('computer');
      // (full strength: "online", then "full"; the second waits for the first to end)
      await vi.waitFor(() => expect(audio.played.filter(([bus]) => bus === 'voice')).toEqual([['voice', 'u:online']]));
      expect(music(audio).some(([, url]) => url === 'u:compute')).toBe(false);
      audio.finish();
      await vi.waitFor(() => expect(audio.played.filter(([bus]) => bus === 'voice')).toHaveLength(2));
      expect(music(audio).some(([, url]) => url === 'u:compute')).toBe(false);
      audio.finish();
      await vi.waitFor(() => expect(music(audio).at(-1)).toEqual(['music', 'u:compute', { gain: 1, loopStart: 4.728 }]));
    });

    it('says the holodeck\'s refusal to its end before the bridge comes back with its music (waitForSpeech)', async () => {
      const audio = recorder(true);
      const base = sounding();
      const refusing: GamePackage = {
        ...base,
        assets: new AssetIndex([['audio/music/bridgamb.ogg', 'u:bridge'], ['audio/music/astro.ogg', 'u:astro'], ['audio/voice/fe090098.opus', 'u:refused']]),
        presentation: { ...base.presentation, shipSounds: { ...base.presentation.shipSounds, computerOffline: 'fe090098' } },
      };
      const s = await Session.start(refusing, { audio: audio as unknown as Mixer, opening: false });
      await s.shipPort().station('astrogation');
      // (the computer, below the 80 percent the holodeck needs)
      s.world.state.ship.systems.units.forEach(u => { u.current = 10; });
      const going = s.shipPort().screen(0xa);
      await vi.waitFor(() => expect(audio.played.filter(([bus]) => bus === 'voice')).toEqual([['voice', 'u:refused']]));
      // (still on astrogation, with its music, while the line is said)
      expect(s.world.state.ship.station).toBe('astrogation');
      expect(music(audio).at(-1)?.[1]).toBe('u:astro');
      audio.finish();
      await going;
      expect(s.world.state.ship.station).toBe('bridge');
      await vi.waitFor(() => expect(music(audio).at(-1)?.[1]).toBe('u:bridge'));
    });

    it('does not start the computer\'s music when the ship has left it while it spoke', async () => {
      const audio = recorder(true);
      const s = await Session.start(sounding(), { audio: audio as unknown as Mixer, opening: false });
      await s.shipPort().station('computer');
      await vi.waitFor(() => expect(audio.played.some(([bus]) => bus === 'voice')).toBe(true));
      await s.shipPort().computerLeave('bridge');
      audio.finish();
      await new Promise(resolve => setTimeout(resolve, 20));
      audio.finish();
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(music(audio).some(([, url]) => url === 'u:compute')).toBe(false);
    });

    it('has the computer say a crew member\'s name as they are put on a pad (transporter.cpp:759-763), and the confirmation on Energize', async () => {
      const audio = recorder();
      const files = { ...withUnits, 'ship.yaml': withUnits['ship.yaml']!.replace('crew: { leaderOrder: [picard], voices: [] }', 'crew: { leaderOrder: [picard], voices: [180], voiceOf: { picard: 180 } }') };
      const base = sounding(files);
      const pkg2 = {
        ...base,
        assets: new AssetIndex([...[['audio/voice/fe0900b4.opus', 'u:picard'], ['audio/sfx/trnscnfm.opus', 'u:confirm']] as [string, string][], ['audio/music/bridgamb.ogg', 'u:bridge']]),
        presentation: { ...base.presentation, shipSounds: { transporterConfirm: 'trnscnfm' } },
      };
      const s = await Session.start(pkg2, { audio: audio as unknown as Mixer, opening: false });
      const port = s.shipPort();
      await port.station('transporter');
      await port.pad('picard');
      await vi.waitFor(() => expect(audio.played).toContainEqual(['voice', 'u:picard']));
      // (nobody has a voice but those the list names)
      expect(audio.played.filter(([bus]) => bus === 'voice')).toHaveLength(1);
      await expect(port.energize()).rejects.toThrow();
      expect(audio.played.some(([, url]) => url === 'u:confirm')).toBe(false);
    });

    it('opens the holodeck with its door and projector sounds, and with no music', async () => {
      const audio = recorder();
      const s = await Session.start(sounding(), { audio: audio as unknown as Mixer, opening: false });
      await s.shipPort().station('holodeck');
      expect(audio.played).toContainEqual(['sfx', 'u:holodoor']);
      expect(audio.played).toContainEqual(['sfx', 'u:holoon']);
      expect(music(audio).at(-1)).toEqual(['music', undefined, undefined]);
    });

    it('goes on with the station\'s music after a load aboard', async () => {
      const audio = recorder();
      const s = await Session.start(sounding(), { audio: audio as unknown as Mixer, opening: false });
      await s.shipPort().station('astrogation');
      const text = s.world.save();
      await s.shipPort().station('bridge');
      await s.load(text);
      expect(music(audio).at(-1)?.[1]).toBe('u:astro');
    });
  });

  describe('the settings record and the admin PADD (Plan 32)', () => {
    /** A mixer that records the levels the settings give it, the loops' pauses and what plays. */
    function levelsMixer() {
      const m = {
        master: -1, levels: {} as Record<string, number>, paused: [] as boolean[], played: [] as [string, string][], gains: [] as (number | undefined)[],
        setMaster: (v: number) => { m.master = v; },
        setLevel: (bus: string, v: number) => { m.levels[bus] = v; },
        pauseLoops: (p: boolean) => { m.paused.push(p); },
        play: async (url: string | undefined, bus: string, _loop?: boolean, shape?: LoopShape): Promise<Playing | null> => {
          if (url === undefined) return null;
          m.played.push([bus, url]);
          m.gains.push(shape?.gain);
          return { ended: Promise.resolve(), duration: 0.01, stop: () => {} };
        },
        setLoop: async () => {}, keep: () => {}, release: () => {}, preload: async () => {}, resume: async () => {}, playing: () => 0,
      };
      return m;
    }
    /** localStorage as a map, for one test. */
    function storage(initial: Record<string, string> = {}) {
      const store = new Map(Object.entries(initial));
      const writes = { count: 0 };
      vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { writes.count++; store.set(k, v); } });
      return { store, writes, record: () => JSON.parse(store.get(SETTINGS_KEY) ?? 'null') as Settings | null };
    }
    const padd = (files: Record<string, string> = SHIP): GamePackage => {
      const base = pkg(files);
      return {
        ...base,
        assets: new AssetIndex([['audio/sfx/rgcd.opus', 'u:rgcd'], ['audio/sfx/beep14.opus', 'u:beep14'], ['audio/sfx/beep7.opus', 'u:beep7'], ['audio/sfx/softbop.opus', 'u:softbop']]),
        presentation: { ...base.presentation, shipSounds: { adminOpen: 'rgcd', adminLevel: 'beep14', shipBeep: 'beep7', shipSoftbop: 'softbop' } },
      };
    };

    it('settings apply to the mixer', async () => {
      const { record } = storage();
      const audio = levelsMixer();
      const s = await Session.start(padd(), { audio: audio as unknown as Mixer, opening: false });
      // (the defaults, as the page starts)
      expect([audio.master, audio.levels]).toEqual([0.5, { voice: 1, sfx: 1, music: 1, ambience: 1 }]);
      s.uiPort().settings!.set({ master: 0.3, voices: 0.4, music: 0.5 });
      expect(audio.master).toBe(0.3);
      expect(audio.levels).toEqual({ voice: 0.4, sfx: 0.4, music: 0.5, ambience: 0.5 });
      expect(s.uiPort().settings!.get()).toMatchObject({ master: 0.3, voices: 0.4, music: 0.5 });
      // (kept whole, for the next page)
      expect(record()).toEqual({ ...DEFAULT_SETTINGS, master: 0.3, voices: 0.4, music: 0.5 });
      const again = levelsMixer();
      await Session.start(padd(), { audio: again as unknown as Mixer, opening: false });
      expect([again.master, again.levels.voice, again.levels.ambience]).toEqual([0.3, 0.4, 0.5]);
      // (the console's sounds, at a level where one is given)
      s.uiPort().settings!.sound('beep14', 0.25);
      s.uiPort().settings!.sound('softbop');
      expect(audio.played.slice(-2)).toEqual([['sfx', 'u:beep14'], ['sfx', 'u:softbop']]);
      expect(audio.gains.slice(-2)).toEqual([0.25, undefined]);
      vi.unstubAllGlobals();
    });

    it('a ?difficulty override is not written back', async () => {
      const { store, record } = storage({ [SETTINGS_KEY]: JSON.stringify({ ...DEFAULT_SETTINGS, difficulty: 0 }) });
      const s = await Session.start(pkg(SHIP), { difficulty: 2, artOff: true, opening: false });
      expect([s.difficulty, s.world.difficulty]).toEqual([2, 2]);
      expect(s.stage.debugView.art).toBe(false);
      expect(store.has('au.difficulty')).toBe(false);
      expect(record()?.difficulty).toBe(0);
      // (another change keeps the record whole: the stored difficulty and art stay the player's)
      const settings = s.uiPort().settings!;
      settings.set({ master: 0.2 });
      expect(record()).toMatchObject({ master: 0.2, difficulty: 0, art: true });
      // (a change to an overridden field applies for this page, and is not kept)
      settings.set({ difficulty: 1, art: true });
      expect([s.difficulty, s.world.difficulty, s.stage.debugView.art]).toEqual([1, 1, true]);
      expect(record()).toMatchObject({ difficulty: 0, art: true });
      // (the next page, without the parameters, has the stored ones)
      const again = await Session.start(pkg(SHIP), { opening: false });
      expect([again.difficulty, again.stage.debugView.art]).toEqual([0, true]);
      vi.unstubAllGlobals();
    });

    it('hotspots and difficulty and assists read from the settings record', async () => {
      const { record, writes } = storage({ [SETTINGS_KEY]: JSON.stringify({ ...DEFAULT_SETTINGS, difficulty: 2, hotspots: true, art: false, assists: { difficulty: 'story', speed: 4 } }) });
      const s = await Session.start(pkg(SHIP), { realCombat: true, opening: false });
      expect([s.difficulty, s.world.difficulty, s.assists, s.world.assists, hotspotLabels(), s.stage.debugView.art])
        .toEqual([2, 2, { difficulty: 'story', speed: 4 }, { difficulty: 'story', speed: 4 }, true, false]);
      // (the HUD's toggle, the saves panel's difficulty and the assists panel write the record)
      setHotspotLabels(false);
      expect([record()?.hotspots, s.uiPort().settings!.get().hotspots]).toEqual([false, false]);
      // (one change, one write: the labels are shown, not handed back to the settings)
      writes.count = 0;
      s.uiPort().settings!.set({ hotspots: true });
      expect([hotspotLabels(), writes.count]).toEqual([true, 1]);
      setHotspotLabels(false);
      expect([record()?.hotspots, writes.count]).toEqual([false, 2]);
      s.uiPort().settings!.set({ hotspots: true });
      s.setDifficulty(1);
      s.setAssists({ difficulty: 'game', speed: 8 });
      expect(record()).toMatchObject({ difficulty: 1, hotspots: true, assists: { difficulty: 'game', speed: 8 } });
      // (the difficulty, as before, only with no team away)
      expect(s.uiPort().settings!.canChangeDifficulty()).toBe(true);
      s.world.state.onShip = null;
      expect(s.uiPort().settings!.canChangeDifficulty()).toBe(false);
      expect(() => s.uiPort().settings!.set({ difficulty: 0 })).toThrow('while no team is away');
      expect(record()?.difficulty).toBe(1);
      // (the art, at once; another change leaves the dev tools' Art switch as it is)
      s.uiPort().settings!.set({ art: true });
      expect(s.stage.debugView.art).toBe(true);
      s.stage.setDebug({ art: false });
      s.uiPort().settings!.set({ master: 0.1 });
      expect(s.stage.debugView.art).toBe(false);
      vi.unstubAllGlobals();
    });

    it('opening the PADD stops the world and pauses the loops; closing resumes', async () => {
      storage();
      const audio = levelsMixer();
      // (a game with no ship: the team is away, where timers run)
      const s = await Session.start(padd({ 'objects/clock.yaml': 'id: clock\nname: Clock\nscreen: room\nat: panel\ntimer: 1\n' }), { audio: audio as unknown as Mixer });
      let fired = 0;
      s.world.bus.on(e => { if (e.type === 'timerFired') fired++; });
      const settings = s.uiPort().settings!;
      expect(settings.openAdmin()).toBe(true);
      expect([settings.adminOpen(), s.store.state.panel, s.modal]).toEqual([true, 'admin', true]);
      expect(audio.paused).toEqual([true]);
      expect(audio.played).toContainEqual(['sfx', 'u:rgcd']);
      await run(s, 5);
      expect(fired).toBe(0);
      settings.closeAdmin();
      expect([settings.adminOpen(), s.store.state.panel, s.modal]).toEqual([false, 'none', false]);
      expect(audio.paused).toEqual([true, false]);
      await run(s, 1.5);
      expect(fired).toBeGreaterThan(0);
      // (Escape, or anything else that puts the panel away, resumes too)
      settings.openAdmin();
      s.store.set({ panel: 'none' });
      expect(audio.paused).toEqual([true, false, true, false]);
      vi.unstubAllGlobals();
    });

    it('opening the PADD at tactical pauses the battle, and closing gives it back as it was', async () => {
      storage();
      const { s, fight } = await battleShip();
      const battle = await fight();
      const settings = s.uiPort().settings!;
      expect(battle.paused).toBe(false);
      settings.openAdmin();
      expect(battle.paused).toBe(true);
      settings.closeAdmin();
      expect(battle.paused).toBe(false);
      pauseBattle(s.world, true);
      settings.openAdmin();
      settings.closeAdmin();
      expect(battle.paused).toBe(true);
      vi.unstubAllGlobals();
    });

    it('the Combat Options (F1) pause the battle as its dialog, and closing gives it back as it was; their settings are the PADD\'s (Plan 32 Task 11)', async () => {
      storage();
      const { s, fight } = await battleShip();
      const battle = await fight();
      const port = s.battlePort();
      port.showOptions!(true);
      expect([battle.paused, port.battle()!.overlay]).toEqual([true, 'dialog']);
      port.showOptions!(false);
      expect([battle.paused, port.battle()!.overlay]).toEqual([false, null]);
      pauseBattle(s.world, true);
      port.showOptions!(true);
      port.showOptions!(false);
      expect(battle.paused).toBe(true);
      // (one record: a change on the screen is the console's)
      port.optionsScreen!()!.settings.set({ combat: { stars: false, resolution: 2, radar: false, detail: 'low' } });
      expect(s.uiPort().settings!.get().combat).toEqual({ stars: false, resolution: 2, radar: false, detail: 'low' });
      // (the window the preview is drawn in is the screen's, while it is open)
      port.showOptions!(true);
      port.previewBox!(() => ({ left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10, x: 0, y: 0, toJSON: () => ({}) }));
      // (the PADD does not open over the screen, by any way in: the battle never runs under it)
      const settings = s.uiPort().settings!;
      expect(settings.openAdmin()).toBe(false);
      s.shipPort().adminMenu();
      expect([s.store.state.panel, battle.paused]).toEqual(['none', true]);
      port.showOptions!(false);
      expect(port.battle()!.overlay).toBe(null);
      // (and the preview's window goes with the screen)
      expect((s as unknown as { optionsBox: unknown }).optionsBox).toBeNull();
      expect(settings.openAdmin()).toBe(true);
      settings.closeAdmin();
      vi.unstubAllGlobals();
    });

    it('openAdmin refuses while a warp is pending', async () => {
      storage();
      const s = await Session.start(padd(), { opening: false });
      const settings = s.uiPort().settings!;
      s.world.state.ship.warpPending = true;
      expect(settings.openAdmin()).toBe(false);
      s.shipPort().adminMenu();
      expect(s.store.state.panel).toBe('none');
      s.world.state.ship.warpPending = false;
      s.shipPort().adminMenu();
      expect([settings.adminOpen(), s.store.state.panel]).toEqual([true, 'admin']);
      vi.unstubAllGlobals();
    });

    it("QUIT's YES ends the game as the original's quit (game over 0x20, the credits), aboard and away; NEW's restarts; the game-over screen is the failure screen", async () => {
      storage();
      const s = await Session.start(padd(), { opening: false });
      const settings = s.uiPort().settings!;
      expect(settings.gameOver()).toBe(false);
      settings.openAdmin();
      await settings.quit();
      await settle(s.world);
      expect([s.world.state.onShip, settings.gameOver(), settings.adminOpen()]).toEqual([{ gameOver: 0x20 }, true, false]);
      // (a new game from there: aboard again, nothing over)
      settings.openAdmin();
      await settings.newGame();
      expect([s.world.state.onShip, settings.adminOpen()]).toEqual([{ gameOver: null }, false]);
      // away, the team is brought back to end it
      s.world.state.onShip = null;
      await settings.quit();
      await settle(s.world);
      expect(s.world.state.onShip).toEqual({ gameOver: 0x20 });
      // (a game without a ship has no end screen: QUIT starts it again)
      const away = await Session.start(padd({}), { opening: false });
      const before = away.world;
      await away.uiPort().settings!.quit();
      expect([away.world !== before, away.world.state.onShip]).toEqual([true, null]);
      vi.unstubAllGlobals();
    });

    it('the PADD does not open while a line is said, under a dialog or with input blocked, by any way in; on the game-over screen it does', async () => {
      storage();
      const s = await Session.start(padd(), { opening: false });
      const settings = s.uiPort().settings!;
      const skip = vi.spyOn(s.presenter, 'skipLine');
      // (every way in: Esc, the bridge strip's Admin, and the bar's and the away panel's Admin, which are the settings port's)
      const tries = () => [s.input.key('Escape'), settings.openAdmin(), (s.shipPort().adminMenu(), s.store.state.panel)];
      // a voiced line with text off (no box): Esc skips it, as a click does, and the buttons do nothing
      s.store.say({ who: 'data', name: 'Data', text: 'A synthetic line.' }, false);
      expect(tries()).toEqual([true, false, 'none']);
      expect(skip).toHaveBeenCalledTimes(1);
      s.store.endSay();
      // a dialog up (it answers Esc itself)
      s.store.set({ dialog: { kind: 'choice', question: 'Q?', options: ['Yes', 'No'] } });
      expect(tries()).toEqual([false, false, 'none']);
      s.store.set({ dialog: null });
      // input blocked
      s.world.state.awayFlags.inputBlocked = true;
      expect(tries()).toEqual([false, false, 'none']);
      // the game-over screen: all three at once, and it opens all the same
      s.world.state.onShip = { gameOver: 0x20 };
      s.store.set({ dialog: { kind: 'choice', question: 'Q?', options: ['Yes', 'No'] } });
      s.store.say({ who: 'data', name: 'Data', text: 'A synthetic line.' });
      expect(settings.openAdmin()).toBe(true);
      expect(s.store.state.panel).toBe('admin');
      s.store.set({ panel: 'none', dialog: null });
      s.store.endSay();
      expect([s.input.key('Escape'), s.store.state.panel]).toEqual([true, 'admin']);
      s.store.set({ panel: 'none' });
      // (back to plain: nothing in the way, it opens)
      s.world.state.onShip = { gameOver: null };
      s.world.state.awayFlags.inputBlocked = false;
      expect([s.input.key('Escape'), s.store.state.panel]).toEqual([true, 'admin']);
      vi.unstubAllGlobals();
    });

    it('Esc on the bridge opens the PADD, and Esc closes it', async () => {
      storage();
      const s = await Session.start(padd(), { opening: false });
      // (the key as the bound page hands it to the input: other tests' bound sessions would take a window event first)
      expect(s.world.state.ship.station).toBe('bridge');
      expect([s.input.key('Escape'), s.store.state.panel]).toEqual([true, 'admin']);
      expect([s.input.key('Escape'), s.store.state.panel]).toEqual([true, 'none']);
      // (refused while a warp is pending: the key does nothing)
      s.world.state.ship.warpPending = true;
      expect([s.input.key('Escape'), s.store.state.panel]).toEqual([false, 'none']);
      vi.unstubAllGlobals();
    });
  });
});

describe('feedback', () => {
  async function withFeedback() {
    const saves = await SaveSlots.open('mini', new IDBFactory());
    const reports: FeedbackReport[] = [];
    const feedback: FeedbackTransport = {
      check: async () => ({ token: () => 't', reset: () => {}, dispose: () => {} }),
      send: async (report, token, trap) => { reports.push(report); expect([token, trap]).toEqual(['tok', '']); return 'id1'; },
    };
    const s = await Session.start(pkg(), { saves, log: () => {}, feedback });
    return { s, saves, reports };
  }

  it('has no feedback port without the site\'s transport', async () => {
    const { s } = await start();
    expect(s.uiPort().feedback).toBeUndefined();
  });

  it('sends what the player wrote with where they are, their settings, the last lines and the game as it is now', async () => {
    const { s, reports } = await withFeedback();
    s.store.set({ transcript: [{ who: 'picard', name: 'Picard', text: 'Make it so.' }] });
    expect(await s.uiPort().feedback!.send({ message: 'Hi', email: 'a@b.c', includeSave: true, token: 'tok', trap: '' })).toBe('id1');
    const r = reports[0]!;
    expect(r).toMatchObject({ message: 'Hi', email: 'a@b.c', saveNote: null });
    expect(r.save).toBe(s.world.save());
    expect(r.game).toMatchObject({ game: 'mini', screen: s.world.state.screen, onShip: false, station: null, combat: null, recentLines: ['Picard: Make it so.'] });
    expect(r.game.settings).not.toBeNull();
  });

  it('leaves the save out when the player says so', async () => {
    const { s, reports } = await withFeedback();
    await s.uiPort().feedback!.send({ message: 'Hi', email: '', includeSave: false, token: 'tok', trap: '' });
    expect(reports[0]).toMatchObject({ save: null, saveNote: 'The player left the save out.' });
  });

  it('mid-battle, when the game cannot be saved, sends the last autosave and says so', async () => {
    const { s, saves, reports } = await withFeedback();
    await saves.put(AUTOSAVE_SLOT, '{"autosave":1}', { label: 'Autosave', screen: 'room', savedAt: 1 });
    s.world.state.ship.combat = { scenario: 8, enterprise: 'e', enemies: [], friends: [], destroyed: [], warped: false, redAlert: false } as never;
    await s.uiPort().feedback!.send({ message: 'Hi', email: '', includeSave: true, token: 'tok', trap: '' });
    expect(reports[0]).toMatchObject({ save: '{"autosave":1}', saveNote: 'The game could not be saved just then: this is the last autosave.' });
    expect(reports[0]!.game.combat).toEqual({ scenario: 8, step: null });
  });
});
