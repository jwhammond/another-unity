// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { GameContent } from '../content/types';
import { COMBAT_SAVE_REFUSED, deserializeState, SaveError, serializeState } from './save';
import { createInitialState, STATE_VERSION, type WorldState } from './state';
import { HeadlessPresenter } from './presenter';
import { World } from './world';
import { miniShipContent } from '../testing/ship';

const content: GameContent = {
  id: 't',
  start: { screen: 'room', entrance: 'door', awayTeam: ['picard'], leader: 'picard' },
  screens: { room: { id: 'room', markers: { door: { x: 0, z: 0 } } } },
  objects: { picard: { id: 'picard', name: 'Picard', screen: 'room', crew: true } },
  triggers: [],
  rules: { items: {}, lines: {} },
  conversations: {},
  advice: {},
};

describe('saves', () => {
  it('round-trips the state', () => {
    const s = createInitialState(content);
    s.counters['picard/use/0'] = 3;
    expect(deserializeState(serializeState(s), content)).toEqual(s);
  });

  it('round-trips the animation an object is on, and reads a save from before it was kept', () => {
    const s = createInitialState(content);
    s.objects.picard!.anim = 2;
    expect(deserializeState(serializeState(s), content).objects.picard!.anim).toBe(2);
    // (a save with no `anim` on its objects is every save made before: the picture starts the object on its own animation)
    expect('anim' in deserializeState(serializeState(createInitialState(content)), content).objects.picard!).toBe(false);
  });

  it('rejects text that is not JSON', () => {
    expect(() => deserializeState('{oops', content)).toThrow(new SaveError('save is not valid JSON'));
  });

  it('rejects a save from a newer engine', () => {
    const text = JSON.stringify({ ...createInitialState(content), version: 5 });
    expect(() => deserializeState(text, content)).toThrow('save version 5 is newer than this engine (4)');
  });

  it('rejects a malformed save', () => {
    const text = JSON.stringify({ ...createInitialState(content), tick: 'soon' });
    expect(() => deserializeState(text, content)).toThrow(/^save is malformed: tick: /);
  });

  it('rejects a save from a different game', () => {
    const other = { ...content, objects: { ...content.objects, panel: { id: 'panel', name: 'P', screen: 'room' } } };
    expect(() => deserializeState(serializeState(createInitialState(content)), other))
      .toThrow('save does not match this game: missing objects panel');
  });

  it('rejects a save with no version', () => {
    const { version: _, ...rest } = createInitialState(content);
    expect(() => deserializeState(JSON.stringify(rest), content)).toThrow(new SaveError('save has no version'));
  });

  it('rejects a save from an older engine', () => {
    const text = JSON.stringify({ ...createInitialState(content), version: 0 });
    expect(() => deserializeState(text, content)).toThrow('save version 0 is older than any this engine reads');
  });

  it('checks object ids as own keys only', () => {
    const other = { ...content, objects: { ...content.objects, toString: { id: 'toString', name: 'T', screen: 'room' } } };
    expect(() => deserializeState(serializeState(createInitialState(content)), other))
      .toThrow('save does not match this game: missing objects toString');
  });

  const mismatch = (change: (s: WorldState) => void, c: GameContent = content) => {
    const s = createInitialState(content);
    change(s);
    return () => deserializeState(serializeState(s), c);
  };

  it('rejects a save on a screen this game does not have', () => {
    expect(mismatch(s => { s.screen = 'nowhere'; })).toThrow(new SaveError('save does not match this game: unknown screen "nowhere"'));
  });

  it('rejects an away team member or current actor that is not an object', () => {
    expect(mismatch(s => { s.awayTeam.push('ghost'); }))
      .toThrow(new SaveError('save does not match this game: away team member "ghost" is not an object'));
    expect(mismatch(s => { s.currentActor = 'ghost'; }))
      .toThrow(new SaveError('save does not match this game: current actor "ghost" is not an object'));
  });

  it('rejects a save missing a trigger or a screen\'s regions', () => {
    const more: GameContent = {
      ...content,
      screens: { ...content.screens, hall: { id: 'hall', markers: {} } },
      triggers: [{ id: 't', type: 'normal', context: 'away', target: 'picard', enabled: true }],
    };
    expect(mismatch(() => {}, more)).toThrow(new SaveError('save does not match this game: missing triggers t'));
    expect(mismatch(s => { s.triggers.t = { enabled: true, due: 0 }; }, more))
      .toThrow(new SaveError('save does not match this game: missing regions for screens hall'));
  });

  it('rejects an object on a screen this game does not have', () => {
    expect(mismatch(s => { s.objects.picard.screen = 'nowhere'; }))
      .toThrow(new SaveError('save does not match this game: object "picard" is on unknown screen "nowhere"'));
  });

  it('rejects a save with a screen change pending', () => {
    expect(mismatch(s => { s.pendingScreen = { to: 'room', entrance: 'door' }; }))
      .toThrow(new SaveError('save has a screen change pending'));
  });

  it('turns a zero seed into one, as a new game does', () => {
    expect(deserializeState(serializeState({ ...createInitialState(content), rngSeed: 0 }), content).rngSeed).toBe(1);
  });
});

describe('saves, version 4', () => {
  const ship = () => miniShipContent();
  /** What a v3 save held: no v4 fields, and a queue of ship effects. */
  function v3Save(c: GameContent, queue: unknown[]): string {
    const { computer: _c, adviceMode: _a, conversationLog: _l, beamWorld: _b, ...rest } = createInitialState(c, 1, { onShip: true }) as unknown as Record<string, unknown>;
    const s = rest.ship as Record<string, unknown>;
    for (const k of ['bridgeUse', 'warpPending', 'scriptedWarp', 'warpSpeed', 'universeMoves', 'awaySince', 'newWarpMovie', 'warpMoviesSeen', 'combat']) delete s[k];
    return JSON.stringify({ ...rest, version: 3, shipQueue: queue });
  }

  it('round-trips a v4 save', () => {
    const c = ship();
    const s = createInitialState(c, 1, { onShip: true });
    s.ship.bridgeUse = 'w.planet';
    s.ship.warpPending = true;
    s.ship.scriptedWarp = 110090090;
    s.ship.warpSpeed = 700;
    s.ship.universeMoves = [{ object: 'w.planet', start: 4, from: { x: 1, y: 2, z: 3 }, to: { x: 4, y: 5, z: 6 } }];
    s.ship.awaySince = 12;
    s.ship.newWarpMovie = true;
    s.ship.warpMoviesSeen = 3;
    s.ship.combat = { scenario: 8, enterprise: 'w.ent', enemies: ['w.planet'], friends: [], destroyed: [], warped: false, redAlert: true };
    s.computer = { hidden: [1, 9], readings: [1031, 1030] };
    s.adviceMode = 2;
    s.conversationLog = [[{ speaker: 'picard', text: '-Zap-' }, { speaker: null, text: '-Zip-' }]];
    s.beamWorld = 8;
    s.ship.seenMovies = ['shiptour', 'warp:2', 'labarriv'];
    s.phaser.picard.destroyed = true;
    expect(s.version).toBe(STATE_VERSION);
    expect(STATE_VERSION).toBe(4);
    expect(deserializeState(serializeState(s), c)).toEqual(s);
  });

  it('reads a save from before the holodeck as having seen the ship\'s tour only, as a new game has', () => {
    const c = ship();
    const s = createInitialState(c, 1, { onShip: true });
    const raw = JSON.parse(serializeState(s)) as { ship: Record<string, unknown> };
    delete raw.ship.seenMovies;
    expect(deserializeState(JSON.stringify(raw), c).ship.seenMovies).toEqual(['shiptour']);
  });

  it("a v3 save's shipQueue is applied once, in order, and a re-save has none", () => {
    const c = ship();
    const text = v3Save(c, [{ newWarpMovie: true }, { reveal: 0 }, { computer: 'hide', entry: 0 }, { universe: { object: 'w.ent', x: 110, y: 90, z: 90, speed: 500 } }]);
    const w = World.fromSave(c, text, x => new HeadlessPresenter(x.clock));
    expect(w.state.version).toBe(4);
    expect(w.state.ship).toMatchObject({ newWarpMovie: true, warpPending: true, scriptedWarp: 110090090, warpSpeed: 500 });
    expect(w.state.ship.flags[1]).toBe(0x10);
    // (in order: the hide came after the reveal, and the entry is now hidden)
    expect(w.state.computer.hidden).toEqual([2, 3, 4]);
    const again = w.save();
    expect('shipQueue' in JSON.parse(again)).toBe(false);
    const w2 = World.fromSave(c, again, x => new HeadlessPresenter(x.clock));
    expect(w2.state).toEqual(w.state);
  });

  it('a v3 save made while the team is away starts the ship timers\' delay from its tick (M12)', () => {
    const c = ship();
    const away = JSON.parse(v3Save(c, []));
    away.onShip = null;
    away.tick = 40;
    expect(deserializeState(JSON.stringify(away), c).ship.awaySince).toBe(40);
    // (aboard, there is nothing to delay)
    expect(deserializeState(v3Save(c, []), c).ship.awaySince).toBeNull();
  });

  it('a v3 save with an unknown object in its queue is refused', () => {
    const c = ship();
    expect(() => World.fromSave(c, v3Save(c, [{ universe: { object: 'ghost', x: 0, y: 0, z: 0 } }]), x => new HeadlessPresenter(x.clock)))
      .toThrow('a ship effect names unknown object "ghost"');
  });

  it('a v2 save migrates through v3 to v4', () => {
    const c = ship();
    const old = JSON.parse(v3Save(c, [{ repair: true }]));
    delete old.ship;
    old.version = 2;
    const s = deserializeState(JSON.stringify(old), c);
    expect(s.version).toBe(4);
    // (a v2 save back aboard went through endAwayTeam, which loads the ship's equipment)
    expect(s.ship).toEqual({ ...createInitialState(c, 1, { onShip: true }).ship, equipment: [] });
    expect(s.computer).toEqual({ hidden: [3, 4], readings: [] });
    expect(s.beamWorld).toBeNull();
    expect(s.phaser.picard.destroyed).toBe(false);
  });

  it('refuses a save naming an unknown bridgeUse, universe-move or combat object, or a beamWorld out of 1-8', () => {
    const c = ship();
    const bad = (change: (s: WorldState) => void) => {
      const s = createInitialState(c, 1, { onShip: true });
      change(s);
      return () => deserializeState(serializeState(s), c);
    };
    expect(bad(s => { s.ship.bridgeUse = 'ghost'; })).toThrow('the bridge uses unknown object "ghost"');
    expect(bad(s => { s.ship.universeMoves = [{ object: 'ghost', start: 0, from: { x: 0, y: 0, z: 0 }, to: { x: 1, y: 1, z: 1 } }]; }))
      .toThrow('a universe move names unknown object "ghost"');
    expect(bad(s => { s.ship.combat = { scenario: 8, enterprise: 'w.ent', enemies: ['ghost'], friends: [], destroyed: [], warped: false, redAlert: false }; }))
      .toThrow('the battle names unknown object "ghost"');
    expect(bad(s => { s.beamWorld = 9; })).toThrow(SaveError);
    expect(bad(s => { s.beamWorld = 0; })).toThrow(SaveError);
  });

  it('loads a startup whose actor is $none or $anyone, and refuses one that names an unknown object', () => {
    const s = createInitialState(content);
    s.startups.room = { advice: {}, closeup: false, combadge: null, inputBlocked: null, action: { verb: 'use', target: 'picard', who: '$none' } };
    expect(deserializeState(serializeState(s), content).startups.room.action?.who).toBe('$none');
    s.startups.room = { advice: {}, closeup: false, combadge: null, inputBlocked: null, action: { verb: 'use', target: 'picard', who: '$anyone' } };
    expect(() => deserializeState(serializeState(s), content)).not.toThrow();
    s.startups.room = { advice: {}, closeup: false, combadge: null, inputBlocked: null, action: { verb: 'use', target: 'picard', who: 'ghost' } };
    expect(() => deserializeState(serializeState(s), content)).toThrow('names unknown object "ghost"');
  });
});

describe('saves and combat (Plan 23 R4)', () => {
  it('drops the units\' hitWeight, aiTarget and aiCap, which ScummVM\'s ShipSystems::sync doesn\'t save (ship.cpp:267-276)', () => {
    const c = miniShipContent();
    const s = createInitialState(c, 1, { onShip: true });
    Object.assign(s.ship.systems.units[0]!, { hitWeight: 1, aiTarget: 50, aiCap: 0 });
    const text = serializeState(s);
    expect(text).not.toMatch(/hitWeight|aiTarget|aiCap/);
    const { hitWeight: _h, aiTarget: _t, aiCap: _c, ...kept } = s.ship.systems.units[0]!;
    expect(deserializeState(text, c).ship.systems.units[0]).toEqual(kept);
    // (the running game keeps them)
    expect(s.ship.systems.units[0]).toMatchObject({ hitWeight: 1, aiTarget: 50, aiCap: 0 });
  });

  it('drops the working fields from an older save that carries them, so the template\'s apply (ShipSystems::sync)', () => {
    const c = miniShipContent();
    const s = createInitialState(c, 1, { onShip: true });
    const raw = JSON.parse(JSON.stringify(s)) as typeof s;
    Object.assign(raw.ship.systems.units[0]!, { hitWeight: 1, aiTarget: 50, aiCap: 0 });
    const loaded = deserializeState(JSON.stringify(raw), c).ship.systems.units[0]!;
    expect(loaded).not.toHaveProperty('hitWeight');
    expect(loaded).not.toHaveProperty('aiTarget');
    expect(loaded).not.toHaveProperty('aiCap');
  });

  it('refuses a save during a battle, in ScummVM\'s words (save.cpp:156-159), and saves again once it is over', () => {
    const c = miniShipContent();
    const world = new World(c, createInitialState(c, 1, { onShip: true }), w => new HeadlessPresenter(w.clock));
    world.state.ship.combat = { scenario: 8, enterprise: 'w.ent', enemies: [], friends: [], destroyed: [], warped: false, redAlert: true };
    expect(() => world.save()).toThrow(COMBAT_SAVE_REFUSED);
    expect(COMBAT_SAVE_REFUSED).toBe("You can't save during combat.");
    world.state.ship.combat = null;
    expect(() => world.save()).not.toThrow();
  });
});
