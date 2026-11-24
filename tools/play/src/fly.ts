// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  combatSim,
  parseGame,
  SHIP_FLAGS,
  UNIT_COMPUTER,
  UNIT_FUSION,
  UNIT_IMPULSE,
  UNIT_LIFE_SUPPORT,
  UNIT_MATTER_ANTIMATTER,
  UNIT_PHASER,
  UNIT_POWER_GRID,
  UNIT_SENSOR,
  UNIT_SHIELD,
  UNIT_TORPEDO,
  UNIT_TRACTOR,
  UNIT_WARP,
  type GameContent,
  type World,
} from '@another-unity/engine';
import { parse } from 'yaml';
import type { Play } from './play';
import { readGameDir } from './readGameDir';
import { giveInputs, runWalkthrough, type WalkIds } from './walkthrough';

/**
 * Flying a battle by hand (Plan 31 R6): a walk played to the battle's start, an inputs file's orders given at their
 * steps, and the battle run on to its end. A battle can't be saved (save.cpp:156-159), so each try replays the walk.
 *
 *   npm run fly -- --walk <file> --battle <n> --inputs <file> [--game <dir>] [--cap <steps>]
 */

/**
 * How a flown battle came out: `won`, the Enterprise lives and every enemy is destroyed, or the battle stood down (the red
 * alert off) with every ship the battle's scripts wait on (one with a kill list) destroyed, as the scenario ends it (a
 * kill list's hail 0xb or 0xc stands it down: battle 52's probes outlive it); `lost`, the Enterprise destroyed;
 * `stoodDown`, the red alert off otherwise; `left`, the battle gone otherwise; `undecided`, still fighting at the cap.
 */
export type FlyOutcome = 'won' | 'lost' | 'stoodDown' | 'left' | 'undecided';

export interface FlyResult {
  outcome: FlyOutcome;
  /** The step it ended at. */
  step: number;
  /** The Enterprise's hull (its condition, %). */
  hull: number;
  /** The Enterprise's units destroyed (damage at their most), as `<kind> <index>`. */
  destroyed: string[];
  /** The enemies destroyed, as `<n> of <all>`. */
  enemies: string;
  /** Why an order couldn't be given (the battle ended or went past its step first), or null. */
  note: string | null;
}

export interface FlyOptions {
  /** The game's content, ids and directory; read from `gameDir` (by default the walk's nearest directory with an ids.yaml) when absent. */
  content?: GameContent;
  ids?: WalkIds;
  gameDir?: string;
  /** The longest the battle runs after the walk reaches it: 9000 steps by default (auto-resolve's cap). */
  cap?: number;
  onWorld?: (world: World) => void;
}

/** The unit kinds by ShipUnit.type (shipSystems.ts): engine words, not the game's names. */
const UNIT_KIND: Record<number, string> = {
  [UNIT_PHASER]: 'phaser', [UNIT_TORPEDO]: 'torpedo', [UNIT_IMPULSE]: 'impulse', [UNIT_WARP]: 'warp', [UNIT_FUSION]: 'fusion reactor',
  [UNIT_MATTER_ANTIMATTER]: 'matter-antimatter reactor', [UNIT_SHIELD]: 'shield', [UNIT_SENSOR]: 'sensor', [UNIT_TRACTOR]: 'tractor',
  [UNIT_LIFE_SUPPORT]: 'life support', [UNIT_COMPUTER]: 'computer', [UNIT_POWER_GRID]: 'grid',
};

/** The nearest directory at or above `from` with an ids.yaml: the game's. */
function findGameDir(from: string): string {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    if (existsSync(resolve(dir, 'ids.yaml'))) return dir;
    if (dirname(dir) === dir) throw new Error(`no game directory (with an ids.yaml) above ${from}`);
  }
}

const enemiesOf = (b: combatSim.BattleState) => b.ships.slice(1).filter(s => !(s.flags & SHIP_FLAGS.friendly));

/** Runs the battle a step at a time until it is decided (see FlyOutcome), or `cap` steps. */
async function runToEnd(play: Play, cap: number): Promise<void> {
  const w = play.world;
  let alerted = false;
  for (;;) {
    const b = w.battle?.b;
    if (!b) return;
    if (b.console.redAlert) alerted = true;
    if (b.ships[0]!.destroyed || enemiesOf(b).every(s => s.destroyed)) return;
    if ((alerted || scriptedEnd(w, b)) && !b.console.redAlert) return;
    if (b.steps >= cap) return;
    if (!(await play.untilStep(b.steps + 1))) return;
  }
}

/** Every ship the battle's scripts wait on (its object has a kill list) is destroyed, and there is one. */
export function scriptedEnd(world: World, b: combatSim.BattleState): boolean {
  const watched = b.ships.slice(1).filter(s => (world.content.objects[s.object]?.phaser?.on?.kill?.length ?? 0) > 0);
  return watched.length > 0 && watched.every(s => s.destroyed);
}

/** FlyOutcome's `won`: the Enterprise lives, and every enemy is destroyed, or the battle stood down (`stoodDown`: the red alert off at its last step) with every kill-listed ship destroyed. */
export function battleWon(world: World, b: combatSim.BattleState, stoodDown: boolean): boolean {
  return !b.ships[0]!.destroyed && (enemiesOf(b).every(s => s.destroyed) || (stoodDown && scriptedEnd(world, b)));
}

function report(world: World, note: string | null, stoodDown: boolean): FlyResult {
  const live = world.battle?.b ?? null;
  const b = live ?? world.combatMemory.previous;
  if (!b) throw new Error('no battle was fought');
  const e = b.ships[0]!;
  const defs = world.content.ship?.data.units ?? [];
  const destroyed = e.systems.units.flatMap((u, i) => {
    const def = defs[i];
    return def && def.maxDamage > 0 && u.damage >= def.maxDamage ? [`${UNIT_KIND[def.type] ?? `type ${def.type}`} ${i}`] : [];
  });
  const outcome: FlyOutcome = e.destroyed ? 'lost'
    : battleWon(world, b, stoodDown) ? 'won'
    : live === null ? 'left'
    : stoodDown ? 'stoodDown'
    : 'undecided';
  const enemies = enemiesOf(b);
  return { outcome, step: b.steps, hull: e.condition, destroyed, enemies: `${enemies.filter(s => s.destroyed).length} of ${enemies.length}`, note };
}

/** Plays `walkFile` to battle `battle`'s start, gives `inputsText`'s orders and runs the battle to its end. */
export async function flyBattle(walkFile: string, battle: number, inputsText: string, o: FlyOptions = {}): Promise<FlyResult> {
  const { inputs, errors } = combatSim.parseInputScript(inputsText);
  if (errors.length > 0) throw new Error(`the inputs: ${errors.join('; ')}`);
  const gameDir = o.gameDir ?? findGameDir(dirname(walkFile));
  const content = o.content ?? parseGame(await readGameDir(gameDir));
  const ids = o.ids ?? (parse(readFileSync(resolve(gameDir, 'ids.yaml'), 'utf8')) as WalkIds);
  // (as the route test plays it: live-route.test.ts)
  const walk = await runWalkthrough(readFileSync(walkFile, 'utf8'), {
    content, ids, file: walkFile, gameDir, checkScreens: true,
    ...(o.onWorld ? { onWorld: o.onWorld } : {}),
    // (before the battle's first order: the walk's picks for its conversations, given after `combat wait`, are queued)
    stopBefore: (play, line) => line.args[0] === 'combat' && line.args[1] !== 'wait' && play.world.battle?.b.scenario === battle,
  });
  if (walk.error !== null) throw new Error(`the walk: ${walk.error}`);
  if (!walk.stopped || !walk.play) throw new Error(`the walk never reached battle ${battle}`);
  const play = walk.play;
  // (whether the red alert was off at the battle's last step: a battle left by the Bridge button had stood down)
  let stoodDown = false;
  const ctx = play.world.battle!.ctx;
  const onStep = ctx.onStep;
  ctx.onStep = b => { stoodDown = !b.console.redAlert; onStep?.(b); };
  const note = await giveInputs(play, inputs);
  await runToEnd(play, o.cap ?? 9000);
  return report(play.world, note, stoodDown);
}

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? undefined : args[i + 1];
}

async function main(argv: string[]): Promise<number> {
  const walk = arg(argv, 'walk');
  const battle = arg(argv, 'battle');
  const inputs = arg(argv, 'inputs');
  if (!walk || !battle || !inputs || !/^\d+$/.test(battle)) {
    console.error('usage: npm run fly -- --walk <file> --battle <n> --inputs <file> [--game <dir>] [--cap <steps>]');
    return 2;
  }
  const game = arg(argv, 'game');
  const cap = arg(argv, 'cap');
  const t = Date.now();
  const r = await flyBattle(resolve(walk), Number(battle), readFileSync(inputs, 'utf8'), {
    ...(game ? { gameDir: resolve(game) } : {}),
    ...(cap ? { cap: Number(cap) } : {}),
  });
  console.log(`battle ${battle}: ${r.outcome} at step ${r.step}, hull ${r.hull}%, destroyed: ${r.destroyed.length ? r.destroyed.join(', ') : 'none'}; enemies destroyed: ${r.enemies}`);
  if (r.note) console.log(`note: ${r.note}`);
  console.log(`(${((Date.now() - t) / 1000).toFixed(1)} s)`);
  return r.outcome === 'won' ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => process.exit(code), (e: unknown) => {
    // (a conversation's menu is the game's text: not printed)
    console.error(String(e instanceof Error ? e.message : e).replace(/(no scripted pick for menu):.*/s, '$1 (its options not shown)'));
    process.exit(2);
  });
}
