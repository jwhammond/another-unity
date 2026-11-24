// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { TACTIC, TOKEN } from '../content/tactics';
import { miniBattle, tacticScript } from '../testing/combat';
import { assembleTactics } from '../testing/tactics';
import { consoleLine, keepWarning, maneuverRows, scriptPage, shipLine } from './combatTactics';

const FILE = assembleTactics([
  { cls: TOKEN.page, opcode: 0x1f, page: 'MAIN', args: [{ label: 'main' }] }, { label: 'main' }, { cls: TOKEN.do, opcode: TACTIC.clear },
  // (a page of under 0x18 bytes has no name: it shows as its offset)
  { label: 'short' }, { cls: TOKEN.page, opcode: 0x1f, args: [0, 0] }, { label: 'after' }, { cls: TOKEN.do, opcode: TACTIC.clear },
  { cls: TOKEN.page, opcode: 0x1f, page: 'KERNEL', args: [{ label: 'kernel' }] }, { label: 'kernel' }, { cls: TOKEN.do, opcode: TACTIC.clear },
]);

describe('the dev view\'s tactics lines (combatTactics.ts)', () => {
  it('names the page a script\'s PC is in, or its offset when it has no name', () => {
    const s = tacticScript(FILE.bin);
    expect(scriptPage(s)).toBe('MAIN');
    s.pc = FILE.labels.after!;
    expect(scriptPage(s)).toBe(`0x${FILE.labels.short!.toString(16)}`);
    s.pc = FILE.labels.kernel!;
    expect(scriptPage(s)).toBe('KERNEL');
    s.pc = 7;
    expect(scriptPage(s)).toBe('-');
  });

  it('says what the console and each ship are doing, with the timers left', () => {
    const { b } = miniBattle();
    const [e, chodak] = [b.ships[0]!, b.ships[1]!];
    chodak.script = tacticScript(FILE.bin, 'zap.bin');
    chodak.fireTime = b.now + 1500;
    chodak.engaged = true;
    expect(consoleLine(b)).toBe('no delegate · no kernel ready · no script lock · no engage lock · no engage button · menu 0 headings, 0 rows');
    expect(shipLine(b, e)).toBe('0 · no engaged · no script · no waypoint · target 1 at 5099 · fire 3.0s · strategy - · hold - · freeze -');
    expect(shipLine(b, chodak)).toBe('1 · engaged · zap.bin MAIN pc 0x6b running queue 0:0 returns 0 idle 0x0 kernel 0x0 · no waypoint · target 0 at 5099 · fire 1.5s · strategy - · hold - · freeze -');
  });

  it('lays the maneuvers out on the page\'s seven rows, under the scroll', () => {
    const { b } = miniBattle();
    b.console.menu = [{ heading: true, open: true, payload: 0, label: '-A-', buttons: [{ heading: false, open: false, payload: 0, label: '-a-', buttons: [] }] }];
    b.console.menuRows = [[0, -1], [0, 0]];
    b.console.menuSelected = 1;
    expect(maneuverRows(b).map(r => r.label)).toEqual(['▾ -A-', '  -a-', '', '', '', '', '']);
    expect(maneuverRows(b).map(r => r.selected)).toEqual([false, true, false, false, false, false, false]);
    b.console.menuScroll = 1;
    expect(maneuverRows(b)[0]!.label).toBe('  -a-');
  });

  it('keeps the latest five warnings, each once, a repeat moving to the end', () => {
    let list: string[] = [];
    for (const m of 'abcdefg') list = keepWarning(list, m);
    expect(list).toEqual(['c', 'd', 'e', 'f', 'g']);
    expect(keepWarning(list, 'c')).toEqual(['d', 'e', 'f', 'g', 'c']);
  });

  it('says when the Engage button is holding the engage', () => {
    const { b } = miniBattle();
    b.console.engageButton = true;
    expect(consoleLine(b)).toContain('engaged by button');
  });
});
