// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { TACTIC, TOKEN } from '../../content/tactics';
import { addTactics, miniBattle, miniBattleContext, miniCombat, recordingSeams } from '../../testing/combat';
import { assembleTactics, floatBits, makeTacticsBin } from '../../testing/tactics';
import { loadScript, NUM_QUEUES, scriptQueue, setTokenArg, tokenArg, tokenClass, tokenEnd, tokenFloat, tokenOpcode, tokenText } from './script';
import { NO_SEAMS, warn, type BattleContext } from './types';

/** A file: MAIN at 7 (the code at 0x6b), a MESSAGE, a WHEN PROXIMITY < 1800.0, KERNEL at 0x9b pointing at 0x6b. */
const FILE = assembleTactics([
  { cls: TOKEN.page, opcode: 0x1f, page: 'MAIN', args: [{ label: 'code' }] },
  { label: 'code' },
  { cls: TOKEN.do, opcode: TACTIC.message, text: 'Zap ready' },
  { label: 'when' },
  { cls: TOKEN.when, opcode: TACTIC.proximity, args: [4, { float: 1800 }] },
  { label: 'kernel' },
  { cls: TOKEN.page, opcode: 0x1f, page: 'KERNEL', args: [{ label: 'code' }] },
]);

function withFile(bin: Uint8Array = FILE.bin, file = 'zap.bin') {
  const combat = miniCombat();
  addTactics(combat, file, bin);
  for (const ship of combat.battles[3]!.ships) ship.tactics = file;
  const warnings: string[] = [];
  const ctx: BattleContext = { ...miniBattleContext({ loadScript }, combat), onWarning: m => { warnings.push(m); } };
  const { b } = miniBattle({ ctx });
  return { ctx, b, warnings };
}

describe('the synthetic tactics assembler (testing/tactics.ts)', () => {
  it('places labels after the first page at 0x6b, and writes floats as their bits and texts after their length', () => {
    // (MAIN is 12 + 88 bytes from 7; the MESSAGE 12 + 4 + 12 ("Zap ready" padded to 12); the WHEN 12 + 8)
    expect(FILE.labels).toEqual({ code: 0x6b, when: 0x6b + 28, kernel: 0x6b + 28 + 20 });
    expect(floatBits(1800)).toBe(0x44e10000);
    expect(makeTacticsBin([{ cls: 1, opcode: 0x25, text: 'ab' }])).toEqual(Uint8Array.from([
      ...'TACTICS'].map(c => c.charCodeAt(0)).concat([1, 0, 0, 0, 0x25, 0, 0, 0, 8, 0, 0, 0, 2, 0, 0, 0, 0x61, 0x62, 0, 0])));
    expect(() => assembleTactics([{ cls: 2, opcode: 4, args: [{ label: 'nowhere' }] }])).toThrow('no label nowhere');
    expect(() => assembleTactics([{ label: 'twice' }, { cls: 2, opcode: 4 }, { label: 'twice' }])).toThrow('duplicate label twice');
  });
});

describe('Combat::loadScript and TacticScript::load (tactics.cpp:135-183)', () => {
  it('gives each ship its own copy of its file, at the code start, buffered, with the kernel, and engages it', () => {
    const { ctx, b, warnings } = withFile();
    const [e, chodak] = b.ships;
    for (const ship of [e!, chodak!]) {
      expect(ship.engaged).toBe(true);
      expect({ ...ship.script!, data: ship.script!.data.length }).toEqual({
        file: 'zap.bin', data: FILE.bin.length, pc: 0x6b, idle: 0, kernel: 0x6b, trace: 0,
        queues: Array.from({ length: NUM_QUEUES }, () => []), depth: 0, buffer: true, returns: [],
      });
    }
    // (WHEN DELTA writes into its own copy: neither the other ship's nor the lift's changes)
    setTokenArg(e!.script!, FILE.labels.when!, 1, 99);
    expect(tokenArg(e!.script!, FILE.labels.when!, 1)).toBe(99);
    expect(tokenArg(chodak!.script!, FILE.labels.when!, 1)).toBe(floatBits(1800));
    loadScript(ctx, b, chodak!);
    expect(tokenArg(chodak!.script!, FILE.labels.when!, 1)).toBe(floatBits(1800));
    expect(warnings).toEqual([]);
  });

  it('gives no script to a ship without tactics or whose file the game lacks, quietly, and warns of a file load refuses', () => {
    const { ctx, b, warnings } = withFile();
    const chodak = b.ships[1]!;
    chodak.engaged = false;
    chodak.tactics = null;
    loadScript(ctx, b, chodak);
    expect([chodak.script, chodak.engaged, warnings]).toEqual([null, false, []]);
    chodak.tactics = 'gone.bin';
    loadScript(ctx, b, chodak);
    expect([chodak.script, chodak.engaged, warnings]).toEqual([null, false, []]);
    // (under 0x6b bytes: load refuses it, tactics.cpp:138)
    addTactics(ctx.combat, 'short.bin', FILE.bin.subarray(0, 0x6a));
    chodak.tactics = 'short.bin';
    loadScript(ctx, b, chodak);
    expect([chodak.script, chodak.engaged, warnings]).toEqual([null, false, ['bad tactic file short.bin']]);
  });
});

describe('TacticScript\'s accessors (combat.h:127-134, tactics.cpp:108-133)', () => {
  const { b } = withFile();
  const s = b.ships[0]!.script!;
  const when = FILE.labels.when!;

  it('reads a token\'s class, opcode, end and arguments, and 0 outside the code', () => {
    expect([tokenClass(s, when), tokenOpcode(s, when), tokenEnd(s, when), tokenArg(s, when, 0)]).toEqual([TOKEN.when, TACTIC.proximity, when + 20, 4]);
    expect(tokenFloat(s, when, 1)).toBe(1800);
    expect([tokenArg(s, s.data.length, 0), tokenClass(s, -12)]).toEqual([0, 0]);
  });

  it('writes an argument only inside the code', () => {
    const copy = s.data.slice();
    setTokenArg(s, s.data.length - 12, 0, 7);
    setTokenArg(s, -20, 0, 7);
    expect(s.data).toEqual(copy);
  });

  it('reads a text after its length, up to a NUL, and nothing when it overruns the code', () => {
    expect(tokenText(s, 0x6b, 0)).toBe('Zap ready');
    const nul = withFile(makeTacticsBin([{ cls: 3, opcode: 0x1f, page: 'MAIN' }, { cls: 1, opcode: TACTIC.message, text: 'ab\0cd' }])).b.ships[0]!.script!;
    expect(tokenText(nul, 0x6b, 0)).toBe('ab');
    const over = withFile(makeTacticsBin([{ cls: 3, opcode: 0x1f, page: 'MAIN' }, { cls: 1, opcode: TACTIC.message, args: [40] }])).b.ships[0]!.script!;
    expect(tokenText(over, 0x6b, 0)).toBe('');
    // (6 bytes asked for, "abcd" the 4 left: start + length > size, tactics.cpp:130, so nothing, not "abcd")
    const short = withFile(makeTacticsBin([{ cls: 3, opcode: 0x1f, page: 'MAIN' }, { cls: 1, opcode: TACTIC.message, args: [6, 0x64636261] }])).b.ships[0]!.script!;
    expect(tokenText(short, 0x6b, 0)).toBe('');
  });

  it('keeps a queue per depth', () => {
    s.depth = 3;
    scriptQueue(s).push(5);
    expect(s.queues[3]).toEqual([5]);
    expect(s.queues[0]).toEqual([]);
  });
});

describe('the seams Plan 21 adds (types.ts)', () => {
  it('has NO_SEAMS show no warp, put astrogation at 0, 0, 0 and set no warp; recordingSeams hears them', () => {
    const { ctx, b } = miniBattle();
    expect(NO_SEAMS.astrogationPosition(ctx, b)).toEqual([0, 0, 0]);
    expect(Object.isFrozen(NO_SEAMS.astrogationPosition(ctx, b))).toBe(true);
    const log: string[] = [];
    const seams = recordingSeams(log);
    seams.showWarp(ctx, b);
    seams.scriptedWarp(ctx, b, 1, 0x2da);
    expect(seams.astrogationPosition(ctx, b)).toEqual([0, 0, 0]);
    expect(log).toEqual(['showWarp', 'scriptedWarp', 'astrogationPosition']);
  });

  it('passes a warning to whoever listens, and to nobody else', () => {
    const heard: string[] = [];
    const ctx: BattleContext = { ...miniBattleContext(), onWarning: m => { heard.push(m); } };
    warn(ctx, 'tactic: unknown token');
    warn(miniBattleContext(), 'unheard');
    expect(heard).toEqual(['tactic: unknown token']);
  });
});
