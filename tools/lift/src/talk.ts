// SPDX-License-Identifier: GPL-3.0-or-later
import { conversationKey, type IdTable } from './ids';
import type { Problems } from './problems';

/** Object::setTalkString (object.cpp:981-1005): a "-verb-preposition-" suffix names the use words, and isn't said. */
export function stripUseWords(s: string): string {
  if (s.length < 2 || !s.endsWith('-')) return s;
  const words: string[] = [];
  let end = s.length - 1;
  while (words.length < 2 && end > 0) {
    let start = end;
    while (start > 0 && s[start - 1] !== '-') start--;
    if (start === 0) return s;
    words.unshift(s.slice(start, end));
    end = start - 1;
  }
  return s.slice(0, end).trim();
}

/**
 * "@world,id,situation" (world in decimal) or "@id,situation" (in `world`), read as sayString reads it (talk.cpp:273-294):
 * the situation is atoi's number (or "?n"), whatever follows it. Null if `s` isn't one.
 */
export function parseTalk(s: string, world: number | null): { world: number | null; id: number; situation: string; tail: string } | null {
  if (!s.startsWith('@')) return null;
  const fields = s.slice(1).split(',').map(f => f.trim());
  let w = world;
  if (fields.length === 3 && /^\d+$/.test(fields[0])) w = parseInt(fields.shift() ?? '', 10);
  const situation = fields.length === 2 ? /^(\??\d+)(.*)$/s.exec(fields[1]) : null;
  if (fields.length !== 2 || !/^\d+$/.test(fields[0]) || !situation) return null;
  return { world: w, id: parseInt(fields[0], 10), situation: situation[1], tail: situation[2].trim() };
}

/** A conversation string becomes "@<slug>,<situation>"; other talk strings are kept as they are. */
export function convertTalk(s: string, world: number | null, ids: IdTable, problems: Problems, where: string): string {
  if (!s.startsWith('@')) return s;
  const t = parseTalk(s, world);
  if (!t) {
    problems.error(where, `bad conversation string "${s}"`);
    return s;
  }
  if (t.tail !== '') problems.warn(where, `"${s}" has "${t.tail}" after its situation, which atoi ignores (talk.cpp:273-294)`);
  if (t.world === null) {
    // (in a ship conversation's results, "@id,sit" is in the talk target's world, which can be any: Decision 11)
    problems.error(where, `"${s}" names a conversation in the talk target's world, which isn't fixed here (give the list a screen in overrides/contexts.yaml)`);
    return s;
  }
  return `@${ids.conversation(t.world, t.id, where)},${t.situation}`;
}

/** The IR key of the conversation a "@…" string names, or null if it names none it can know. */
export function talkConversationKey(s: string, world: number | null): string | null {
  const t = parseTalk(s, world);
  return t && t.world !== null ? conversationKey(t.world, t.id) : null;
}

/** The voice type sayString uses: 'l' for a description ("|…"), 't' for anything said. */
export function talkVoiceType(s: string): 'l' | 't' {
  return s.startsWith('|') ? 'l' : 't';
}

/** CommunicateBlock's sscanf(talk_string, "@%d,%d") (object.cpp:1858): the first two numbers, whatever follows. */
export function hailNumbers(talk: string): { conversation: number; situation: number; threeFields: boolean } | null {
  const m = /^@\s*(\d+)\s*,\s*(\d+)/.exec(talk);
  if (!m) return null;
  return { conversation: Number(m[1]), situation: Number(m[2]), threeFields: /^@\s*\d+\s*,\s*\d+\s*,/.test(talk) };
}
