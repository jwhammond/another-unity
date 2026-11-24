// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { makeTacticsBin } from '../testing/tactics';
import { checkTactics, decodeBase64, encodeBase64, readTacticInt, TACTICS_CODE_START, tacticsCode, tacticTokens, TOKEN } from './tactics';

const page = (name: string, target = 0) => ({ cls: TOKEN.page, opcode: 0x1f, page: name, args: [target] });

describe('the tactics bytecode (TacticScript::load, tactics.cpp:135-155)', () => {
  const bin = makeTacticsBin([page('MAIN'), { cls: TOKEN.do, opcode: 0x2b, args: [1, 2] }, page('Kernel', 0x1234), { cls: TOKEN.when, opcode: 0x1c }]);

  it('puts the code at 0x6b after the first page, walks every token to the end, and finds the kernel in any case', () => {
    expect(tacticTokens(bin).map(t => [t.offset, t.cls, t.opcode, t.length])).toEqual([[7, 3, 0x1f, 88], [0x6b, 1, 0x2b, 8], [0x7f, 3, 0x1f, 88], [0xe3, 0, 0x1c, 0]]);
    expect(checkTactics(bin)).toEqual({ loads: true, kernel: 0x1234, pages: [{ name: 'MAIN', offset: 7 }, { name: 'Kernel', offset: 0x7f }], tokens: 4, problems: [] });
  });

  it('refuses what load refuses: fewer than 0x6b bytes, or no "TACTICS"', () => {
    expect(checkTactics(bin.subarray(0, TACTICS_CODE_START - 1)).loads).toBe(false);
    const bad = bin.slice();
    bad[0] = 0x58;
    expect(checkTactics(bad).loads).toBe(false);
  });

  it('says when the tokens overrun the file or miss the code start, and still loads it, as ScummVM would', () => {
    const cut = checkTactics(bin.subarray(0, bin.length - 4));
    expect(cut.loads).toBe(true);
    expect(cut.problems).toEqual([`the tokens end at ${0xe3}, not at the file's end (${bin.length - 4})`]);
    const skewed = checkTactics(makeTacticsBin([{ cls: TOKEN.do, opcode: 1, args: new Array<number>(30).fill(0) }]));
    expect(skewed.problems).toEqual(['no token starts at the code start (0x6b)']);
  });

  it('names only pages of at least 0x18 bytes, and takes the last KERNEL', () => {
    const two = makeTacticsBin([page('MAIN'), { cls: TOKEN.page, opcode: 0x1f, args: [5, 0] }, page('KERNEL', 1), page('kernel', 2)]);
    const c = checkTactics(two);
    expect(c.pages.map(p => p.name)).toEqual(['MAIN', 'KERNEL', 'kernel']);
    expect(c.kernel).toBe(2);
  });

  it('reads 0 outside the code, as readInt does', () => {
    expect(readTacticInt(bin, -4)).toBe(0);
    expect(readTacticInt(bin, bin.length - 2)).toBe(0);
    expect(readTacticInt(bin, TACTICS_CODE_START + 4)).toBe(0x2b);
  });

  it('gives each caller its own copy of the code, since SET writes into it (TacticScript::setArg; Review Focus 4)', () => {
    const script = { file: 'x.bin', size: bin.length, kernel: 0, pages: [], code: encodeBase64(bin) };
    const mine = tacticsCode(script);
    mine[TACTICS_CODE_START] = 0xff;
    expect(tacticsCode(script)[TACTICS_CODE_START]).toBe(bin[TACTICS_CODE_START]);
    expect(decodeBase64(encodeBase64(bin))).toEqual(bin);
  });
});
