// SPDX-License-Identifier: GPL-3.0-or-later
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** One JSON file of an export. (All non-ASCII bytes are \u escapes, so UTF-8 reads it exactly.) */
export async function readJson(dir: string, rel: string): Promise<unknown> {
  return JSON.parse(await readFile(join(dir, rel), 'utf8'));
}

/** The object lines printed by each `objects` console command in a run's out.log. */
export function objectsBlocks(log: string): string[][] {
  const lines = log.split('\n');
  const blocks: string[][] = [];
  lines.forEach((line, i) => {
    const header = /^Screen \d+\/\d+ has (\d+) object\(s\):$/.exec(line);
    if (!header) return;
    const want = Number(header[1]);
    const block: string[] = [];
    for (let j = i + 1; j < lines.length && block.length < want; j++) {
      if (/^\s*\d+: [0-9a-f]{6} /.test(lines[j])) block.push(lines[j]);
    }
    blocks.push(block);
  });
  return blocks;
}
