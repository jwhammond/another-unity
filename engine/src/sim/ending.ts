// SPDX-License-Identifier: GPL-3.0-or-later
import type { GameContent } from '../content/types';

export type Ending = { won: true } | { won: false; text?: string };

/**
 * endGame (unity.cpp): reasons 3 and 0x20 win (the credits, M6); otherwise the Admiral's log gives the reason's line,
 * response `reason - 1` of the game-over situation, with 4 read as 1 (M3 Plan 8 R9).
 */
export function ending(content: GameContent, reason: number): Ending {
  if (reason === 3 || reason === 0x20) return { won: true };
  const ref = content.rules.lines.gameOver;
  const key = (reason === 4 ? 1 : reason) - 1;
  const r = ref ? content.conversations[ref.conversation]?.responses.find(x => x.situation === ref.situation && x.key === key) : undefined;
  const text = r?.replies?.[0]?.text ?? r?.text;
  return { won: false, ...(text ? { text } : {}) };
}
