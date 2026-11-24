// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { ContentError, parseCombatFor } from '../content/parse';
import type { CombatData, GameContent } from '../content/types';
import { BATTLE, battleContent, CHODAK } from '../testing/battle';
import { COMBAT_READ_TIMEOUT_MS, combatReadError, ensureCombat, prefetchCombat } from './combatData';
import { HeadlessPresenter } from './presenter';
import { flush, settle } from './settle';
import { STATION_CODE } from './ship';
import { createInitialState } from './state';
import { gotoShipScreen } from './stations';
import { World } from './world';

/** battleContent's game parsed without combat.yaml, as the web app parses it (M8 spec §8), and its combat.yaml's text. */
function lazyGame(edit: (combat: CombatData) => void = () => {}): { content: GameContent; text: string } {
  const content = battleContent();
  const combat = content.ship!.combat!;
  delete content.ship!.combat;
  // (the fixture's battles name a space screen its game hasn't: the checks would refuse them, as parseGame would)
  for (const b of Object.values(combat.battles)) b.screen = content.start.screen;
  edit(combat);
  return { content, text: stringify(combat) };
}

/** A world on the ship that fights in the combat sim, with combat.yaml from `source`; the warnings it says. */
function lazyWorld(content: GameContent, source: () => Promise<string>) {
  const world = new World(content, createInitialState(content, 1, { onShip: true }), w => new HeadlessPresenter(w.clock), { combat: 'real', combatSource: source });
  world.hooks.register('rec', () => 0);
  const warnings: string[] = [];
  world.bus.on(e => { if (e.type === 'warning') warnings.push(e.message); });
  const enter = async () => {
    world.state.ship.battleScenario = BATTLE;
    void world.enqueue(() => gotoShipScreen(world, STATION_CODE.tactical));
    await settle(world);
  };
  return { world, warnings, enter };
}

describe('combat.yaml read when a battle needs it (M8 spec §8, Plan 24 Task 4)', () => {
  it('reads it from the world\'s source as tactical opens, and the battle starts', async () => {
    const { content, text } = lazyGame();
    let calls = 0;
    const { world, enter } = lazyWorld(content, async () => { calls++; return text; });
    expect(content.ship!.combat).toBeUndefined();
    await enter();
    expect(calls).toBe(1);
    expect(content.ship!.combat!.battles[BATTLE]!.ships.map(s => s.object)).toContain(CHODAK);
    expect(world.battle?.b.scenario).toBe(BATTLE);
  });

  it('reads it once for the game: a prefetch and every world after share it', async () => {
    const { content, text } = lazyGame();
    let calls = 0;
    const source = async () => { calls++; return text; };
    const first = lazyWorld(content, source);
    prefetchCombat(first.world);
    prefetchCombat(first.world);
    const [a, b] = await Promise.all([ensureCombat(first.world), ensureCombat(lazyWorld(content, source).world)]);
    expect(a).toBe(b);
    expect(calls).toBe(1);
    // (a later world of the same game, after a load, has it at once)
    expect(await ensureCombat(lazyWorld(content, source).world)).toBe(a);
    expect(calls).toBe(1);
  });

  it('never asks the source of a game parsed with combat.yaml (the tools, the walks)', async () => {
    const content = battleContent();
    let calls = 0;
    const { world } = lazyWorld(content, async () => { calls++; return ''; });
    expect(await ensureCombat(world)).toBe(content.ship!.combat);
    expect(calls).toBe(0);
  });

  it('refuses the battle, saying why, when the read fails, and tries again at the next battle', async () => {
    const { content, text } = lazyGame();
    let calls = 0;
    const { world, warnings, enter } = lazyWorld(content, async () => {
      calls++;
      if (calls === 1) throw new Error('offline');
      return text;
    });
    await enter();
    expect(warnings).toContain('combat.yaml could not be read: offline');
    expect(world.battle).toBeNull();
    expect(world.state.ship.station).toBe('bridge');
    await enter();
    expect(calls).toBe(2);
    expect(world.battle?.b.scenario).toBe(BATTLE);
  });

  describe('a read that never answers (Plan 24 Task 4 fix round 1)', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('times out after 20 s: the battle refuses to the bridge, the world is free, and the next battle reads again', async () => {
      // (only the timers: settle's flush runs on setImmediate)
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      expect(COMBAT_READ_TIMEOUT_MS).toBe(20_000);
      const { content, text } = lazyGame();
      let calls = 0;
      const { world, warnings } = lazyWorld(content, () => {
        calls++;
        return calls === 1 ? new Promise<string>(() => {}) : Promise.resolve(text);
      });
      world.state.ship.battleScenario = BATTLE;
      void world.enqueue(() => gotoShipScreen(world, STATION_CODE.tactical));
      await flush();
      // (waiting on the read, inside the queue)
      expect([calls, world.busy, world.battle]).toEqual([1, true, null]);
      await vi.advanceTimersByTimeAsync(COMBAT_READ_TIMEOUT_MS - 1);
      await flush();
      expect(world.busy).toBe(true);
      expect(warnings).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await settle(world);
      expect(warnings).toContain('combat.yaml could not be read: no answer in 20 s');
      expect(combatReadError(world)).toBe('combat.yaml could not be read: no answer in 20 s');
      expect([world.busy, world.battle, world.state.ship.station]).toEqual([false, null, 'bridge']);
      // (the stalled read was dropped: the next battle asks again, and fights)
      world.state.ship.battleScenario = BATTLE;
      void world.enqueue(() => gotoShipScreen(world, STATION_CODE.tactical));
      await settle(world);
      expect(calls).toBe(2);
      expect(world.battle?.b.scenario).toBe(BATTLE);
      expect(combatReadError(world)).toBeUndefined();
    });
  });

  it('checks its names against the game, as parseGame does', async () => {
    const { content, text } = lazyGame(c => { c.battles[BATTLE]!.ships[1]!.object = 'space.nobody'; });
    expect(() => parseCombatFor(content, text)).toThrow(ContentError);
    const { world, warnings } = lazyWorld(content, async () => text);
    expect(await ensureCombat(world)).toBeUndefined();
    expect(warnings.join('\n')).toMatch(/combat\.yaml: battles\.3\.ships\[1\]\.object: unknown object "space\.nobody"/);
    expect(content.ship!.combat).toBeUndefined();
  });
});
