// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { GameContent } from '../content/types';
import { createInitialState } from './state';

const content: GameContent = {
  id: 't',
  start: { screen: 'room', entrance: 'door', awayTeam: ['picard', 'data'], leader: 'picard', seed: 9 },
  screens: {
    room: { id: 'room', markers: { door: { x: 1, z: 2 }, panel: { x: 5, z: 0 } }, regions: { bridge: false } },
  },
  objects: {
    picard: { id: 'picard', name: 'Picard', screen: 'room', crew: true },
    data: { id: 'data', name: 'Data', screen: null, crew: true },
    panel: { id: 'panel', name: 'Panel', screen: 'room', at: 'panel', state: 2, timer: 3 },
    tricorder: { id: 'tricorder', name: 'Tricorder', screen: 'room', inventory: true },
  },
  triggers: [{ id: 't1', type: 'normal', context: 'away', target: 'panel', enabled: true }],
  rules: { items: {}, lines: {} },
  conversations: {},
  advice: {},
};

describe('createInitialState', () => {
  it('puts the away team at the start entrance', () => {
    const s = createInitialState(content);
    expect(s.screen).toBe('room');
    expect(s.objects.data).toMatchObject({ screen: 'room', pos: { x: 1, z: 2 } });
    expect(s.currentActor).toBe('picard');
  });

  it('places objects at their markers with their initial values', () => {
    const s = createInitialState(content);
    expect(s.objects.panel).toEqual({
      screen: 'room', pos: { x: 5, z: 0 }, state: 2, active: true, inventory: false,
      stunned: false, name: 'Panel', timer: 3, timerDue: 0, talk: '', talkVoice: null,
    });
  });

  it('takes inventory objects off the screen', () => {
    expect(createInitialState(content).objects.tricorder).toMatchObject({ screen: null, inventory: true });
  });

  it('copies regions and triggers so play never mutates the content', () => {
    const s = createInitialState(content);
    s.regions.room.bridge = true;
    s.objects.panel.pos.x = 99;
    expect(content.screens.room.regions?.bridge).toBe(false);
    expect(content.screens.room.markers.panel.x).toBe(5);
    expect(s.triggers).toEqual({ t1: { enabled: true, due: 0 } });
  });

  it('seeds from the argument, then the content', () => {
    expect(createInitialState(content).rngSeed).toBe(9);
    expect(createInitialState(content, 4).rngSeed).toBe(4);
  });
});
