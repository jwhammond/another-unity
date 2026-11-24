// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { miniBattle } from '../../testing/combat';
import { anglesTo, dot, facing, foreFacing, forward, fromInternal, hitShield, toInternal } from './aim';
import { fr, v3 } from './math';

describe('aim (weapons.cpp:66-195)', () => {
  it('splits the space around a ship into eight by three planes, from the ship\'s own frame (Combat::facing, weapons.cpp:170-178)', () => {
    const { b } = miniBattle();
    const e = b.ships[0]!;
    // (heading 0: forward is +y, up +z; toInternal(pos - point) against the planes' normals, worked by hand)
    const at = (x: number, y: number, z: number) => facing(e, v3(x, y, z));
    expect([at(0, 1000, 0), at(0, -1000, 0), at(0, 0, 1000), at(0, 0, -1000), at(-1000, 0, 0), at(1000, 0, 0)]).toEqual([1, 6, 0, 3, 2, 5]);
    // (it turns with the ship: a quarter turn to starboard puts +x ahead)
    e.angles = [0x1000, 0, 0];
    expect(forward(1000, 0x1000, 0).x).toBe(1000);
    expect([at(1000, 0, 0), at(-1000, 0, 0)]).toEqual([1, 6]);
    expect([0, 1, 4, 5].every(foreFacing)).toBe(true);
    expect([2, 3, 6, 7].some(foreFacing)).toBe(false);
  });

  it('takes a hit on the shield the shooter faces, folding 6 and 7 into 5 and 1 for ships with six (hitShield, weapons.cpp:180-191)', () => {
    const { b } = miniBattle();
    const [e, chodak] = [b.ships[0]!, b.ships[1]!];
    e.pos = v3(0, 0, 0);
    chodak.pos = v3(0, -1000, 0);
    // (the chodak is behind the Enterprise: facing 6; it has six shields, so 5)
    expect(hitShield(e, chodak)).toBe(5);
    chodak.pos = v3(0, -1000, -2000);
    expect(facing(e, chodak.pos)).toBe(7);
    expect(hitShield(e, chodak)).toBe(1);
    // (the Enterprise has eight)
    chodak.angles = [0, 0, 0];
    chodak.pos = v3(0, 1000, 0);
    expect(hitShield(chodak, e)).toBe(6);
  });

  it('points along a heading and back (forward and anglesTo, weapons.cpp:74-85), and swaps battle and model axes', () => {
    expect(forward(100, 0, 0)).toEqual(v3(0, 100, 0));
    expect(anglesTo(v3(0, 100, 0), v3())).toEqual([0, 0]);
    expect(anglesTo(v3(100, 0, 0), v3())).toEqual([0x1000, 0]);
    expect(anglesTo(v3(0, 0, 100), v3())[1]).toBe(0x1000);
    expect(toInternal(v3(1, 2, 3))).toEqual({ x: 1, y: -3, z: 2 });
    expect(fromInternal(toInternal(v3(1, 2, 3)))).toEqual(v3(1, 2, 3));
    // (Vector3::dot fused as clang does: fma(z, v.z, fma(x, v.x, y * v.y)))
    expect(dot(v3(1, 2, 3), v3(4, 5, 6))).toBe(32);
    // (a case from a C++ program compiled as ScummVM is: rounding each product and sum gives -1031.4478759765625)
    expect(dot(v3(797.999512, 1745.08508, 3743.38452), v3(0.72013402, 0.832071424, -0.816947818))).toBe(fr(-1031.44775));
  });
});
