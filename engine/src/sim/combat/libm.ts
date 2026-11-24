// SPDX-License-Identifier: GPL-3.0-or-later
import { decodeBase64 } from '../../content/tactics';
import type { CombatData } from '../../content/types';
import { bindLibm, MATH_LIBM, type Libm } from './math';
import type { BattleContext } from './types';

/** The angles a turn has (16384), and so the entries in each of the trig table's columns. */
export const TRIG_ANGLES = 0x4000;

const tables = new WeakMap<CombatData, { sin: Float32Array; cos: Float32Array } | null>();

/**
 * combat.yaml's `trig` (ScummVM's sinf and cosf of each whole angle, float32 little-endian, base64) as tables; null
 * without it. A table that isn't TRIG_ANGLES floats a column (hand-edited or corrupt: the lift checks the length) is
 * an error: falling back to Math's sinf and cosf would quietly fly the battle apart from ScummVM's.
 */
export function trigTables(combat: CombatData): { sin: Float32Array; cos: Float32Array } | null {
  let t = tables.get(combat);
  if (t === undefined) {
    const column = (bytes: Uint8Array): Float32Array => {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const out = new Float32Array(TRIG_ANGLES);
      for (let i = 0; i < TRIG_ANGLES; i++) out[i] = view.getFloat32(i * 4, true);
      return out;
    };
    const sin = combat.trig ? decodeBase64(combat.trig.sin) : null;
    const cos = combat.trig ? decodeBase64(combat.trig.cos) : null;
    if (combat.trig && !(sin && cos && sin.length === TRIG_ANGLES * 4 && cos.length === TRIG_ANGLES * 4)) {
      throw new Error(`combat.yaml's trig table has ${sin?.length ?? 'unreadable'} bytes of sinf and ${cos?.length ?? 'unreadable'} of cosf, not ${TRIG_ANGLES * 4} each`);
    }
    t = sin && cos ? { sin: column(sin), cos: column(cos) } : null;
    tables.set(combat, t);
  }
  return t;
}

/**
 * Binds the battle's C library (math.ts' bindLibm): the lifted trig table, if the lift has it, and the context's
 * angle oracle (a parity replay's only). Every sim entry calls it first (setupBattle, updateBattle, applyCommand and
 * tactical.ts' startBattle and tacticalUpdate), so the maths a battle does is always its own context's.
 */
export function bindContext(ctx: BattleContext): void {
  const t = trigTables(ctx.combat);
  const libm: Libm = t || ctx.angleOracle ? { sin: t?.sin ?? null, cos: t?.cos ?? null, angle: ctx.angleOracle ?? null } : MATH_LIBM;
  bindLibm(libm);
}
