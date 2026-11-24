// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contacts, parseGame, type World } from '@another-unity/engine';
import { describe, expect, it } from 'vitest';
import { readGameDir } from './readGameDir';
import { runWalkthrough, WalkPresenter } from './walkthrough';

// RAW_DIR=$HOME/pcode/unity-raw/runs/export/raw, after npm run unity:build (docs/unity-local.md)
const game = fileURLToPath(new URL('../../../games/unity', import.meta.url));
const lifted = !!process.env.RAW_DIR && existsSync(join(game, 'ids.yaml'));
if (!lifted) console.info('live-ship.test.ts: skipped; set RAW_DIR and run npm run unity:build (docs/unity-local.md)');

describe.skipIf(!lifted)('the new-game walk on the real ship (needs RAW_DIR)', () => {
  it('ship-opening.walk plays to its end, on the first mission\'s first screen with the team away', async () => {
    const content = parseGame(await readGameDir(game));
    const walk = readFileSync(join(game, 'tests/ship-opening.walk'), 'utf8');
    let menus = 0;
    class Counting extends WalkPresenter {
      override async menu(options: string[]): Promise<number | null> {
        menus++;
        return super.menu(options);
      }
    }
    const result = await runWalkthrough(walk, { content, ids: { objects: {}, screens: {} }, presenter: clock => new Counting(clock) });
    expect(result.error).toBeNull();
    // (the opening's five menus and the first mission's hail: the browser check answers the same six, apps/web/e2e/unity-ship.spec.ts)
    expect(menus).toBe(6);
    const state = result.play!.state;
    expect(state.screen).toBe('lab.s01');
    expect(state.onShip).toBeNull();
    expect(state.awayTeam.length).toBeGreaterThan(0);
  }, 120_000);

  it('lists the bridge contacts of a new game, active and with a sprite, within the limit of ten', async () => {
    const content = parseGame(await readGameDir(game));
    const result = await runWalkthrough('start ship\nend', { content, ids: { objects: {}, screens: {} } });
    expect(result.error).toBeNull();
    const world = result.play!.world;
    const comms = contacts(world, 'comms');
    const lounge = contacts(world, 'lounge');
    console.info(`live-ship: new game contacts: comms ${comms.join(' ')}; lounge ${lounge.join(' ')}`);
    expect(comms.length).toBeLessThanOrEqual(10);
    expect(lounge.length).toBeLessThanOrEqual(10);
    for (const o of [...comms, ...lounge]) expect(world.state.objects[o].active).toBe(true);
  });

  it('every lifted battle starts at tactical, and wins, flees and loses (Plan 12 Task 6)', async () => {
    const content = parseGame(await readGameDir(game));
    const battles = Object.keys(content.ship!.combat!.battles).map(Number);
    expect(battles.length).toBeGreaterThan(30);
    // (the scenarios whose Enterprise object is inactive or missing at setup: no battle starts, and tactical returns to the bridge)
    const fallback = new Set<number>();
    const fight = async (scenario: number, how: 'win' | 'flee' | 'lose'): Promise<World> => {
      const r = await runWalkthrough('start ship\nend', { content, ids: { objects: {}, screens: {} }, seed: 1 });
      const play = r.play!;
      play.world.state.ship.battleScenario = scenario;
      await play.station('tactical');
      if (play.state.ship.combat === null) {
        fallback.add(scenario);
        return play.world;
      }
      await play.combat(how);
      return play.world;
    };
    let started = 0;
    for (const scenario of battles) {
      for (const how of ['win', 'flee', 'lose'] as const) {
        const world = await fight(scenario, how);
        expect(world.errors, `${scenario} ${how}`).toEqual([]);
        expect(world.state.ship.combat, `${scenario} ${how}`).toBeNull();
        if (how === 'lose' && world.state.onShip !== null && world.state.onShip.gameOver !== null) started++;
        else expect(world.state.ship.station).toBe('bridge');
      }
    }
    // Combat::setup checks OBJFLAG_ACTIVE before it classifies the Enterprise (combat.cpp:202-213), and no hail names these scenarios
    // (ledger, Plan 12 final fix wave), so they are unreachable test screens. A lift change that deactivates a real battle's Enterprise
    // changes this set.
    expect([...fallback].sort((a, b) => a - b)).toEqual([2, 3, 4, 6, 7]);
    console.info(`live-ship: ${started} of ${battles.length} battles lost to the game's end`);
    expect(started).toBeGreaterThan(0);
  }, 120_000);
});
