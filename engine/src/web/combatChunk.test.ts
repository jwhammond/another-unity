// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The combat chunk stays lazy (M8 spec §8): the space view's modules come in with spaceScene's dynamic import, never with
 * the main bundle. A module the main bundle reaches by a value import is in main (Rollup hoists it there and the chunk
 * imports it back), so none of them may be reached from the main bundle's modules except by `import type` or `import()`.
 */
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** The main bundle's modules that lead to the combat view: the session, the view's host and the battle set's loader. */
const ENTRIES = ['web/session.ts', 'web/combatView.ts', 'view/combat/assets.ts', 'ui/ship/tactical.tsx', 'ui/ship/bridge.tsx'];
/** The chunk's own modules. */
const CHUNK_ONLY = ['spaceScene', 'effects', 'draw', 'warp', 'bloom', 'effectLayer', 'warpOverlay', 'console', 'consoleFrame', 'consoleInput', 'controls', 'hud', 'radar', 'scanner'].map(m => `view/combat/${m}.ts`).concat('ui/combat/console.tsx', 'ui/combat/hud.tsx', 'ui/combat/drawer.tsx', 'ui/combat/viewInput.tsx', 'ui/combat/controls.ts');

/** A module's static value imports (and re-exports), resolved to files under src: not `import type`, `export type`, or one whose names are all types. */
function valueImports(file: string): string[] {
  const text = readFileSync(resolve(SRC, file), 'utf8');
  const out: string[] = [];
  for (const m of text.matchAll(/^(import|export)\s+(type\s+)?([^;]*?)\s*from\s+'([^']+)'/gms)) {
    const [, , typeOnly, names, spec] = m;
    if (typeOnly || !spec!.startsWith('.')) continue;
    const braces = /^\{([^}]*)\}$/.exec(names!.trim());
    if (braces && braces[1]!.split(',').map(s => s.trim()).filter(Boolean).every(s => s.startsWith('type '))) continue;
    const base = resolve(dirname(resolve(SRC, file)), spec!);
    const found = [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find(p => existsSync(p));
    if (found) out.push(relative(SRC, found));
  }
  return out;
}

describe('the combat chunk (M8 spec §8)', () => {
  it('is reached from the main bundle\'s modules by no value import', () => {
    const via = new Map<string, string>(ENTRIES.map(e => [e, '']));
    const queue = [...ENTRIES];
    while (queue.length) {
      const file = queue.shift()!;
      for (const next of valueImports(file)) {
        if (via.has(next)) continue;
        via.set(next, file);
        queue.push(next);
      }
    }
    const path = (f: string): string => (via.get(f) ? `${path(via.get(f)!)} -> ${f}` : f);
    expect(CHUNK_ONLY.filter(f => via.has(f)).map(path)).toEqual([]);
  });

  it('finds a value import, and skips a type-only one (the walk itself)', () => {
    expect(valueImports('web/combatView.ts')).toContain('view/combat/projection.ts');
    expect(valueImports('web/combatView.ts')).not.toContain('view/combat/spaceScene.ts');
  });
});
