// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deserializeState, parseGame, type World } from '@another-unity/engine';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { battleWon } from './fly';
import { readGameDir } from './readGameDir';
import { runWalkthrough, type WalkEvent } from './walkthrough';

// RAW_DIR=$HOME/pcode/unity-raw/runs/export/raw, after npm run unity:build (docs/unity-local.md)
const game = fileURLToPath(new URL('../../../games/unity', import.meta.url));
const lifted = !!process.env.RAW_DIR && existsSync(join(game, 'ids.yaml')) && existsSync(join(game, 'tests/whole-game.walk'));
if (!lifted) console.info('live-route.test.ts: skipped; set RAW_DIR and run npm run unity:build (docs/unity-local.md)');

/**
 * The `trigger <id> on` steps the route walks take (R9): mission entries that no script and no C++ site enables.
 * Each has a ruling in the plan's ledger. The census found none, all the way to the Unity Device.
 */
export const ROUTE_GAPS: number[] = [];
/**
 * The use, get and talk steps after a `# gap:` comment (the opt-out of Play's reachable-target check, R9), by the original id of the target.
 * Each is a target the original's UI could not click on that route (inactive, never activated by what the walk does):
 * - 030327, the zoo's accusation lines: inactive, nothing activates or names it (Plans 9 and 10 ruled it in);
 * - 020f19, Allanor's pedestal chart: activated only by the variant of the Chodak chain that this route does not take
 *   (chod_have_been_here state 1, a 5 s window), so the walk reaches the same ship trigger by a shortcut.
 */
export const ROUTE_OBJECT_GAPS: string[] = ['030327', '020f19'];

/**
 * The beam-downs the whole-game walk makes, in order: the original's world number and the screen and team they land on.
 * (World 8, Frigis's second visit, is reported as world 5, the world it is: awayteam.cpp:112-113.)
 */
const BEAM_DOWNS = [
  { world: 4, screen: 'lab.s01', team: ['riker', 'worf', 'crusher', 'la_forge'] },
  { world: 3, screen: 'zoo.s03', team: ['data', 'worf', 'troi', 'crusher'] },
  { world: 5, screen: 'frigis.s01', team: ['riker', 'data', 'troi', 'la_forge'] },
  { world: 5, screen: 'frigis.s01', team: ['picard', 'data', 'worf', 'troi'] },
  { world: 7, screen: 'horst3.s01', team: ['picard', 'data', 'la_forge', 'troi'] },
  { world: 2, screen: 'allanor.s01', team: ['picard', 'data', 'la_forge', 'carlstrom'] },
  // (the Unity Device's is a ship conversation's beam, c006@8, not the transporter's)
  { world: 6, screen: 'unity.s01', team: ['picard', 'data', 'worf', 'butler'] },
];
/** The walk ends at the Unity Device's beam-down, on its first screen. */
const UNITY = { screen: 'unity.s01', team: ['picard', 'data', 'worf', 'butler'] };
/** Each mission's return aboard is a checkpoint: a save the browser check can import (R12). */
const CHECKPOINTS = ['after-mertens', 'after-zoo', 'after-frigis', 'after-frigis2', 'after-horst3', 'after-allanor'];
/** The census's mandatory battles resolved by the dev shortcut (`combat win`): none since Plan 31 (Plans 10 and 23 had 52 and 71). */
const RESOLVED: Record<number, string> = {};
/**
 * The mandatory battles flown by hand (Plan 31 R5): a `combat inputs` step gives the file's orders, a player's, and the
 * battle is won at the game's difficulty, Lieutenant (71 its one enemy destroyed; 52 the ship its kill list waits on,
 * which stands the battle down, its two probes left). Delegate can't (measured for Plan 23, seed
 * 1): it loses 71, the Enterprise destroyed at step 584, and wins 52 at step 552 with the reactors and the grid destroyed,
 * so no repair can run and the scripted warp after it can't go.
 */
const BY_HAND: Record<number, string> = { 52: 'tests/battles/52.inputs', 71: 'tests/battles/71.inputs' };
/**
 * The route's battles fought in the combat sim by Delegate (`combat auto`, Plan 23), with how each ended (measured for
 * Plan 23: seed 1, Lieutenant): the step it stood down at, its enemies all destroyed. Engineering's repairs follow it.
 */
const BY_DELEGATE: Record<number, number> = { 51: 2186 };
/** And the ones the route doesn't fight, with the ledger's reason (Task 9). */
const NOT_ON_ROUTE: Record<number, string> = {
  16: 'its hails (c020@0 k6, c018, c023, c024, c035) are never raised: c008@3 k13 lets the scout go and the route never takes the confrontation line',
  70: 'its hail is c016@11 k4, through t170 (ship.taa), which c016@8 k4 enables when the relay station was lost; the route wins battle 71, so the station stands',
  83: 'the Warbird of c002@9 arrives only if the team stays at Allanor; the route leaves at once',
};

describe.skipIf(!lifted)('the whole-game walk from a new game (needs RAW_DIR)', () => {
  it('plays through every mission to the Unity Device, with the recommended team each time, and writes a checkpoint on each return', async () => {
    const content = parseGame(await readGameDir(game));
    const ids = parse(readFileSync(join(game, 'ids.yaml'), 'utf8')) as { objects: Record<string, string>; screens: Record<string, string> };
    const dir = process.env.ROUTE_CHECKPOINTS ?? join(homedir(), 'pcode/unity-raw/runs/plan12-route');
    const beams: { world: number; screen: string; team: string[] }[] = [];
    const steps: string[] = [];
    const gapped: string[] = [];
    const fought: { scenario: number; how: string }[] = [];
    const ended: { scenario: number; steps: number; won: boolean; lost?: boolean; flown?: boolean }[] = [];
    const settings: { scenario: number; assists: object; difficulty: number }[] = [];
    let world: World | null = null;
    let stoodDown = false;
    const walkFile = join(game, 'tests/whole-game.walk');
    const result = await runWalkthrough(readFileSync(walkFile, 'utf8'), {
      content, ids, file: walkFile, gameDir: game, checkpointDir: dir, checkScreens: true,
      onEvent: (e: WalkEvent) => {
        if (e.kind !== 'step') return;
        steps.push(e.text);
        if (e.gap) gapped.push(e.text);
        // (the step event comes before the step, so the battle is still set)
        // (`combat wait` only waits for a battle: it decides none)
        if (e.text.startsWith('combat ') && e.text !== 'combat wait') fought.push({ scenario: world!.state.ship.combat?.scenario ?? -1, how: e.text.split(' ')[1] });
      },
      onWorld: w => {
        world = w;
        // (the screen changes just before the event, so this is the first screen they land on)
        w.bus.on(e => {
          // (a battle the combat sim fought: kept by endCombat as the last battle)
          const last = w.combatMemory.previous;
          if (e.type === 'combat' && e.on) settings.push({ scenario: e.scenario, assists: { ...w.assists }, difficulty: w.difficulty });
          // (whether the red alert was off at the battle's last step, as fly reads it: a battle left at red alert hasn't stood down)
          if (e.type === 'combat' && e.on && w.battle) {
            const ctx = w.battle.ctx;
            const onStep = ctx.onStep;
            ctx.onStep = b => { stoodDown = !b.console.redAlert; onStep?.(b); };
            stoodDown = false;
          }
          if (e.type === 'combat' && !e.on && last) {
            ended.push({
              scenario: e.scenario, steps: last.steps, won: last.ships.slice(1).every(s => s.destroyed),
              // (and for the battles flown by hand: the Enterprise's fate, and fly's `won`, the same rule)
              ...(BY_HAND[e.scenario] ? { lost: last.ships[0]!.destroyed, flown: battleWon(w, last, stoodDown) } : {}),
            });
          }
          if (e.type === 'beamedDown') beams.push({ world: e.world, screen: w.state.screen, team: [...w.state.awayTeam] });
        });
      },
    });
    expect(result.error).toBeNull();
    expect(result.ended).toBe(true);
    // each mission's beam-down, in order, on its first screen, with the transporter's recommended team
    expect(beams.map(b => ({ ...b, team: [...b.team].sort() }))).toEqual(BEAM_DOWNS.map(b => ({ ...b, team: [...b.team].sort() })));
    // every dev shortcut the walk takes is a ruled gap
    const triggers = steps.filter(s => s.startsWith('trigger ')).map(s => Number(s.split(' ')[1]));
    expect(triggers).toEqual(ROUTE_GAPS);
    // and every opt-out of the reachable-target check is a ruled object gap (`force use <who> <target> ...`)
    const forced = gapped.filter(s => ['use', 'get', 'talk'].includes(s.split(/\s+/)[0])).map(s => s.split(/\s+/)[2]);
    expect(forced).toEqual(ROUTE_OBJECT_GAPS);
    // the walk ends on the Unity Device's first screen, with its team
    const end = result.play!.state;
    expect(end.onShip).toBeNull();
    expect({ screen: end.screen, team: [...end.awayTeam].sort() }).toEqual({ screen: UNITY.screen, team: [...UNITY.team].sort() });
    // every mandatory battle was fought by a combat step (flown by hand, or the shortcut), or is not on the route for the ledger's reason
    const mandatory = [16, 52, 70, 71, 83];
    const fight = { ...RESOLVED, ...Object.fromEntries(Object.keys(BY_HAND).map(n => [n, 'inputs'])) } as Record<number, string>;
    expect(fought.map(f => f.scenario).filter(n => mandatory.includes(n)).sort()).toEqual(Object.keys(fight).map(Number).sort());
    for (const f of fought) if (fight[f.scenario] !== undefined) expect(f.how).toBe(fight[f.scenario]);
    expect([...Object.keys(fight), ...Object.keys(NOT_ON_ROUTE)].map(Number).sort()).toEqual([...mandatory].sort());
    // every battle is fought by Delegate, or by hand where Delegate can't win it (Plan 31); no dev shortcut is left
    const decided = fought.filter(f => ['auto', 'win', 'inputs'].includes(f.how));
    expect(decided.map(f => `${f.scenario} ${f.how}`).sort()).toEqual([
      ...Object.keys(BY_DELEGATE).map(n => `${n} auto`), ...Object.keys(BY_HAND).map(n => `${n} inputs`), ...Object.keys(RESOLVED).map(n => `${n} win`),
    ].sort());
    // (BY_DELEGATE's steps and BY_HAND's flights hold for these settings only: the walk's defaults, the assists the
    // original's (the game's difficulty, 1x) and the game's difficulty Lieutenant (1))
    for (const scenario of [...Object.keys(BY_DELEGATE), ...Object.keys(BY_HAND)].map(Number)) {
      expect(settings.filter(s => s.scenario === scenario)).toEqual([{ scenario, assists: { difficulty: 'game', speed: 1 }, difficulty: 1 }]);
    }
    for (const [scenario, steps] of Object.entries(BY_DELEGATE)) expect(ended.find(e => e.scenario === Number(scenario))).toEqual({ scenario: Number(scenario), steps, won: true });
    // each battle flown by hand was won by fly's rule, battleWon (the Enterprise lives; every enemy destroyed, or every ship the
    // battle's kill lists wait on destroyed and the red alert off at its last step), and the walk's `combat inputs` names its file
    for (const [scenario, file] of Object.entries(BY_HAND)) {
      const e = ended.filter(x => x.scenario === Number(scenario));
      expect(e.map(x => ({ lost: x.lost, won: x.flown }))).toEqual([{ lost: false, won: true }]);
      expect(steps).toContain(`combat inputs ${file}`);
    }
    for (const name of CHECKPOINTS) {
      const file = join(dir, `${name}.json`);
      expect(existsSync(file)).toBe(true);
      // (the save menu's Import loads it)
      const state = deserializeState(readFileSync(file, 'utf8'), content);
      expect(state.onShip).not.toBeNull();
    }
  }, 300_000);
});
