// SPDX-License-Identifier: GPL-3.0-or-later
import { diffTraces } from '../diff';
import type { Norm, Value } from '../model';
import { testMaps } from './maps';

export const BASE: Record<string, Value> = {
  'obj:picard.pos': '0,0', 'obj:data.pos': '0,0', 'obj:rubble.screen': 'room', 'obj:lever.screen': 'room',
  'obj:lever.state': 0, 'phaser:rubble.health': 10, 'trigger:t3': true,
  'global:adviceId': 'horst3.a1',
};

/** A run of steps as either engine's normalized trace has them (only the TypeScript side's baseline is read). */
export function run(...steps: [string, Norm[]][]): Norm[] {
  return [
    ...steps.flatMap(([text, events], i): Norm[] => [
      { k: 'step', line: i + 1, text },
      ...(i === 0 ? [{ k: 'baseline', values: BASE } as Norm] : []),
      ...events,
    ]),
    { k: 'end' },
  ];
}

export const diff = (s: Norm[], t: Norm[]) => diffTraces(s, t, testMaps());
