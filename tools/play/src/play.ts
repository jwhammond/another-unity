// SPDX-License-Identifier: GPL-3.0-or-later
import {
  addToPad,
  advance,
  canEnergize,
  chooseRecommended,
  energize,
  removeFromPad,
  transporterRoom,
  callShip,
  clickRow,
  contacts,
  hailObject,
  answerHail,
  autoResolve,
  battleCommand,
  combatSim,
  finishResolved,
  resolveCombat,
  type BattleResult,
  loungeTalk,
  COMBADGE_QUESTION,
  createInitialState,
  engage,
  previewCourse,
  HeadlessPresenter,
  gotoShipScreen,
  parseGame,
  perform,
  STATION_CODE,
  setPhaserSetting,
  setSlider,
  SLIDER_WIDTH,
  UNIT_FUSION,
  UNIT_MATTER_ANTIMATTER,
  UNIT_POWER_GRID,
  UNIT_TORPEDO,
  TICKS_PER_SECOND,
  settle,
  World,
  type Clock,
  type Course,
  type CourseError,
  type GameContent,
  type ObjectState,
  type Station,
  type Verb,
  type WorldState,
} from '@another-unity/engine';
import { readGameDir } from './readGameDir';

/** What clicking the communicator asks first (awayteam.cpp:830); the engine's, so the browser asks the same. */
export { COMBADGE_QUESTION };

export interface PlayOptions {
  /** The presenter: a HeadlessPresenter, or one that extends it. */
  presenter?: (clock: Clock) => HeadlessPresenter;
  /** Called with the new world before it starts (hooks, subscriptions, the harness's preamble). */
  beforeStart?: (world: World) => void;
  /** The difficulty setting, 0-2 (R6); 1 by default. */
  difficulty?: number;
  /** How tactical fights (Plan 23 R2): the combat sim by default, headless; 'dialog' for M4's dialog. */
  combat?: 'dialog' | 'real';
}

/** `force`: opts out of the reachable-target check (a use, get or talk after a `# gap:` comment in a walk; counted, R9). */
export interface ReachOptions {
  force?: boolean;
}

/** Drives a world through a scripted playthrough, with no browser. */
export class Play {
  private constructor(readonly world: World, private readonly presenter: HeadlessPresenter) {}

  static async load(dir: string, seed?: number, opts?: PlayOptions): Promise<Play> {
    return Play.from(parseGame(await readGameDir(dir)), seed, opts);
  }

  static from(content: GameContent, seed?: number, opts: PlayOptions = {}): Play {
    const make = opts.presenter ?? ((clock: Clock) => new HeadlessPresenter(clock));
    const world = new World(content, createInitialState(content, seed), w => make(w.clock), { difficulty: opts.difficulty, combat: opts.combat ?? 'real' });
    opts.beforeStart?.(world);
    world.start();
    return new Play(world, world.presenter as HeadlessPresenter);
  }

  /** A new game as the player starts it: on the ship's bridge when the game has a ship, else at its start. */
  static newGame(content: GameContent, seed?: number, opts: PlayOptions = {}): Play {
    const make = opts.presenter ?? ((clock: Clock) => new HeadlessPresenter(clock));
    const world = new World(content, createInitialState(content, seed, { onShip: content.ship !== undefined }), w => make(w.clock), { difficulty: opts.difficulty, combat: opts.combat ?? 'real' });
    opts.beforeStart?.(world);
    world.start();
    return new Play(world, world.presenter as HeadlessPresenter);
  }

  static fromSave(content: GameContent, text: string, opts: Pick<PlayOptions, 'difficulty' | 'combat'> = {}): Play {
    const world = World.fromSave(content, text, w => new HeadlessPresenter(w.clock), { difficulty: opts.difficulty, combat: opts.combat ?? 'real' });
    return new Play(world, world.presenter as HeadlessPresenter);
  }

  get state(): WorldState {
    return this.world.state;
  }

  get log(): string[] {
    return this.presenter.log;
  }

  obj(id: string): ObjectState {
    return this.world.obj(id);
  }

  /** Queues the answer to the next question. */
  answer(choice: 0 | 1): this {
    this.presenter.answer(choice);
    return this;
  }

  use(who: string, target: string, withObj?: string, reach?: ReachOptions): Promise<void> {
    return this.run('use', { who, target, other: withObj ?? null }, reach);
  }

  get(who: string, target: string, reach?: ReachOptions): Promise<void> {
    return this.run('get', { who, target }, reach);
  }

  look(who: string, target: string): Promise<void> {
    return this.run('look', { who, target });
  }

  walk(who: string, target: string): Promise<void> {
    return this.run('walk', { who, target });
  }

  /** Talks as `who` to `target`; with one argument, the captain talks to a crew object on the ship's bridge. */
  talk(object: string): Promise<void>;
  talk(who: string, target: string, reach?: ReachOptions): Promise<void>;
  talk(who: string, target?: string, reach?: ReachOptions): Promise<void> {
    if (target === undefined) return this.shipTalk(who);
    return this.run('talk', { who, target }, reach);
  }

  /** The bridge's crew talk (BridgeScreen::clickItem, bridge.cpp:446-448): performAction TALK as the captain, at any screen (R6). */
  private async shipTalk(object: string): Promise<void> {
    const w = this.world;
    void w.enqueue(async () => {
      await perform(w, { verb: 'talk', target: object, who: w.content.start.leader, other: null, walked: false });
    });
    await settle(w);
    this.rethrow();
  }

  /** Goes to a ship station (the turbolift, astrogation or the transporter's button). */
  async station(name: Station): Promise<void> {
    const w = this.world;
    void w.enqueue(() => gotoShipScreen(w, STATION_CODE[name]));
    await settle(w);
    this.rethrow();
  }

  /** Clicks a row of the open computer screen (ComputerScreen::clickRow); `station('computer')` opens it. */
  computer(row: number): void {
    const view = this.world.computer;
    if (view === null) throw new Error('the computer is not open');
    clickRow(this.world, view, row);
  }

  /** The bridge's Comms (BridgeScreen kActionComms): hails a contact, or with null says nobody answers. */
  async comms(object: string | null): Promise<void> {
    const w = this.world;
    void w.enqueue(() => hailObject(w, object));
    await settle(w);
    this.rethrow();
  }

  /** The bridge's lounge (kActionLounge): Picard talks to a contact, or with null the room is said to be empty. */
  async lounge(object: string | null): Promise<void> {
    const w = this.world;
    void w.enqueue(() => loungeTalk(w, object));
    await settle(w);
    this.rethrow();
  }

  /**
   * Auto-resolve (spec §5): Delegate on, the battle run to its end, then gone on from, as the route fights its battles
   * (Plan 23). Throws if it is still undecided at the cap.
   */
  async autoBattle(): Promise<BattleResult> {
    const w = this.world;
    if (!w.battle) throw new Error('there is no battle to resolve');
    const resolving = autoResolve(w);
    // (its scripts' lines and conversations wait on the clock, which only settle runs)
    await settle(w);
    const result = await resolving;
    this.rethrow();
    if (result.outcome === 'undecided') throw new Error(`the battle is still undecided after ${result.steps} steps`);
    const finishing = finishResolved(w);
    await settle(w);
    await finishing;
    this.rethrow();
    return result;
  }

  /** An order for the battle (spec §6's walkthrough verbs, in Plan 22's input lines), given before the next frame. */
  order(cmd: combatSim.CombatCommand): void {
    if (!this.world.battle) throw new Error('not in a battle the combat sim fights');
    battleCommand(this.world, cmd);
  }

  /**
   * At engineering, as a player sets the ship right after a battle (EngineeringScreen::setSlider, engineering.cpp:228-250):
   * every damaged unit's repair slider pulled all the way, so it mends a point a second while the grid has power
   * (ship.cpp:155-166), and every unit whose power a hit took (a hit's target 0, damage.cpp:246) given its full power
   * again; a reactor's only once it is whole. The torpedo tubes' loads and the grid are left as they are.
   */
  repairAll(): void {
    const c = this.world.content.ship;
    if (!c || this.state.onShip === null || this.state.ship.station !== 'engineering') throw new Error('not at engineering');
    const systems = this.state.ship.systems;
    systems.units.forEach((u, i) => {
      const type = c.data.units[i]?.type;
      if (u.damage) setSlider(c, systems, i, 'repair', SLIDER_WIDTH);
      if (type === UNIT_TORPEDO || type === UNIT_POWER_GRID || u.target >= u.max) return;
      setSlider(c, systems, i, type === UNIT_FUSION || type === UNIT_MATTER_ANTIMATTER ? 'reactor' : 'power', SLIDER_WIDTH);
    });
  }

  /** Lets the game run, a world tick at a time, until a battle is on (at most `seconds`); a battle already on is at once. */
  async untilCombat(seconds: number): Promise<void> {
    const w = this.world;
    for (let i = 0; i <= seconds * TICKS_PER_SECOND; i++) {
      if (w.state.onShip !== null && w.state.ship.combat !== null) return;
      w.tick();
      await settle(w);
      this.rethrow();
    }
    throw new Error(`no battle began within ${seconds} seconds`);
  }

  /**
   * Lets the battle run, a world tick at a time, until it has taken exactly `step` steps (held there at any speed:
   * WorldBattle.holdAt), so an order given next applies before step `step` + 1; false if it ended first, or had already
   * gone past.
   */
  async untilStep(step: number): Promise<boolean> {
    const w = this.world;
    const run = w.battle;
    if (!run) return false;
    run.holdAt = step;
    try {
      // (at most the steps' worth of ticks, and a margin: 66 ms a step, 1000/60 ms a tick)
      for (let i = 0; i < step * 5 + 600; i++) {
        const b = w.battle?.b;
        if (!b) return false;
        if (b.steps > step) return false;
        if (b.steps === step) return true;
        w.tick();
        await settle(w);
        this.rethrow();
      }
    } finally {
      delete run.holdAt;
    }
    throw new Error(`the battle didn't reach step ${step}`);
  }

  /** The placeholder combat dialog (R3): win, flee or lose the battle at tactical, or answer a waiting hail. */
  async combat(how: 'win' | 'flee' | 'lose' | 'answer'): Promise<void> {
    const w = this.world;
    void w.enqueue(() => (how === 'answer' ? answerHail(w) : resolveCombat(w, how)));
    await settle(w);
    this.rethrow();
  }

  /**
   * Beams down from the transporter room: with no ids, the recommended team and kit; with ids, exactly those crew
   * (the kit stays the recommended one the room opened with).
   */
  async beam(ids?: string[]): Promise<void> {
    const w = this.world;
    const room = transporterRoom(w);
    if (room === null) throw new Error('not at the transporter room');
    if (room.target === null) throw new Error('no transporter target');
    if (ids === undefined) chooseRecommended(w, room);
    else {
      for (let i = 0; i < room.pads.length; i++) removeFromPad(w, room, i);
      for (const id of ids) {
        if (!room.crew.includes(id)) throw new Error(`${id} cannot go on a pad`);
        addToPad(w, room, id);
      }
    }
    if (!canEnergize(room)) throw new Error('nobody is on the pads');
    void w.enqueue(async () => { energize(w, room); });
    await settle(w);
    this.rethrow();
  }

  /** Also refuse a use, get or talk on another screen's object while the team is away (off by default: see `unreachable`). */
  checkScreens = false;
  private transitions: Set<string> | null = null;
  private plotted: Course | null = null;

  /** Plots a course at astrogation (the screen's cursor): throws unless the station is astrogation or the course is refused. */
  plot(course: Omit<Course, 'warp' | 'speed'> & Partial<Pick<Course, 'warp' | 'speed'>>): void {
    if (this.world.state.onShip === null || this.world.state.ship.station !== 'astrogation') throw new Error('not at astrogation');
    const full: Course = { warp: true, speed: 0, ...course };
    const preview = previewCourse(this.world, full);
    if (typeof preview === 'string') throw new Error(`cannot plot that course: ${preview}`);
    this.plotted = full;
  }

  /** Engages the plotted course at a warp factor * 100 or an impulse step (AstrogationScreen::engage). Returns why it was refused. */
  async engage(warp: boolean, speed: number): Promise<CourseError | null> {
    const w = this.world;
    if (!this.plotted) throw new Error('no course is plotted');
    const course = { ...this.plotted, warp, speed };
    let result: CourseError | null = null;
    void w.enqueue(async () => { result = engage(w, course); });
    await settle(w);
    this.rethrow();
    return result;
  }

  /** Queues the answer to the next conversation menu (null backs out). */
  pick(index: number | null): this {
    this.presenter.pick(index);
    return this;
  }

  /** 0 off, 1 low, 2 medium, 3 high. */
  setPhaser(setting: number): this {
    if (!setPhaserSetting(this.world, setting)) throw new Error('there is no phaser in the inventory');
    return this;
  }

  /**
   * A click on the combadge (awayteam.cpp:824-831): nothing while it is off; otherwise the question,
   * answered from the queue (answer), and on Hail the call to the ship as the current member.
   */
  async combadge(): Promise<void> {
    if (!this.world.state.awayFlags.combadge) return;
    if ((await this.world.presenter.choose(COMBADGE_QUESTION, ['Hail', 'Ignore'])) === 0) callShip(this.world);
    await settle(this.world);
    this.rethrow();
  }

  async advance(seconds: number): Promise<void> {
    await advance(this.world, seconds);
    this.rethrow();
  }

  /**
   * Why a player could not click `target` (null when they could). A player picks an object that is active (or held)
   * and on the current screen (objectAt, unity.cpp:1425-1431). The rule is narrower than objectAt on purpose:
   * ScummVM runs some actions remotely on other screens' objects (Plan 9: a walk may talk to someone on another
   * screen), so a target is always refused when it is inactive, and when the team is away and it is on another screen
   * only if `checkScreens` is set (the whole-game route sets it; the Plan 9 walks don't). An inventory item, an action
   * square (a walk onto it) and a transition object (the click on the object that names it) are always reachable.
   */
  unreachable(target: string): string | null {
    const o = this.world.state.objects[target];
    if (!o || o.inventory) return null;
    // an action square is walked onto, and a transition object is reached by clicking the object that names it
    const def = this.world.content.objects[target];
    if (def?.actionSquare !== undefined) return null;
    if (this.transitions === null) {
      this.transitions = new Set(Object.values(this.world.content.objects).flatMap(x => (x.transition === undefined ? [] : [x.transition])));
    }
    if (this.transitions.has(target)) return null;
    if (!o.active) return `${target} is inactive: nobody can click it`;
    if (this.checkScreens && this.world.state.onShip === null && o.screen !== null && o.screen !== this.world.state.screen) {
      return `${target} is on ${o.screen}, not on the current screen`;
    }
    return null;
  }

  private async run(verb: Verb, opts: { who: string; target: string; other?: string | null }, reach?: ReachOptions): Promise<void> {
    if (reach?.force !== true && (verb === 'use' || verb === 'get' || verb === 'talk')) {
      const why = this.unreachable(opts.target);
      if (why !== null) throw new Error(`${why} (a walk opts out after a gap comment)`);
    }
    void this.world.act(verb, opts);
    await settle(this.world);
    this.rethrow();
  }

  /** Throws what went wrong in the last step: the error itself if there was one, or all of them together. */
  private rethrow(): void {
    const errors = this.world.errors.splice(0);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, `${errors.length} errors`);
  }
}
