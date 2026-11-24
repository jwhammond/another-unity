// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { TACTIC, TOKEN } from '../../content/tactics';
import { miniBattle, miniBattleContext, tacticScript } from '../../testing/combat';
import { assembleTactics, type TacticItem } from '../../testing/tactics';
import { engage, rebuildManeuvers } from './maneuvers';
import { newRandom } from './random';
import { runScript, scriptStep, TACTICS_SEAMS } from './tactics';
import type { BattleContext } from './types';

const page = (name: string, code: string): TacticItem => ({ cls: TOKEN.page, opcode: 0x1f, page: name, args: [{ label: code }] });
const when = (opcode: number, args: (number | { float: number })[] = []): TacticItem => ({ cls: TOKEN.when, opcode, args });
const doIt = (opcode: number, args: (number | { label: string })[] = [], text?: string): TacticItem =>
  text === undefined ? { cls: TOKEN.do, opcode, args } : { cls: TOKEN.do, opcode, args, text };
const branch = (opcode: number, args: (number | { label: string })[], text?: string): TacticItem =>
  text === undefined ? { cls: TOKEN.branch, opcode, args } : { cls: TOKEN.branch, opcode, args, text };
const label = (name: string): TacticItem => ({ label: name });
/** WHEN SPEED >= 0 holds for a ship at rest; WHEN SPEED > 0 doesn't. */
const ALWAYS = when(TACTIC.speed, [0, 0, 2]);
const NEVER = when(TACTIC.speed, [0, 0, 1]);

/** miniCombat's battle with `items` as the script of the Enterprise (`ship` 0) or the chodak (1). */
function vm(items: TacticItem[], ship: 0 | 1 = 1) {
  const { bin, labels } = assembleTactics([page('MAIN', 'code'), label('code'), ...items]);
  const warnings: string[] = [];
  const sites: string[] = [];
  const ctx: BattleContext = {
    ...miniBattleContext({ engage }), onWarning: m => { warnings.push(m); }, onDraw: (site, n, value) => { sites.push(`${site} ${n} ${value}`); },
  };
  const { b } = miniBattle({ ctx });
  const s = tacticScript(bin);
  b.ships[ship]!.script = s;
  b.cues.length = 0;
  const L = labels as Record<string, number>;
  return { ctx, b, ship: b.ships[ship]!, s, L, warnings, sites, run: () => runScript(ctx, b, b.ships[ship]!) };
}

describe('Combat::runScript and scriptStep (tactics.cpp:185-295)', () => {
  it('runs a token a step: a WHEN joins the queue, its DO runs if it holds, and it is skipped if not', () => {
    const { s, ship, L, run } = vm([
      label('never'), NEVER, doIt(TACTIC.message, [], 'no'),
      label('always'), ALWAYS, doIt(TACTIC.message, [], 'yes'),
      label('after'), doIt(TACTIC.debug, [1]),
    ]);
    run();
    expect([s.pc, s.queues[0], ship.log]).toEqual([L.always, [L.never], []]);
    run();
    expect([s.pc, s.queues[0], ship.log]).toEqual([L.after, [L.always, L.never], ['yes']]);
    run();
    expect(s.trace).toBe(1);
  });

  it('at a page\'s end tests the queue instead, newest first, running each that holds, until the queue is empty', () => {
    const { s, ship, L, run } = vm([
      label('w1'), ALWAYS, doIt(TACTIC.message, [], 'one'),
      label('w2'), ALWAYS, doIt(TACTIC.message, [], 'two'),
      page('THEN', 'onward'), label('onward'), doIt(TACTIC.message, [], 'onward'),
    ]);
    run();
    run();
    run();
    // (the page's end: the PC is past it, and the script tests its queue)
    expect([s.pc, s.buffer, ship.log]).toEqual([L.onward, false, ['one', 'two']]);
    run();
    expect([s.pc, s.buffer, ship.log]).toEqual([L.onward, false, ['one', 'two', 'two', 'one']]);
    s.queues[0] = [];
    run();
    // (an empty queue: back to the code, where it left off)
    expect([s.buffer, ship.log.at(-1)]).toEqual([true, 'onward']);
  });

  it('runs the Enterprise\'s setup all at once, until ENGAGE 3 makes the kernel ready, and at most 100000 tokens', () => {
    const setup = vm([doIt(TACTIC.engage, [2]), doIt(TACTIC.message, [], 'menu'), doIt(TACTIC.engage, [3]), label('after'), doIt(TACTIC.message, [], 'later')], 0);
    setup.run();
    expect([setup.s.pc, setup.ship.log, setup.b.console.kernelReady, setup.b.console.scriptLock]).toEqual([setup.L.after, ['menu'], true, false]);
    setup.run();
    expect(setup.ship.log).toEqual(['menu', 'later']);
    // (a RETURN with nowhere to go runs again and again: the guard stops it)
    const stuck = vm([doIt(TACTIC.return)], 0);
    stuck.run();
    expect([stuck.s.pc, stuck.b.console.scriptLock]).toEqual([0x6b, true]);
  });

  it('past the code, returns, else tests the queue, else starts again (testing the empty queue first)', () => {
    const { s, run } = vm([NEVER, doIt(TACTIC.debug, [1])]);
    s.pc = s.data.length;
    s.returns = [0x6b];
    run();
    expect([s.pc, s.returns]).toEqual([0x6b, []]);
    s.pc = s.data.length;
    s.queues[0] = [0x6b];
    run();
    expect([s.pc, s.buffer]).toEqual([s.data.length, false]);
    s.queues[0] = [];
    run();
    expect([s.pc, s.buffer]).toEqual([0x6b, false]);
  });

  it('warns of an unknown token and goes past it, and of an unknown branch and stays on it', () => {
    const { s, L, run, warnings } = vm([{ cls: 7, opcode: 1, args: [0] }, label('branch'), branch(0x30, [0])]);
    run();
    run();
    run();
    expect([s.pc, warnings]).toEqual([L.branch, ['tactic: unknown token', 'tactic: unknown branch 30', 'tactic: unknown branch 30']]);
  });
});

describe('the branches (tactics.cpp:457-556)', () => {
  it('GOTO goes to its page, or the idle page for -2; GOSUB returns after the token it was on; IDLE is also the return stack\'s bottom', () => {
    const { s, L, run, warnings } = vm([
      branch(TACTIC.goto, [TACTIC.goto, 0, -2]),
      label('idle'), branch(TACTIC.idle, [2, { label: 'p' }]),
      label('gosub'), branch(TACTIC.gosub, [TACTIC.gosub, { label: 'p' }, 0, 0]),
      label('back'), doIt(TACTIC.debug, [1]),
      label('p'), doIt(TACTIC.return),
    ]);
    // (no idle page yet: it warns, and stays on the GOTO)
    run();
    expect([s.pc, warnings]).toEqual([0x6b, ['tactic: no idle page']]);
    s.pc = L.idle!;
    run();
    expect([s.pc, s.idle, s.returns]).toEqual([L.gosub, L.p, [L.p]]);
    run();
    expect([s.pc, s.returns]).toEqual([L.p, [L.back, L.p]]);
    run();
    expect([s.pc, s.returns]).toEqual([L.back, [L.p]]);
    s.pc = 0x6b;
    run();
    expect(s.pc).toBe(L.p);
  });

  it('RETURN with an empty stack goes to the idle page, or tracing, to the start', () => {
    // (a token before the RETURN, so the start is somewhere else)
    const { s, L, run } = vm([doIt(TACTIC.debug, [1]), label('ret'), doIt(TACTIC.return)]);
    s.idle = 0x200;
    s.pc = L.ret!;
    run();
    expect(s.pc).toBe(0x200);
    s.idle = 0;
    s.trace = 1;
    s.pc = L.ret!;
    run();
    expect(s.pc).toBe(0x6b);
  });

  it('ONE, SKILL and RANDOM switch by the first, the difficulty or rnd(total - 1) (tactics.cpp:490), as GOSUB or not; out of the table, on to the next token', () => {
    const switches = (kind: number, gosub: number, total: number) => branch(kind, [kind, 0, gosub, total, { label: 'a' }, { label: 'b' }, { label: 'c' }]);
    const { b, s, L, run, sites, warnings } = vm([
      switches(TACTIC.one, TACTIC.goto, 3), label('skill'), switches(TACTIC.skill, TACTIC.gosub, 3), label('random'), switches(TACTIC.random, TACTIC.goto, 3),
      label('bad'), switches(TACTIC.skill, TACTIC.goto, 1), label('onward'), doIt(TACTIC.debug, [1]),
      label('a'), doIt(TACTIC.debug, [1]), label('b'), doIt(TACTIC.debug, [1]), label('c'), doIt(TACTIC.debug, [1]),
    ]);
    run();
    expect(s.pc).toBe(L.a);
    s.pc = L.skill!;
    run();
    // (miniBattle is Lieutenant, difficulty 1)
    expect([s.pc, s.returns]).toEqual([L.b, [L.random]]);
    b.random = newRandom(1);
    s.pc = L.random!;
    run();
    // (seed 1's first low byte 198: rnd(2) = (198 * 2 + 0x80) >> 8 = 2)
    expect([s.pc, sites]).toEqual([L.c, ['tactics.cpp:490 2 2']]);
    s.pc = L.bad!;
    run();
    expect([s.pc, warnings]).toEqual([L.onward, ['tactic: bad branch address']]);
  });

  it('PUSH, POP and FLUSH keep a stack of queues, 9 deep, warning past either end; FLUSH clears only for ALL', () => {
    const { s, run, warnings } = vm([
      doIt(TACTIC.pop), ALWAYS, doIt(TACTIC.debug, [0]), doIt(TACTIC.flush, [1]), doIt(TACTIC.flush, [TACTIC.all]),
      ...Array.from({ length: 10 }, () => doIt(TACTIC.push)), doIt(TACTIC.pop),
    ]);
    run();
    expect([s.depth, warnings]).toEqual([0, ['tactic: event queue stack underflow']]);
    run();
    run();
    expect(s.queues[0]!.length).toBe(1);
    run();
    expect(s.queues[0]).toEqual([]);
    for (let i = 0; i < 10; i++) run();
    expect([s.depth, warnings.slice(1)]).toEqual([9, ['tactic: event queue stack overflow', 'tactic: event queue stack overflow']]);
    run();
    expect(s.depth).toBe(8);
  });

  it('BUTTON adds a maneuver under the Enterprise\'s last heading, warns without one, and is nothing from another ship', () => {
    const items = [label('button'), branch(TACTIC.button, [TACTIC.goto, 0, 0x6b], 'Close in'), label('after'), doIt(TACTIC.debug, [1])];
    const e = vm(items, 0);
    // (past its setup: not run all at once)
    e.b.console.kernelReady = true;
    e.run();
    expect([e.s.pc, e.warnings]).toEqual([e.L.after, ['tactic: no current menu heading']]);
    e.b.console.menu = [{ heading: true, open: true, payload: 0, label: '-H-', buttons: [] }];
    e.s.pc = e.L.button!;
    e.run();
    expect(e.b.console.menu[0]!.buttons).toEqual([{ heading: false, open: false, payload: e.L.button! + 12, label: 'Close in', buttons: [] }]);
    expect(e.b.console.menuRows).toEqual([[0, -1], [0, 0]]);
    const chodak = vm(items);
    chodak.b.console.menu = [{ heading: true, open: true, payload: 0, label: '-H-', buttons: [] }];
    rebuildManeuvers(chodak.b);
    chodak.run();
    expect([chodak.b.console.menu[0]!.buttons, chodak.s.pc]).toEqual([[], chodak.L.after]);
  });
});

describe('a WHEN\'s action (tactics.cpp:297-455)', () => {
  it('as the code meets it: a DO of the stack leaves the PC on the WHEN, a branch goes, ONCE leaves the queue, and RANDOM is unknown', () => {
    const { s, L, run, warnings } = vm([
      label('push'), ALWAYS, doIt(TACTIC.push),
      label('once'), ALWAYS, branch(TACTIC.once, [TACTIC.once, { label: 'target' }, 0]),
      label('random'), ALWAYS, branch(TACTIC.random, [TACTIC.random, 0, 0, 1, { label: 'target' }]),
      label('target'), doIt(TACTIC.debug, [1]),
    ]);
    run();
    expect([s.pc, s.depth, s.queues[0], s.queues[1]]).toEqual([L.push, 1, [L.push], []]);
    s.pc = L.once!;
    run();
    // (queued, then dequeued: ONCE)
    expect([s.pc, s.queues[1]]).toEqual([L.target, []]);
    s.pc = L.random!;
    run();
    // (the PC on the RANDOM, after the 24-byte WHEN)
    expect([s.pc, s.queues[1], warnings]).toEqual([L.random! + 24, [L.random], ['tactic: unknown branch 16 after a WHEN']]);
  });

  it('from the queue: a branch goes and the code runs on; ONCE leaves the queue and stops; POP and FLUSH ALL stop', () => {
    const { s, ship, L, run, warnings } = vm([
      label('msg'), ALWAYS, doIt(TACTIC.message, [], 'm'),
      label('once'), ALWAYS, branch(TACTIC.once, [TACTIC.once, { label: 'target' }, 0]),
      label('pop'), ALWAYS, doIt(TACTIC.pop),
      label('target'), doIt(TACTIC.debug, [1]),
      label('bad'), when(0x40),
    ]);
    // (as the code left it: these queued, newest first, and testing it)
    s.queues[0] = [L.msg!, L.once!, L.msg!];
    s.buffer = false;
    run();
    // (the first logs; ONCE removes the first of its own (the second node) and stops there)
    expect([ship.log, s.queues[0], s.pc, s.buffer]).toEqual([['m'], [L.msg, L.msg], L.target, true]);
    s.buffer = false;
    s.depth = 1;
    s.queues[1] = [L.pop!, L.msg!];
    run();
    expect([s.depth, s.queues[1], ship.log]).toEqual([0, [], ['m']]);
    s.queues[0] = [L.target!];
    s.buffer = false;
    run();
    // (a DEBUG token is not a WHEN: opcode 0x20 is a no-op condition, and over 0x32 is "illegal")
    expect(warnings).toEqual([]);
    s.queues[0] = [L.bad!];
    s.buffer = false;
    run();
    expect(warnings).toEqual(['tactic: illegal jump address']);
  });
});

describe('the edges the mutation sweep found unpinned', () => {
  it('runs a stuck setup exactly 100000 tokens: an unknown branch warns each time (tactics.cpp:195-199)', () => {
    const { s, L, run, warnings } = vm([label('stuck'), branch(0x30, [0])], 0);
    run();
    expect([s.pc, warnings.length, new Set(warnings)]).toEqual([L.stuck, 100000, new Set(['tactic: unknown branch 30'])]);
  });

  it('in the queue, a ONCE stops the test once its own WHEN has gone, though the same WHEN is next (tactics.cpp:422-424)', () => {
    const { s, ship, L, run } = vm([
      label('msg'), ALWAYS, doIt(TACTIC.message, [], 'm'),
      label('once'), ALWAYS, branch(TACTIC.once, [TACTIC.once, { label: 'target' }, 0]),
      label('target'), doIt(TACTIC.debug, [1]),
    ]);
    s.queues[0] = [L.once!, L.once!, L.msg!];
    s.buffer = false;
    run();
    expect([s.queues[0], s.pc, ship.log]).toEqual([[L.once, L.msg], L.target, []]);
  });

  it('IDLE goes under the return stack; a page\'s end returns; OPPOSE and CLEAR go on to the next token', () => {
    const { s, ship, L, run } = vm([
      label('idle'), branch(TACTIC.idle, [2, 0x300]),
      label('oppose'), branch(TACTIC.oppose, [0]),
      label('clear'), doIt(TACTIC.clear),
      label('page'), page('THEN', 'then'), label('then'), doIt(TACTIC.debug, [1]),
    ]);
    s.returns = [0x200];
    run();
    expect([s.pc, s.returns, s.idle]).toEqual([L.oppose, [0x200, 0x300], 0x300]);
    run();
    expect(s.pc).toBe(L.clear);
    ship.waypointActive = true;
    run();
    expect([s.pc, ship.waypointActive]).toEqual([L.page, false]);
    run();
    expect([s.pc, s.returns, s.buffer]).toEqual([0x200, [0x300], false]);
  });

  it('in the queue, a POP or FLUSH ALL stops the pass even after a PUSH, when it empties the queue above (tactics.cpp:431-437)', () => {
    for (const stop of [doIt(TACTIC.pop), doIt(TACTIC.flush, [TACTIC.all])]) {
      const { s, ship, L, run } = vm([
        label('push'), ALWAYS, doIt(TACTIC.push),
        label('stop'), ALWAYS, stop,
        label('msg'), ALWAYS, doIt(TACTIC.message, [], 'm'),
      ]);
      s.queues[0] = [L.push!, L.stop!, L.msg!];
      s.buffer = false;
      run();
      expect([ship.log, s.queues[0]]).toEqual([[], [L.push, L.stop, L.msg]]);
    }
  });

  it('as the code meets it, a WHEN\'s POP leaves the PC on the WHEN, as its PUSH does (tactics.cpp:313-315)', () => {
    const { s, L, run, warnings } = vm([label('pop'), ALWAYS, doIt(TACTIC.pop), doIt(TACTIC.debug, [1])]);
    s.depth = 1;
    run();
    // (queued at depth 1, which the POP then empties)
    expect([s.pc, s.depth, s.queues[1], warnings]).toEqual([L.pop, 0, [], []]);
  });

  it('a switch past its tenth page is a bad address, however many it lists (tactics.cpp:491)', () => {
    // (seed 1's first low byte 198: rnd(14) = (198 * 14 + 0x80) >> 8 = 11)
    const pages = Array.from({ length: 15 }, () => ({ label: 'a' }));
    const { b, s, L, run, warnings } = vm([branch(TACTIC.random, [TACTIC.random, 0, TACTIC.goto, 15, ...pages]), label('onward'), label('a'), doIt(TACTIC.debug, [1])]);
    b.random = newRandom(1);
    run();
    expect([s.pc, warnings]).toEqual([L.onward, ['tactic: bad branch address']]);
  });

  it('BUTTON is the Enterprise\'s only as the battle\'s first ship and of the Enterprise\'s kind (tactics.cpp:543)', () => {
    const items = [branch(TACTIC.button, [TACTIC.goto, 0, 0x6b], 'Close in'), doIt(TACTIC.debug, [1])];
    const heading = () => [{ heading: true, open: true, payload: 0, label: '-H-', buttons: [] }];
    const first = vm(items, 0);
    first.b.console.kernelReady = true;
    first.b.console.menu = heading();
    first.ship.type = first.b.ships[1]!.type;
    first.run();
    const second = vm(items);
    // (of the Enterprise's kind, it would lock the script: past its setup)
    second.b.console.kernelReady = true;
    second.b.console.menu = heading();
    second.ship.type = second.b.ships[0]!.type;
    second.run();
    expect([first.b.console.menu[0]!.buttons, second.b.console.menu[0]!.buttons]).toEqual([[], []]);
  });
});

describe('TACTICS_SEAMS', () => {
  it('fills tactics.cpp\'s seams, frozen', () => {
    expect(Object.keys(TACTICS_SEAMS).sort()).toEqual(['clickManeuver', 'engage', 'engageManeuver', 'loadScript', 'runScript', 'scrollManeuvers']);
    expect(Object.isFrozen(TACTICS_SEAMS)).toBe(true);
    expect(TACTICS_SEAMS.runScript).toBe(runScript);
    expect(typeof scriptStep).toBe('function');
  });
});
