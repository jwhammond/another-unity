// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  combatSim,
  contacts,
  HeadlessPresenter,
  normalizeSeed,
  STATION_CODE,
  type Station,
  type Clock,
  type GameContent,
  type MenuAt,
  type World,
} from '@another-unity/engine';
import { Play } from './play';

/** The longest `advance`, as ScummVM's runner allows (walkthrough.h kMaxAdvanceSeconds). */
export const MAX_ADVANCE_SECONDS = 3600;
/**
 * How `combat auto` can come out (Plan 23): auto-resolve's stoodDown (won, or nothing in range), left (by an exit code)
 * or ended (a script ended it), or lost (the Enterprise destroyed, whichever way it then left).
 */
export const AUTO_OUTCOMES = ['stoodDown', 'left', 'ended', 'lost'] as const;
export type AutoOutcome = (typeof AUTO_OUTCOMES)[number];

/** A line of a walkthrough file (docs/trace-format.md, "Walkthroughs"): its number, its text and its tokens. */
export interface WalkLine {
  line: number;
  text: string;
  args: string[];
  /** A `# gap:` comment came just before this line (R9: a `trigger` step needs one). */
  gap?: true;
}

/** The original ids a walkthrough names, mapped to slugs as ids.yaml does. */
export interface WalkIds {
  objects: Record<string, string>;
  screens: Record<string, string>;
}

export type WalkEvent =
  | { kind: 'step'; line: number; text: string; gap?: true }
  | { kind: 'seed'; seed: number }
  | { kind: 'refused'; who: string }
  /** How a `combat auto` battle came out, and the step it ended at (Plan 23). */
  | { kind: 'battle'; outcome: AutoOutcome; steps: number }
  | { kind: 'error'; what: string }
  | { kind: 'end' };

export interface WalkOptions {
  content: GameContent;
  ids: WalkIds;
  /** The seed until a `seed` line says otherwise (ScummVM's `trace <file> <seed>`). */
  seed?: number;
  /** The difficulty setting until a `difficulty` line says otherwise (R6); 1 by default. */
  difficulty?: number;
  /** How tactical fights (Plan 23 R2): the combat sim by default; 'dialog' for M4's dialog. */
  combat?: 'dialog' | 'real';
  /** Triggers (slugs) to turn off before the world starts, as ScummVM's harness does (Plan 6 Decision 3); `start` fails on one the game hasn't. */
  disableTriggers?: string[];
  presenter?: (clock: Clock) => WalkPresenter;
  /** Called with the new world before it starts. */
  onWorld?: (world: World) => void;
  onEvent?: (event: WalkEvent) => void;
  /** The file this text came from, so that an `include` resolves its path against the file's directory. */
  file?: string;
  /**
   * Whether a use, get or talk on another screen's object is refused while the team is away (Play.checkScreens). Off by
   * default: the Plan 9 walks act remotely, as ScummVM does. The whole-game route turns it on.
   */
  checkScreens?: boolean;
  /** Where a `checkpoint <name>` writes `<name>.json`; the CHECKPOINT_DIR environment variable by default. With neither, it does nothing. */
  checkpointDir?: string;
  /** The game's directory, which a `combat inputs <file>` path is from (Plan 31 R5). */
  gameDir?: string;
  /** Checked before each line once the game has started: true stops the walk there, unfinished and without an error (`WalkResult.stopped`: fly's). */
  stopBefore?: (play: Play, line: WalkLine) => boolean;
}

export interface WalkResult {
  play: Play | null;
  ended: boolean;
  error: string | null;
  /** The walk stopped where `stopBefore` said, before this line. */
  stopped?: WalkLine;
}

/**
 * Gives a battle's scripted orders (Plan 22's `at <step> <input>` lines) as `combat at <step> <input>` gives each: the
 * battle run to that step, then the order. Null once all are given, else why one couldn't be.
 */
export async function giveInputs(play: Play, inputs: readonly { step: number; command: combatSim.CombatCommand }[]): Promise<string | null> {
  for (const { step, command } of inputs) {
    const b = play.world.battle?.b;
    if (!b) return `the battle ended before step ${step}`;
    if (b.steps > step) return `the battle is already past step ${step} (at ${b.steps})`;
    if (!(await play.untilStep(step))) return `the battle ended before step ${step}`;
    play.order(command);
  }
  return null;
}

/** The headless presenter, failing a scripted pick past a menu's options as ScummVM's walkthrough does. */
export class WalkPresenter extends HeadlessPresenter {
  override async menu(options: string[], at?: MenuAt): Promise<number | null> {
    const picked = await super.menu(options, at);
    if (picked !== null && picked >= options.length) throw new Error(`scripted pick ${picked} is out of range for a menu of ${options.length}`);
    return picked;
  }
}

/** Whole-line '#' comments and blank lines are skipped; tokens are split on spaces and tabs (walkthrough.cpp). */
export function parseWalk(text: string): WalkLine[] {
  const lines: WalkLine[] = [];
  let gap = false;
  text.split('\n').forEach((raw, i) => {
    const t = raw.trim();
    if (t === '') return;
    if (t.startsWith('#')) {
      if (/^#\s*gap:/.test(t)) gap = true;
      return;
    }
    lines.push({ line: i + 1, text: t, args: t.split(/[ \t]+/), ...(gap ? { gap: true as const } : {}) });
    gap = false;
  });
  return lines;
}

/** Decimal, or hex after 0x; no sign, at most 32 bits (walkthrough.cpp parseUint). */
export function parseUint(text: string): number | null {
  const hex = /^0[xX][0-9a-fA-F]+$/.test(text);
  if (!hex && !/^[0-9]+$/.test(text)) return null;
  const value = hex ? parseInt(text.slice(2), 16) : parseInt(text, 10);
  return value > 0xffffffff ? null : value;
}

const hex2 = (n: number) => n.toString(16).padStart(2, '0');
const ACTIONS = new Set(['look', 'talk', 'walk', 'get', 'use', 'combadge']);

/** Plays a walkthrough through Play, reporting each step as ScummVM's runner logs it. */
export async function runWalkthrough(text: string, opts: WalkOptions): Promise<WalkResult> {
  const emit = (e: WalkEvent) => opts.onEvent?.(e);
  let play: Play | null = null;
  let seed = opts.seed;
  let difficulty = opts.difficulty;
  const answers: (0 | 1)[] = [];
  const picks: (number | null)[] = [];
  /** The line `stopBefore` stopped the walk at. */
  let stopped: WalkLine | null = null;

  async function start(a: string[]): Promise<string | null> {
    const [w, s, e] = [parseUint(a[0]), parseUint(a[1]), a.length === 3 ? parseUint(a[2]) : 0];
    if (w === null || s === null || e === null) return 'no such screen';
    const screen = opts.ids.screens[`s_${hex2(w)}${hex2(s)}`];
    if (screen === undefined || !opts.content.screens[screen]) return 'no such screen';
    if (play) return 'Play starts once: a second start would make a new game, where ScummVM keeps playing this one';
    // (the low four bits are the entrance, 0x40 and 0x80 flags; placeAwayTeam, awayteam.cpp:367-389)
    if (e > 0xff) return 'an entrance is a byte (at most 0xff)';
    if (e & 0xc0) return 'Play starts only on a plain entrance (no 0x40 gather or 0x80 step-in)';
    if (e > 0x0f) {
      return `Play starts only on entrances 0-15 (ScummVM would place the team at entrance ${e & 0x0f} and ignore 0x${(e & 0x30).toString(16)})`;
    }
    const entrance = `entrance_${e}`;
    if (!opts.content.screens[screen].markers[entrance]) return `${screen} has no ${entrance}`;
    const unknown = (opts.disableTriggers ?? []).find(id => !opts.content.triggers.some(t => t.id === id));
    if (unknown !== undefined) return `no trigger ${unknown} to turn off`;
    const content: GameContent = { ...opts.content, start: { ...opts.content.start, screen, entrance } };
    play = Play.from(content, seed, {
      difficulty,
      ...(opts.combat ? { combat: opts.combat } : {}),
      presenter: opts.presenter ?? (clock => new WalkPresenter(clock)),
      beforeStart: world => {
        for (const id of opts.disableTriggers ?? []) world.state.triggers[id].enabled = false;
        opts.onWorld?.(world);
      },
    });
    play.checkScreens = opts.checkScreens === true;
    for (const x of answers.splice(0)) play.answer(x);
    for (const x of picks.splice(0)) play.pick(x);
    // (the screen's startup action runs before the next step, as in ScummVM)
    await play.advance(0);
    return null;
  }

  /** `start ship`: a new game as the player starts it, on the bridge (R5). */
  function startShip(): string | null {
    if (play) return 'Play starts once: a second start would make a new game, where ScummVM keeps playing this one';
    if (!opts.content.ship) return 'this game has no ship to start on';
    const unknown = (opts.disableTriggers ?? []).find(id => !opts.content.triggers.some(t => t.id === id));
    if (unknown !== undefined) return `no trigger ${unknown} to turn off`;
    play = Play.newGame(opts.content, seed, {
      difficulty,
      ...(opts.combat ? { combat: opts.combat } : {}),
      presenter: opts.presenter ?? (clock => new WalkPresenter(clock)),
      beforeStart: world => {
        for (const id of opts.disableTriggers ?? []) world.state.triggers[id].enabled = false;
        opts.onWorld?.(world);
      },
    });
    play.checkScreens = opts.checkScreens === true;
    for (const x of answers.splice(0)) play.answer(x);
    for (const x of picks.splice(0)) play.pick(x);
    return null;
  }

  async function step(l: WalkLine, file: string | undefined): Promise<string | null> {
    const [verb, ...a] = l.args;
    if (verb === 'seed' && a.length === 1 && parseUint(a[0]) !== null) {
      seed = normalizeSeed(parseUint(a[0])!);
      if (play) play.world.state.rngSeed = seed;
      emit({ kind: 'seed', seed });
      return null;
    }
    // `difficulty <0-2>`: the setting (R6); once playing, only while no team is away (metaengine.cpp:84-86)
    if (verb === 'difficulty' && a.length === 1) {
      const n = parseUint(a[0]);
      if (n === null || n > 2) return 'a difficulty is 0, 1 or 2';
      if (play) {
        if (play.state.onShip === null && play.world.content.ship !== undefined) return 'the difficulty can only be changed while no team is away';
        play.world.difficulty = n as 0 | 1 | 2;
      }
      difficulty = n;
      return null;
    }
    // `repair all`: at engineering, every damaged unit's repairs given in full, as a player does after a battle (Plan 23)
    if (verb === 'repair' && a.length === 1 && a[0] === 'all') {
      if (!play) return "the game hasn't started";
      try {
        play.repairAll();
      } catch (e) {
        return (e as Error).message;
      }
      return null;
    }
    // `assists <difficulty> [<speed>]`: the player's combat assists (spec §5): the combat difficulty (game, ensign,
    // lieutenant, captain or story) and the fast-forward; a setting, which a battle takes as it starts
    if (verb === 'assists' && (a.length === 1 || a.length === 2)) {
      if (!play) return "the game hasn't started";
      const speed = a.length === 2 ? parseUint(a[1]) : 1;
      const assists = combatSim.readAssists({ difficulty: a[0], speed });
      if (assists.difficulty !== a[0] || assists.speed !== speed) return 'assists are a combat difficulty (game, ensign, lieutenant, captain or story) and a speed (1, 2, 4 or 8)';
      play.world.assists = assists;
      return null;
    }
    // `include <file>`: another walk's steps, after its `seed` and `start` lines, on the screen it starts on (a path from this file)
    if (verb === 'include' && a.length === 1) {
      if (!play) return "the game hasn't started";
      let text: string;
      const path = file === undefined ? resolve(a[0]) : resolve(dirname(file), a[0]);
      try {
        text = readFileSync(path, 'utf8');
      } catch {
        return `include ${a[0]}: no such file`;
      }
      const lines = parseWalk(text);
      let first = 0;
      let startScreen: string | null = null;
      for (; first < lines.length && (lines[first].args[0] === 'seed' || lines[first].args[0] === 'start'); first++) {
        const [v, ...b] = lines[first].args;
        if (v !== 'start') continue;
        if (b[0] === 'ship') startScreen = 'ship';
        else startScreen = opts.ids.screens[`s_${hex2(parseUint(b[0]) ?? 0)}${hex2(parseUint(b[1]) ?? 0)}`] ?? null;
      }
      if (startScreen !== null) {
        const now = play.state.onShip !== null ? 'ship' : play.state.screen;
        if (startScreen !== now) return `include ${a[0]}: starts on ${startScreen}, the game is on ${now}`;
      }
      const result = await runLines(lines.slice(first), path, a[0]);
      return result.error;
    }
    // `checkpoint <name>`: the world as a save file in the save menu's Import format, when there is a directory for it
    if (verb === 'checkpoint' && a.length === 1) {
      if (!play) return "the game hasn't started";
      if (!/^[A-Za-z0-9_-]+$/.test(a[0])) return 'a checkpoint name is letters, digits, - and _';
      const dir = opts.checkpointDir ?? process.env.CHECKPOINT_DIR;
      if (dir !== undefined && dir !== '') {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${a[0]}.json`), play.world.save());
      }
      return null;
    }
    // `trigger <id> on|off`: the dev shortcut for a gap in the route (R9), only after a `# gap:` comment
    if (verb === 'trigger' && a.length === 2) {
      if (l.gap !== true) return 'trigger without a gap comment';
      if (!play) return "the game hasn't started";
      const n = parseUint(a[0]);
      if (n === null || (a[1] !== 'on' && a[1] !== 'off')) return 'a trigger step is an id, then on or off';
      const t = play.world.state.triggers[`t${n}`];
      if (!t) return 'no such trigger';
      t.enabled = a[1] === 'on';
      return null;
    }
    if (verb === 'start' && a.length === 1 && a[0] === 'ship') return startShip();
    if (verb === 'start' && (a.length === 2 || a.length === 3)) return start(a);
    if (verb === 'station' && a.length === 1) {
      if (!play) return "the game hasn't started";
      if (play.state.onShip === null) return "the team is away: there's no ship to go to a station of";
      if (!Object.hasOwn(STATION_CODE, a[0]) || a[0] === 'viewscreen') return `no such station: ${a[0]}`;
      await play.station(a[0] as Station);
      return null;
    }
    // `computer <row>`: a click on the nth row of the open computer screen (`station computer` opens it)
    if (verb === 'computer' && a.length === 1) {
      if (!play) return "the game hasn't started";
      const row = parseUint(a[0]);
      if (row === null) return 'a computer row is a number';
      if (play.state.onShip === null || play.world.computer === null) return 'the computer is not open';
      play.computer(row);
      return null;
    }
    // `comms <object>` and `lounge <object>`: a pick from the bridge's list (an object on it, or none to see it empty)
    if ((verb === 'comms' || verb === 'lounge') && a.length <= 1) {
      if (!play) return "the game hasn't started";
      if (play.state.onShip === null || play.state.ship.station !== 'bridge') return 'not at the bridge';
      const object = a.length === 0 ? null : opts.ids.objects[a[0]];
      if (object === undefined) return 'no such object';
      const listed = contacts(play.world, verb);
      if (object !== null && !listed.includes(object)) return `${a[0]} is not on the ${verb} list`;
      if (object === null && listed.length > 0) return `the ${verb} list is not empty`;
      await (verb === 'comms' ? play.comms(object) : play.lounge(object));
      return null;
    }
    // `combat win|flee|lose|answer`: the M4 dialog's outcome (a test shortcut beside the combat sim: Plan 23 R2), or
    // answering a waiting hail; `combat auto`: auto-resolved, Delegate on, to its end (the route's battles); `combat at
    // <step> <input>`: the battle run to that step, then the order; `combat <input>`: the order (Plan 22's input lines);
    // `combat inputs <file>`: an inputs file's orders, each at its step (Plan 31)
    if (verb === 'combat' && a.length >= 1) {
      if (!play) return "the game hasn't started";
      const p: Play = play;
      // `combat wait`: the game runs until a battle is on (with the combat sim, it fights from its first frame, so a walk
      // gives its orders as it starts rather than after an `advance`)
      if (a.length === 1 && a[0] === 'wait') {
        try {
          await p.untilCombat(MAX_ADVANCE_SECONDS);
        } catch (e) {
          return (e as Error).message;
        }
        return null;
      }
      if (p.state.onShip === null || p.state.ship.combat === null) return 'not in combat';
      // `combat inputs <file>`: an inputs file's orders (a path from the game's directory), each at its step (Plan 31 R5)
      if (a[0] === 'inputs') {
        if (a.length !== 2) return 'combat inputs is a file of input lines';
        if (opts.gameDir === undefined) return "combat inputs needs the game's directory";
        let text: string;
        try {
          text = readFileSync(resolve(opts.gameDir, a[1]), 'utf8');
        } catch {
          return `${a[1]}: no such file`;
        }
        const { inputs, errors } = combatSim.parseInputScript(text);
        if (errors.length > 0) return errors.map(e => `${a[1]}: ${e}`).join('; ');
        if (!p.world.battle) return 'not in a battle the combat sim fights';
        try {
          return await giveInputs(p, inputs);
        } catch (e) {
          return (e as Error).message;
        }
      }
      if (a.length === 1 && ['win', 'flee', 'lose', 'answer'].includes(a[0])) {
        await p.combat(a[0] as 'win' | 'flee' | 'lose' | 'answer');
        return null;
      }
      // `combat auto [expect <outcome>]`: the battle must stand down (won, or nothing left in range), unless the walk
      // expects it to leave, end by a script, or be lost (Plan 23 Task 11's review: a loss fails the walk)
      const auto = a[0] === 'auto' && (a.length === 1 || (a.length === 3 && a[1] === 'expect'));
      if (auto && a.length === 3 && !(AUTO_OUTCOMES as readonly string[]).includes(a[2])) return `combat auto expects ${AUTO_OUTCOMES.join(', ')}`;
      // (the input line is the walk line's own text after the verb, or after `at <step>`, not its tokens joined again: the
      // input lines' grammar refuses doubled spaces and tabs, Plan 22)
      const rest = l.text.startsWith('combat ') ? l.text.slice('combat '.length) : null;
      const held = a[0] === 'at' && rest !== null ? /^at ([^ \t]+) ([\s\S]*)$/.exec(rest) : null;
      const at = held ? parseUint(held[1]) : null;
      if (a[0] === 'at' && at === null) return 'combat at is a step and an input line';
      const read = auto ? null : combatSim.parseInputLine(held ? held[2] : rest ?? '');
      if (read && 'error' in read) return 'combat is win, flee, lose, answer, auto, an input line, or at <step> and one';
      if (!p.world.battle) return 'not in a battle the combat sim fights';
      try {
        if (read === null) {
          const result = await p.autoBattle();
          // (endCombat keeps the battle as the last one: the Enterprise's fate is there whichever way it ended)
          const lost = p.world.combatMemory.previous?.ships[0]?.destroyed === true;
          const outcome: AutoOutcome = lost ? 'lost' : (result.outcome as Exclude<AutoOutcome, 'lost'>);
          emit({ kind: 'battle', outcome, steps: result.steps });
          const expected = a.length === 3 ? a[2] : 'stoodDown';
          if (outcome !== expected) return `the battle came out ${outcome} at step ${result.steps}, where the walk expects ${expected}`;
        } else {
          if (at !== null) return await giveInputs(p, [{ step: at, command: read.command }]);
          p.order(read.command);
        }
      } catch (e) {
        return (e as Error).message;
      }
      return null;
    }
    // `beam [<crew>...]`: the transporter room's recommended team and kit, or exactly these crew
    if (verb === 'beam') {
      if (!play) return "the game hasn't started";
      if (play.state.onShip === null) return "the team is away: there's no transporter to beam from";
      const crew = a.map(x => opts.ids.objects[x]);
      if (crew.some(x => x === undefined)) return 'no such object';
      try {
        await play.beam(a.length === 0 ? undefined : (crew as string[]));
      } catch (e) {
        return (e as Error).message;
      }
      return null;
    }
    // `plot <sector> <star> [planet]` at astrogation, then `engage <warp|impulse> <speed>`
    if (verb === 'plot' && (a.length === 2 || a.length === 3)) {
      if (!play) return "the game hasn't started";
      const n = a.map(parseUint);
      if (n.some(x => x === null)) return 'a plot is a sector, a star and optionally a planet, as numbers';
      if (play.state.onShip === null || play.state.ship.station !== 'astrogation') return 'not at astrogation';
      try {
        play.plot({ sector: n[0]!, star: n[1]!, ...(n[2] === undefined ? {} : { planet: n[2]! }) });
      } catch (e) {
        return (e as Error).message;
      }
      return null;
    }
    if (verb === 'engage' && a.length === 2) {
      if (!play) return "the game hasn't started";
      const speed = parseUint(a[1]);
      if ((a[0] !== 'warp' && a[0] !== 'impulse') || speed === null) return 'an engage is warp or impulse, then a speed';
      if (play.state.onShip === null || play.state.ship.station !== 'astrogation') return 'not at astrogation';
      try {
        const refused = await play.engage(a[0] === 'warp', speed);
        return refused === null ? null : `the course was refused: ${refused}`;
      } catch (e) {
        return (e as Error).message;
      }
    }
    // (one argument, on the ship: the current member talks to a crew object on the bridge)
    if (verb === 'talk' && a.length === 1) {
      if (!play) return "the game hasn't started";
      if (play.state.onShip === null) return "the team is away: a talk names who and whom";
      const slug = opts.ids.objects[a[0]];
      if (slug === undefined) return 'no such object';
      await play.talk(slug);
      return null;
    }
    if (verb === 'answer' && a.length === 1) {
      const n = parseUint(a[0]);
      if (n === null || n > 1) return 'an answer is 0 or 1';
      if (play) play.answer(n as 0 | 1);
      else answers.push(n as 0 | 1);
      return null;
    }
    if (verb === 'pick' && a.length === 1) {
      const n = a[0] === 'cancel' ? null : parseUint(a[0]);
      if (a[0] !== 'cancel' && (n === null || n > 0x7fffffff)) return "a pick is a number or 'cancel'";
      if (play) play.pick(n);
      else picks.push(n);
      return null;
    }
    if (verb === 'advance' && a.length === 1 && parseUint(a[0]) !== null) {
      const n = parseUint(a[0])!;
      if (n > MAX_ADVANCE_SECONDS) return `an advance is at most ${MAX_ADVANCE_SECONDS} seconds`;
      if (!play) return "the away team isn't beamed down";
      await play.advance(n);
      return null;
    }
    if (verb === 'phaser' && a.length === 1) {
      const n = parseUint(a[0]);
      if (n === null || n > 3) return 'a phaser setting is 0-3';
      if (!play) return "the away team isn't beamed down";
      // (Play can't set a phaser the team doesn't carry, and says so; ScummVM sets its gauge anyway)
      play.setPhaser(n);
      return null;
    }

    // a use, get or talk after a `# gap:` comment opts out of Play's reachable-target check (R9: counted, and each has a ruling).
    // (A plain action line, so ScummVM's runner reads the same file.)
    const force = l.gap === true;
    const combadge = verb === 'combadge';
    if (!ACTIONS.has(verb) || a.length < (combadge ? 1 : 2) || a.length > (combadge ? 1 : verb === 'use' ? 3 : 2)) return 'unknown step';
    const slugs = a.map(id => opts.ids.objects[id]);
    if (slugs.some(slug => slug === undefined)) return 'no such object';
    if (!play) return "the away team isn't beamed down";
    const world = play.world;
    const [who, target, other] = slugs as string[];
    if (!world.state.awayTeam.includes(who)) return 'not on the away team';
    // as a click does: nobody who is down can act, and a new command replaces the last
    if (world.isIncapacitated(who)) {
      emit({ kind: 'refused', who });
      return null;
    }
    world.selectMember(who);
    world.cancelQueuedActions(who);
    if (combadge) await play.combadge();
    else if (verb === 'look') await play.look(who, target);
    else if (verb === 'talk') await play.talk(who, target, { force });
    else if (verb === 'walk') await play.walk(who, target);
    else if (verb === 'get') await play.get(who, target, { force });
    else await play.use(who, target, other, { force });
    return null;
  }

  const fail = (what: string): WalkResult => {
    emit({ kind: 'error', what });
    return { play, ended: false, error: what };
  };
  /** Runs lines until one fails or an `end`; an included file's `end` ends only that file. */
  async function runLines(lines: WalkLine[], file: string | undefined, label: string | null): Promise<{ ended: boolean; error: string | null }> {
    for (const l of lines) {
      if (stopped === null && play !== null && opts.stopBefore?.(play, l)) stopped = l;
      if (stopped !== null) return { ended: false, error: null };
      emit({ kind: 'step', line: l.line, text: l.text, ...(l.gap ? { gap: true as const } : {}) });
      if (l.args[0] === 'end' && l.args.length === 1) return { ended: true, error: null };
      let why: string | null;
      try {
        why = await step(l, file);
      } catch (err) {
        why = err instanceof Error ? err.message : String(err);
      }
      if (why !== null) return { ended: false, error: `${label === null ? '' : `${label} `}line ${l.line} (${l.text}): ${why}` };
    }
    return { ended: false, error: null };
  }
  const run = await runLines(parseWalk(text), opts.file, null);
  if (run.error !== null) return fail(run.error);
  if (stopped !== null) return { play, ended: false, error: null, stopped };
  if (!run.ended) return fail("the walkthrough has no 'end'");
  emit({ kind: 'end' });
  return { play, ended: true, error: null };
}
