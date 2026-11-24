// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * space3d's float maths (space3d.h:39-63, space3d.cpp:33-90), in float32 (spec §4.4). Every value ScummVM keeps in
 * a `float` is rounded with Math.fround after each operation: a product, sum or quotient of two float32 values worked
 * in double and rounded once is the float32 result exactly.
 *
 * The reference build (Apple clang, arm64, ScummVM's configure: no -O, default -ffp-contract=on) fuses a multiply
 * and an add written in one expression into one fused multiply-add, rounded once. Measured (Plan 19): `a * b + c`
 * and `c + a * b` are fma(a, b, c), the left product fused when both sides are products (`a * b + c * d` is
 * fma(a, b, c * d)); `x -= y * z` is fma(-y, z, x) and `x += y * z` fma(y, z, x); a product under a division is not
 * fused; Vector3's operators are separate functions, so `pos + forward * k` is not. Code ported from combat.cpp and
 * space3d.cpp writes fma32 exactly where clang fuses, with the C expression in a comment.
 *
 * The C library (Plan 22's R1). Apple's libm differs from Math rounded to float32 by a float32 step for some inputs
 * (sinf on 218 and cosf on 211 of the 16384 whole angles; atan2f on about 6% of inputs, which moves
 * angleFromSinCos's whole angle on 26 of 2,000,000; atan2f(0, -1) is 3.1415925, not the float nearest pi). ScummVM
 * takes sinf and cosf only of whole angles (16384 to a turn), so the sim reads them from ScummVM's own table, lifted
 * as combat.yaml's `trig` (sinAngle, cosAngle); without it (a synthetic fixture) they are Math's, rounded. atan2f has
 * no table: angleFromSinCos is Math's, and a parity replay alone may put ScummVM's angle in where its trace says the
 * two differ (the angle oracle; tracediff's `libm-atan2f` allowance). sqrtf is correctly rounded in both: no
 * difference. The table and the oracle are bound from the battle's context at each sim entry (bindLibm).
 */
export const fr = Math.fround;

/** An unsigned 32-bit value in hex, as the original's %x prints a token's opcode or a screen's number. */
export const hex = (n: number): string => (n >>> 0).toString(16);

/** The flight controls by axis, in the order HEADING, CLIMB and BANK index them (tactics.cpp:768) and inputHistory keeps them (ai.cpp:80). */
export const AXES = ['yaw', 'pitch', 'roll'] as const;

/**
 * fmaf(a, b, c) for float32 a, b and c: a * b is exact in double, so the only error is the double sum's rounding,
 * which matters only when that sum lands exactly halfway between two float32 values (then the sum's rounding error
 * says which way the exact value lies).
 */
export function fma32(a: number, b: number, c: number): number {
  const p = a * b;
  const s = p + c;
  const r = fr(s);
  const other = 2 * s - r;
  // (not a halfway point between r and a neighbour: rounding s is rounding the exact sum)
  if (other === r || fr(other) !== other) return r;
  const z = s - p;
  const err = (p - (s - z)) + (c - z);
  if (err === 0) return r;
  return (err > 0) === (other > r) ? other : r;
}

/** CLIP (common/util.h): (v < lo) ? lo : (v > hi) ? hi : v. */
export const clip = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** (float)M_PI. */
export const PI_F = fr(Math.PI);

/** Vector3 (space3d.h:39-51). Battle positions are x, y forward and z up (combat.h:138 CombatShip); models are x right, y down, z forward. */
export interface V3 { x: number; y: number; z: number }

/** Vector3's constructors (space3d.h:42-43): zero by default. */
export const v3 = (x = 0, y = 0, z = 0): V3 => ({ x: fr(x), y: fr(y), z: fr(z) });
/** Vector3::operator+ (space3d.h:48). */
export const add = (a: V3, b: V3): V3 => ({ x: fr(a.x + b.x), y: fr(a.y + b.y), z: fr(a.z + b.z) });
/** Vector3::operator- (space3d.h:49). */
export const sub = (a: V3, b: V3): V3 => ({ x: fr(a.x - b.x), y: fr(a.y - b.y), z: fr(a.z - b.z) });
/** Vector3::operator* (space3d.h:50), by a float. */
export const scale = (a: V3, f: number): V3 => ({ x: fr(a.x * f), y: fr(a.y * f), z: fr(a.z * f) });

/** Vector3::length (space3d.cpp:38-40): sqrtf(x * x + y * y + z * z). */
export function length(a: V3): number {
  // (fma(z, z, fma(x, x, y * y)))
  return sqrtf(fma32(a.z, a.z, fma32(a.x, a.x, fr(a.y * a.y))));
}

/** The C library's float functions as Math's, rounded: sqrtf is exact; sinf, cosf and atan2f are the libm difference above. */
export const sinf = (x: number): number => fr(Math.sin(x));
export const cosf = (x: number): number => fr(Math.cos(x));
export const atan2f = (y: number, x: number): number => fr(Math.atan2(y, x));
export const sqrtf = (x: number): number => fr(Math.sqrt(x));

/** A parity replay's say over angleFromSinCos: given the inputs and Math's angle, the angle ScummVM's atan2f gave. */
export type AngleOracle = (s: number, c: number, angle: number) => number;
/** What the sim takes from ScummVM's C library: sinf and cosf of each whole angle (16384 each, or null for Math's), and the angle oracle. */
export interface Libm { sin: Float32Array | null; cos: Float32Array | null; angle: AngleOracle | null }
export const MATH_LIBM: Readonly<Libm> = Object.freeze({ sin: null, cos: null, angle: null });
let libm: Readonly<Libm> = MATH_LIBM;
/** Binds the C library the sim's maths reads until the next bind (each sim entry binds its context's: libm.ts' bindContext); returns the one it replaces. */
export function bindLibm(l: Readonly<Libm>): Readonly<Libm> {
  const was = libm;
  libm = l;
  return was;
}
/** sinf(angleToRadians(angle)) as ScummVM's build gives it (the lifted table), else Math's. */
export function sinAngle(angle: number): number {
  return libm.sin ? libm.sin[angle & 0x3fff]! : sinf(angleToRadians(angle));
}
/** cosf(angleToRadians(angle)) as ScummVM's build gives it (the lifted table), else Math's. */
export function cosAngle(angle: number): number {
  return libm.cos ? libm.cos[angle & 0x3fff]! : cosf(angleToRadians(angle));
}

/** angleToRadians (space3d.cpp:33-36): (angle & 0x3fff) * 2.0f * (float)M_PI / 16384.0f, 16384 to a turn. */
export function angleToRadians(angle: number): number {
  return fr(fr(fr((angle & 0x3fff) * 2) * PI_F) / 16384);
}

/** angleFromSinCos (space3d.cpp:47-49): (int)(atan2f(s, c) * 16384.0f / (2.0f * (float)M_PI)) & 0x3fff. */
export function angleFromSinCos(s: number, c: number): number {
  const angle = Math.trunc(fr(fr(atan2f(s, c) * 16384) / fr(2 * PI_F))) & 0x3fff;
  return libm.angle ? libm.angle(s, c, angle) : angle;
}

/** Matrix3 (space3d.h:53-63), row-major: m[row * 3 + column]; applied to row vectors (v * M). */
export type M3 = number[];

/** Matrix3::apply (space3d.cpp:51-55). */
export function apply(m: M3, v: V3): V3 {
  // (v.x * m[0][j] + v.y * m[1][j] + v.z * m[2][j]: fma(v.z, m2j, fma(v.x, m0j, v.y * m1j)))
  const col = (j: number) => fma32(v.z, m[6 + j]!, fma32(v.x, m[j]!, fr(v.y * m[3 + j]!)));
  return { x: col(0), y: col(1), z: col(2) };
}

/** Matrix3::transpose (space3d.cpp:57-64). */
export function transpose(m: M3): M3 {
  return [m[0]!, m[3]!, m[6]!, m[1]!, m[4]!, m[7]!, m[2]!, m[5]!, m[8]!];
}

/** Matrix3::operator* (space3d.cpp:66-73). */
export function mul(a: M3, b: M3): M3 {
  const r: M3 = [];
  for (let i = 0; i < 3; i++) {
    // (m[i][0] * o[0][j] + m[i][1] * o[1][j] + m[i][2] * o[2][j])
    for (let j = 0; j < 3; j++) r.push(fma32(a[i * 3 + 2]!, b[6 + j]!, fma32(a[i * 3]!, b[j]!, fr(a[i * 3 + 1]! * b[3 + j]!))));
  }
  return r;
}

/** Matrix3::fromAngles (space3d.cpp:75-90): rolled, then pitched, then turned; 16384 to a turn. */
export function fromAngles(yaw: number, pitch: number, roll: number): M3 {
  const s0 = sinAngle(yaw), c0 = cosAngle(yaw);
  const s1 = sinAngle(pitch), c1 = cosAngle(pitch);
  const s2 = sinAngle(roll), c2 = cosAngle(roll);
  // (c0 * c2 + s0 * s1 * s2 is fma(c0, c2, s0 * s1 * s2), and so on)
  return [
    fma32(c0, c2, fr(fr(s0 * s1) * s2)), fr(c1 * s2), fma32(-s0, c2, fr(fr(c0 * s1) * s2)),
    fma32(-c0, s2, fr(fr(s0 * s1) * c2)), fr(c1 * c2), fma32(s0, s2, fr(fr(c0 * s1) * c2)),
    fr(c1 * s0), -s1, fr(c1 * c0),
  ];
}

/** Vector3::cross (space3d.h:45): y * v.z - z * v.y and so on, which clang fuses as fma(y, v.z, -(z * v.y)) (the left product: Plan 19's R2). */
export function cross(a: V3, b: V3): V3 {
  return { x: fma32(a.y, b.z, -fr(a.z * b.y)), y: fma32(a.z, b.x, -fr(a.x * b.z)), z: fma32(a.x, b.y, -fr(a.y * b.x)) };
}

/** Vector3::normalized (space3d.cpp:42-45): `*this * (1.0f / l)`, or itself when its length is 0. */
export function normalized(a: V3): V3 {
  const l = length(a);
  return l > 0 ? scale(a, fr(1 / l)) : a;
}

/** Matrix3::fromRows (space3d.cpp:92-101): the three vectors as its rows. */
export function fromRows(x: V3, y: V3, z: V3): M3 {
  return [x.x, x.y, x.z, y.x, y.y, y.z, z.x, z.y, z.z];
}
