// SPDX-License-Identifier: GPL-3.0-or-later
import type { CombatData, Effect, GameContent, ObjectDef, RuleGroup } from '../content/types';
import type { CombatAssists } from '../sim/combat/assists';
import type { SimEvent } from '../sim/events';
import { HeadlessPresenter } from '../sim/presenter';
import { settle } from '../sim/settle';
import { STATION_CODE } from '../sim/ship';
import { gotoShipScreen } from '../sim/stations';
import { createInitialState } from '../sim/state';
import { World } from '../sim/world';
import { miniCombat, miniEnterpriseUnits } from './combat';
import { makeGame } from './fixture';
import { miniShipData } from './ship';

/** The world's battle fixture's ships: miniCombat's battle 3, the Enterprise and a chodak. */
export const BATTLE = 3;
export const ENTERPRISE = 'space.enterprise';
export const CHODAK = 'space.chodak';

/** A hook script that records it ran, through the `rec` hook, then does `then`. */
export const rec = (n: string, then: Effect[] = []): RuleGroup => ({ do: [{ call: { hook: 'rec', args: { n } } }, ...then] });
/** A hail raised from a script (CommunicateFx). */
export const hail = (type: number, scenario?: number): Effect => ({ communicate: { type, ...(scenario === undefined ? {} : { scenario }) } });

export interface BattleWorldOptions {
  /** The combat data (miniCombat's without its ships' tactics by default; battle 3 is copied to the default battle 8). */
  combat?: CombatData;
  difficulty?: 0 | 1 | 2;
  assists?: CombatAssists;
  /** The chodak's LOOK groups (the event hooks), USE groups (the hail buckets, from 1), and phaser data's kill and stun lists. */
  look?: RuleGroup[]; use?: RuleGroup[]; kill?: RuleGroup[]; stun?: RuleGroup[];
  /** The Enter, Exit and Warp objects' USE. */
  enter?: RuleGroup[]; exit?: RuleGroup[]; warp?: RuleGroup[];
  /** The Enterprise object's state (TacticalScreen::start's power level: 1-5). */
  enterpriseState?: number;
  /** Where the chodak is (battle units, x right, y ahead, z up): 1000, 0, 5000 by default. */
  chodakAt?: [number, number, number];
}

/** miniCombat with no tactics script for battle 3's ships: mini.bin's script takes its steps slowly, and these tests fight hundreds. */
function scriptless(): CombatData {
  const combat = miniCombat();
  for (const ship of combat.battles[BATTLE]!.ships) ship.tactics = null;
  return combat;
}

/**
 * A world on the ship that fights tactical's battles in the combat sim (WorldOptions.combat 'real'): miniShipData with
 * miniCombat's Enterprise units and battle 3, made-up objects for its ships and its Enter, Exit and Warp, and a `rec`
 * hook that lists the scripts that ran.
 */
export function battleWorld(o: BattleWorldOptions = {}) {
  const content = battleContent(o);
  const world = new World(content, createInitialState(content, 1, { onShip: true }), w => new HeadlessPresenter(w.clock), {
    difficulty: o.difficulty ?? 1, combat: 'real', ...(o.assists ? { assists: o.assists } : {}),
  });
  const ran: string[] = [];
  world.hooks.register('rec', (_w, _c, args) => { ran.push(args.n as string); return 0; });
  const events: SimEvent[] = [];
  world.bus.on(e => events.push(e));
  const warnings = () => events.filter((e): e is Extract<SimEvent, { type: 'warning' }> => e.type === 'warning').map(e => e.message);
  /** Runs `f` as the world's task, to its end. */
  const run = async (f: () => Promise<unknown>) => { void world.enqueue(async () => { await f(); }); await settle(world); };
  /** `n` world ticks (the session's loop), each letting the world's tasks run. */
  const ticks = async (n: number) => { for (let i = 0; i < n; i++) { world.tick(); await settle(world); } };
  /** Goes to tactical for `scenario`, and runs the first frame: the Enter object's USE and processHails (tactical.cpp:458-466). */
  const enter = async (scenario = BATTLE) => {
    world.state.ship.battleScenario = scenario;
    await run(() => gotoShipScreen(world, STATION_CODE.tactical));
    if (world.battle) await ticks(1);
  };
  return { world, ran, events, warnings, run, enter, ticks, ship: world.state.ship };
}

/** battleWorld's game: the ship, its combat data and the battle's objects. A `rec` hook must be registered to run its scripts. */
export function battleContent(o: BattleWorldOptions = {}): GameContent {
  const data = miniShipData();
  data.data.units = miniEnterpriseUnits();
  const combat = o.combat ?? scriptless();
  const three = combat.battles[BATTLE]!;
  combat.battles[BATTLE] = { ...three, enter: 'b.enter', exit: 'b.exit', warp: 'b.warp' };
  if (o.chodakAt) combat.battles[BATTLE]!.ships[1] = { ...three.ships[1]!, position: o.chodakAt };
  combat.battles[8] = combat.battles[BATTLE]!;
  data.combat = combat;
  const use = (id: string, groups: RuleGroup[] | undefined): ObjectDef => ({ id, name: id, screen: null, on: { use: groups ?? [rec(id)] } });
  const chodak: ObjectDef = {
    id: CHODAK, name: 'Chodak', screen: null,
    on: { ...(o.look ? { look: o.look } : {}), ...(o.use ? { use: o.use } : {}) },
    ...(o.kill || o.stun ? { phaser: { health: 5, threshold: 0, damageFrom: 1, gtpFrom: 1, on: { ...(o.kill ? { kill: o.kill } : {}), ...(o.stun ? { stun: o.stun } : {}) } } } : {}),
  };
  return makeGame(
    [
      { id: 'w.ent', name: 'Enterprise', screen: null, universe: { x: 90, y: 90, z: 90 } },
      { id: ENTERPRISE, name: 'Enterprise', screen: null, state: o.enterpriseState ?? 0 },
      chodak,
      use('b.enter', o.enter), use('b.exit', o.exit), use('b.warp', o.warp),
    ],
    { triggers: [{ id: 't1', type: 'normal', context: 'ship', target: 'w.ent', enabled: false }], ship: data },
  );
}
