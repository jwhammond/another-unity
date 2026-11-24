// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { gateParamsJson } from '../../../apps/web/src/gate/params';
import { readScanInputs, type InputDeps } from './inputs';

// Made-up inputs only: a gate of no real disc, and strings of no game.
const GATE_YAML = gateParamsJson({
  version: 1,
  salt: new Uint8Array(32).map((_, i) => i),
  ranges: [1, 2, 3].map(n => ({ path: `MADEUP/FILE${n}.BIN`, offset: 10_000 * n, length: 65_536 })),
});
const ALLOW = JSON.stringify([{ path: 'icons/made-up.png', blob: 'a'.repeat(40), why: 'our own icon' }]);

function deps(o: { gate?: string | null; sample?: string[] | 'throws'; allow?: string } = {}): InputDeps & { logged: string[] } {
  const logged: string[] = [];
  return {
    logged,
    readFile(path) {
      if (path.endsWith('gate.yaml')) {
        if (o.gate === null) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
        return o.gate ?? GATE_YAML;
      }
      if (o.allow === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return o.allow;
    },
    sample() {
      if (o.sample === 'throws') throw new Error('made-up sampler failure: SOME QUOTED LINE');
      return o.sample ?? ['a made-up line of text'];
    },
    log: m => logged.push(m),
  };
}

const read = (strict: boolean, d: InputDeps) => readScanInputs({ gameDir: 'games/x', allowPath: 'allow.json', sample: {}, strict }, d);

describe('readScanInputs', () => {
  it('reads the gate, the lifted text and the allow-list', () => {
    const r = read(true, deps({ allow: ALLOW }));
    expect(r.gate?.ranges).toHaveLength(3);
    expect(r.text).toEqual(['a made-up line of text']);
    expect(r.allow).toEqual([{ path: 'icons/made-up.png', blob: 'a'.repeat(40), why: 'our own icon' }]);
  });

  it('fails closed for a tree when gate.yaml is missing or unreadable', () => {
    expect(() => read(true, deps({ gate: null }))).toThrow(/no usable games\/x\/gate\.yaml \(ENOENT\)/);
    expect(() => read(true, deps({ gate: 'not: [a gate' }))).toThrow(/no usable games\/x\/gate\.yaml/);
  });

  it('fails closed for a tree when the lifted text yields nothing, or the sampler throws, without quoting its error', () => {
    expect(() => read(true, deps({ sample: [] }))).toThrow(/no lifted text found under games\/x/);
    let message = '';
    try {
      read(true, deps({ sample: 'throws' }));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/reading the lifted text under games\/x failed/);
    expect(message).not.toContain('QUOTED');
  });

  it('skips a missing input with a notice for the history scan', () => {
    const d = deps({ gate: null, sample: 'throws' });
    const r = read(false, d);
    expect(r.gate).toBeUndefined();
    expect(r.text).toEqual([]);
    expect(r.allow).toEqual([]);
    expect(d.logged).toEqual(['scan: no usable gate.yaml; the gate rule is skipped', 'scan: no lifted text found; the lifted-text rule is skipped']);
  });
});
