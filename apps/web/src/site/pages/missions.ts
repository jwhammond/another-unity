// SPDX-License-Identifier: GPL-3.0-or-later
export type MissionWorld = 'horst3' | 'mertens' | 'allanor' | 'zoo' | 'frigis' | 'unity';
export type MissionInfo = {
  world: MissionWorld;
  name: string;
  /** The room-id prefix in the game's data (Mertens Station is `lab` there). */
  gameWorld: string;
  /** The rooms that have a published plate (from docs/unity-art-status.md): the cut rooms and the two advice lists are not here. */
  rooms: string[];
  /** Sprite sheets (`sheet.<card>` in the media manifest): the world's own cards first, then any effect sheet that belongs to it. */
  cards: string[];
};

const hex = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => `s${(a + i).toString(16).padStart(2, '0')}`);

export const MISSIONS: MissionInfo[] = [
  { world: 'horst3', name: 'Horst III', gameWorld: 'horst3', rooms: hex(1, 4), cards: ['world.horst3'] },
  { world: 'mertens', name: 'Mertens Station', gameWorld: 'lab', rooms: hex(1, 13), cards: ['world.lab', 'beam_effect'] },
  { world: 'allanor', name: 'Allanor', gameWorld: 'allanor', rooms: ['s01', ...hex(3, 20)], cards: ['world.allanor', 'beam_chodak'] },
  { world: 'zoo', name: 'The zoo', gameWorld: 'zoo', rooms: [...hex(1, 10), 's10'], cards: ['world.zoo'] },
  { world: 'frigis', name: 'Frigis', gameWorld: 'frigis', rooms: [...hex(1, 10), 's0c', 's0d'], cards: ['world.frigis'] },
  { world: 'unity', name: 'Unity', gameWorld: 'unity', rooms: hex(1, 16), cards: ['world.unity'] },
];

export const missionFor = (world: string | undefined) => MISSIONS.find(m => m.world === world);
