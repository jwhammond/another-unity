// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { Bus, Playing } from '../audio/mixer';
import type { ObjectDef } from '../content/types';
import { flush } from '../sim/settle';
import { createInitialState } from '../sim/state';
import { ALL_READINGS } from '../sim/talk';
import { StopSignal } from '../sim/stop';
import { World } from '../sim/world';
import { makeGame, makeWorld } from '../testing/fixture';
import type { Settings } from '../web/settings';
import { UiStore } from '../ui/store';
import { AssetIndex } from './assets';
import { BrowserPresenter, readingTime, type StagePort } from './browserPresenter';
import { ReadingTable } from './readings';
import { ScreenTextTable } from './screenTexts';
import { PresentationClock } from './timeline';
import { VoiceTable } from './voices';

class FakeSound {
  played: [string, Bus][] = [];
  endings: (() => void)[] = [];
  stops = 0;
  async play(url: string | undefined, bus: Bus): Promise<Playing | null> {
    if (url === undefined) return null;
    this.played.push([url, bus]);
    let end!: () => void;
    const ended = new Promise<void>(resolve => { end = resolve; });
    this.endings.push(end);
    return { ended, duration: 1, stop: () => { this.stops++; end(); } };
  }
}

const panel: ObjectDef = { id: 'panel', name: 'Panel', screen: 'room', at: 'panel', description: { text: 'A panel.' } };

function stagePort(calls: string[]): StagePort {
  return {
    walk: async (actor, _from, to) => { calls.push(`walk ${actor}`); return to; },
    anim: async object => { calls.push(`anim ${object}`); },
    show: async visual => { calls.push(`show ${visual.kind}`); },
    speak: (who, on) => { calls.push(`speak ${who} ${on ? 'on' : 'off'}`); },
  };
}

const A = { title: '-A-', heading: '-a-', text: '-Zap-' };
const B = { title: '-B-', heading: '-b-', text: '-Zip-' };

function setup(settings?: { text: boolean; movies: boolean }) {
  const world = makeWorld([panel]);
  const store = new UiStore();
  const clock = new PresentationClock();
  const sound = new FakeSound();
  const calls: string[] = [];
  const assets = new AssetIndex([
    ['audio/voice/d0201.wav', '/v/d0201.wav'],
    ['audio/music/hum.wav', '/m/hum.wav'],
    ['audio/sfx/tricorder.wav', '/s/tricorder.wav'],
    ['movies/intro.webm', '/movies/intro.webm'],
  ]);
  const voices = new VoiceTable({ speakers: { data: '02' }, other: 'ff', lines: {} });
  const effects: string[] = [];
  const p = new BrowserPresenter(world, { stage: stagePort(calls), sound, store, clock, assets, voices, readings: new ReadingTable({ test: { 1: [A], 2: [B] } }), effect: e => effects.push(e), ...(settings ? { settings: () => settings as Settings, warpMovies: ['intro'] } : {}) });
  return { world, store, clock, sound, p, calls, effects };
}

/** Whether a promise has settled yet. */
function track<T>(promise: Promise<T>): { done: boolean; value?: T } {
  const t: { done: boolean; value?: T } = { done: false };
  void promise.then(v => { t.done = true; t.value = v; });
  return t;
}

describe('BrowserPresenter', () => {
  it('with text off, a voiced line shows no text box but is still logged; an unvoiced line still shows', async () => {
    const { store, sound, clock, p } = setup({ text: false, movies: true });
    const voiced = track(p.say('data', 'Captain.', 'd@01'));
    await flush();
    expect(sound.played).toEqual([['/v/d0201.wav', 'voice']]);
    // (the line is still being said, hidden: a click or Space skips it, and the bridge's speaker talks; only the box is gone)
    expect(store.state.subtitle).toEqual({ who: 'data', name: 'Data', text: 'Captain.', hidden: true });
    expect(store.state.transcript).toEqual([{ who: 'data', name: 'Data', text: 'Captain.' }]);
    sound.endings[0]();
    await flush();
    expect(voiced.done).toBe(true);
    expect(store.state.subtitle).toBeNull();
    const plain = track(p.say('picard', 'Engage.'));
    expect(store.state.subtitle).toEqual({ who: 'picard', name: 'Picard', text: 'Engage.' });
    clock.update(2);
    await flush();
    expect(plain.done).toBe(true);
  });

  it('with text off, a click skips a voiced line as with text on', async () => {
    const { store, sound, p } = setup({ text: false, movies: true });
    const voiced = track(p.say('data', 'Captain.', 'd@01'));
    await flush();
    expect(store.state.subtitle?.hidden).toBe(true);
    p.skipLine();
    await flush();
    expect([voiced.done, store.state.subtitle, sound.stops]).toEqual([true, null, 1]);
  });

  it('with text off, a voice that fails to play (null or throws) still shows the text', async () => {
    for (const fail of ['null', 'throw']) {
      const { store, sound, clock, p } = setup({ text: false, movies: true });
      sound.play = async () => { if (fail === 'throw') throw new Error('no'); return null; };
      const said = track(p.say('data', 'Captain.', 'd@01'));
      await flush();
      expect(store.state.subtitle).toEqual({ who: 'data', name: 'Data', text: 'Captain.' });
      clock.update(2);
      await flush();
      expect(said.done).toBe(true);
    }
  });

  it('with movies off, a play.movie and a warp movie are skipped as after a Skip', async () => {
    const { store, p } = setup({ text: true, movies: false });
    const film = track(p.play({ movie: 'intro' }));
    const warp = track(p.play({ warpMovie: 0 }));
    await flush();
    expect(film.done).toBe(true);
    expect(warp.done).toBe(true);
    expect(store.state.dialog).toBeNull();
  });

  it('shows a line without a voice for its reading time, and keeps it in the transcript', async () => {
    const { store, clock, p } = setup();
    const said = track(p.say('picard', 'Engage.'));
    expect(store.state.subtitle).toEqual({ who: 'picard', name: 'Picard', text: 'Engage.' });
    expect(readingTime('Engage.')).toBe(1.5);
    clock.update(1.4);
    await flush();
    expect(said.done).toBe(false);
    clock.update(0.2);
    await flush();
    expect(said.done).toBe(true);
    expect(store.state.subtitle).toBeNull();
    expect(store.state.transcript).toEqual([{ who: 'picard', name: 'Picard', text: 'Engage.' }]);
  });

  it('tells the stage when a line starts and ends in a crew member\'s voice (their talk animation)', async () => {
    const { clock, p, calls } = setup();
    const said = track(p.say('picard', 'Engage.'));
    expect(calls).toEqual(['speak picard on']);
    clock.update(2);
    await flush();
    expect(said.done).toBe(true);
    expect(calls).toEqual(['speak picard on', 'speak picard off']);
  });

  it("plays the speaker's voice, and ends the line when the voice ends", async () => {
    const { clock, sound, p } = setup();
    const said = track(p.say('data', 'Captain.', 'd@01'));
    await flush();
    expect(sound.played).toEqual([['/v/d0201.wav', 'voice']]);
    clock.update(1);
    await flush();
    expect(said.done).toBe(false);
    sound.endings[0]();
    await flush();
    expect(said.done).toBe(true);
  });

  it('gives up on a voice that never ends, just after its length', async () => {
    const { clock, p } = setup();
    const said = track(p.say('data', 'Captain.', 'd@01'));
    await flush();
    clock.update(1.6);
    await flush();
    expect(said.done).toBe(true);
  });

  it('ends a line early on a click, stopping its voice', async () => {
    const { sound, p } = setup();
    const said = track(p.say('data', 'Captain.', 'd@01'));
    await flush();
    p.skipLine();
    await flush();
    expect(said.done).toBe(true);
    expect(sound.stops).toBe(1);
  });

  it('leaves no wait on the clock once a line has ended, so the game is not left busy', async () => {
    const { clock, sound, p } = setup();
    const skipped = track(p.say('data', 'Captain.', 'd@01'));
    await flush();
    p.skipLine();
    await flush();
    expect(skipped.done).toBe(true);
    expect(clock.pending).toBe(0);
    const heard = track(p.say('data', 'Captain.', 'd@01'));
    await flush();
    sound.endings[1]();
    await flush();
    expect(heard.done).toBe(true);
    expect(clock.pending).toBe(0);
  });

  it('scales the give-up time for a voice by the clock speed, since the voice plays in real time', async () => {
    const { clock, p } = setup();
    clock.speed = 4;
    const said = track(p.say('data', 'Captain.', 'd@01'));
    await flush();
    clock.update(5.9);
    await flush();
    expect(said.done).toBe(false);
    clock.update(0.2);
    await flush();
    expect(said.done).toBe(true);
  });

  it('stops a voice that finishes loading after the line was skipped', async () => {
    const { store, clock, p } = setup();
    let arrive!: (playing: Playing) => void;
    const late = new Promise<Playing | null>(resolve => { arrive = resolve; });
    const parts = { stage: stagePort([]), sound: { play: () => late }, store, clock, assets: new AssetIndex([['audio/voice/d0201.wav', '/v/d0201.wav']]), voices: new VoiceTable({ speakers: { data: '02' }, other: 'ff', lines: {} }) };
    const presenter = new BrowserPresenter(makeWorld([panel]), parts);
    const said = track(presenter.say('data', 'Captain.', 'd@01'));
    await flush();
    presenter.skipLine();
    await flush();
    expect(said.done).toBe(true);
    expect(store.state.subtitle).toBeNull();
    let stopped = 0;
    arrive({ ended: new Promise<void>(() => {}), duration: 1, stop: () => { stopped++; } });
    await flush();
    expect(stopped).toBe(1);
  });

  it('still ends the line when the voice fails to load', async () => {
    const { store, clock, p } = setup();
    const parts = { stage: stagePort([]), sound: { play: () => Promise.reject(new Error('decode')) }, store, clock, assets: new AssetIndex([['audio/voice/d0201.wav', '/v/d0201.wav']]), voices: new VoiceTable({ speakers: { data: '02' }, other: 'ff', lines: {} }) };
    const presenter = new BrowserPresenter(makeWorld([panel]), parts);
    const said = track(presenter.say('data', 'Captain.', 'd@01'));
    await flush();
    clock.update(1.5);
    await flush();
    expect(said.done).toBe(true);
    expect(store.state.subtitle).toBeNull();
  });

  it('clamps a zero clock speed, so a voice is not given up on the very next frame', async () => {
    const { clock, p } = setup();
    clock.speed = 0;
    const said = track(p.say('data', 'Captain.', 'd@01'));
    await flush();
    clock.update(0);
    await flush();
    expect(said.done).toBe(false);
  });

  it('falls back to the reading time when the voice file is missing', async () => {
    const { clock, sound, p } = setup();
    const said = track(p.say('picard', 'Hm.', 'zz@99'));
    await flush();
    expect(sound.played).toEqual([]);
    clock.update(1.5);
    await flush();
    expect(said.done).toBe(true);
  });

  it('asks choices, menus and screen text through the dialogs', async () => {
    const { store, p } = setup();
    const choice = p.choose('Go?', ['Yes', 'No']);
    expect(store.state.dialog).toEqual({ kind: 'choice', question: 'Go?', options: ['Yes', 'No'] });
    store.answer(1);
    expect(await choice).toBe(1);
    const menu = p.menu(['A', 'B']);
    expect(store.state.dialog).toEqual({ kind: 'menu', options: ['A', 'B'] });
    store.answer(null);
    expect(await menu).toBeNull();
    const at = p.menu(['A'], { conversation: 'x.c001', situation: 2 });
    expect(store.state.dialog).toEqual({ kind: 'menu', options: ['A'], conversation: 'x.c001', situation: 2 });
    store.answer(0);
    expect(await at).toBe(0);
  });

  it('shows a screen text on the screen, with no dialog and no wait, and says false where the game has none', async () => {
    const world = makeWorld([panel]);
    const store = new UiStore();
    const text = { x: 214, y: 140, width: 230, height: 75, font: 6, lines: ['', '  ONLINE'] };
    const other = { ...text, x: 10 };
    const table = new ScreenTextTable({ [world.state.screen]: { 0: text, 1: { ...text, lines: ['again'] }, 2: other } });
    const p = new BrowserPresenter(world, { stage: stagePort([]), sound: null, store, clock: new PresentationClock(), assets: new AssetIndex([]), voices: new VoiceTable({ speakers: {}, other: 'ff', lines: {} }), screenTexts: table });
    expect(await p.screenText(0)).toBe(true);
    expect(store.state.dialog).toBeNull();
    expect(store.state.screenTexts).toEqual([text]);
    // (a text at the same corner replaces what was there; another corner adds)
    expect(await p.screenText(2)).toBe(true);
    expect(await p.screenText(1)).toBe(true);
    expect(store.state.screenTexts.map(t => t.lines)).toEqual([other.lines, ['again']]);
    expect(await p.screenText(9)).toBe(false);
    expect(store.state.dialog).toBeNull();
  });

  it('rejects, rather than throws, when a question is asked while another is up', async () => {
    const { store, p } = setup();
    void store.ask<void>({ kind: 'tricorder', reading: 1, pages: [], index: 0 });
    let choice!: Promise<unknown>;
    let menu!: Promise<unknown>;
    expect(() => { choice = p.choose('Go?', ['Yes', 'No']); }).not.toThrow();
    expect(() => { menu = p.menu(['A']); }).not.toThrow();
    await expect(choice).rejects.toThrow(/already up/);
    await expect(menu).rejects.toThrow(/already up/);
  });

  it('does not answer the missing movie card once disposed', async () => {
    const { store, clock, p } = setup();
    void p.play({ movie: 'lost' });
    p.dispose();
    clock.update(2);
    await flush();
    expect(store.state.dialog).toEqual({ kind: 'movie', title: 'lost', url: null });
  });

  it('opens the tricorder on this world\'s readings, the newest first, at the one just taken (runTricorder)', async () => {
    const { world, store, sound, p } = setup();
    world.state.readings.push({ world: 'test', group: 1 }, { world: 'test', group: 2 }, { world: 'elsewhere', group: 1 });
    const viewer = track(p.tricorder(1));
    await flush();
    expect(store.state.dialog).toEqual({ kind: 'tricorder', reading: 1, pages: [B, A], index: 1 });
    expect(sound.played).toEqual([]);
    store.answer(undefined);
    await flush();
    expect(viewer.done).toBe(true);
  });

  it('opens on the first page when the reading just taken has no entry of its own', async () => {
    const { world, store, p } = setup();
    world.state.readings.push({ world: 'test', group: 1 }, { world: 'test', group: 9 });
    void p.tricorder(9);
    await flush();
    expect(store.state.dialog).toEqual({ kind: 'tricorder', reading: 9, pages: [A], index: 0 });
  });

  it('opens on the first page for all readings, and with no pages where nothing is recorded', async () => {
    const { world, store, p } = setup();
    void p.tricorder(ALL_READINGS);
    await flush();
    expect(store.state.dialog).toEqual({ kind: 'tricorder', reading: ALL_READINGS, pages: [], index: 0 });
    store.answer(undefined);
    world.state.readings.push({ world: 'test', group: 2 });
    void p.tricorder(ALL_READINGS);
    await flush();
    expect(store.state.dialog).toEqual({ kind: 'tricorder', reading: ALL_READINGS, pages: [B], index: 0 });
  });

  it('shows a card for a missing movie for a moment, and plays a found one until it ends', async () => {
    const { store, clock, p } = setup();
    const card = track(p.play({ movie: 'lost' }));
    expect(store.state.dialog).toEqual({ kind: 'movie', title: 'lost', url: null });
    clock.update(2);
    await flush();
    expect(card.done).toBe(true);
    expect(store.state.dialog).toBeNull();
    const film = track(p.play({ movie: 'intro' }));
    expect(store.state.dialog).toEqual({ kind: 'movie', title: 'intro', url: '/movies/intro.webm' });
    clock.update(5);
    await flush();
    expect(film.done).toBe(false);
    store.answer(undefined);
    await flush();
    expect(film.done).toBe(true);
  });

  it('plays a sound on the bus of the folder it was found in, and carries on', async () => {
    const { clock, sound, p } = setup();
    const hum = track(p.play({ sound: 'hum' }));
    const none = track(p.play({ sound: 'nothing' }));
    expect(sound.played).toEqual([['/m/hum.wav', 'music']]);
    clock.update(0);
    await flush();
    expect([hum.done, none.done]).toEqual([true, true]);
  });

  it('hands walks, animations and visuals to the stage', async () => {
    const { p, calls } = setup();
    expect(await p.walk('picard', { x: 0, z: 0 }, { x: 1, z: 0 }, new StopSignal())).toEqual({ x: 1, z: 0 });
    await p.anim('panel', { play: 2 });
    await p.show({ kind: 'phaserShot', from: 'picard', to: 'panel' });
    expect(calls).toEqual(['walk picard', 'anim panel', 'show phaserShot']);
  });

  it("plays the engine's own sound with each phaser shot and beam, as the original does", async () => {
    const { p, calls, effects } = setup();
    await p.show({ kind: 'phaserShot', from: 'picard', to: 'panel' });
    await p.show({ kind: 'phaserShot', from: 'panel', to: 'picard' });
    await p.show({ kind: 'beam', objects: ['picard'], out: false, chodak: false });
    await p.show({ kind: 'beam', objects: ['picard'], out: true, chodak: false });
    await p.show({ kind: 'beam', objects: ['picard'], out: true, chodak: true });
    await p.show({ kind: 'beam', objects: ['picard'], out: false, chodak: true });
    // (a crew member's hand phaser, anyone else's; then the transporter: in, out, and the Chodak's either way)
    expect(effects).toEqual(['phaserCrew', 'phaserOther', 'beamIn', 'beamOut', 'beamChodak', 'beamChodak']);
    expect(calls.filter(c => c.startsWith('show'))).toHaveLength(6);
  });

  it('goes quiet for good once disposed: what it waits for never ends, and it touches nothing', async () => {
    const twoLines: ObjectDef = { ...panel, on: { use: [{ do: [{ say: { who: 'picard', text: 'One.' } }, { say: { who: 'picard', text: 'Two.' } }] }] } };
    const content = makeGame([twoLines]);
    const store = new UiStore();
    const clock = new PresentationClock();
    let presenter!: BrowserPresenter;
    const world = new World(content, createInitialState(content), w => (presenter = new BrowserPresenter(w, {
      stage: stagePort([]), sound: null, store, clock, assets: new AssetIndex(), voices: new VoiceTable(),
    })));
    world.start();
    void world.act('use', { target: 'panel', who: 'picard' });
    await flush();
    expect(store.state.subtitle?.text).toBe('One.');
    // (as a load does: the old presenter goes quiet, the store starts over for the new world)
    presenter.dispose();
    store.reset();
    store.say({ who: 'data', name: 'Data', text: 'New world.' });
    for (let i = 0; i < 3; i++) {
      clock.update(10);
      await flush();
    }
    expect(store.state.subtitle?.text).toBe('New world.');
    expect(store.state.transcript.map(l => l.text)).toEqual(['New world.']);
    expect(world.busy).toBe(true);
    const asked = await Promise.race([presenter.choose('Go?', ['Yes', 'No']).then(() => 'answered'), flush().then(() => 'waiting')]);
    expect(asked).toBe('waiting');
    expect(store.state.dialog).toBeNull();
  });

  it('drives a world: a look ends when its line does', async () => {
    const content = makeGame([panel]);
    const store = new UiStore();
    const clock = new PresentationClock();
    const world = new World(content, createInitialState(content), w => new BrowserPresenter(w, {
      stage: stagePort([]), sound: null, store, clock, assets: new AssetIndex(), voices: new VoiceTable(),
    }));
    world.start();
    void world.act('look', { target: 'panel', who: 'picard' });
    await flush();
    expect(store.state.subtitle?.text).toBe('A panel.');
    expect(world.busy).toBe(true);
    clock.update(2);
    await flush();
    expect(world.busy).toBe(false);
    expect(store.state.subtitle).toBeNull();
  });
});
