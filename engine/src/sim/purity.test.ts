// SPDX-License-Identifier: GPL-3.0-or-later
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = fileURLToPath(new URL('..', import.meta.url));
/** Import specifiers (static, side-effect or dynamic, in either quote) of the browser-side code. */
const FORBIDDEN_IMPORTS = [
  /(?:from\s*|import\s*\(?\s*)['"](?:\.\.\/)+(view|ui|audio|dev|web)(?:\/|['"])/,
  /(?:from\s*|import\s*\(?\s*)['"](three|preact)/,
];
const FORBIDDEN_GLOBALS = /\b(document|window|requestAnimationFrame|AudioContext|indexedDB|HTMLElement)\b/;

/** (Comments may talk about documents and windows.) */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

describe('the simulation', () => {
  it('uses no DOM, view, UI or audio code', async () => {
    const problems: string[] = [];
    for (const dir of ['sim', 'content']) {
      for (const name of await readdir(join(src, dir), { recursive: true })) {
        if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
        const text = await readFile(join(src, dir, name), 'utf8');
        for (const re of FORBIDDEN_IMPORTS) if (re.test(text)) problems.push(`${dir}/${name}: ${re}`);
        if (FORBIDDEN_GLOBALS.test(stripComments(text))) problems.push(`${dir}/${name}: ${FORBIDDEN_GLOBALS}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('keeps the browser code out of the main entry', async () => {
    const index = await readFile(join(src, 'index.ts'), 'utf8');
    expect(index).not.toMatch(/\.\/(view|ui|audio|dev|web)\//);
  });

  it('catches a browser folder imported by its index as well as by a file in it', () => {
    const caught = (line: string) => FORBIDDEN_IMPORTS.some(re => re.test(line));
    expect(caught("import { Session } from '../web';")).toBe(true);
    expect(caught('import type { UiStore } from "../../ui";')).toBe(true);
    expect(caught("import { Stage } from '../view/stage';")).toBe(true);
    expect(caught("const m = await import('../audio');")).toBe(true);
    expect(caught("import { World } from './world';")).toBe(false);
    expect(caught("import { thing } from '../viewer';")).toBe(false);
  });
});
