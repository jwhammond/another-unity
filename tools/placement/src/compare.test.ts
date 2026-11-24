// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { GameMaps } from '../../tracediff/src/maps';
import { compareRoom, type OursObject } from './compare';
import type { ScummObject } from './scummvm';

const base: ScummObject & { slug: string } = { id: '040308', slug: 'lab.big_cable.0308', name: 'big cable', screen: 3, x: 390, y: 260, z: -1, width: 260, height: 45, flags: 0x3e, active: true, state: 0, sprite: 716, anim: 0, player: true, playing: 0, nothingShown: false, stopped: true };
// (a projection that maps a pixel to metres as x / 100, y / 100)
const maps = { pos: (_room: string, x: number, y: number) => `${x / 100},${y / 100}` } as unknown as GameMaps;
const ours = (over: Partial<OursObject> = {}): Record<string, OursObject> => ({ 'lab.big_cable.0308': { screen: 'lab.s03', active: true, state: 0, pos: { x: 3.9, z: 2.6 }, ...over } });
const name = (id: number) => `sprite${id}`;

describe('compareRoom', () => {
  it('finds nothing when the two agree and the art stands the sprite in', () => {
    expect(compareRoom('lab.s03', [base], ours(), maps, new Set(['lab.big_cable.0308']), name)).toEqual([]);
  });

  it('reports an object ScummVM has on that we have off, and one standing elsewhere', () => {
    const f = compareRoom('lab.s03', [base], ours({ active: false, pos: { x: 5, z: 2.6 } }), maps, null, name);
    expect(f.map(x => x.kind)).toEqual(['active', 'position']);
  });

  it('reports a sprite ScummVM draws that the art has no layer for, and one playing an animation the still is not', () => {
    const recipes = new Map([['lab.big_cable.0308', { id: 'card.lab_big_cable', anim: 0 }]]);
    const f = compareRoom('lab.s03', [{ ...base, playing: 1 }], ours(), maps, new Set(), name, recipes);
    expect(f.map(x => [x.kind, x.scummvm, x.ours])).toEqual([['no-art', 'sprite716 anim 1', 'card.lab_big_cable is not published'], ['anim', 'sprite716 anim 1', 'card.lab_big_cable shows animation 0']]);
    // (a sprite with nothing shown is not drawn, and a room with no art is not asked)
    expect(compareRoom('lab.s03', [{ ...base, nothingShown: true }], ours(), maps, new Set(), name)).toEqual([]);
    expect(compareRoom('lab.s03', [base], ours(), maps, null, name)).toEqual([]);
  });
});
