// SPDX-License-Identifier: GPL-3.0-or-later
import { SHIP_FLAGS, type CombatBattle, type GameContent } from '../content/types';
import type { ActionContext, World } from './world';
import { perform } from './actions';
import { runList } from './rules';
import { GAME_END, NO_SCENARIO, STATION_CODE, type CombatState } from './ship';
import { gotoShipScreen, runViewscreen } from './stations';
import { battleHails, endWorldBattle, returnToTactical, startWorldBattle } from './tacticalScreen';
import { ensureCombat } from './combatData';

/** How the placeholder combat dialog ends a battle (Decision 1, R3). */
export type CombatOutcome = 'win' | 'flee' | 'lose';

/** TacticalScreen::kStarbaseBattle (tactical.cpp:207, astrogation.cpp:97). */
const STARBASE_BATTLE = 0x50;
/** No hail is pending. */
const NO_HAIL = 0xff;

/** Battles being ended, whose destroyed hooks run with the battle still set up (tactical.cpp:344-362: `_inCombat` is false, the ships are not cleared yet). */
const ending = new WeakSet<World>();

const leaderUses = (world: World, target: string): ActionContext => ({ verb: 'use', target, who: world.content.start.leader, other: null, walked: false });

/** A battle as combat.yaml lifts it (the space world's screen for a scenario): the dialog's and the combat sim's (Plan 23). */
export function battleDef(content: GameContent, scenario: number): CombatBattle | undefined {
  return content.ship?.combat?.battles[scenario];
}

/** Whether a battle's ship is the Enterprise, and whether it is friendly: its kind's, kShipKinds (combat.cpp:35-49). */
export function shipKind(content: GameContent, type: number): { enterprise: boolean; friendly: boolean } {
  const kind = content.ship?.combat?.kinds[type];
  return { enterprise: kind?.name === 'enterprise', friendly: !!kind && (kind.flags & SHIP_FLAGS.friendly) !== 0 };
}

/**
 * Combat::setup (combat.cpp:157-236) over the lifted battle: active ships only, the first Enterprise first, friends
 * split from enemies. Null, with a warning, without an Enterprise (combat.cpp:233-236). The lifter already left out
 * ships of no kind and the Enter, Exit and Warp objects (combat.cpp:189-211), and the cap of 8 ships is the lifter's.
 */
export function battleFor(world: World, scenario: number): CombatState | null {
  const battle = battleDef(world.content, scenario);
  const warn = (message: string) => { world.bus.emit({ type: 'warning', message }); return null; };
  if (!battle) return warn(`battle screen ${scenario.toString(16)} has no Enterprise`);
  let enterprise: string | null = null;
  const enemies: string[] = [];
  const friends: string[] = [];
  for (const ship of battle.ships) {
    if (!world.state.objects[ship.object]?.active) continue;
    const kind = shipKind(world.content, ship.type);
    if (kind.enterprise) {
      // (combat.cpp:216-219: a second Enterprise is skipped, with a warning)
      if (enterprise !== null) { warn(`battle screen ${scenario.toString(16)} contains more than one Enterprise`); continue; }
      enterprise = ship.object;
    } else (kind.friendly ? friends : enemies).push(ship.object);
  }
  if (enterprise === null) return warn(`battle screen ${scenario.toString(16)} has no Enterprise`);
  // (the red alert: any battle but the default one or the starbase's, tactical.cpp:323)
  const redAlert = scenario !== world.content.ship!.data.astro.defaultBattle && scenario !== STARBASE_BATTLE;
  return { scenario, enterprise, enemies, friends, destroyed: [], warped: false, redAlert };
}

/** TacticalScreen::standDown (tactical.cpp:364-367). */
function standDown(world: World): void {
  if (world.state.ship.combat) world.state.ship.combat.redAlert = false;
  world.state.ship.battleScenario = NO_SCENARIO;
}

/**
 * TacticalScreen::start (tactical.cpp:290-332) and update's Enter (457-466): the scenario or the default battle, Enter's
 * USE, then processHails. Cues, stars, the power level and Worf's delegation are presentation or M7 (tactical.cpp:296-322).
 */
export async function startCombat(world: World): Promise<void> {
  // (combat.yaml, if the game was parsed without it: read now, if the scenario's setting hasn't already: M8 spec §8)
  await ensureCombat(world);
  const ship = world.state.ship;
  // back from engineering (or a conversation), the battle goes on (tactical.cpp:290-291), after start's resets (:281-284)
  if (ship.combat !== null) {
    returnToTactical(world);
    return;
  }
  // (the combat sim: tacticalScreen.ts)
  if (world.combatMode === 'real') return startWorldBattle(world);
  const screen = ship.battleScenario === NO_SCENARIO ? world.content.ship!.data.astro.defaultBattle : ship.battleScenario;
  const combat = battleFor(world, screen);
  if (combat === null) {
    // (tactical.cpp:317-321)
    ship.battleScenario = NO_SCENARIO;
    await gotoShipScreen(world, STATION_CODE.bridge);
    return;
  }
  ship.combat = combat;
  world.bus.emit({ type: 'combat', on: true, scenario: screen });
  const enter = battleDef(world.content, screen)!.enter;
  // (tactical.cpp:461-463)
  if (enter !== null && (world.content.objects[enter]?.on?.use?.length ?? 0) > 0) await perform(world, leaderUses(world, enter));
  await processHails(world);
}

/** Combat::runDestroyedHook's script (damage.cpp:718-730): the kill list as USE by the leader, once; destroyed, inactive. False when there is nothing to run. */
export async function runKillList(world: World, shipId: string): Promise<boolean> {
  const def = world.content.objects[shipId]?.phaser;
  const pd = world.state.phaser[shipId];
  const kill = def?.on?.kill ?? [];
  if (!pd || kill.length === 0 || pd.destroyed) return false;
  await runList(world, kill, leaderUses(world, shipId), `${shipId}/phaser/kill`);
  pd.destroyed = true;
  world.state.objects[shipId].active = false;
  return true;
}

/** Combat::runDestroyedHook (damage.cpp:718-732): the kill list, then processHails. */
export async function runDestroyedHook(world: World, shipId: string): Promise<void> {
  if (await runKillList(world, shipId)) await processHails(world);
}

/** Combat::removeShip (damage.cpp:598-618): the ship is lost, and its hook runs. The Enterprise's loss is handled by the caller (damage.cpp:616). */
async function destroyShip(world: World, id: string): Promise<void> {
  const combat = world.state.ship.combat;
  if (combat && !combat.destroyed.includes(id)) combat.destroyed.push(id);
  await runDestroyedHook(world, id);
}

/**
 * TacticalScreen::endCombat (tactical.cpp:344-362): the destroyed ships' hooks (once each, damage.cpp:718), then the
 * bridge uses Warp if the Enterprise warped, else Exit; the scenario resets.
 */
export async function endCombat(world: World, toBridge: boolean): Promise<void> {
  const ship = world.state.ship;
  const combat = ship.combat;
  if (combat === null || ending.has(world)) return;
  ending.add(world);
  try {
    standDown(world);
    // (a real battle's: its systems back on the ship's clock, kept for the next; the dialog's destroyed ships' hooks)
    let warped = combat.warped;
    // (the dev Flee shortcut's warp, resolveCombat's, counts as the battle's own)
    if (world.battle) warped = (await endWorldBattle(world)) || combat.warped;
    else for (const id of [...combat.destroyed]) await runDestroyedHook(world, id);
    const battle = battleDef(world.content, combat.scenario);
    const hook = warped && battle?.warp ? battle.warp : battle?.exit ?? null;
    if (toBridge && hook !== null) ship.bridgeUse = hook;
    ship.combat = null;
    world.bus.emit({ type: 'combat', on: false, scenario: combat.scenario });
  } finally {
    ending.delete(world);
  }
}

/** The battle's ships in screen order, the Enterprise first (Combat::setup puts it at index 0, combat.cpp:221). */
function shipsInOrder(world: World, combat: CombatState): string[] {
  const rest = (battleDef(world.content, combat.scenario)?.ships ?? []).map(s => s.object).filter(id => id !== combat.enterprise);
  return [combat.enterprise, ...rest.filter(id => combat.enemies.includes(id) || combat.friends.includes(id))];
}

/**
 * TacticalScreen::processHails (tactical.cpp:377-437), as R3 lists it. Returns whether a conversation was had.
 * The exit code of 0xd is taken at once: the screen leaves for the bridge (tactical.cpp:455-466's update would).
 */
export async function processHails(world: World): Promise<boolean> {
  // (a real battle's: tacticalScreen.ts)
  if (world.battle) return battleHails(world, world.battle.b);
  const combat = world.state.ship.combat;
  const hail = world.state.pendingHail;
  if (combat === null) return false;
  const type = hail?.type ?? NO_HAIL;
  const clear = () => { world.state.pendingHail = null; };
  const toBridge = async () => { if (!ending.has(world)) await gotoShipScreen(world, STATION_CODE.bridge); };
  switch (type) {
    case 7: {
      // a conversation on the viewscreen, from the middle of the battle (tactical.cpp:381-398)
      if (combat.destroyed.includes(combat.enterprise)) return false;
      let talked = false;
      while (world.state.pendingHail?.type === 7) {
        await runViewscreen(world, true, world.state.pendingHail.from);
        talked = true;
      }
      await gotoShipScreen(world, STATION_CODE.tactical);
      const next = world.state.pendingHail?.type ?? NO_HAIL;
      if (next !== 0xd) {
        // (the original leaves these until the next hook)
        if (next === 0xc || next === 0xf || next === 0x10) await processHails(world);
        return talked;
      }
      // fall through to the battle's end
      clear();
      standDown(world);
      await toBridge();
      return talked;
    }
    case 0xd:
      // the battle is over (tactical.cpp:400-404)
      clear();
      standDown(world);
      await toBridge();
      return false;
    case 8:
      // they're hailing us, until we answer (tactical.cpp:405-408; the cue is presentation)
      return false;
    case 0xb:
    case 0xc:
      clear();
      standDown(world);
      return false;
    case 0xe:
      return false;
    case 0xf:
      clear();
      combat.redAlert = true;
      return false;
    case 0x10: {
      // everyone blows up, in turn: the later ships first, the Enterprise last (tactical.cpp:420-431, combatTicks((3 - i) * 0x5af))
      clear();
      standDown(world);
      for (const id of shipsInOrder(world, combat).reverse()) {
        if (world.state.ship.combat === null) return false;
        await destroyShip(world, id);
        // (losing the Enterprise is the end of the game, damage.cpp:616-617)
        if (id === combat.enterprise && world.state.ship.combat !== null) await gotoShipScreen(world, GAME_END | 0x100);
      }
      return false;
    }
    case NO_HAIL:
      return false;
    default:
      clear();
      return false;
  }
}

/** TacticalScreen::hail (tactical.cpp:439-455) for a waiting type 8: it becomes 7, and processHails runs it. A hail with nothing pending is Combat::hailResponse, after M4. */
export async function answerHail(world: World): Promise<void> {
  const pending = world.state.pendingHail;
  if (world.state.ship.combat === null || pending === null) return;
  if (pending.type === 7 || pending.type === 8 || pending.type === 0xe) {
    pending.type = 7;
    await processHails(world);
  }
}

/** Decision 1 and R3: the dialog's three ways out. */
export async function resolveCombat(world: World, outcome: CombatOutcome): Promise<void> {
  const combat = world.state.ship.combat;
  if (combat === null) throw new Error('there is no battle to resolve');
  if (outcome === 'lose') {
    // the Enterprise is destroyed: its hook, then the game ends (damage.cpp:616-617)
    await destroyShip(world, combat.enterprise);
    return gotoShipScreen(world, GAME_END | 0x100);
  }
  if (outcome === 'win') {
    for (const id of [...combat.enemies]) {
      // (a hook's hail ended the battle: 0xd, 0x10)
      if (world.state.ship.combat === null) return;
      if (!combat.destroyed.includes(id)) await destroyShip(world, id);
    }
  } else {
    // an in-battle warp (ai.cpp:258)
    combat.warped = true;
  }
  if (world.state.ship.combat !== null) await gotoShipScreen(world, STATION_CODE.bridge);
}
