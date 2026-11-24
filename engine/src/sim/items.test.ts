// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { checkRefs } from '../content/refs';
import type { ObjectDef } from '../content/types';
import { lineConversation, makeGame, makeWorld } from '../testing/fixture';
import type { HeadlessPresenter } from './presenter';
import { settle } from './settle';
import type { World } from './world';

const lines: Record<number, string> = {};
for (const s of [2, 4, 6, 7, 8, 15, 16, 17, 24, 25, 26, 33, 34, 35]) lines[s] = `line ${s}`;

const item = (id: string, inventory = true): ObjectDef => ({ id, name: id, screen: inventory ? null : 'room', inventory });
const guard: ObjectDef = {
  id: 'guard', name: 'Guard', screen: 'room', at: 'panel',
  phaser: { health: 3, threshold: 1, damageFrom: 1, gtpFrom: 4 },
  on: {
    use: [
      { when: { other: 'medtric' }, do: [{ say: { who: 'picard', text: 'Not a patient.' } }] },
      { when: { other: 'phaser' }, do: [{ say: { who: 'picard', text: 'Put that down.' } }] },
    ],
  },
};

function world(phaserInInventory = true): World {
  const crusher: ObjectDef = { id: 'crusher', name: 'Crusher', screen: 'room', crew: true };
  return makeWorld([guard, crusher, item('phaser', phaserInInventory), item('medtric'), item('medkit')], {
    start: { ...makeGame([]).start, awayTeam: ['picard', 'data', 'crusher'] },
    conversations: { med: lineConversation('med', lines) },
    rules: {
      doctor: 'crusher',
      items: { phaser: 'phaser', medicalTricorder: 'medtric', medkit: 'medkit' },
      lines: { medical: { conversation: 'med', order: ['picard', 'data', 'crusher'] } },
    },
  });
}

async function use(w: World, target: string, other: string, who = 'picard'): Promise<string | undefined> {
  void w.act('use', { target, other, who });
  await settle(w);
  return (w.presenter as HeadlessPresenter).log.at(-1);
}

describe('useAwayTeamItem', () => {
  it('fires the phaser from the inventory at things with phaser data, after their rules', async () => {
    const w = world();
    w.state.phaserSetting = 2;
    expect(await use(w, 'guard', 'phaser')).toBe('phaser picard -> guard');
    expect((w.presenter as HeadlessPresenter).log).toEqual(['say picard: Put that down.', 'phaser picard -> guard']);
    expect(w.state.phaser.guard.health).toBe(1);
  });

  it('treats a phaser that is not in the inventory like anything else', async () => {
    const w = world(false);
    expect(await use(w, 'guard', 'phaser')).toBe('say picard: Put that down.');
    expect(w.state.phaser.guard.health).toBe(3);
  });

  it('reads a patient with the medical tricorder', async () => {
    const w = world();
    expect(await use(w, 'data', 'medtric')).toBe('say picard: line 7');
    w.state.phaser.data.health = 6;
    expect(await use(w, 'data', 'medtric')).toBe('say picard: line 16');
    w.state.phaser.data.health = 4;
    expect(await use(w, 'data', 'medtric')).toBe('say picard: line 16');
    w.state.phaser.data.health = 3;
    expect(await use(w, 'data', 'medtric')).toBe('say picard: line 25');
    w.state.phaser.data.health = -1;
    expect(await use(w, 'data', 'medtric')).toBe('say picard: line 34');
    expect(await use(w, 'picard', 'medtric')).toBe('say picard: line 4');
  });

  it('treats with the medkit: up to the threshold, or better by the doctor', async () => {
    const w = world();
    const recovered: string[] = [];
    w.bus.on(e => { if (e.type === 'recovered') recovered.push(e.id); });
    w.state.phaser.data.health = 6;
    expect(await use(w, 'data', 'medkit')).toBe('say picard: line 2');
    expect(w.state.phaser.data.health).toBe(6);

    w.state.phaser.data = { health: 2, stunned: true, regenAt: 0, destroyed: false };
    w.clock.advanceTo(100);
    expect(await use(w, 'data', 'medkit')).toBe('say picard: line 16');
    expect(w.state.phaser.data).toEqual({ health: 4, stunned: true, regenAt: 100, destroyed: false });
    expect(w.isIncapacitated('data')).toBe(true);

    w.state.phaser.data.health = 2;
    expect(await use(w, 'data', 'medkit', 'crusher')).toBe('say crusher: line 16');
    expect(w.state.phaser.data).toMatchObject({ health: 8, stunned: false });
    expect(recovered).toEqual(['data']);

    w.state.phaser.data.health = -1;
    expect(await use(w, 'data', 'medkit', 'crusher')).toBe('say crusher: line 16');
    expect(w.state.phaser.data.health).toBe(6);
    w.state.phaser.data.health = -1;
    await use(w, 'data', 'medkit');
    expect(w.state.phaser.data.health).toBe(4);
  });

  it('works the medical items from outside the inventory', async () => {
    const w = world();
    w.obj('medkit').inventory = false;
    w.state.phaser.data.health = 2;
    expect(await use(w, 'data', 'medkit')).toBe('say picard: line 16');
  });

  it('leaves a medical item used on something that is not crew to the rules', async () => {
    const w = world();
    expect(await use(w, 'guard', 'medtric')).toBe('say picard: Not a patient.');
  });

  it('needs the medical lines, for every crew member with phaser data', () => {
    const c = makeGame([item('medkit')], { rules: { items: { medkit: 'medkit' }, lines: {} } });
    expect(checkRefs(c)).toEqual(['game.yaml: rules.lines.medical: needed for the medical tricorder and medkit']);
    const partial = makeGame([item('medkit')], {
      conversations: { med: lineConversation('med', lines) },
      rules: { items: { medkit: 'medkit' }, lines: { medical: { conversation: 'med', order: ['picard'] } } },
    });
    expect(checkRefs(partial)).toEqual(['game.yaml: rules.lines.medical.order: missing crew member "data"']);
  });
});
