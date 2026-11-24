// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';

export interface BatchItem {
  id: string;
  /** What the output depends on: see `itemKey`. */
  key: string;
  run(): Promise<{ ok: boolean; detail: string }>;
}

/**
 * Runs items in order on one generator (the caller's); skips an item whose key has a passing output; appends a line per
 * item to the log; never stops mid-item (R11). A throw counts as a failed item, and the batch goes on.
 */
export async function runBatch(
  items: BatchItem[],
  opts: { done(key: string): Promise<boolean>; log(line: string): void },
): Promise<{ ran: number; skipped: number; failed: string[] }> {
  let ran = 0;
  let skipped = 0;
  const failed: string[] = [];
  for (const [i, item] of items.entries()) {
    const tag = `[${i + 1}/${items.length}] ${item.id}`;
    if (await opts.done(item.key)) {
      skipped++;
      opts.log(`${tag} skipped (a passing output has this key ${item.key.slice(0, 12)})`);
      continue;
    }
    opts.log(`${tag} running`);
    const t0 = Date.now();
    let r: { ok: boolean; detail: string };
    try {
      r = await item.run();
    } catch (e) {
      r = { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
    ran++;
    if (!r.ok) failed.push(item.id);
    opts.log(`${tag} ${r.ok ? 'ok' : 'FAILED'} in ${((Date.now() - t0) / 1000).toFixed(0)} s: ${r.detail}`);
  }
  opts.log(`batch: ${ran} ran, ${skipped} skipped, ${failed.length} failed${failed.length ? ` (${failed.join(', ')})` : ''}`);
  return { ran, skipped, failed };
}

/** R11's input key: the recipe text, the model hashes, the reference hashes, the source frame hashes and the pins, hashed. */
export function itemKey(parts: { recipe: string; models: string[]; references: string[]; sources: string[]; pins: string }): string {
  const h = createHash('sha256');
  for (const [name, v] of Object.entries({ recipe: [parts.recipe], models: [...parts.models].sort(), references: [...parts.references].sort(), sources: [...parts.sources].sort(), pins: [parts.pins] })) {
    h.update(`${name}\0${v.join('\0')}\0\0`);
  }
  return h.digest('hex');
}
