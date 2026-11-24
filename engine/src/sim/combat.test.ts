// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { Effect, ObjectDef } from '../content/types';
import { makeGame } from '../testing/fixture';
import { miniBattleDef, miniCombat } from '../testing/combat';
import { miniShipData } from '../testing/ship';
import type { SimEvent } from './events';
import { answerHail, battleDef, battleFor, endCombat, processHails, resolveCombat, runDestroyedHook, shipKind, startCombat } from './combat';
import { HeadlessPresenter } from './presenter';
import { settle } from './settle';
import { NO_SCENARIO } from './ship';
import { shipTick } from './shipTick';
import { dispatchHail, gotoShipScreen, runViewscreen } from './stations';
import { createInitialState } from './state';
import { World } from './world';

const rec = (n: string): Effect => ({ call: { hook: 'rec', args: { n } } });
const hail = (type: number, scenario?: number): Effect => ({ communicate: { type, ...(scenario === undefined ? {} : { scenario }) } });
const ship = (id: string, name: string, effects: Effect[] = [], extra: Partial<ObjectDef> = {}): ObjectDef => ({
  id, name, screen: null, ...extra,
  ...(effects.length > 0 ? { phaser: { health: 5, threshold: 0, damageFrom: 1, gtpFrom: 1, on: { kill: [{ do: effects }] } } } : {}),
});
const hook = (id: string, effects: Effect[]): ObjectDef => ({ id, name: id, screen: null, on: { use: [{ do: effects }] } });

/** Battle 10: Enter, Exit and Warp, the Enterprise, a friendly Klingon, two Romulans (the second inactive). */
function combatWorld(extra: { enter?: Effect[]; exit?: Effect[]; warp?: boolean; romulan?: Effect[]; klingon?: Effect[]; enterprise?: Effect[] } = {}) {
  const data = miniShipData();
  // (combat.yaml's battles, which the dialog reads too: Plan 23; a klingon is friendly by its kind's flags)
  data.combat = miniCombat();
  data.combat.battles[10] = miniBattleDef({
    enter: 'b.enter', exit: 'b.exit', warp: extra.warp === false ? null : 'b.warp',
    ships: [['b.ent', 'enterprise'], ['b.klingon', 'klingon'], ['b.rom1', 'romulan'], ['b.rom2', 'romulan']],
  });
  const content = makeGame(
    [
      { id: 'w.ent', name: 'Enterprise', screen: null, universe: { x: 90, y: 90, z: 90 } },
      hook('b.enter', extra.enter ?? [rec('enter')]),
      hook('b.exit', extra.exit ?? [rec('exit')]),
      hook('b.warp', [rec('warp')]),
      ship('b.ent', 'Enterprise', extra.enterprise ?? [rec('ent')]),
      ship('b.klingon', 'Klingon', extra.klingon ?? [rec('klingon')]),
      ship('b.rom1', 'Romulan', extra.romulan ?? [rec('rom1')]),
      ship('b.rom2', 'Romulan', [rec('rom2')], { active: false }),
    ],
    { triggers: [{ id: 't1', type: 'normal', context: 'ship', target: 'w.ent', enabled: false }], ship: data },
  );
  const world = new World(content, createInitialState(content, 1, { onShip: true }), w => new HeadlessPresenter(w.clock));
  const ran: string[] = [];
  world.hooks.register('rec', (_w, _c, args) => { ran.push(args.n as string); return 0; });
  const events: SimEvent[] = [];
  world.bus.on(e => events.push(e));
  const warnings = () => events.filter(e => e.type === 'warning').map(e => (e as { message: string }).message);
  const run = async (f: () => Promise<unknown>) => { void world.enqueue(async () => { await f(); }); await settle(world); };
  const enter = async (scenario = 10) => { world.state.ship.battleScenario = scenario; await run(() => gotoShipScreen(world, 7)); };
  return { world, ran, events, warnings, run, enter, ship: world.state.ship };
}

describe('battle hails', () => {
  it('a battle hail goes to tactical with its scenario, not its conversation', async () => {
    const { world, ship, run } = combatWorld();
    for (const type of [0xa, 0x10]) {
      world.state.pendingHail = { from: null, conversation: null, situation: 0, type, scenario: 10 };
      let code: number | null = null;
      await run(async () => { code = await dispatchHail(world); });
      expect(code).toBe(7);
      expect(ship.battleScenario).toBe(10);
      expect(world.state.pendingHail).toBeNull();
      ship.battleScenario = NO_SCENARIO;
    }
    // (no scenario is none)
    world.state.pendingHail = { from: null, conversation: null, situation: 0, type: 0xa };
    await run(async () => { await dispatchHail(world); });
    expect(ship.battleScenario).toBe(NO_SCENARIO);
  });

  it('a later hail no longer overwrites a battle hail: it is dispatched first, on the next ship tick', async () => {
    const { world, ship, run } = combatWorld();
    world.state.pendingHail = { from: null, conversation: null, situation: 0, type: 0xa, scenario: 10 };
    shipTick(world);
    await settle(world);
    expect(world.state.ship.station).toBe('tactical');
    expect(ship.combat?.scenario).toBe(10);
    // (a hail raised in the battle waits, with nothing lost, for the bridge's own tick)
    world.state.pendingHail = { from: null, conversation: null, situation: 0, type: 9 };
    await run(() => gotoShipScreen(world, 0));
    // (the bridge uses Exit first, then dispatches)
    shipTick(world);
    await settle(world);
    shipTick(world);
    await settle(world);
    expect(world.state.pendingHail).toBeNull();
    expect(ship.station).toBe('transporter');
  });

  it("a battle hail during the viewscreen's conversation goes to tactical", async () => {
    const { world, ship, run } = combatWorld();
    world.state.objects['b.klingon'].talk = '';
    ship.viewscreenTarget = 'b.klingon';
    // (the target's own talk string runs; the hail is raised by it afterwards: here, directly)
    world.state.pendingHail = { from: null, conversation: null, situation: 0, type: 0x10, scenario: 10 };
    let next = -1;
    await run(async () => { next = await runViewscreen(world, false, 'b.klingon'); });
    expect(next).toBe(7);
    expect(ship.battleScenario).toBe(10);
    expect(world.state.pendingHail).toBeNull();
  });
});

describe('battleDef and shipKind (combat.yaml\'s battles and kinds, Plan 23)', () => {
  it('reads a battle by scenario, and none for an unknown scenario or without combat.yaml', () => {
    const { world } = combatWorld();
    expect(battleDef(world.content, 10)?.ships.map(s => s.object)).toEqual(['b.ent', 'b.klingon', 'b.rom1', 'b.rom2']);
    expect(battleDef(world.content, 11)).toBeUndefined();
    expect(battleDef({ ...world.content, ship: { ...world.content.ship!, combat: undefined } }, 10)).toBeUndefined();
    expect(battleDef({ ...world.content, ship: undefined }, 10)).toBeUndefined();
  });

  it('names the Enterprise and the friendly kinds by kShipKinds\' flags (combat.cpp:35-49), and neither for an unknown type or without combat.yaml', () => {
    const { world } = combatWorld();
    const c = world.content;
    // (kinds by combat.h's numbers: romulan 1, enterprise 2, klingon 3, starbase 6; 0x08000000 is friendly)
    expect(shipKind(c, 2)).toEqual({ enterprise: true, friendly: false });
    expect(shipKind(c, 1)).toEqual({ enterprise: false, friendly: false });
    expect(shipKind(c, 3)).toEqual({ enterprise: false, friendly: true });
    expect(shipKind(c, 6)).toEqual({ enterprise: false, friendly: true });
    expect(shipKind(c, 12)).toEqual({ enterprise: false, friendly: false });
    expect(shipKind({ ...c, ship: { ...c.ship!, combat: undefined } }, 2)).toEqual({ enterprise: false, friendly: false });
    expect(shipKind({ ...c, ship: undefined }, 3)).toEqual({ enterprise: false, friendly: false });
  });
});

describe('Combat::setup', () => {
  it('battleFor keeps active ships only, splits friends from enemies, and ends at once without an Enterprise', async () => {
    const { world, warnings, enter, ship } = combatWorld();
    expect(battleFor(world, 10)).toEqual({
      scenario: 10, enterprise: 'b.ent', enemies: ['b.rom1'], friends: ['b.klingon'], destroyed: [], warped: false, redAlert: true,
    });
    world.state.objects['b.ent'].active = false;
    expect(battleFor(world, 10)).toBeNull();
    expect(warnings().some(w => w.includes('no Enterprise'))).toBe(true);
    // (the original goes back to the bridge and forgets the scenario)
    await enter();
    expect(ship.station).toBe('bridge');
    expect(ship.combat).toBeNull();
    expect(ship.battleScenario).toBe(NO_SCENARIO);
  });

  it('0xffff fights the default battle 8; the starbase battle is 0x50', async () => {
    const { world, enter, ship } = combatWorld();
    world.content.ship!.combat!.battles[0x50] = miniBattleDef({ screen: 's', ships: [['b.ent', 'enterprise']] });
    world.content.ship!.combat!.battles[8] = miniBattleDef({ screen: 's', ships: [['b.ent', 'enterprise']] });
    await enter(NO_SCENARIO);
    expect(ship.combat).toMatchObject({ scenario: 8, redAlert: false });
    await resolveCombat(world, 'flee');
    await enter(0x50);
    expect(ship.combat).toMatchObject({ scenario: 0x50, redAlert: false });
  });

  it("startCombat runs Enter's USE once, then processHails", async () => {
    const { world, ran, enter, run, ship } = combatWorld({ enter: [rec('enter'), hail(0xf)] });
    await enter();
    expect(ran).toEqual(['enter']);
    expect(ship.combat?.redAlert).toBe(true);
    expect(world.state.pendingHail).toBeNull();
    // (back from engineering, the battle goes on: nothing runs again)
    await run(() => gotoShipScreen(world, 9));
    await run(() => gotoShipScreen(world, 7));
    await run(() => startCombat(world));
    expect(ran).toEqual(['enter']);
    expect(ship.combat).not.toBeNull();
  });
});

describe('the dialog', () => {
  it("win runs each active enemy's kill list once, not the friends', then Exit's USE on the bridge", async () => {
    const { world, ran, enter, run, ship } = combatWorld();
    await enter();
    await run(() => resolveCombat(world, 'win'));
    expect(ran).toEqual(['enter', 'rom1']);
    expect(ship.combat).toBeNull();
    expect(ship.station).toBe('bridge');
    expect(ship.bridgeUse).toBe('b.exit');
    expect(world.state.objects['b.rom1'].active).toBe(false);
    expect(ship.battleScenario).toBe(NO_SCENARIO);
    shipTick(world);
    await settle(world);
    expect(ran).toEqual(['enter', 'rom1', 'exit']);
  });

  it('a destroyed hook runs once', async () => {
    const { world, ran, enter, run } = combatWorld();
    await enter();
    const combat = world.state.ship.combat!;
    await run(() => resolveCombat(world, 'win'));
    // (the flag survives endCombat and a second pass)
    expect(world.state.phaser['b.rom1'].destroyed).toBe(true);
    await run(() => runDestroyedHook(world, 'b.rom1'));
    world.state.ship.combat = combat;
    await run(() => endCombat(world, true));
    expect(ran.filter(r => r === 'rom1')).toHaveLength(1);
  });

  it("flee runs Warp's USE on the bridge", async () => {
    const { world, ran, enter, run, ship } = combatWorld();
    await enter();
    await run(() => resolveCombat(world, 'flee'));
    expect(ship.station).toBe('bridge');
    expect(ship.bridgeUse).toBe('b.warp');
    expect(ran).toEqual(['enter']);
    shipTick(world);
    await settle(world);
    expect(ran).toEqual(['enter', 'warp']);
  });

  it('flee without a Warp object runs Exit', async () => {
    const { world, enter, run, ship } = combatWorld({ warp: false });
    await enter();
    await run(() => resolveCombat(world, 'flee'));
    expect(ship.bridgeUse).toBe('b.exit');
  });

  it("lose runs the Enterprise's kill list, then ends the game with reason 1", async () => {
    const { world, ran, enter, run, ship } = combatWorld();
    await enter();
    await run(() => resolveCombat(world, 'lose'));
    expect(ran).toEqual(['enter', 'ent']);
    expect(world.state.onShip).toEqual({ gameOver: 1 });
    expect(ship.combat).toBeNull();
    expect(ship.bridgeUse).toBeNull();
  });

  it('refuses with no battle', async () => {
    const { world } = combatWorld();
    await expect(resolveCombat(world, 'win')).rejects.toThrow(/no battle/);
  });

  it('leaving tactical for the bridge ends the battle; for engineering it waits', async () => {
    const { world, enter, run, ship } = combatWorld();
    await enter();
    await run(() => gotoShipScreen(world, 9));
    expect(ship.combat).not.toBeNull();
    expect(ship.station).toBe('engineering');
    await run(() => gotoShipScreen(world, 0));
    expect(ship.combat).toBeNull();
    expect(ship.bridgeUse).toBe('b.exit');
    // (any other screen ends it without Exit)
    await enter();
    await run(() => gotoShipScreen(world, 4));
    expect(ship.combat).toBeNull();
    expect(ship.bridgeUse).toBe('b.exit');
  });
});

describe('processHails', () => {
  const pending = (world: World, type: number) => { world.state.pendingHail = { from: null, conversation: null, situation: 0, type }; };
  const ph = (world: World, run: (f: () => Promise<unknown>) => Promise<void>) => run(() => processHails(world));

  it('7 runs the viewscreen conversation and stays in tactical', async () => {
    const { world, enter, run, events, ship } = combatWorld();
    await enter();
    world.state.objects['b.rom1'].talk = '';
    world.state.pendingHail = { from: 'b.rom1', conversation: null, situation: 0, type: 7 };
    await ph(world, run);
    expect(events.filter(e => e.type === 'viewscreen').map(e => (e as { on: boolean }).on)).toEqual([true, false]);
    expect(world.state.pendingHail).toBeNull();
    expect(ship.station).toBe('tactical');
    expect(ship.combat).not.toBeNull();
  });

  it('8 waits; answerHail turns it into 7', async () => {
    const { world, enter, run, events } = combatWorld();
    await enter();
    world.state.pendingHail = { from: 'b.rom1', conversation: null, situation: 0, type: 8 };
    await ph(world, run);
    expect(world.state.pendingHail?.type).toBe(8);
    expect(events.some(e => e.type === 'viewscreen')).toBe(false);
    await run(() => answerHail(world));
    expect(world.state.pendingHail).toBeNull();
    expect(events.some(e => e.type === 'viewscreen')).toBe(true);
  });

  it.each([0xb, 0xc])('%i stands down: scenario reset, no red alert', async type => {
    const { world, enter, run, ship } = combatWorld();
    await enter();
    ship.battleScenario = 10;
    pending(world, type);
    await ph(world, run);
    expect(ship.combat?.redAlert).toBe(false);
    expect(ship.battleScenario).toBe(NO_SCENARIO);
    expect(world.state.pendingHail).toBeNull();
  });

  it('0xd ends the battle to the bridge with Exit', async () => {
    const { world, enter, run, ship } = combatWorld();
    await enter();
    pending(world, 0xd);
    await ph(world, run);
    expect(ship.combat).toBeNull();
    expect(ship.station).toBe('bridge');
    expect(ship.bridgeUse).toBe('b.exit');
  });

  it('0xf is red alert', async () => {
    const { world, enter, run, ship } = combatWorld();
    await enter();
    ship.combat!.redAlert = false;
    pending(world, 0xf);
    await ph(world, run);
    expect(ship.combat?.redAlert).toBe(true);
  });

  it('0x10 destroys every ship, the Enterprise last: the game ends', async () => {
    const { world, ran, enter, run, ship } = combatWorld();
    await enter();
    pending(world, 0x10);
    await ph(world, run);
    expect(ran).toEqual(['enter', 'rom1', 'klingon', 'ent']);
    expect(world.state.onShip).toEqual({ gameOver: 1 });
    expect(ship.combat).toBeNull();
  });

  it("a hook's hails do what processHails does: a kill list that raises 0xd ends the battle", async () => {
    const { world, ran, enter, run, ship } = combatWorld({ romulan: [rec('rom1'), hail(0xd)] });
    await enter();
    await run(() => resolveCombat(world, 'win'));
    expect(ran).toEqual(['enter', 'rom1']);
    expect(ship.combat).toBeNull();
    expect(ship.bridgeUse).toBe('b.exit');
  });
});
