// SPDX-License-Identifier: GPL-3.0-or-later
export interface ConversationRef {
  conversation: string;
  /** A number, or "?n" for a random situation from 0 to n. */
  situation: string;
}

/** "@conversation,situation" (talk.cpp:273-294, with the world already resolved into the slug). */
export function parseConversationString(s: string): ConversationRef | null {
  if (!s.startsWith('@')) return null;
  const fields = s.slice(1).split(',');
  if (fields.length !== 2 || fields[0] === '' || !/^\??\d+$/.test(fields[1])) return null;
  return { conversation: fields[0], situation: fields[1] };
}
