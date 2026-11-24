// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { ConversationDef, RuleGroup } from '../content/types';
import { BATTLE, battleWorld, CHODAK, ENTERPRISE, rec, type BattleWorldOptions } from '../testing/battle';
import { miniTacticsCombat } from '../testing/combat';
import { ASTROGATION_EXIT } from './combat/warp';
import { GAME_OVER_EXIT } from './combat/types';
import { newRandom, nextRandom } from './combat/random';
import { NO_SCENARIO, STATION_CODE } from './ship';
import { gotoShipScreen } from './stations';
import { resolveCombat } from './combat';
import type { SimEvent } from './events';
import type { HeadlessPresenter } from './presenter';
import { battleCommand, battleHails, consolePage, pauseBattle, VIEW_WAIT_CAP } from './tacticalScreen';
import { flush } from './settle';

describe('a battle in the world (TacticalScreen::start, tactical.cpp:300-336; Plan 23)', () => {
  it('starts one at tactical: the seed from the game\'s random source, the Enterprise\'s systems shared, Worf at Ensign, the Enter object first', async () => {
    const { world, enter, events, ship, ran } = battleWorld({ difficulty: 0 });
    await enter();
    // (the first frame is the Enter object's USE, then processHails: no step yet, tactical.cpp:458-466)
    expect([ran, world.battle!.b.steps]).toEqual([['b.enter'], 0]);
    const run = world.battle!;
    expect([ship.station, run.b.scenario, run.b.console.delegate, run.b.console.redAlert]).toEqual(['tactical', BATTLE, true, true]);
    expect(run.b.ships[0]!.systems).toBe(ship.systems);
    expect(ship.combat).toEqual({ scenario: BATTLE, enterprise: ENTERPRISE, enemies: [CHODAK], friends: [], destroyed: [], warped: false, redAlert: true });
    expect(events.filter(e => e.type === 'rng').map(e => (e as { site: string }).site)).toEqual(['combatSeed']);
    expect(events.some(e => e.type === 'combat' && e.on && e.scenario === BATTLE)).toBe(true);
    expect(world.combatMemory.lastDifficulty).toBe(0);
  });

  it('seeds the battle with the game\'s draw: Combat::setup\'s gameRandom(0x7fffffff) (combat.cpp:164)', async () => {
    const { world, enter, events } = battleWorld();
    await enter();
    const draw = events.find(e => e.type === 'rng') as { max: number; value: number };
    expect(draw.max).toBe(0x7fffffff);
    // (the battle's random state is the draw's, moved on by the battle's own draws since)
    const r = world.battle!.b.random, replay = newRandom(draw.value);
    for (let i = 0; i < r.draws; i++) nextRandom(replay);
    expect(r.state).toBe(replay.state);
  });

  it('moves the Enterprise\'s systems onto the battle\'s clock as it starts, each time its distance from now (systemsToBattleClock)', async () => {
    const { world, run, ticks, ship } = battleWorld();
    // (the systems ticked at the bridge)
    await ticks(3);
    expect([ship.station, ship.systems.lastTick > 0]).toEqual(['bridge', true]);
    // (a repair due 30 ticks on is due 500 ms on: 30 * 1000 / 60)
    ship.systems.units[2]!.nextRepair = world.state.tick + 30;
    // (the start alone, before the first frame moves the battle's clock on)
    ship.battleScenario = BATTLE;
    await run(() => gotoShipScreen(world, STATION_CODE.tactical));
    expect(ship.systems.units[2]!.nextRepair).toBe(world.battle!.clock + 500);
    expect(ship.systems.lastTick).toBeLessThanOrEqual(world.battle!.clock);
  });

  it('fights the default battle without a scenario, and takes the power level from the Enterprise object\'s state', async () => {
    const { world, enter } = battleWorld({ enterpriseState: 3 });
    await enter(NO_SCENARIO);
    expect([world.battle!.b.scenario, world.battle!.b.console.powerLevel, world.battle!.b.console.redAlert]).toEqual([8, 2, false]);
  });

  it('goes back to the bridge, the scenario forgotten, with no Enterprise to fight with, the seed drawn all the same (combat.cpp:164, tactical.cpp:314-318)', async () => {
    const { world, enter, events, ship, warnings } = battleWorld();
    world.state.objects[ENTERPRISE]!.active = false;
    await enter();
    expect([ship.station, ship.combat, world.battle, ship.battleScenario]).toEqual(['bridge', null, null, NO_SCENARIO]);
    expect(events.filter(e => e.type === 'rng').length).toBe(1);
    expect(warnings()).toEqual(['battle screen 3 has no Enterprise']);
  });

  it('fights a frame a world tick at tactical, on its own clock: a second of ticks is 15 steps of 66 ms', async () => {
    const { world, enter, ticks } = battleWorld();
    await enter();
    const run = world.battle!;
    const start = run.clock;
    await ticks(60);
    expect([run.clock - start, run.b.steps]).toEqual([1000, 15]);
  });

  it('waits at engineering, whose tick charges the Enterprise\'s systems on the battle\'s clock; back at tactical it skips ahead (combat.cpp:409-419)', async () => {
    const { world, enter, ticks, run: task, ship } = battleWorld();
    await enter();
    await ticks(30);
    const steps = world.battle!.b.steps;
    await task(() => gotoShipScreen(world, STATION_CODE.engineering));
    expect([ship.station, ship.combat !== null, world.battle !== null]).toEqual(['engineering', true, true]);
    await ticks(180);
    expect(world.battle!.b.steps).toBe(steps);
    expect(ship.systems.lastTick).toBe(world.battle!.clock);
    await task(() => gotoShipScreen(world, STATION_CODE.tactical));
    await ticks(1);
    // (three seconds away is a gap of more than one: one step, not 45)
    expect(world.battle!.b.steps).toBe(steps + 1);
  });

  it('stands down once only the Enterprise is left: the red alert off and the scenario forgotten; the battle waits for the player to leave', async () => {
    const { world, enter, ticks, ship } = battleWorld();
    await enter();
    world.battle!.b.ships[1]!.removed = true;
    await ticks(5);
    expect([world.battle!.b.console.redAlert, ship.combat!.redAlert, ship.battleScenario, ship.station]).toEqual([false, false, NO_SCENARIO, 'tactical']);
  });

  it('leaves by the exit code through the ship\'s screens: retreat to astrogation ends it without the Exit object, its systems back on the ship\'s clock and the battle kept', async () => {
    const { world, enter, ticks, ship, ran } = battleWorld();
    await enter();
    const b = world.battle!.b;
    b.exitCode = ASTROGATION_EXIT;
    await ticks(5);
    expect([ship.station, ship.combat, world.battle, world.combatMemory.previous]).toEqual(['astrogation', null, null, b]);
    expect(ran).toEqual(['b.enter']);
    // (the last tick a moment ago on the ship's clock, as it was on the battle's: systemsToShipClock)
    expect(ship.systems.lastTick).toBeLessThanOrEqual(world.state.tick);
    expect(ship.systems.lastTick).toBeGreaterThan(world.state.tick - 10);
  });

  it('moves the Enterprise\'s systems back onto the ship\'s clock as it ends, before astrogation ticks them (systemsToShipClock)', async () => {
    const { world, enter, ticks, ship } = battleWorld();
    // (the systems ticked at the bridge first, and by the battle's steps since, so none starts afresh: lastTick isn't 0)
    await ticks(3);
    await enter();
    await ticks(8);
    const run = world.battle!;
    expect(ship.systems.lastTick).toBeGreaterThan(0);
    // (500 ms on is 30 ticks on; the leave's frame takes a tick, 1000/60 ms, of it: ceil((500 - 16.7) * 60 / 1000) = 29)
    ship.systems.units[2]!.nextRepair = run.clock + 500;
    run.b.exitCode = ASTROGATION_EXIT;
    await ticks(1);
    expect([ship.station, world.battle]).toEqual(['astrogation', null]);
    const due = ship.systems.units[2]!.nextRepair - world.state.tick;
    expect(due).toBeGreaterThanOrEqual(28);
    expect(due).toBeLessThanOrEqual(30);
    expect(ship.systems.lastTick).toBeLessThanOrEqual(world.state.tick);
  });

  it('leaves without taking the red flash or standing down: leave returns first (tactical.cpp:475-478)', async () => {
    const { world, enter, ticks } = battleWorld();
    await enter();
    const run = world.battle!;
    run.b.exitCode = ASTROGATION_EXIT;
    run.b.console.redFlash = true;
    await ticks(1);
    expect([world.battle, run.redFlash, run.b.console.redFlash]).toEqual([null, false, true]);
  });

  it('fights the same battle whatever the frame rate: the steps follow the battle\'s clock, not the frames', async () => {
    const fight = async (every: number) => {
      const { world, enter, ticks, ship } = battleWorld();
      await enter();
      // (a frame every `every` ticks: the ticks between advance the world's clock without the ship's tick)
      for (let i = 1; i <= 90; i++) {
        if (i % every === 0) await ticks(1);
        else world.clock.advance();
      }
      return JSON.stringify([world.battle!.b, world.battle!.clock, ship.systems, world.state.rngSeed]);
    };
    const one = await fight(1);
    expect(await fight(2)).toBe(one);
    expect(await fight(3)).toBe(one);
  });

  it('runs the Exit object\'s USE as the battle ends at the bridge, and ends the game when the Enterprise is lost', async () => {
    const one = battleWorld();
    await one.enter();
    await one.run(() => gotoShipScreen(one.world, STATION_CODE.bridge));
    await one.ticks(2);
    expect([one.ship.combat, one.world.battle, one.ran]).toEqual([null, null, ['b.enter', 'b.exit']]);
    const two = battleWorld();
    await two.enter();
    two.world.battle!.b.exitCode = GAME_OVER_EXIT;
    await two.ticks(2);
    expect([two.world.state.onShip, two.world.battle]).toEqual([{ gameOver: 1 }, null]);
  });

  it('carries the last battle into the next, as the session\'s one Combat does: Delegate kept at the same difficulty, the spread', async () => {
    const { world, enter, run, ticks } = battleWorld({ difficulty: 0 });
    await enter();
    world.battle!.b.console.delegate = false;
    battleCommand(world, { type: 'spread', cell: 3 });
    await ticks(1);
    await run(() => gotoShipScreen(world, STATION_CODE.bridge));
    await ticks(2);
    await enter();
    expect([world.battle!.b.console.delegate, world.battle!.b.console.spreadDegrees]).toEqual([false, 15]);
  });

  it('applies the orders given since the last frame before the next, in order', async () => {
    const { world, enter, ticks } = battleWorld();
    await enter();
    battleCommand(world, { type: 'shields', on: true });
    battleCommand(world, { type: 'powerLevel', level: 2 });
    expect([world.battle!.b.console.shieldsRaised, world.battle!.queue.length]).toEqual([false, 2]);
    await ticks(1);
    // (level 2 lowers the shields again: setPowerLevel, weapons.cpp:681-684)
    expect([world.battle!.b.console.shieldsRaised, world.battle!.b.console.powerLevel, world.battle!.queue]).toEqual([false, 2, []]);
  });

  it('tells each of the tactics\' warnings once a battle, hands the frame\'s cues and sounds on, and takes the red flash', async () => {
    const { world, enter, ticks, events, warnings } = battleWorld();
    await enter();
    const run = world.battle!;
    run.ctx.onWarning!('no kernel page');
    run.ctx.onWarning!('no kernel page');
    expect(warnings()).toEqual(['combat: no kernel page']);
    battleCommand(world, { type: 'shields', on: true });
    run.b.console.redFlash = true;
    await ticks(1);
    const audio = events.filter(e => e.type === 'battleAudio');
    expect(audio.length).toBeGreaterThan(0);
    expect([run.b.cues, run.b.sounds, run.b.console.redFlash, run.redFlash]).toEqual([[], [], false, true]);
  });

  it('holds while a hail\'s conversation is on the viewscreen, and skips the time it took after (runViewscreen blocks, tactical.cpp:386-390; combat.cpp:411-419)', async () => {
    // (an even fight's hail is USE group 4, a viewscreen conversation, as below; its line held open until let go, as a player
    // reading it does)
    const talks = { communicate: { type: 7, from: CHODAK } };
    const { world, enter, ticks, events } = battleWorld({ use: [rec('use1'), rec('use2'), rec('use3'), rec('use4'), rec('use5', [talks])] });
    world.state.objects[CHODAK]!.talk = '-Zap-';
    let release = (): void => {};
    world.presenter.say = () => new Promise<void>(r => { release = r; });
    await enter();
    await ticks(30);
    const b = world.battle!.b;
    battleCommand(world, { type: 'hail' });
    world.tick();
    await flush();
    expect(events.some(e => e.type === 'viewscreen' && e.on)).toBe(true);
    const held = b.steps;
    // (ten seconds of the world's ticks with the line up: the battle doesn't step)
    for (let i = 0; i < 600; i++) {
      world.tick();
      await flush();
    }
    expect([world.busy, world.viewscreen !== null, b.steps]).toEqual([true, true, held]);
    release();
    await flush();
    expect([world.busy, world.viewscreen, world.state.ship.station]).toEqual([false, null, 'tactical']);
    // (and back, the ten seconds are skipped, not caught up: one step, not 150)
    await ticks(1);
    expect(world.battle!.b.steps).toBe(held + 1);
    await ticks(60);
    expect(world.battle!.b.steps).toBe(held + 16);
  });
});

describe('coming back to a battle (TacticalScreen::start before its _inCombat return, tactical.cpp:281-291; Plan 23 final review)', () => {
  it('turns Wide off and lets the keys go on coming back from Engineering, so the next step asks the sensors again', async () => {
    const { world, enter, run, ticks, ship } = battleWorld();
    await enter();
    const b = world.battle!.b;
    battleCommand(world, { type: 'wide', on: true });
    battleCommand(world, { type: 'steer', yaw: 1, pitch: 0, roll: 0, throttle: 1 });
    battleCommand(world, { type: 'orbit', direction: -1 });
    await ticks(1);
    expect([b.view.wide, b.console.radarShown, b.input.held !== 0]).toEqual([true, false, true]);
    // (wide, the steps don't ask the sensors: a check long due stays due; a step is 66 ms, four ticks)
    b.console.sensorCheckTime = 0;
    let steps = b.steps;
    await ticks(8);
    expect([b.steps > steps, b.console.sensorCheckTime]).toEqual([true, 0]);
    battleCommand(world, { type: 'engineering' });
    await ticks(1);
    expect(ship.station).toBe('engineering');
    await run(() => gotoShipScreen(world, STATION_CODE.tactical));
    steps = b.steps;
    await ticks(8);
    expect([ship.station, b.view.wide, b.console.radarShown, b.input.held]).toEqual(['tactical', false, true, 0]);
    expect([b.steps > steps, b.console.sensorCheckTime > 0]).toEqual([true, true]);
  });

  it('does the same after a conversation in the middle of a step (processHails\' gotoShipScreen, tactical.cpp:391)', async () => {
    // (an even fight's hail is USE group 4, a viewscreen conversation: as tacticalButtons.test.ts's)
    const talks = { communicate: { type: 7, from: CHODAK } };
    const { world, enter, ticks, events } = battleWorld({ use: [rec('use1'), rec('use2'), rec('use3'), rec('use4'), rec('use5', [talks])] });
    world.state.objects[CHODAK]!.talk = '-Zap-';
    await enter();
    const b = world.battle!.b;
    battleCommand(world, { type: 'wide', on: true });
    battleCommand(world, { type: 'steer', yaw: -1, pitch: 1, roll: 0, throttle: 0 });
    await ticks(1);
    expect([b.view.wide, b.input.held !== 0]).toEqual([true, true]);
    // (Engineering, pressed after the hail, waits for the next frame: the conversation's return lets it go, tactical.cpp:282)
    battleCommand(world, { type: 'hail' });
    battleCommand(world, { type: 'engineering' });
    await ticks(1);
    expect(events.some(e => e.type === 'viewscreen' && e.on)).toBe(true);
    await ticks(2);
    expect([b.view.wide, b.console.radarShown, b.input.held, world.state.ship.station]).toEqual([false, true, 0, 'tactical']);
  });
});

describe('the console\'s page (TacticalScreen::_page, tactical.cpp:301, 655-658; Plan 27 R4)', () => {
  it('opens a battle on CONN, shows a new page at once and tells the sim at the next frame, and keeps it across Engineering', async () => {
    const { world, enter, run, ticks, ship } = battleWorld();
    await enter();
    const r = world.battle!;
    expect([r.page, r.b.console.connPage]).toEqual(['conn', true]);
    consolePage(world, 'tactics');
    // (the page is the screen's, at once; the sim's _connPage follows at the next update, tactical.cpp:471)
    expect([r.page, r.b.console.connPage, r.queue]).toEqual(['tactics', true, [{ type: 'page', page: 'tactics' }]]);
    await ticks(1);
    expect([r.page, r.b.console.connPage]).toEqual(['tactics', false]);
    // (paused, the page still turns at once, and the sim's waits for the next step with every order)
    battleCommand(world, { type: 'engineering' });
    await ticks(1);
    expect(ship.station).toBe('engineering');
    await run(() => gotoShipScreen(world, STATION_CODE.tactical));
    // (back from Engineering the battle goes on, its page as it was: start()'s _inCombat return comes before `_page = kPageConn`, tactical.cpp:289-301)
    expect(world.battle!.page).toBe('tactics');
  });

  it('is changed nowhere while the warp overlay shows, as mouseClick returns then (tactical.cpp:647-648)', async () => {
    const { world, enter } = battleWorld();
    await enter();
    const r = world.battle!;
    r.ctx.seams.showWarp(r.ctx, r.b);
    r.journal.entries = [];
    consolePage(world, 'sensors');
    expect([r.page, r.queue]).toEqual(['conn', []]);
  });

  it('turns while paused, the sim\'s CONN waiting for the next step', async () => {
    const { world, enter, ticks } = battleWorld();
    await enter();
    const r = world.battle!;
    r.paused = true;
    consolePage(world, 'phasers');
    await ticks(4);
    expect([r.page, r.b.console.connPage, r.queue]).toEqual(['phasers', true, [{ type: 'page', page: 'phasers' }]]);
  });
});

describe('the dev shortcuts in a real battle (Decision 1, R3; Plan 23 final review)', () => {
  it('flees by the Warp object, not the Exit object', async () => {
    const { world, enter, run, ticks, ship, ran } = battleWorld();
    await enter();
    await run(() => resolveCombat(world, 'flee'));
    await ticks(1);
    expect([ship.station, ship.combat, world.battle, ran]).toEqual(['bridge', null, null, ['b.enter', 'b.warp']]);
  });

  it('lists the ships the sim destroyed in the world\'s record, for the ship list', async () => {
    const { world, enter, ticks, ship } = battleWorld();
    await enter();
    expect(ship.combat!.destroyed).toEqual([]);
    world.battle!.b.ships[1]!.destroyed = true;
    await ticks(1);
    expect(ship.combat!.destroyed).toEqual([CHODAK]);
  });
});

describe('the battle\'s audio, a frame at a time (TacticalScreen::update\'s _cues->update(), tactical.cpp:474; Plan 28 R2, R3)', () => {
  const audio = (events: SimEvent[]) => events.filter((e): e is Extract<SimEvent, { type: 'battleAudio' }> => e.type === 'battleAudio');

  it('hands every frame\'s cues and sounds on with the battle\'s clock, an empty frame\'s too, and none while paused or under the warp overlay', async () => {
    const { world, enter, ticks, events } = battleWorld();
    await enter();
    const run = world.battle!;
    // (a frame a world tick, each with the clock its update ran to: six ticks of 1000 / 60 ms are 100 ms of the battle's clock,
    // its whole ms as they fall due, after the sixtieths of a ms the earlier ticks left owed: syncBattleClock)
    let from = audio(events).length;
    let clock = run.clock;
    await ticks(6);
    expect(audio(events).slice(from).map(e => e.now - clock)).toEqual([17, 34, 50, 67, 84, 100]);
    expect(audio(events).at(-1)).toEqual({ type: 'battleAudio', now: run.clock, silenced: false, cues: [], sounds: [] });
    // (paused: no frame runs, so nothing is handed on and the clock stands: what plays plays on, nothing new starts)
    pauseBattle(world, true);
    from = audio(events).length;
    clock = run.clock;
    await ticks(6);
    expect([audio(events).length - from, run.clock]).toEqual([0, clock]);
    pauseBattle(world, false);
    // (at 4x the battle's clock runs four times as fast, and the cues' delays and gaps with it)
    world.assists = { ...world.assists, speed: 4 };
    clock = run.clock;
    await ticks(6);
    expect(audio(events).at(-1)!.now - clock).toBe(400);
    // (the warp overlay: no update runs while it lasts, so nothing is handed on: tactical.cpp:840-842)
    run.warpHold = 200;
    from = audio(events).length;
    await ticks(2);
    expect([audio(events).length - from, run.warpHold]).toEqual([0, 66]);
  });

  it('hands nothing on at Engineering, where no frame runs; back at tactical the first frame\'s clock has the time away in it, so a later cue comes due then (tactical.cpp:511-517)', async () => {
    const { world, enter, ticks, run: task, events } = battleWorld();
    await enter();
    await ticks(1);
    await task(() => gotoShipScreen(world, STATION_CODE.engineering));
    const from = audio(events).length;
    const clock = world.battle!.clock;
    await ticks(60);
    expect(audio(events).length).toBe(from);
    await task(() => gotoShipScreen(world, STATION_CODE.tactical));
    await ticks(1);
    // (61 ticks of the battle's clock, the second away and the frame back, its whole ms as they fell due)
    expect([audio(events).length - from, audio(events).at(-1)!.now - clock]).toEqual([1, 1017]);
  });

  it('says whether the Enterprise is lost, so the cues fall silent from that frame (damage.cpp:533-534, cues.cpp:132-133)', async () => {
    const { world, enter, ticks, events } = battleWorld();
    await enter();
    world.battle!.b.silenced = true;
    await ticks(1);
    expect(audio(events).at(-1)!.silenced).toBe(true);
  });
});

describe('a hail they\'re making, type 8 (TacticalScreen::processHails and hail, tactical.cpp:377-453; Plan 34 Task 9)', () => {
  /** A ship conversation of the chodak's: situation 0 is its one line, which disables itself as it is said. */
  const ZAP = 'ship.zap';
  const zap: ConversationDef = {
    id: ZAP, ship: true, number: 1,
    responses: [{ situation: 0, key: 0, state: 'enabled', who: ['picard'], replier: { object: CHODAK }, replies: [{ text: '-Zap-' }], changes: [{ to: 'disabled', situation: 0, key: 0 }] }],
  };
  /** The chodak's hook 0 makes the hail, with ZAP's situation 0 (CommunicateBlock::execute keeps 8's own numbers, object.cpp:1853, 1879-1883). */
  const raise8: RuleGroup = rec('look0', [{ communicate: { type: 8, conversation: ZAP, situation: 0 } }]);
  /** A battleWorld with ZAP in its content and state; difficulty 0, so Worf's lock runs the chodak's hook 0 as the battle starts. */
  function hailingWorld(o: BattleWorldOptions) {
    const bw = battleWorld({ difficulty: 0, ...o });
    bw.world.content.conversations[ZAP] = zap;
    bw.world.state.conversations[ZAP] = zap.responses.map(r => r.state);
    return bw;
  }
  const cues = (events: SimEvent[]) => events.flatMap(e => (e.type === 'battleAudio' ? e.cues.map(c => c.cue) : []));
  const said = (world: { presenter: unknown }) => (world.presenter as HeadlessPresenter).log.filter(l => l.startsWith('say '));

  it('a type-8 hail replays cue 0x5a at each hook until answered (processHails case 8 plays it and keeps the type, tactical.cpp:405-408)', async () => {
    // (every hook's script ends in processHails: runEventHook, damage.cpp:672; the Enter object's USE too, tactical.cpp:460-465)
    const look: RuleGroup[] = Array.from({ length: 12 }, (_, i) => (i === 0 ? raise8 : rec(`look${i}`)));
    const { world, enter, ticks, ran, events } = hailingWorld({ combat: miniTacticsCombat(), chodakAt: [2000, 9000, 0], look });
    await enter();
    for (let i = 0; i < 900 && world.battle; i++) await ticks(1);
    // (hook 0 at the start, the Enter object, then the hooks the steps ran: one hailing cue for each, the hail never taken)
    expect(ran.slice(0, 2)).toEqual(['look0', 'b.enter']);
    expect(ran.length).toBeGreaterThan(3);
    expect(cues(events).filter(c => c === 0x5a)).toHaveLength(ran.length);
    expect([world.state.pendingHail?.type, events.some(e => e.type === 'viewscreen'), said(world)]).toEqual([8, false, []]);
  });

  it('answering a type-8 hail runs its conversation (hail takes it as 7, tactical.cpp:448-450; processHails runs the viewscreen until it clears, :381-391)', async () => {
    const { world, enter, ticks, run: task, events } = hailingWorld({ look: [raise8] });
    await enter();
    expect(world.state.pendingHail?.type).toBe(8);
    battleCommand(world, { type: 'hail' });
    await ticks(1);
    // (runViewscreen clears the hail and says its conversation: unity.cpp:693-707. A conversation is an answer: no 0x5b, tactical.cpp:452-453)
    expect([world.state.pendingHail, said(world), events.filter(e => e.type === 'viewscreen').length]).toEqual([null, [`say ${CHODAK}: -Zap-`], 2]);
    expect(cues(events)).not.toContain(0x5b);
    // (cleared, so a later hook's processHails has no hail to play: case 0xff, tactical.cpp:430-431)
    const b = world.battle!.b;
    b.cues.length = 0;
    await task(() => battleHails(world, b));
    expect(b.cues).toEqual([]);
  });

  it('hailing back after it cleared does as tactical.cpp:438-453: hailResponse runs the bucket\'s USE group once, and a spent conversation shows nothing', async () => {
    // (an even fight is bucket 5, USE group 4: its script hails again with the same conversation, as battle 34's USE groups do)
    const use = [rec('use1'), rec('use2'), rec('use3'), rec('use4'), rec('use5', [{ communicate: { type: 7, conversation: ZAP, situation: 0 } }])];
    const { world, enter, ticks, ran, events } = hailingWorld({ look: [raise8], use });
    await enter();
    battleCommand(world, { type: 'hail' });
    await ticks(1);
    expect([world.state.pendingHail, said(world).length]).toEqual([null, 1]);
    // (nothing pending: Combat::hailResponse, damage.cpp:675-694. Its 7 is run by processHails, which has the viewscreen up for
    // ZAP's situation 0, already said and disabled: nothing is said, but a conversation was had, so no 0x5b either,
    // tactical.cpp:385-390, 452-453. The hail clears with nothing shown)
    const viewscreens = events.filter(e => e.type === 'viewscreen').length;
    battleCommand(world, { type: 'hail' });
    await ticks(1);
    expect([ran.slice(-1), world.state.pendingHail, said(world).length, events.filter(e => e.type === 'viewscreen').length - viewscreens]).toEqual([['use5'], null, 1, 2]);
    expect(cues(events)).not.toContain(0x5b);
    // (the bucket is spent, hooksRun's bit 5, which runEventHook shares (damage.cpp:658-660, 679-681): no script, "no response")
    battleCommand(world, { type: 'hail' });
    await ticks(1);
    expect([ran.filter(n => n.startsWith('use')), said(world).length, cues(events).filter(c => c === 0x5b).length]).toEqual([['use5'], 1, 1]);
  });
});

describe('the battle waits for its view (Plan 34 Task 8 fix I1)', () => {
  it('the battle\'s clock holds until its view first draws', async () => {
    const { world, enter, ticks, ran } = battleWorld();
    let drawn = false;
    world.battleView = () => drawn;
    await enter();
    const run = world.battle!;
    const clock = run.clock;
    // (the view readying the battle: the ticks let go, no frame run, not even the Enter object's USE)
    await ticks(30);
    expect([run.clock, run.b.steps, ran, run.enterPending]).toEqual([clock, 0, [], true]);
    // (drawn once: the clock runs from the next tick, the first frame the Enter USE, and on as it always does)
    drawn = true;
    await ticks(1);
    expect([run.clock - clock, ran]).toEqual([16, ['b.enter']]);
    drawn = false;
    await ticks(6);
    expect(run.clock - clock).toBe(116);
  });

  it('with no view the clock runs at once', async () => {
    const { world, enter, ticks, ran } = battleWorld();
    expect(world.battleView).toBeNull();
    await enter();
    const run = world.battle!;
    const clock = run.clock;
    await ticks(6);
    expect([run.clock - clock, ran]).toEqual([100, ['b.enter']]);
  });

  it('a view that never draws releases the clock at the cap', async () => {
    const { world, enter, ticks, ran } = battleWorld();
    world.battleView = () => false;
    await enter();
    const run = world.battle!;
    const clock = run.clock;
    // (enter's own tick, and the rest of the cap's)
    await ticks(VIEW_WAIT_CAP - 1);
    expect([run.clock, ran]).toEqual([clock, []]);
    await ticks(1);
    expect(ran).toEqual(['b.enter']);
    await ticks(6);
    expect(run.clock).toBeGreaterThan(clock);
  });
});

