// SPDX-License-Identifier: GPL-3.0-or-later
import type { TacticsScript } from './types';

/** The magic a tactics file starts with (TacticScript::load, tactics.cpp:138). */
export const TACTICS_MAGIC = 'TACTICS';
/** kCodeStart (tactics.cpp:93): where a script's code starts, and restarts. */
export const TACTICS_CODE_START = 0x6b;
/** The token classes (tactics.cpp:40-45). */
export const TOKEN = { when: 0, do: 1, branch: 2, page: 3 } as const;
/** The keywords, opcodes and arguments alike (tactics.cpp:47-91). STORY, BEARING and OPPOSE are no-ops in the original (tactics.cpp:913-915). */
export const TACTIC = {
  button: 1, push: 2, pop: 3, goto: 4, once: 5, one: 6, print: 7, fire: 8, flush: 0xa, heading: 0xb, climb: 0xc,
  bank: 0xd, speed: 0xe, pos: 0xf, phaser: 0x10, photon: 0x11, system: 0x12, story: 0x13, all: 0x15, random: 0x16,
  proximity: 0x17, foe: 0x18, friend: 0x19, target: 0x1a, bearing: 0x1b, fired: 0x1c, delta: 0x1d, skill: 0x1e,
  debug: 0x20, gosub: 0x21, onceGosub: 0x22, way: 0x23, clear: 0x24, message: 0x25, acquire: 0x26, cloak: 0x27,
  menu: 0x28, engage: 0x29, return: 0x2a, idle: 0x2b, warp: 0x2c, oppose: 0x2d,
} as const;

/** A token: its class, opcode and the length of what follows its 12-byte header (combat.h:127-130 TacticScript::tokenClass, tokenOpcode, end). */
export interface TacticToken { offset: number; cls: number; opcode: number; length: number }

/** TacticScript::readInt (tactics.cpp:108-112): a signed int32, or 0 outside the code. */
export function readTacticInt(code: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > code.length) return 0;
  return new DataView(code.buffer, code.byteOffset, code.byteLength).getInt32(offset, true);
}

/** Every token from offset 7 on, each followed by the next at its end, as load's kernel search walks them (tactics.cpp:144-153). */
export function tacticTokens(code: Uint8Array): TacticToken[] {
  const out: TacticToken[] = [];
  for (let at = 7; at + 12 <= code.length;) {
    const length = readTacticInt(code, at + 8);
    out.push({ offset: at, cls: readTacticInt(code, at), opcode: readTacticInt(code, at + 4), length });
    // (a negative length would walk backwards for ever: the walk stops, and checkTactics says so)
    if (length < 0) break;
    at += 12 + length;
  }
  return out;
}

export interface TacticsCheck {
  /** TacticScript::load would take it: at least 0x6b bytes, starting "TACTICS" (tactics.cpp:138). */
  loads: boolean;
  kernel: number;
  pages: { name: string; offset: number }[];
  tokens: number;
  /** What is odd about the token chain. ScummVM doesn't check these, so a script with problems still loads. */
  problems: string[];
}

export function checkTactics(code: Uint8Array): TacticsCheck {
  const loads = code.length >= TACTICS_CODE_START && String.fromCharCode(...code.subarray(0, 7)) === TACTICS_MAGIC;
  const result: TacticsCheck = { loads, kernel: 0, pages: [], tokens: 0, problems: [] };
  if (!loads) return result;
  const tokens = tacticTokens(code);
  result.tokens = tokens.length;
  for (const t of tokens) {
    if (t.length < 0) result.problems.push(`the token at ${t.offset} has a negative length`);
    if (t.cls !== TOKEN.page || t.length < 0x18) continue;
    // (the name is 16 bytes at +20, up to its NUL: Common::String(&data[offset + 20], 16).c_str())
    const raw = code.subarray(t.offset + 20, t.offset + 36);
    const nul = raw.indexOf(0);
    const name = String.fromCharCode(...(nul < 0 ? raw : raw.subarray(0, nul)));
    result.pages.push({ name, offset: t.offset });
    if (name.toLowerCase() === 'kernel') result.kernel = readTacticInt(code, t.offset + 12);
  }
  const last = tokens.at(-1);
  const end = last ? last.offset + 12 + Math.max(last.length, 0) : 7;
  if (end !== code.length) result.problems.push(`the tokens end at ${end}, not at the file's end (${code.length})`);
  if (!tokens.some(t => t.offset === TACTICS_CODE_START)) result.problems.push('no token starts at the code start (0x6b)');
  return result;
}

export function encodeBase64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

export function decodeBase64(text: string): Uint8Array {
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** A ship's own copy of its script: Combat::loadScript gives each ship one, and TacticScript::setArg writes into it. */
export function tacticsCode(script: TacticsScript): Uint8Array {
  return decodeBase64(script.code);
}
