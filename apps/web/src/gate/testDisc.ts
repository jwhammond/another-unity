// SPDX-License-Identifier: GPL-3.0-or-later
// Minimal disc writers for the tests: an ISO 9660 image and a BIN/CUE of the same files, built from made-up bytes.
const SECTOR = 2048;

const ascii = (s: string): Uint8Array => Uint8Array.from(s, c => c.charCodeAt(0));
const put32 = (b: Uint8Array, at: number, v: number): void => {
  const dv = new DataView(b.buffer, b.byteOffset);
  dv.setUint32(at, v, true);
  dv.setUint32(at + 4, v, false);
};

interface Node { name: string; dir: boolean; data?: Uint8Array; kids: Node[]; extent: number; size: number }

function record(n: { name: string; dir: boolean; extent: number; size: number }, id?: Uint8Array): Uint8Array {
  const ident = id ?? ascii(n.dir ? n.name : `${n.name};1`);
  const len = 33 + ident.length + (ident.length % 2 === 0 ? 1 : 0);
  const r = new Uint8Array(len);
  r[0] = len;
  put32(r, 2, n.extent);
  put32(r, 10, n.size);
  r[25] = n.dir ? 2 : 0;
  r[28] = 1; r[30] = 1; // volume sequence number, both-endian
  r[32] = ident.length;
  r.set(ident, 33);
  return r;
}

function entries(d: Node, parent: Node): Uint8Array[] {
  return [
    record(d, Uint8Array.of(0)),
    record(parent, Uint8Array.of(1)),
    ...d.kids.map(k => record(k)),
  ];
}

/** Records are packed so that none straddles a sector; the rest of the sector is zero. */
function layout(recs: Uint8Array[]): Uint8Array {
  const sectors: Uint8Array[][] = [[]];
  let used = 0;
  for (const r of recs) {
    if (used + r.length > SECTOR) { sectors.push([]); used = 0; }
    sectors[sectors.length - 1].push(r);
    used += r.length;
  }
  const out = new Uint8Array(sectors.length * SECTOR);
  sectors.forEach((rs, i) => {
    let at = i * SECTOR;
    for (const r of rs) { out.set(r, at); at += r.length; }
  });
  return out;
}

const sectorsFor = (n: number): number => Math.max(1, Math.ceil(n / SECTOR));

/** `files` maps paths like `DIR/SUB/FILE.BIN` to bytes. Directories are made as needed. */
export function makeIso(files: Record<string, Uint8Array>): Uint8Array {
  const root: Node = { name: '', dir: true, kids: [], extent: 0, size: 0 };
  for (const [path, data] of Object.entries(files)) {
    const parts = path.split('/');
    let at = root;
    for (const part of parts.slice(0, -1)) {
      let next = at.kids.find(k => k.dir && k.name === part);
      if (!next) { next = { name: part, dir: true, kids: [], extent: 0, size: 0 }; at.kids.push(next); }
      at = next;
    }
    at.kids.push({ name: parts[parts.length - 1], dir: false, data, kids: [], extent: 0, size: data.length });
  }
  const dirs: { node: Node; parent: Node }[] = [];
  const walk = (d: Node, parent: Node): void => { dirs.push({ node: d, parent }); for (const k of d.kids) if (k.dir) walk(k, d); };
  walk(root, root);
  // Directory sizes depend only on the names, so extents can be handed out before the records are written.
  let next = 18;
  for (const { node, parent } of dirs) {
    node.size = layout(entries(node, parent)).length;
    node.extent = next;
    next += node.size / SECTOR;
  }
  const filesFlat: Node[] = [];
  const collect = (d: Node): void => { for (const k of d.kids) { if (k.dir) collect(k); else filesFlat.push(k); } };
  collect(root);
  for (const f of filesFlat) { f.extent = next; next += sectorsFor(f.size); }

  const img = new Uint8Array(next * SECTOR);
  const pvd = 16 * SECTOR;
  img[pvd] = 1;
  img.set(ascii('CD001'), pvd + 1);
  img[pvd + 6] = 1;
  put32(img, pvd + 80, next);
  img.set(record(root, Uint8Array.of(0)), pvd + 156);
  img[17 * SECTOR] = 255;
  img.set(ascii('CD001'), 17 * SECTOR + 1);
  for (const { node, parent } of dirs) img.set(layout(entries(node, parent)), node.extent * SECTOR);
  for (const f of filesFlat) img.set(f.data!, f.extent * SECTOR);
  return img;
}

/** The same files as a raw MODE1/2352 BIN (sync, header and EDC left zero) and its CUE sheet. */
export function makeBinCue(files: Record<string, Uint8Array>, binName = 'disc.bin'): { bin: Uint8Array; cue: string } {
  const iso = makeIso(files);
  const n = iso.length / SECTOR;
  const bin = new Uint8Array(n * 2352);
  for (let i = 0; i < n; i++) bin.set(iso.subarray(i * SECTOR, (i + 1) * SECTOR), i * 2352 + 16);
  const cue = `FILE "${binName}" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n`;
  return { bin, cue };
}

/** Files as the browser gives a picked folder: `webkitRelativePath` is `<folder>/<path>`. */
export function fakeFiles(map: Record<string, Uint8Array>, folder = 'cd'): File[] {
  return Object.entries(map).map(([path, data]) => {
    const f = new File([data as BlobPart], path.split('/').pop()!);
    Object.defineProperty(f, 'webkitRelativePath', { value: `${folder}/${path}` });
    return f;
  });
}
