// SPDX-License-Identifier: GPL-3.0-or-later
import { lineConversation, makeGame } from '@another-unity/engine';
import { GameMaps, type CoordsFile, type IdsFile } from '../maps';

const FLAT = { kind: 'flat', slope: 0, horizonY: 0, meanScale: 256, topY: 0, metersPerPixel: 0.0125, samples: 0, rms: 0 } as const;

/**
 * Plan 1's test game (Picard and Data on "room", and "hall"), with a rubble that has a near check and
 * phaser data, a lever, a trigger and a conversation, plus the ids.yaml, coords.yaml and voices.yaml the
 * lifter would write for them. Both screens are flat at 0.0125 m a pixel: pixel (320 + 80x, 399 + 40z)
 * is the point (x, z).
 */
export function testMaps(): GameMaps {
  const content = makeGame([
    {
      id: 'rubble', name: 'rubble', screen: 'room', at: 'panel', phaser: { health: 10, threshold: 4, damageFrom: 1, gtpFrom: 4 },
      on: { use: [{ when: { near: { dist: 1 } }, do: [{ alter: { object: 'rubble', state: 1 } }] }, { do: [] }] },
    },
    { id: 'lever', name: 'lever', screen: 'room', at: 'center', on: { use: [{ do: [{ alter: { object: 'lever', state: 2 } }] }] } },
  ], {
    triggers: [{ id: 't3', type: 'normal', context: 'away', target: 'lever', enabled: true }],
    conversations: { 'horst3.c000': lineConversation('horst3.c000', { 1: 'Hello.' }) },
    advice: { 'horst3.a1': { easy: { data: 'Advice.' } } },
  });
  content.screens.room.markers.entrance_0 = { x: 0, z: 0 };
  const ids: IdsFile = {
    worlds: { '00': 'crew', '07': 'horst3' },
    screens: { s_0701: 'room', s_0702: 'hall' },
    objects: { '000000': 'picard', '000001': 'data', '070103': 'rubble', '070104': 'lever' },
    conversations: { w007c000: 'horst3.c000' },
    triggers: { '3': 't3' },
    advice: { 'w_07/1': 'horst3.a1' },
    lists: { 'o_070103#/use_entries': 'rubble/use', 'o_070104#/use_entries': 'lever/use', 'w007c000#/responses/0/results/0': 'horst3.c000/0/results0' },
  };
  const coords: CoordsFile = {
    metersPerPixel: 0.0125,
    screens: {
      room: { projection: { ...FLAT }, markers: { entrance_0: [320, 399], door: [320, 399], panel: [1120, 399], center: [720, 599] } },
      hall: { projection: { ...FLAT }, markers: { entry: [400, 439] } },
    },
  };
  // (64: a ship trigger, 70: an unused one, 99: an away trigger the lift ought to have named)
  const rawTriggers = [
    { id: 3, type: 0, context: 1, target: '070104' },
    { id: 64, type: 2, context: 0, target: '5f0340' },
    { id: 70, type: 3, context: 1, target: '070104' },
    { id: 99, type: 0, context: 1, target: '070104' },
  ];
  return new GameMaps(ids, coords, { speakers: { picard: '00', data: '01' }, other: 'ff' }, content, rawTriggers);
}
