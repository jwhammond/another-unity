// SPDX-License-Identifier: GPL-3.0-or-later
import { parse } from 'yaml';
import { z } from 'zod';
import type { ReadingPage } from '../content/types';

const schema = z.record(z.record(z.array(z.object({ title: z.string(), heading: z.string(), text: z.string() }).strict())));

/** readings.yaml: the computer entries each tricorder reading shows, by world and group (M3 Decision 13). */
export class ReadingTable {
  constructor(private readonly table: Record<string, Record<string, ReadingPage[]>> = {}) {}

  static parse(text: string | undefined): ReadingTable {
    return new ReadingTable(schema.parse(text === undefined ? {} : parse(text) ?? {}));
  }

  pages(world: string, group: number): ReadingPage[] {
    return this.table[world]?.[String(group)] ?? [];
  }
}
