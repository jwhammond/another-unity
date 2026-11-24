// SPDX-License-Identifier: GPL-3.0-or-later
import type { GameContent, ShipContent } from '../content/types';
import { makeGame } from './fixture';

/** A made-up ship for tests: two sectors, an Enterprise and a planet with positions, and two teams. */
export function miniShipData(): ShipContent {
  const sector = (firstStar: number) => ({
    numStars: 1, numPhenomena: 0, alignment: 0, firstStar, firstPhenomenon: 0, station: -1, description: '', name: `Sector ${firstStar}`, region: 0,
  });
  const star = (id: number, x: number) => ({
    id, type: 0, seed: 0, x, y: 90, z: 90, name: `Star ${id}`, range: 0,
    flags: 0, spectralClass: 0, magnitude: 0, orbitScale: 1, systemName: '', scriptedName: '', scriptedDescription: '', special: -1,
  });
  return {
    universe: {
      sectors: [sector(0), sector(1)], stars: [star(0, 90), star(1, 110)], phenomena: [], stations: [], specials: [],
      flags: [1, 0], regionChatter: [], warpSpeeds: Array<number>(90).fill(1e10), impulseSpeeds: [1e10], scriptedWarps: [{ code: 110090090, sector: 1, star: 0, planet: -1, type: 0x20, index: 0 }], planetOrbits: [1, 2], reveals: [1],
    },
    data: {
      bridge: { items: [], objects: [], turbolift: [] },
      transporter: {
        exits: [],
        teams: [{ world: 1, members: ['picard', 'data'], items: [] }, { world: 2, members: ['data'], items: [] }],
        targets: [],
        pads: [],
      },
      crew: { leaderOrder: ['picard', 'data'], voices: [] },
      speeds: { warp: [1, 2], impulse: [1] },
      // (full health: warp, matter/antimatter, impulse, fusion and sensors, so maxWarp is 940 and the sensors chart)
      units: [4, 6, 3, 5, 8, 11].map(type => ({
        name: type === 8 ? 'Long-Zap' : `Unit ${type}`, type, current: 100, target: 100, max: 100, chargeTicks: 0, dischargeTicks: 0,
        damage: 0, repair: 0, baseDamage: 0, maxDamage: 0, efficiency: type === 5 || type === 6 ? 95 : 0,
      })),
      astro: {
        enterprise: 'w.ent', starbaseBattle: 80, defaultBattle: 8,
        triggers: { arriveStarbase: 't1', arriveStar: 't1', firstVisit: 't1', runAway: 't1', secondVisitCheck: 't1', secondVisit: 't1' },
      },
      equipment: [],
      contacts: { comms: [{ object: 'w.planet', sprite: false }], lounge: [] },
    },
    computer: {
      entries: [0, 1, 2, 3, 4, 5].map(i => ({ title: `Entry ${i}`, heading: '', text: '', flags: 0, subentries: [] })),
      // (a script's entry number n names entry entryIds[n]; entries 3 and 4 start hidden, and the readings unhide them)
      entryIds: [2, 3, 4],
      readingParents: { 1030: 4, 1031: 4 },
      hidden: [3, 4],
      startReadings: [],
      readings: [
        { key: 1030, world: 'test', group: 3, index: 0, entry: 5, parent: 4 },
        { key: 1031, world: 'test', group: 3, index: 1, entry: 3, parent: 4 },
        { key: 1040, world: 'test', group: 4, index: 0, entry: 5, parent: 4 },
      ],
    },
  };
}

/** A game with that ship, whose bridge a new game starts on; its away start is still `room`. */
export function miniShipContent(): GameContent {
  return makeGame(
    [
      { id: 'w.ent', name: 'Enterprise', screen: null, universe: { x: 90, y: 90, z: 90 } },
      { id: 'w.planet', name: 'Planet', screen: null, universe: { x: 10, y: 20, z: 30 } },
    ],
    { triggers: [{ id: 't1', type: 'normal', context: 'ship', target: 'w.ent', enabled: false }], ship: miniShipData() },
  );
}
