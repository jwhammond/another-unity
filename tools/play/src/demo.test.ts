// SPDX-License-Identifier: GPL-3.0-or-later
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Play } from './play';

const demo = fileURLToPath(new URL('../fixtures/demo', import.meta.url));

async function walkthrough(): Promise<Play> {
  const play = await Play.load(demo);

  // only Data can work the panel; Picard walks over and gives up
  await play.use('picard', 'panel', 'tricorder');
  expect(play.log).toContain('say picard: We need to understand it first.');
  expect(play.obj('picard').pos).toEqual({ x: 3, z: 0 });

  // the door is sealed until the power is rerouted
  await play.walk('picard', 'door');
  expect(play.log).toContain('say picard: The door is sealed.');

  await play.answer(0).use('data', 'panel', 'tricorder');
  expect(play.obj('door').state).toBe(1);
  expect(play.obj('panel').state).toBe(1);
  expect(play.state.regions.corridor.doorway).toBe(true);

  await play.walk('picard', 'door');
  expect(play.state.screen).toBe('lab');
  expect(play.obj('data')).toMatchObject({ screen: 'lab', pos: { x: 0, z: 0 } });

  await play.get('picard', 'chip');
  expect(play.obj('chip')).toMatchObject({ inventory: true, screen: null });

  // Picard walks up to the guard; the menu lists the last line in the file first
  let mark = play.log.length;
  await play.pick(1).talk('picard', 'guard');
  expect(play.obj('picard').pos).toEqual({ x: 5, z: 0 });
  expect(play.log.slice(mark)).toEqual([
    'walk picard -> 5,0',
    'menu We mean no harm. | Who goes there?',
    'say picard: Who goes there?',
    'say guard: I keep the lab.',
    // (only one line is left, so it runs without a menu)
    'say picard: We mean no harm.',
    'say guard: Then pass.',
  ]);
  expect(play.obj('guard').state).toBe(1);
  expect(play.state.conversations.guard).toEqual(['disabled', 'disabled', 'enabled']);

  mark = play.log.length;
  await play.talk('picard', 'guard');
  expect(play.log.slice(mark)).toEqual(['say picard: Anything else?', 'say guard: No.']);

  // the tricorder: a reading on the guard, and nothing on the chip
  mark = play.log.length;
  await play.use('picard', 'guard', 'tricorder');
  await play.use('picard', 'chip', 'tricorder');
  expect(play.log.slice(mark)).toEqual(['tricorder 12', 'say picard: Nothing unusual.']);
  expect(play.state.readings).toEqual([{ world: 'demo', group: 12 }]);

  // the phaser, on medium: the guard is stunned; firing on Data is refused
  mark = play.log.length;
  await play.setPhaser(2).use('picard', 'guard', 'phaser');
  await play.use('picard', 'data', 'phaser');
  expect(play.log.slice(mark)).toEqual(['phaser picard -> guard', "say picard: I can't fire on that."]);
  expect(play.obj('guard').state).toBe(2);
  expect(play.state.phaser.guard).toMatchObject({ health: 1, stunned: true });

  await play.advance(16);
  return play;
}

describe('demo game', () => {
  it('plays from start to finish', async () => {
    const play = await walkthrough();
    const alarms = play.log.filter(line => line === 'say data: Captain, the alarm is getting louder.');
    expect(alarms).toHaveLength(2);
  });

  it('is deterministic', async () => {
    const a = await walkthrough();
    const b = await walkthrough();
    expect(a.world.save()).toBe(b.world.save());
    expect(a.log).toEqual(b.log);
  });

  it('survives a save and load mid-game', async () => {
    const play = await walkthrough();
    const loaded = Play.fromSave(play.world.content, play.world.save());
    expect(loaded.state).toEqual(play.state);
  });

  it('plays on from a save made in the lab exactly as the game it was saved from', async () => {
    const play = await Play.load(demo);
    await play.answer(0).use('data', 'panel', 'tricorder');
    await play.walk('picard', 'door');
    await play.get('picard', 'chip');
    expect(play.state.screen).toBe('lab');
    const loaded = Play.fromSave(play.world.content, play.world.save());

    const mark = play.log.length;
    const onwards = async (p: Play) => {
      await p.pick(1).talk('picard', 'guard');
      await p.talk('picard', 'guard');
      await p.use('picard', 'guard', 'tricorder');
      await p.setPhaser(3).use('picard', 'guard', 'phaser');
      await p.advance(16);
    };
    await onwards(play);
    await onwards(loaded);

    expect(loaded.log).toEqual(play.log.slice(mark));
    expect(loaded.log).toContain('phaser picard -> guard');
    expect(loaded.world.save()).toBe(play.world.save());
  });

  it('fails at the step whose action broke', async () => {
    const play = await Play.load(demo);
    await expect(play.use('data', 'panel', 'tricorder')).rejects.toThrow('no scripted answer for choice: Reroute the power?');
  });

  it('fails when a conversation menu has no scripted pick', async () => {
    const play = await Play.load(demo);
    await play.answer(0).use('data', 'panel', 'tricorder');
    await play.walk('picard', 'door');
    expect(play.state.screen).toBe('lab');
    await expect(play.talk('picard', 'guard')).rejects.toThrow('no scripted pick for menu: We mean no harm. | Who goes there?');
  });

  it('reports every error from a step, not just the first', async () => {
    const play = await Play.load(demo);
    play.world.bus.on(e => { if (e.type === 'actionFailed') throw new Error('bad subscriber'); });
    const err: unknown = await play.use('data', 'panel', 'tricorder').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AggregateError);
    expect((err as AggregateError).message).toBe('2 errors');
    expect((err as AggregateError).errors.map(e => (e as Error).message))
      .toEqual(['no scripted answer for choice: Reroute the power?', 'bad subscriber']);
    expect(play.world.errors).toEqual([]);
  });

  it('refuses a phaser setting without a phaser', async () => {
    const play = await Play.load(demo);
    play.obj('phaser').inventory = false;
    expect(() => play.setPhaser(2)).toThrow('there is no phaser in the inventory');
  });
});
