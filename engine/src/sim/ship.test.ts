// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { miniShipContent } from '../testing/ship';
import { makeGame } from '../testing/fixture';
import { deserializeState, SaveError, serializeState } from './save';
import { NO_SCENARIO, newShipState, sectorOf } from './ship';
import { createInitialState, STATE_VERSION } from './state';
import { HeadlessPresenter } from './presenter';
import { SHIP } from '../content/types';
import { settle } from './settle';
import { World } from './world';

/** What a v2 save held: no ship, no object positions. */
function v2Save(c = miniShipContent(), opts: { onShip?: boolean } = {}): string {
  const s = createInitialState(c, 1, opts) as unknown as Record<string, unknown>;
  const { ship: _ship, ...rest } = s;
  const objects = Object.fromEntries(Object.entries(s.objects as Record<string, Record<string, unknown>>)
    .map(([id, o]) => [id, Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'universe'))]));
  return JSON.stringify({ ...rest, objects, version: 2 });
}

describe('the ship state', () => {
  it("starts at (90, 90, 90) on the bridge, with ast_stat's flags", () => {
    const s = createInitialState(miniShipContent(), 1, { onShip: true });
    expect(s.onShip).toEqual({ gameOver: null });
    expect(s.awayTeam).toEqual([]);
    expect(s.ship.station).toBe('bridge');
    expect(s.ship.pos).toEqual({ x: 90, y: 90, z: 90 });
    expect(s.ship.battleScenario).toBe(NO_SCENARIO);
    expect(s.ship.flags).toEqual(miniShipContent().ship!.universe.flags);
    expect(s.ship.equipment).toBeNull();
    expect(s.objects['w.ent'].universe).toEqual({ x: 90, y: 90, z: 90 });
    expect(s.objects['w.planet'].universe).toEqual({ x: 10, y: 20, z: 30 });
    expect(s.screen).toBe('room');
  });

  it('keeps the away start without the option', () => {
    const s = createInitialState(miniShipContent(), 1);
    expect(s.onShip).toBeNull();
    expect(s.awayTeam).toEqual(['picard', 'data']);
    expect(s.objects.picard.screen).toBe('room');
  });

  it('puts no team on the screen for a start on the ship', () => {
    const s = createInitialState(miniShipContent(), 1, { onShip: true });
    expect(s.objects.picard.screen).toBe('room');
    expect(s.spritesLoaded).not.toContain('guard');
  });

  it('numbers sectors as the original does', () => {
    const u = miniShipContent().ship!.universe;
    expect(sectorOf(u, { x: 90, y: 90, z: 90 })).toBe(4 + 4 * 8 + 4 * 64);
    expect(sectorOf(u, { x: 0, y: 0, z: 0 })).toBe(0);
    expect(newShipState(miniShipContent()).lastSector).toBe(4 + 4 * 8 + 4 * 64);
  });

  it('gives a game with no ship an empty one', () => {
    const s = createInitialState(makeGame([]));
    expect(s.ship.flags).toEqual([]);
    expect(s.onShip).toBeNull();
  });
});

describe('saves, version 3', () => {
  it('round-trips a v3 save', () => {
    const c = miniShipContent();
    const s = createInitialState(c, 1, { onShip: true });
    s.ship.station = 'astrogation';
    s.ship.equipment = ['picard'];
    s.ship.viewscreenTarget = 'w.planet';
    s.ship.transit = {
      from: { x: 1, y: 2, z: 3 }, to: { x: 4, y: 5, z: 6 }, orbit: 0, destination: { sector: 1, star: 0, planet: -1, moon: -1, station: -1, phenomenon: -1 },
      destType: 1, destStarId: 1, warp: true, speed: 2, startTick: 5, ticks: 50,
    };
    expect(s.version).toBe(STATE_VERSION);
    expect(deserializeState(serializeState(s), c)).toEqual(s);
  });

  it('migrates a v2 save away and a v2 save back aboard', () => {
    const c = miniShipContent();
    const away = deserializeState(v2Save(c), c);
    expect(away.version).toBe(STATE_VERSION);
    expect(away.onShip).toBeNull();
    // (away, so the ship's timers are delayed by the time from its tick on the return, M12)
    expect(away.ship).toEqual({ ...newShipState(c), awaySince: away.tick });
    expect(away.objects['w.planet'].universe).toEqual({ x: 10, y: 20, z: 30 });
    expect(away.objects['w.ent'].universe).toEqual({ x: 90, y: 90, z: 90 });

    const aboard = createInitialState(c, 1);
    aboard.onShip = { gameOver: null };
    // (v2 never ended the away mission: the team, and whoever was acting, are still set)
    aboard.awayTeam = ['picard'];
    aboard.currentActor = 'data';
    const text = JSON.stringify({ ...aboard, ship: undefined, version: 2, shipQueue: [{ repair: true }] });
    const back = deserializeState(text, c);
    expect(back.onShip).toEqual({ gameOver: null });
    expect(back.ship.station).toBe('bridge');
    expect('shipQueue' in back).toBe(false);
    // endAwayTeam ran: nobody is away and the captain is acting
    expect(back.awayTeam).toEqual([]);
    expect(back.currentActor).toBe(c.start.leader);
  });

  it('migrates a v2 save for a game with no ship', () => {
    const c = makeGame([]);
    const s = deserializeState(v2Save(c), c);
    expect(s.ship.flags).toEqual([]);
  });

  it('refuses a save naming an unknown viewscreenTarget or equipment object', () => {
    const c = miniShipContent();
    const s = createInitialState(c, 1, { onShip: true });
    s.ship.viewscreenTarget = 'w.gone';
    expect(() => deserializeState(serializeState(s), c)).toThrow(/viewscreen shows unknown object "w.gone"/);
    s.ship.viewscreenTarget = null;
    s.ship.equipment = ['nope'];
    expect(() => deserializeState(serializeState(s), c)).toThrow(/equipment names unknown object "nope"/);
  });

  it('refuses a malformed ship and a v3 save without one', () => {
    const c = miniShipContent();
    const s = createInitialState(c, 1, { onShip: true });
    const bad = JSON.stringify({ ...s, ship: { ...s.ship, station: 'galley' } });
    expect(() => deserializeState(bad, c)).toThrow(SaveError);
    expect(() => deserializeState(JSON.stringify({ ...s, ship: undefined }), c)).toThrow(/ship/);
  });

  it('refuses a v1 save', () => {
    const c = miniShipContent();
    const text = JSON.stringify({ ...createInitialState(c), version: 1 });
    expect(() => deserializeState(text, c)).toThrow('save version 1 is older than any this engine reads');
  });
});

describe('a new game on the ship', () => {
  it('runs no away screen, and ticks without an away mission', () => {
    const c = miniShipContent();
    const w = new World(c, createInitialState(c, 1, { onShip: true }), x => new HeadlessPresenter(x.clock));
    w.start();
    for (let i = 0; i < 10; i++) w.tick();
    expect(w.state.tick).toBe(10);
    expect(w.state.onShip).toEqual({ gameOver: null });
    expect((w.presenter as HeadlessPresenter).log).toEqual([]);
  });
});

describe('back aboard', () => {
  function away() {
    const c = makeGame(
      [
        { id: 'kit', name: 'Kit', screen: null, inventory: true },
        { id: 'spare', name: 'Spare', screen: null },
        { id: 'w.ent', name: 'Enterprise', screen: null, universe: { x: 90, y: 90, z: 90 } },
      ],
      { ship: miniShipContent().ship },
    );
    const w = new World(c, createInitialState(c, 1), x => new HeadlessPresenter(x.clock));
    w.start();
    return w;
  }

  it("heals the crew and keeps what was carried in the ship's equipment", async () => {
    const w = away();
    const s = w.state;
    s.phaser.picard = { health: 3, stunned: true, regenAt: 5, destroyed: false };
    s.phaser.data.health = 1;
    s.ship.equipment = ['spare'];
    s.ship.station = 'transporter';
    s.ship.clockStopped = 7;
    s.pendingScreen = { to: SHIP, entrance: '' };
    w.applyScreenChange();
    await settle(w);
    expect(s.onShip).toEqual({ gameOver: null });
    expect(s.phaser.picard).toMatchObject({ health: 10, stunned: false });
    expect(s.phaser.data.health).toBe(10);
    expect(s.objects.kit.inventory).toBe(false);
    expect(s.objects.kit.screen).toBeNull();
    expect(s.ship.equipment).toEqual(['spare', 'kit']);
    // back to the bridge, with the clock running again
    expect(s.ship.station).toBe('bridge');
    expect(s.ship.clockStopped).toBe(0);
    expect(s.awayTeam).toEqual([]);
  });

  it('keeps the game-over panel for a game that ended', async () => {
    const w = away();
    w.state.pendingScreen = { to: SHIP, entrance: '', gameOver: 3 };
    w.applyScreenChange();
    await settle(w);
    expect(w.state.onShip).toEqual({ gameOver: 3 });
    expect(w.state.phaser.picard.health).toBe(10);
  });
});
