// SPDX-License-Identifier: GPL-3.0-or-later
/** One synthetic thing: only what readThing and Astrogation::load read. */
export interface MakeThing {
  id?: number; type?: number; seed?: number; x?: number; y?: number; z?: number; name?: string; range?: number;
  // stars
  flags?: number; spectralClass?: number; magnitude?: number; orbitScale?: number;
  systemName?: string; scriptedName?: string; scriptedDescription?: string;
  // stations (a sector) and specials (sector, star, planet)
  sector?: number; star?: number; planet?: number;
}
export interface MakeSector { numStars?: number; numPhenomena?: number; alignment?: number; description?: string | null }

/**
 * An astro.db in Astrogation::load's layout: 512 sector records (0x24 bytes; the first ones given, the rest empty), the stars (0x44),
 * the phenomena (0x28), the station and special counts, the stations and specials (0x24), then the string pool.
 */
export function makeAstroDb(o: { sectors?: MakeSector[]; stars?: MakeThing[]; phenomena?: MakeThing[]; stations?: MakeThing[]; specials?: MakeThing[] }): Uint8Array {
  const pool: number[] = [];
  const add = (s: string | null | undefined): number => {
    if (s === null || s === undefined) return -1;
    const at = pool.length;
    pool.push(...Buffer.from(s, 'latin1'), 0);
    return at;
  };
  const record = (size: number, write: (v: DataView) => void): number[] => {
    const buf = new ArrayBuffer(size);
    write(new DataView(buf));
    return [...new Uint8Array(buf)];
  };
  const thing = (v: DataView, t: MakeThing) => {
    v.setUint16(4, t.id ?? 0, true); v.setUint8(6, t.type ?? 0); v.setUint32(8, t.seed ?? 0, true);
    v.setInt32(0xc, t.x ?? 0, true); v.setInt32(0x10, t.y ?? 0, true); v.setInt32(0x14, t.z ?? 0, true);
    v.setInt32(0x1c, add(t.name), true);
  };
  const sectors = Array.from({ length: 512 }, (_, i) => o.sectors?.[i] ?? {});
  const out: number[] = [];
  for (const s of sectors) {
    out.push(...record(0x24, v => {
      v.setUint32(4, s.numStars ?? 0, true); v.setUint32(8, s.numPhenomena ?? 0, true); v.setUint32(0x10, s.alignment ?? 0, true);
      v.setInt32(0x20, s.description === undefined ? -1 : add(s.description), true);
    }));
  }
  for (const t of o.stars ?? []) {
    out.push(...record(0x44, v => {
      thing(v, t);
      v.setUint8(0x20, t.flags ?? 0); v.setInt16(0x24, t.spectralClass ?? 0, true); v.setInt16(0x26, t.magnitude ?? 0, true);
      v.setInt16(0x28, t.orbitScale ?? 0, true);
      v.setInt32(0x30, add(t.systemName), true); v.setInt32(0x34, add(t.scriptedName), true); v.setInt32(0x38, add(t.scriptedDescription), true);
    }));
  }
  for (const t of o.phenomena ?? []) out.push(...record(0x28, v => { thing(v, t); v.setInt16(0x20, t.range ?? 0, true); }));
  out.push(...record(8, v => { v.setUint32(0, o.stations?.length ?? 0, true); v.setUint32(4, o.specials?.length ?? 0, true); }));
  for (const t of o.stations ?? []) out.push(...record(0x24, v => { thing(v, t); v.setInt32(0x20, t.sector ?? -1, true); }));
  for (const t of o.specials ?? []) {
    out.push(...record(0x24, v => {
      thing(v, t); v.setInt16(0x20, t.sector ?? 0, true); v.setUint8(0x22, t.star ?? 0); v.setUint8(0x23, t.planet ?? 0);
    }));
  }
  return Uint8Array.from([...out, ...pool]);
}
