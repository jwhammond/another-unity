// SPDX-License-Identifier: GPL-3.0-or-later
import { ANYONE, NONE, type GameContent, type ShipFx, type Vec2, type Verb } from '../content/types';
import { perform } from './actions';
import { giveAdvice, updateAdvice } from './advice';
import { Clock } from './clock';
import { EventBus } from './events';
import { reportFailure } from './failures';
import { distance, samePos } from './geometry';
import { HookRegistry } from './hooks';
import { actionSquaresNear, pixelWalk } from './pixels';
import type { Presenter } from './presenter';
import { updateHealth } from './phaser';
import { Rng } from './rng';
import { COMBAT_SAVE_REFUSED, deserializeSave, serializeState } from './save';
import type { Course } from './astro';
import type { ComputerView } from './computer';
import { applyShipFx } from './shipFx';
import type { ObjectState, WorldState } from './state';
import { clipDifficulty, DEFAULT_DIFFICULTY, restoreTransporter, type TransporterRoom } from './transporter';
import { applyScreenChange as changeScreen, applyStartup } from './screens';
import { shipTick } from './shipTick';
import { StopSignal } from './stop';
import { checkTriggers, processTimers, startScreenTimers } from './timers';
import { ORIGINAL_ASSISTS, type CombatAssists } from './combat/assists';
import { newCombatMemory, type CombatMemory, type WorldBattle } from './tacticalScreen';

export interface ActionContext {
  verb: Verb;
  target: string | null;
  who: string;
  /** The second object, as in "use X with Y"; null when there isn't one. */
  other: string | null;
  /** True when re-running after walking into range. */
  walked: boolean;
  /** For walking to a point instead of an object. */
  to?: Vec2;
}

/** What a World takes besides its content and state: settings, which aren't saved (R6). */
export interface WorldOptions {
  difficulty?: number;
  /**
   * How tactical fights (Plan 23 R2): 'dialog' is M4's win, flee or lose (players', until M8's switch-on); 'real' is the
   * combat sim (behind ?dev, the walkthroughs, and players from M8). The dialog by default.
   */
  combat?: 'dialog' | 'real';
  /** The player's assists (spec §5): the original by default. */
  assists?: CombatAssists;
  /**
   * combat.yaml's text, for a game parsed without it (the web app's lazy chunk, M8 spec §8): read by ensureCombat when a battle
   * needs it. A game parsed with combat.yaml (the tools, the tests) needs none.
   */
  combatSource?: () => Promise<string>;
}

export class World {
  readonly rng: Rng;
  readonly clock: Clock;
  /** A subscriber that throws doesn't stop the sim: its error is recorded like a failed action's. */
  readonly bus = new EventBus(err => this.errors.push(err));
  readonly hooks = new HookRegistry();
  readonly presenter: Presenter;
  readonly errors: unknown[] = [];
  actionDepth = 0;
  /** Who the outermost action is by, and what it is on (the original's _actionWho and _talkTarget). Not saved. */
  actionWho: string | null = null;
  talkTarget: string | null = null;
  /** UnityEngine::_talkDepth and _logging (unity.h:243-244): the conversation log's state. Not saved. */
  talkDepth = 0;
  logging = true;
  /** AstrogationScreen::_autoEngage and its course (astrogation.cpp:1170-1176): a scripted warp that engages by itself. Not saved. */
  autoEngage: Course | null = null;
  /** AstrogationScreen::_warpSetting (astrogation.cpp:1050): the screen's own speed, which a scripted warp with speed 0 leaves. Not saved. */
  warpSetting = 500;
  /** The computer screen while it is open (ComputerScreen). Not saved: it opens afresh. */
  computer: ComputerView | null = null;
  /** The viewscreen is up (runViewscreen, unity.cpp:697): who is on it (`caller`: the object that replies in a hail with no target, whose sprite is shown). Not saved: nothing saves while it runs. */
  viewscreen: { target: string | null; caller?: string } | null = null;
  /** The transporter room's pads and kit while the ship is at the transporter. Not saved: the room opens afresh. */
  transporter: TransporterRoom | null = null;
  /** Bumped by cancelQueuedActions(); an actor's walks queued before then are dropped. Not saved. */
  private readonly halts = new Map<string, number>();
  /** How many screen changes there have been; queued walks are dropped when it moves on. Not saved. */
  screenChanges = 0;
  /** The walk-then-act actions queued but not yet started, so each is only queued once. */
  private readonly pendingWalks = new Map<string, { actor: string; token: number }>();
  private walkTokens = 0;
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  /** The walk in progress for each actor. Not saved. */
  private readonly walks = new Map<string, { stop: StopSignal; placed: boolean }>();
  /** Queued tasks that are only walks so far (walkTo, or walkThenAct before its action starts). */
  private walkTasks = 0;

  /**
   * Resolves once the voice line the sim has just cued has been said: the original's `waitForSpeech` (unity.cpp:379-386, runHolodeck's refusal).
   * The session installs the mixer's; with no audio there is nothing to wait for. Not saved.
   */
  waitForSpeech: () => Promise<void> = () => Promise.resolve();

  /**
   * Hands the host a turn in a long run of the sim's own (auto-resolve's steps), so a page can paint. The browser's
   * session installs a macrotask; headless, it resolves at once, so settle() never sees the world busy with no timer due. Not saved.
   */
  yieldToHost: () => Promise<void> = () => Promise.resolve();

  /** UnityEngine::difficulty() (awayteam.cpp:103): a setting, not saved state (R6). 0 Ensign, 1 Lieutenant, 2 Captain. */
  difficulty: 0 | 1 | 2;
  /** How tactical fights (WorldOptions.combat). Not saved. */
  readonly combatMode: 'dialog' | 'real';
  /** The player's assists (spec §5), a setting: the session keeps it with the settings. Not saved. */
  assists: CombatAssists;
  /** Where combat.yaml comes from when the game was parsed without it (WorldOptions.combatSource). Not saved. */
  readonly combatSource: (() => Promise<string>) | undefined;
  /**
   * Whether the space view has drawn the battle yet: the browser's session sets it when its view readies a battle before
   * drawing it (Plan 34 Task 8). Until then the battle's clock waits, at most VIEW_WAIT_CAP (tacticalScreen.ts
   * syncBattleClock). Null with no view (tests, walks): the clock never waits. Not saved.
   */
  battleView: (() => boolean) | null = null;
  /** The battle being fought (TacticalScreen's _combat while _inCombat): not saved, as nothing saves during one. */
  battle: WorldBattle | null = null;
  /** What TacticalScreen keeps from one battle to the next: _lastDifficulty and the last battle (Plan 23 R8). Not saved. */
  combatMemory: CombatMemory = newCombatMemory();

  constructor(readonly content: GameContent, readonly state: WorldState, presenter: (w: World) => Presenter, options: WorldOptions = {}) {
    this.difficulty = clipDifficulty(options.difficulty ?? DEFAULT_DIFFICULTY);
    this.combatMode = options.combat ?? 'dialog';
    this.assists = { ...(options.assists ?? ORIGINAL_ASSISTS) };
    this.combatSource = options.combatSource;
    this.rng = new Rng(state, (site, max, value) => this.bus.emit({ type: 'rng', site, max, value }));
    this.clock = new Clock(state);
    this.presenter = presenter(this);
  }

  static fromSave(content: GameContent, text: string, presenter: (w: World) => Presenter, options: WorldOptions = {}): World {
    const { state, queued } = deserializeSave(text, content);
    const world = new World(content, state, presenter, options);
    // (a v3 save's queued ship effects, once and in order, before the first tick. Nobody can listen to a world this new, so
    // their events are lost here: a session leaves them queued and applies them after it subscribes)
    world.queuedShipFx = queued;
    world.applyQueuedShipFx();
    // (the transporter room isn't saved: a save made there opens it again, M9)
    restoreTransporter(world);
    return world;
  }

  /** The ship effects a v3 save had queued, until `applyQueuedShipFx` runs them (once, in order). Not saved. */
  queuedShipFx: ShipFx[] = [];

  /** Applies and clears the queued ship effects: the one place a v3 save's queue is applied, so its events reach whoever listens now. */
  applyQueuedShipFx(): void {
    const queued = this.queuedShipFx;
    this.queuedShipFx = [];
    for (const fx of queued) this.applyShipEffect(fx);
  }

  get busy(): boolean {
    return this.pending > 0;
  }

  /** True when nothing runs, or only walks do: the player may give a command (which stops the walker). */
  get interruptible(): boolean {
    return this.pending === this.walkTasks && this.actionDepth === 0;
  }

  obj(id: string): ObjectState {
    const o = this.state.objects[id];
    if (!o) throw new Error(`unknown object: ${id}`);
    return o;
  }

  marker(screen: string, name: string): Vec2 {
    const m = this.content.screens[screen]?.markers[name];
    if (!m) throw new Error(`unknown marker "${name}" on screen "${screen}"`);
    return { ...m };
  }

  /**
   * Who walks for an action by `who`: the current member for $none or $anyone (getWalker, unity.cpp:876-886),
   * else `who`, if it is on the current screen (crew only when it isn't a close-up).
   */
  walkerIdFor(who: string): string | undefined {
    if (who === NONE || who === ANYONE) return this.state.currentActor;
    const o = this.state.objects[who];
    // getWalker (unity.cpp:876-886): any object on the current screen's list; crew aren't on a close-up's
    if (!o || o.screen !== this.state.screen) return undefined;
    if (this.content.objects[who]?.crew && this.state.onCloseup) return undefined;
    return who;
  }

  /** The object who walks for an action, if any. */
  walkerFor(who: string): ObjectState | undefined {
    const id = this.walkerIdFor(who);
    return id === undefined ? undefined : this.state.objects[id];
  }

  /** With the team, on this screen, and on their feet (awayteam.cpp:942-945). */
  isActiveAwayTeamMember(id: string): boolean {
    if (!this.state.awayTeam.includes(id)) return false;
    return this.obj(id).screen === this.state.screen && !this.isIncapacitated(id);
  }

  /** At or below their threshold of health; only objects with phaser data can be (awayteam.cpp:938-940). */
  isIncapacitated(id: string): boolean {
    const def = this.content.objects[id]?.phaser;
    const ps = this.state.phaser[id];
    return def !== undefined && ps !== undefined && ps.health <= def.threshold;
  }

  /** The next member, in team order, who can act here (selectNextAwayTeamMember, awayteam.cpp:742-760). */
  selectNextMember(): void {
    const team = this.state.awayTeam;
    const current = Math.max(0, team.indexOf(this.state.currentActor));
    for (let i = 1; i < team.length; i++) {
      const id = team[(current + i) % team.length];
      const o = this.obj(id);
      if (o.active && o.screen === this.state.screen && !this.isIncapacitated(id)) {
        this.state.currentActor = id;
        return;
      }
    }
  }

  /**
   * The away-team selector (the original's portrait click): only a member who is with the team, here, on
   * their feet, and not on a close-up. Returns whether the current member changed to them.
   */
  selectMember(id: string): boolean {
    if (this.actionDepth > 0 || this.state.onCloseup || !this.isActiveAwayTeamMember(id)) return false;
    this.state.currentActor = id;
    return true;
  }

  /**
   * cancelQueuedActions (unity.cpp:933): the actor's queued walks and walk-then-act actions are dropped, and a
   * walk in progress goes on (its action, if it had one, is dropped when it arrives). A click that isn't a
   * command does only this (awayteam.cpp:610-611).
   */
  cancelQueuedActions(actor: string): void {
    this.halts.set(actor, this.haltCount(actor) + 1);
    for (const [key, w] of this.pendingWalks) if (w.actor === actor) this.pendingWalks.delete(key);
  }

  /** Whether the actor has a walk in progress. */
  isWalking(actor: string): boolean {
    return this.walks.has(actor);
  }

  /** A halt: the queued actions go, and the walk in progress stops where it is (as collapse() clears walk_path). */
  halt(actor: string): void {
    this.cancelQueuedActions(actor);
    this.stopWalk(actor);
  }

  /**
   * Stops an actor's walk in progress. `placed`: something else has put them somewhere (an alter's `at` or
   * `get`, object.cpp:1304, 1329), which wins over where the walk got to.
   */
  stopWalk(actor: string, placed = false): void {
    const walk = this.walks.get(actor);
    if (!walk) return;
    if (placed) walk.placed = true;
    walk.stop.stop();
  }

  private haltCount(actor: string): number {
    return this.halts.get(actor) ?? 0;
  }

  /** Ship-side changes apply at once (applyShipFx). */
  applyShipEffect(effect: ShipFx): void {
    applyShipFx(this, effect);
  }

  isObjectAt(p: Vec2): boolean {
    return Object.values(this.state.objects).some(o => o.active && o.screen === this.state.screen && samePos(o.pos, p));
  }

  /** Runs tasks strictly one after another; a failure is recorded and doesn't stop later tasks. */
  enqueue(task: () => Promise<void>): Promise<void> {
    this.pending++;
    const run = this.tail
      .then(task)
      .catch((err: unknown) => {
        this.errors.push(err);
        // (the bus keeps a throwing subscriber from poisoning the queue)
        this.bus.emit({ type: 'actionFailed', error: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => {
        this.pending--;
      });
    this.tail = run;
    return run;
  }

  /**
   * Queues a player's action. Rules and hooks must not call this; an action inside an action uses perform().
   * Whether the player may act at all is the UI's call, as it is the original's input handling's: it drops
   * clicks and keys while awayFlags.inputBlocked is set or a dialog is up (unity.cpp:1329-1370), and this
   * engine's UI also decides what to do while busy. The sim only refuses a member who is down.
   * The combadge is callShip(), which checks its own flag.
   */
  act(verb: Verb, opts: { target?: string | null; who?: string; other?: string | null; to?: Vec2 }): Promise<void> {
    // (queued behind the running action, it would deadlock anything that awaited it)
    if (this.actionDepth > 0) throw new Error('act() called inside an action; use perform()');
    const who = opts.who ?? this.state.currentActor;
    const ctx: ActionContext = { verb, target: opts.target ?? null, who, other: opts.other ?? null, walked: false, to: opts.to };
    // a new command replaces whatever the member was going to do, from the moment it is given (awayteam.cpp:610-611)
    if (this.state.awayTeam.includes(who) && !this.isIncapacitated(who)) this.halt(who);
    return this.enqueue(async () => {
      if (this.state.awayTeam.includes(who)) {
        // nobody can act while down (awayteam.cpp:606-607)
        if (this.isIncapacitated(who)) return;
        this.state.currentActor = who;
        // (and anything queued for them while this command waited is dropped too)
        this.halt(who);
      }
      const result = await perform(this, ctx);
      await reportFailure(this, ctx, result);
      // (the main loop applies a screen change that the failure line's conversation asked for)
      if (this.actionDepth === 0) this.applyScreenChange();
    });
  }

  walkTo(actor: string, to: Vec2): void {
    const screenChanges = this.screenChanges;
    const halts = this.haltCount(actor);
    this.walkTasks++;
    void this.enqueue(async () => {
      try {
        // (a new screen, or a halt, clears the queued walks)
        if (this.screenChanges !== screenChanges || this.haltCount(actor) !== halts) return;
        // (on a screen with a pixel metric, the original's path finder says where the walk ends; with no floor
        // to walk on, there is no walk)
        const planned = pixelWalk(this, this.obj(actor).pos, to);
        if (planned === null) return;
        await this.walkActor(actor, planned ? planned.end : to);
      } finally {
        this.walkTasks--;
      }
    });
  }

  /**
   * Walks to within stopWithin of `to`, then runs the action again as already in range (the original's
   * walkToThenAct, whose result this is: false when there is no walk to make). The stop point is worked out when the walk starts, from where the actor is then.
   * Like the original's queueAfterWalk, the same action is only queued once, until its walk is over.
   */
  walkThenAct(actor: string, to: Vec2, ctx: ActionContext, stopWithin = 0, stopPx?: number): boolean {
    // (where findPath finds no walk at all, walkToThenAct fails at once and the caller goes on as if in range)
    if (pixelWalk(this, this.obj(actor).pos, to, stopWithin, stopPx) === null) return false;
    // (queueAfterWalk keys on the walker, target, action and who, not the other object: unity.cpp:918-931)
    const key = `${actor}|${ctx.verb}|${ctx.target}|${ctx.who}`;
    if (this.pendingWalks.has(key)) return true;
    const token = ++this.walkTokens;
    this.pendingWalks.set(key, { actor, token });
    const screenChanges = this.screenChanges;
    const halts = this.haltCount(actor);
    // (a halt or screen change may have dropped the key, and the same action queued again since)
    const release = () => {
      if (this.pendingWalks.get(key)?.token === token) this.pendingWalks.delete(key);
    };
    let walking = true;
    this.walkTasks++;
    void this.enqueue(async () => {
      try {
        // (a new screen, or a halt, clears the queued walks)
        if (this.screenChanges !== screenChanges || this.haltCount(actor) !== halts) return;
        const from = { ...this.obj(actor).pos };
        const planned = pixelWalk(this, from, to, stopWithin, stopPx);
        if (planned) {
          // (a walk that was stopped, by a halt or an alter, doesn't act: Decision 4; nor does one towards a
          // point it can't reach)
          if (await this.walkActor(actor, planned.end)) return;
          if (!planned.acts) return;
        } else if (planned === undefined) {
          const d = distance(from, to);
          if (d > stopWithin) {
            const dest = {
              x: to.x + ((from.x - to.x) * stopWithin) / d,
              z: to.z + ((from.z - to.z) * stopWithin) / d,
            };
            if (await this.walkActor(actor, dest)) return;
          }
        }
        // (with no floor to walk on, walkToThenAct fails and the original acts where it stands)
        // (runQueuedActions takes it off the queue once the walk is over: unity.cpp:945-951)
        release();
        if (this.haltCount(actor) !== halts) return;
        walking = false;
        this.walkTasks--;
        await perform(this, { ...ctx, walked: true });
      } finally {
        release();
        if (walking) this.walkTasks--;
      }
    });
    return true;
  }

  /** Returns whether the walk was stopped before it got there. */
  private async walkActor(actor: string, to: Vec2): Promise<boolean> {
    const o = this.obj(actor);
    const walk = { stop: new StopSignal(), placed: false };
    // (one walk per actor)
    this.walks.get(actor)?.stop.stop();
    this.walks.set(actor, walk);
    try {
      const end = await this.presenter.walk(actor, { ...o.pos }, to, walk.stop);
      if (!walk.placed) o.pos = { ...end };
    } finally {
      if (this.walks.get(actor) === walk) this.walks.delete(actor);
    }
    this.bus.emit({ type: 'objectChanged', id: actor });
    if (walk.stop.stopped) return true;
    // (the walker arrived: ScummVM's updateWalking runs the action squares near it before the queued action, and
    // drops that action if they changed the screen)
    const screenChanges = this.screenChanges;
    for (const square of actionSquaresNear(this, actor)) {
      await perform(this, { verb: 'use', target: square, who: actor, other: null, walked: false });
      if (this.screenChanges !== screenChanges || this.state.pendingScreen) return true;
    }
    return false;
  }

  setTriggerEnabled(id: string, enabled: boolean): void {
    const t = this.state.triggers[id];
    if (!t) throw new Error(`unknown trigger: ${id}`);
    t.enabled = enabled;
    // enabling a timer starts it again
    if (enabled) t.due = 0;
  }

  applyScreenChange(): void {
    if (!this.state.pendingScreen) return;
    // (a screen change drops every queued walk)
    this.pendingWalks.clear();
    changeScreen(this);
  }

  /** The dev tools' jump: straight to a screen's entrance, as a screen change goes there. Only while nothing runs. */
  jump(screen: string, entrance: string): void {
    if (this.busy) throw new Error('cannot jump while an action is running');
    if (!Object.hasOwn(this.content.screens, screen)) throw new Error(`unknown screen: ${screen}`);
    // (throws for an unknown marker)
    this.marker(screen, entrance);
    this.state.pendingScreen = { to: screen, entrance };
    this.applyScreenChange();
  }

  /** Starts a new game: the first screen's timers and startup. Not for a world loaded from a save. */
  start(): void {
    // (a new game on the ship has no away screen to start)
    if (this.state.onShip !== null) return;
    this.state.onCloseup = this.state.startups[this.state.screen].closeup;
    startScreenTimers(this);
    applyStartup(this, false);
  }

  /**
   * One fixed step: time passes, then, if nothing else is running, triggers and timers may fire, both
   * in the same step and triggers first, as in the original's main loop.
   */
  tick(): void {
    this.clock.advance();
    // (back on the ship, the away mission's timers, triggers, advice and health stop)
    if (this.state.onShip !== null) {
      // (on the ship, the ship's triggers and journey run instead, until the game is over)
      if (!this.busy && this.state.onShip.gameOver === null) shipTick(this);
      return;
    }
    if (this.busy) return;
    checkTriggers(this, 'away');
    processTimers(this);
    if (this.busy) {
      // (the original runs the tick's actions first, applying any screen change they asked for as the
      // outermost one ends, so advice is decided behind them, on the new screen if they changed it, and
      // said before that screen's startup action, which waits for the next frame: unity.cpp:1770-1776, 1861)
      void this.enqueue(async () => {
        // (unless they took the team back to the ship)
        if (this.state.onShip !== null) return;
        await this.adviseThenHeal(updateAdvice(this));
      });
    } else {
      const member = updateAdvice(this);
      if (member === null) updateHealth(this);
      else void this.enqueue(() => this.adviseThenHeal(member));
    }
  }

  /**
   * The rest of the original's frame after the actions (unity.cpp:1772-1776): the advice line is said
   * there and then, the team's health updates after it, and a screen change the line's conversation asked
   * for waits for the next frame's start (unity.cpp:1751-1752).
   */
  private async adviseThenHeal(member: string | null): Promise<void> {
    if (member !== null) await giveAdvice(this, member);
    updateHealth(this);
    this.applyScreenChange();
  }

  save(): string {
    if (this.busy) throw new Error('cannot save while an action is running');
    // (no save during a battle: save.cpp:156-159)
    if (this.state.ship.combat !== null) throw new Error(COMBAT_SAVE_REFUSED);
    return serializeState(this.state);
  }
}
