// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { TACTIC, TOKEN } from '../../content/tactics';
import { addTactics, miniBattle, miniBattleContext, miniCombat } from '../../testing/combat';
import { assembleTactics } from '../../testing/tactics';
import { clickManeuver, engage, engageManeuver, kernelJump, maneuverAt, MANEUVER_ROWS, rebuildManeuvers, resetScript, scrollManeuvers } from './maneuvers';
import { loadScript } from './script';
import type { BattleContext, ManeuverItem } from './types';

/**
 * The Enterprise's script: a MENU heading (id 1), a GOSUB button to one page and a GOTO button to another, as the game's
 * scripts lay them out (MENU: args [0, id, 0] and its label; BUTTON: [kind, 0, page] and its label), and KERNEL.
 */
const FILE = assembleTactics([
  { cls: TOKEN.page, opcode: 0x1f, page: 'MAIN', args: [{ label: 'code' }] },
  { label: 'code' },
  { label: 'menu' },
  { cls: TOKEN.do, opcode: TACTIC.menu, args: [0, 1, 0], text: 'Pounce' },
  { label: 'dash button' },
  { cls: TOKEN.branch, opcode: TACTIC.button, args: [TACTIC.gosub, 0, { label: 'dash' }], text: 'Close in' },
  { label: 'swerve button' },
  { cls: TOKEN.branch, opcode: TACTIC.button, args: [TACTIC.goto, 0, { label: 'swerve' }], text: 'Swerve' },
  { cls: TOKEN.page, opcode: 0x1f, page: 'KERNEL', args: [{ label: 'dash' }] },
  { label: 'dash' },
  { cls: TOKEN.do, opcode: TACTIC.clear },
  { label: 'swerve' },
  { cls: TOKEN.do, opcode: TACTIC.clear },
]);
const L = FILE.labels as Record<string, number>;

function battle() {
  const combat = miniCombat();
  addTactics(combat, 'worf.bin', FILE.bin);
  combat.battles[3]!.ships[0]!.tactics = 'worf.bin';
  const warnings: string[] = [];
  const ctx: BattleContext = { ...miniBattleContext({ loadScript, engage }, combat), onWarning: m => { warnings.push(m); } };
  const { b } = miniBattle({ ctx });
  const e = b.ships[0]!;
  const button = (label: string, at: number): ManeuverItem => ({ heading: false, open: false, payload: at + 12, label, buttons: [] });
  // (as the script's MENU and BUTTONs build it: tactics.ts)
  b.console.menu = [{ heading: true, open: false, payload: L.menu! + 12, label: 'Pounce', buttons: [button('Close in', L['dash button']!), button('Swerve', L['swerve button']!)] }];
  rebuildManeuvers(b);
  b.cues.length = 0;
  return { ctx, b, e, s: e.script!, warnings };
}

describe('Combat::engage (tactics.cpp:944-971)', () => {
  it('engages and disengages the Enterprise\'s tactics unless locked, centring the controls and resetting the script as it disengages', () => {
    const { ctx, b, e, s } = battle();
    // (setup locked it: engage(2), combat.cpp:266)
    expect(b.console.engageLock).toBe(true);
    e.engaged = true;
    e.controls.yaw = 50;
    engage(ctx, b, 0);
    expect([e.engaged, e.controls.yaw]).toEqual([true, 50]);
    engage(ctx, b, 3);
    expect(b.console.engageLock).toBe(false);
    s.returns = [0x200, L.dash!];
    s.queues[0] = [0x6b];
    s.queues[2] = [0x80];
    s.depth = 2;
    engage(ctx, b, 0);
    expect([e.engaged, b.console.engageButton, e.controls.yaw, s.pc, s.returns, s.depth, s.queues[0], s.queues[2]]).toEqual([false, false, 0, L.dash, [], 0, [], []]);
    engage(ctx, b, 1);
    expect([e.engaged, b.console.engageButton]).toEqual([true, true]);
  });

  it('jumps to the kernel as it unlocks only when the kernel is ready and the power is at 4, and warns of a bad mode', () => {
    const { ctx, b, s, warnings } = battle();
    engage(ctx, b, 3);
    expect(s.pc).toBe(0x6b);
    // (full power without the kernel ready doesn't jump)
    b.console.powerLevel = 4;
    engage(ctx, b, 3);
    expect(s.pc).toBe(0x6b);
    b.console.kernelReady = true;
    b.console.powerLevel = 3;
    engage(ctx, b, 3);
    expect(s.pc).toBe(0x6b);
    b.console.powerLevel = 4;
    s.buffer = false;
    engage(ctx, b, 3);
    expect([s.pc, s.buffer]).toEqual([L.dash, true]);
    engage(ctx, b, 7);
    expect(warnings).toEqual(['tactic: bad engage mode 7']);
  });

  it('resets only a script with somewhere to return to, and warns when there is no kernel to jump to', () => {
    const { ctx, s, warnings } = battle();
    s.queues[0] = [0x6b];
    resetScript(s);
    expect(s.queues[0]).toEqual([0x6b]);
    resetScript(null);
    s.kernel = 0;
    kernelJump(ctx, s);
    kernelJump(ctx, null);
    expect([s.pc, warnings]).toEqual([0x6b, ['tactic: no kernel page for delegation']]);
  });
});

describe('the maneuver menu (tactics.cpp:973-1016)', () => {
  it('shows a heading\'s buttons once it is open; a click opens or closes it, disengages and selects the row', () => {
    const { ctx, b, e } = battle();
    expect(b.console.menuRows).toEqual([[0, -1]]);
    expect(maneuverAt(b, 1)).toBeNull();
    b.console.engageLock = false;
    e.engaged = true;
    clickManeuver(ctx, b, 0);
    expect([b.console.menuRows, b.console.menuSelected, e.engaged]).toEqual([[[0, -1], [0, 0], [0, 1]], 0, false]);
    expect(maneuverAt(b, 2)!.label).toBe('Swerve');
    b.console.menuScroll = 1;
    expect(maneuverAt(b, 0)!.label).toBe('Close in');
    // (closing a heading scrolls back to the top; a button only selects)
    clickManeuver(ctx, b, 1);
    expect([b.console.menuSelected, b.console.menuScroll]).toEqual([1, 1]);
    b.console.menuScroll = 0;
    clickManeuver(ctx, b, 0);
    b.console.menuScroll = 0;
    expect([b.console.menuRows, b.console.menuSelected]).toEqual([[[0, -1]], 0]);
  });

  it('takes a click only on the page\'s seven rows (tactical.cpp:669-673)', () => {
    const { ctx, b } = battle();
    for (const row of [-1, MANEUVER_ROWS, 1.5]) clickManeuver(ctx, b, row);
    expect([b.console.menuSelected, b.console.menu[0]!.open]).toEqual([-1, false]);
  });

  it('scrolls while there are rows below the seventh, else moves the selection, from 0 to 6', () => {
    const { ctx, b } = battle();
    // (nine rows: nine headings)
    b.console.menu = Array.from({ length: 9 }, (_, i) => ({ heading: true, open: false, payload: 0, label: `-H${i}-`, buttons: [] }));
    rebuildManeuvers(b);
    scrollManeuvers(ctx, b, 1);
    scrollManeuvers(ctx, b, 1);
    expect([b.console.menuScroll, b.console.menuSelected]).toEqual([2, -1]);
    for (let i = 0; i < 9; i++) scrollManeuvers(ctx, b, 1);
    expect([b.console.menuScroll, b.console.menuSelected]).toEqual([2, 6]);
    for (let i = 0; i < 9; i++) scrollManeuvers(ctx, b, -1);
    expect([b.console.menuScroll, b.console.menuSelected]).toEqual([0, 0]);
  });

  it('keeps the scroll as a heading opens, or as Engage closes it, and scrolls back to the top as a click closes it (tactics.cpp:996-997, 1036-1038)', () => {
    const { ctx, b } = battle();
    // (nine headings, each with one button; scrolled to the third)
    b.console.menu = Array.from({ length: 9 }, (_, i) => ({ heading: true, open: false, payload: 0, label: `-H${i}-`, buttons: [{ heading: false, open: false, payload: 0, label: `-B${i}-`, buttons: [] }] }));
    rebuildManeuvers(b);
    b.console.menuScroll = 2;
    clickManeuver(ctx, b, 0);
    expect([b.console.menu[2]!.open, b.console.menuScroll]).toEqual([true, 2]);
    b.console.engageButton = false;
    engageManeuver(ctx, b);
    expect([b.console.menu[2]!.open, b.console.menuScroll]).toEqual([false, 2]);
    clickManeuver(ctx, b, 0);
    clickManeuver(ctx, b, 0);
    expect([b.console.menu[2]!.open, b.console.menuScroll]).toEqual([false, 0]);
  });
});

describe('Combat::engageManeuver (tactics.cpp:1018-1054)', () => {
  it('disengages with nothing selected, or when engaged (saying so), and opens a heading', () => {
    const { ctx, b, e } = battle();
    b.console.engageLock = false;
    e.engaged = true;
    engageManeuver(ctx, b);
    expect([e.engaged, b.cues]).toEqual([false, []]);
    b.console.menuSelected = 0;
    engageManeuver(ctx, b);
    expect([b.console.menu[0]!.open, b.console.engageButton, b.console.menuRows.length, b.cues.map(c => c.cue)]).toEqual([true, true, 3, [0xe]]);
    engageManeuver(ctx, b);
    expect([b.console.engageButton, b.cues.map(c => c.cue)]).toEqual([false, [0xe, 0xf]]);
  });

  it('sends the script to a GOSUB button\'s page, returning after the token it was on, and a GOTO button\'s without', () => {
    const { ctx, b, e, s } = battle();
    b.console.engageLock = false;
    b.console.menu[0]!.open = true;
    rebuildManeuvers(b);
    b.console.menuSelected = 1;
    s.buffer = false;
    engageManeuver(ctx, b);
    // (from the code start, 0x6b: a MENU token of 12 + 24 bytes (three args, the length, "Pounce" padded to 8), so it returns to 0x8f)
    expect([s.pc, s.returns, s.buffer, e.engaged, b.console.engageButton]).toEqual([L.dash, [0x6b + 36], true, true, true]);
    b.console.engageButton = false;
    b.console.menuSelected = 2;
    s.returns = [];
    engageManeuver(ctx, b);
    expect([s.pc, s.returns]).toEqual([L.swerve, []]);
  });

  it('jumps even while the lock keeps the Enterprise from engaging, as ScummVM does', () => {
    const { ctx, b, e, s } = battle();
    b.console.menu[0]!.open = true;
    rebuildManeuvers(b);
    b.console.menuSelected = 2;
    // (loadScript engaged it: R13)
    e.engaged = false;
    engageManeuver(ctx, b);
    // (engage(1) returns at the lock; the jump and engaged = true follow it: tactics.cpp:1046-1053)
    expect([s.pc, e.engaged, b.console.engageButton]).toEqual([L.swerve, true, false]);
  });
});
