// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { encodeBase64 } from '../../content/tactics';
import { miniBattle, miniBattleContext, miniCombat } from '../../testing/combat';
import { bindContext, TRIG_ANGLES, trigTables } from './libm';
import { angleFromSinCos, bindLibm, cosAngle, fr, MATH_LIBM, sinAngle, sinf } from './math';
import { forward } from './aim';
import { updateBattle } from './battle';
import { applyCommand } from './commands';
import type { BattleContext } from './types';

/** A made-up table: sin(i) = i / 16384 and cos(i) = -i / 16384, as float32 little-endian in base64, as combat.yaml's `trig` holds them. */
function madeUpTrig(): { sin: string; cos: string } {
  const column = (sign: number) => {
    const bytes = new Uint8Array(TRIG_ANGLES * 4);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < TRIG_ANGLES; i++) view.setFloat32(i * 4, (sign * i) / TRIG_ANGLES, true);
    return encodeBase64(bytes);
  };
  return { sin: column(1), cos: column(-1) };
}

describe('the C library the sim reads (Plan 22 R1)', () => {
  afterEach(() => bindLibm(MATH_LIBM));

  it('decodes the lifted table once per combat data, and has none without it; a table of the wrong length is an error', () => {
    const combat = { ...miniCombat(), trig: madeUpTrig() };
    const t = trigTables(combat)!;
    expect([t.sin[0], t.sin[4096], t.cos[8192], t.sin.length]).toEqual([0, 0.25, -0.5, TRIG_ANGLES]);
    expect(trigTables(combat)).toBe(t);
    expect(trigTables(miniCombat())).toBeNull();
    expect(() => trigTables({ ...miniCombat(), trig: { sin: encodeBase64(new Uint8Array(8)), cos: encodeBase64(new Uint8Array(8)) } }))
      .toThrow(`combat.yaml's trig table has 8 bytes of sinf and 8 of cosf, not ${TRIG_ANGLES * 4} each`);
    expect(() => trigTables({ ...miniCombat(), trig: { ...madeUpTrig(), cos: encodeBase64(new Uint8Array(TRIG_ANGLES * 4 + 4)) } })).toThrow(/of cosf/);
    // (and so at a battle's entry, never Math's in its place)
    expect(() => bindContext(miniBattleContext({}, { ...miniCombat(), trig: { sin: '', cos: '' } }))).toThrow(/trig table/);
  });

  it('reads sinf and cosf of a whole angle from the bound table, masking it, and Math\'s without one', () => {
    bindContext(miniBattleContext({}, { ...miniCombat(), trig: madeUpTrig() }));
    expect([sinAngle(4096), cosAngle(4096), sinAngle(4096 + 16384), sinAngle(-16384 + 1)]).toEqual([0.25, -0.25, 0.25, fr(1 / 16384)]);
    // (aim.ts's forward from the table: sinf(a0) * cosf(a1) * len = 0.25 * -0.5 * 4, cosf(a0) * cosf(a1) * len = -0.25 * -0.5 * 4, sinf(a1) * len = 0.5 * 4)
    expect(forward(4, 4096, 8192)).toEqual({ x: -0.5, y: 0.5, z: 2 });
    bindContext(miniBattleContext());
    expect(sinAngle(4096)).toBe(1);
    expect([cosAngle(0), sinAngle(1)]).toEqual([1, sinf(fr(fr(fr(2) * fr(Math.PI)) / 16384))]);
    bindLibm(MATH_LIBM);
  });

  it('takes the angle oracle\'s say over atan2f only where it is bound: ScummVM\'s atan2f(0, -1) is the float below pi', () => {
    const ctx: BattleContext = { ...miniBattleContext(), angleOracle: (s, c, angle) => (s === 0 && c === -1 ? 8191 : angle) };
    bindContext(ctx);
    expect([angleFromSinCos(0, -1), angleFromSinCos(1, 0)]).toEqual([8191, 4096]);
    bindContext(miniBattleContext());
    expect(angleFromSinCos(0, -1)).toBe(8192);
  });

  it('binds at each entry: a battle set up with the table flies by it, and the next without it by Math', () => {
    miniBattle({ ctx: miniBattleContext({}, { ...miniCombat(), trig: madeUpTrig() }) });
    expect(sinAngle(4096)).toBe(0.25);
    miniBattle();
    expect(sinAngle(4096)).toBe(1);
  });

  it('binds the battle\'s own library at updateBattle and applyCommand, whichever was bound before', () => {
    const a = miniBattle({ ctx: miniBattleContext({}, { ...miniCombat(), trig: madeUpTrig() }) });
    const b = miniBattle();
    const entries: [string, (x: typeof a) => void][] = [
      ['updateBattle', x => updateBattle(x.ctx, x.b, 10100)],
      ['applyCommand', x => applyCommand(x.ctx, x.b, { type: 'allStop' })],
    ];
    for (const [name, enter] of entries) {
      bindContext(b.ctx);
      enter(a);
      expect(sinAngle(4096), `${name} with the table`).toBe(0.25);
      bindContext(a.ctx);
      enter(b);
      expect(sinAngle(4096), `${name} without the table`).toBe(1);
    }
  });
});
