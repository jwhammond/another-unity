// SPDX-License-Identifier: GPL-3.0-or-later
import { parse } from 'yaml';
import { z } from 'zod';

const box = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number(), font: z.number(), lines: z.array(z.string()) }).strict();
const schema = z.record(z.record(box));

/** One screen text as the game draws it: a box in the 640 by 480 screen's pixels and its lines. */
export type ScreenTextBox = z.infer<typeof box>;

/** screentexts.yaml: the text a script shows on a screen itself (a `^N` line), by screen and record. */
export class ScreenTextTable {
  constructor(private readonly table: Record<string, Record<string, ScreenTextBox>> = {}) {}

  static parse(text: string | undefined): ScreenTextTable {
    return new ScreenTextTable(schema.parse(text === undefined ? {} : parse(text) ?? {}));
  }

  /** The record, or undefined where the game has none (it warns and shows nothing). */
  get(screen: string, id: number): ScreenTextBox | undefined {
    return this.table[screen]?.[String(id)];
  }
}
