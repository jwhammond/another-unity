// SPDX-License-Identifier: GPL-3.0-or-later
import { ANYONE, type ConversationDef, type GameContent, type ObjectDef, type PhaserDef, type PixelMetric, type ScreenDef } from '../content/types';
import { HeadlessPresenter } from '../sim/presenter';
import { createInitialState } from '../sim/state';
import { World } from '../sim/world';

/** The crew's phaser data in the test game: down at health 4 or less. */
export const CREW_PHASER: PhaserDef = { health: 10, threshold: 4, damageFrom: 1, gtpFrom: 4 };

/**
 * A deep floor, as Horst III's s03 is fitted: near the back, one row is several columns' width deep. Its one polygon,
 * the region `deck`, covers rows 211-399, its corners scaled as the fit has them.
 */
export const DEEP_FLOOR: PixelMetric = {
  kind: 'perspective', slope: 0.917568, horizonY: 129.095, meanScale: 101.304, topY: 211, metersPerPixel: 0.0125,
  floor: [{ region: 'deck', points: [{ x: 0, y: 211, scale: 75 }, { x: 639, y: 211, scale: 75 }, { x: 639, y: 399, scale: 248 }, { x: 0, y: 399, scale: 248 }] }],
};

/** What a test screen needs to stand on DEEP_FLOOR: the metric, with its deck open. */
export const DEEP_SCREEN: Pick<ScreenDef, 'pixelMetric' | 'regions'> = { pixelMetric: DEEP_FLOOR, regions: { deck: true } };

/**
 * A two-screen game for unit tests. Picard (skills 0x5555) and Data (0x9999)
 * start at "door" (0, 0) on "room", with CREW_PHASER health.
 */
export function makeGame(objects: ObjectDef[], extra: Partial<GameContent> = {}): GameContent {
  const crew: ObjectDef[] = [
    { id: 'picard', name: 'Picard', screen: 'room', crew: true, skills: 0x5555, phaser: { ...CREW_PHASER } },
    { id: 'data', name: 'Data', screen: 'room', crew: true, skills: 0x9999, phaser: { ...CREW_PHASER } },
  ];
  return {
    id: 'test',
    start: { screen: 'room', entrance: 'door', awayTeam: ['picard', 'data'], leader: 'picard', seed: 1 },
    screens: {
      room: {
        id: 'room',
        markers: { door: { x: 0, z: 0 }, panel: { x: 10, z: 0 }, center: { x: 5, z: 5 } },
        regions: { bridge: false },
      },
      hall: { id: 'hall', markers: { entry: { x: 1, z: 1 } }, regions: {} },
    },
    objects: Object.fromEntries([...crew, ...objects].map(o => [o.id, o])),
    triggers: [],
    rules: { items: {}, lines: {} },
    conversations: {},
    advice: {},
    ...extra,
  };
}

export function makeWorld(objects: ObjectDef[], extra: Partial<GameContent> = {}): World {
  const content = makeGame(objects, extra);
  const world = new World(content, createInitialState(content), w => new HeadlessPresenter(w.clock));
  world.start();
  return world;
}

/** A conversation of plain lines, one per situation, that anyone with the team can say. */
export function lineConversation(id: string, lines: Record<number, string>): ConversationDef {
  return {
    id,
    responses: Object.entries(lines).map(([situation, text]) => ({
      situation: Number(situation),
      key: 0,
      state: 'enabled',
      who: [ANYONE],
      text,
    })),
  };
}
