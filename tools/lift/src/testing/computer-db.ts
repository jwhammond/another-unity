// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A computer.db in loadComputerDatabase's layout: a count, each entry's offset (and the end), then per entry its 20-byte header,
 * its subentries' offsets, and (after all entries) the strings. `subentries` are entry indexes, or `{ offset }` for one that matches none.
 */
export function makeDb(entries: { title: string; heading: string; text: string; flags?: number; subentries?: (number | { offset: number })[] }[]): Uint8Array {
  const u16 = (v: number) => [v & 0xff, v >> 8];
  const u32 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24];
  const sizes = entries.map(e => 20 + 4 * (e.subentries?.length ?? 0));
  const offsets = sizes.map((_, i) => sizes.slice(0, i).reduce((a, b) => a + b, 0));
  const total = sizes.reduce((a, b) => a + b, 0);
  const strings: number[] = [];
  const add = (s: string) => {
    const at = total + strings.length;
    strings.push(...Buffer.from(s, 'latin1'), 0);
    return at;
  };
  const records = entries.flatMap(e => [
    ...u16(e.subentries?.length ?? 0), ...u16(e.flags ?? 0), ...u32(add(e.title)), ...u32(add(e.heading)), ...u32(add(e.text)), ...u32(0),
    ...(e.subentries ?? []).flatMap(s => u32(typeof s === 'number' ? offsets[s] : s.offset)),
  ]);
  const data = [...records, ...strings];
  return Uint8Array.from([...u32(entries.length), ...offsets.flatMap(u32), ...u32(data.length), ...data]);
}
