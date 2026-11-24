// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SHIP_TRIGGERS_OFF } from './preamble';

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

describe('the harness preamble', () => {
  it('turns off the same triggers in ScummVM\'s runs as the TypeScript runner does', () => {
    const ids = /for t in ([^;]+); do/.exec(read('../run-scummvm.sh'))?.[1].trim().split(/\s+/).map(Number);
    expect(ids).toEqual(SHIP_TRIGGERS_OFF);
    const walk = read('../../rawcheck/harness/walk/script.txt');
    expect([...walk.matchAll(/^trigger (\S+) off$/gm)].map(m => Number(m[1]))).toEqual(SHIP_TRIGGERS_OFF);
  });
});
