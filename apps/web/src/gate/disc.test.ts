// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { GateError } from './crypto';
import { binCueSource, folderSource, isoSource, normalizeCdPath, rangeDigests, sourceFromFiles } from './disc';
import { fakeFiles, makeBinCue, makeIso } from './testDisc';
import type { GateParams } from './params';

// Deterministic made-up bytes.
function noise(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; out[i] = x & 255; }
  return out;
}

const FILES: Record<string, Uint8Array> = {
  'ALPHA.DAT': noise(70000, 1), // over two sectors
  'SUB/BETA.DAT': noise(9000, 2),
  'SUB/DEEP/GAMMA.DAT': noise(3000, 3),
};
// Enough names that the root directory spans several sectors.
for (let i = 0; i < 120; i++) FILES[`FILLER_NUMBER_${String(i).padStart(4, '0')}.DAT`] = noise(10, 100 + i);

const sha = async (b: Uint8Array): Promise<Uint8Array> => new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource));

describe('normalizeCdPath', () => {
  it('normalizes lower-case, version suffixes and the picked folder', () => {
    expect(normalizeCdPath('sub\\file.dat;1')).toBe('SUB/FILE.DAT');
    expect(normalizeCdPath('NAME.;1')).toBe('NAME');
    expect(normalizeCdPath('cd/sttng.zip;1', true)).toBe('STTNG.ZIP');
    expect(normalizeCdPath('sttng.zip')).toBe('STTNG.ZIP');
  });
});

describe('folderSource', () => {
  it('reads a range from a folder', async () => {
    const src = folderSource(fakeFiles({ 'sub/beta.dat': FILES['SUB/BETA.DAT'] }));
    expect(src.has('SUB/BETA.DAT')).toBe(true);
    expect(src.has('SUB/NOPE.DAT')).toBe(false);
    expect(await src.read('SUB/BETA.DAT', 5000, 100)).toEqual(FILES['SUB/BETA.DAT'].subarray(5000, 5100));
  });

  it('a lower-case folder under a parent unlocks', async () => {
    const src = folderSource(fakeFiles({ 'sub/beta.dat': FILES['SUB/BETA.DAT'] }, 'parent/cd'));
    expect(src.has('SUB/BETA.DAT')).toBe(true);
    expect(await src.read('SUB/BETA.DAT', 0, 4)).toEqual(FILES['SUB/BETA.DAT'].subarray(0, 4));
  });
});

describe('disc images', () => {
  it('reads the same range from an ISO and from a BIN/CUE of the same files', async () => {
    const iso = await isoSource(new Blob([makeIso(FILES) as BlobPart]), 'a.iso');
    const bc = makeBinCue(FILES);
    const bin = await binCueSource(new Blob([bc.bin as BlobPart]), bc.cue, 'a.bin');
    for (const [path, [off, len]] of [['ALPHA.DAT', [2000, 5000]], ['SUB/BETA.DAT', [100, 8000]], ['SUB/DEEP/GAMMA.DAT', [0, 3000]], ['FILLER_NUMBER_0119.DAT', [0, 10]]] as const) {
      const want = FILES[path].subarray(off, off + len);
      expect(iso.has(path)).toBe(true);
      expect(await iso.read(path, off, len)).toEqual(want);
      expect(await bin.read(path, off, len)).toEqual(want);
    }
    expect(iso.has('MISSING.DAT')).toBe(false);
  });

  it('an ISO reader reads only slices', async () => {
    const blob = new Blob([makeIso({ ...FILES, 'BIG.DAT': noise(2_000_000, 9) }) as BlobPart]);
    const sizes: number[] = [];
    const spy = { size: blob.size, slice: (a?: number, b?: number) => { sizes.push((b ?? blob.size) - (a ?? 0)); return blob.slice(a, b); } } as unknown as Blob;
    const iso = await isoSource(spy, 'big.iso');
    const got = await iso.read('BIG.DAT', 1000, 1 << 20);
    expect(got).toEqual(noise(2_000_000, 9).subarray(1000, 1000 + (1 << 20)));
    expect(Math.max(...sizes)).toBeLessThanOrEqual((1 << 20) + 2 * 2048);
  });

  it('a BIN without a CUE says no-cue; a CUE alone says no-bin', async () => {
    const bc = makeBinCue(FILES);
    const bin = new File([bc.bin as BlobPart], 'disc.bin');
    const cue = new File([bc.cue], 'disc.cue');
    await expect(sourceFromFiles([bin])).rejects.toMatchObject({ code: 'no-cue' });
    await expect(sourceFromFiles([cue])).rejects.toMatchObject({ code: 'no-bin' });
    const src = await sourceFromFiles([bin, cue]);
    expect(await src.read('SUB/BETA.DAT', 0, 8)).toEqual(FILES['SUB/BETA.DAT'].subarray(0, 8));
  });

  it('sourceFromFiles takes an .iso and a picked folder', async () => {
    const iso = await sourceFromFiles([new File([makeIso(FILES) as BlobPart], 'DISC.ISO')]);
    expect(iso.has('ALPHA.DAT')).toBe(true);
    const folder = await sourceFromFiles(fakeFiles({ 'alpha.dat': FILES['ALPHA.DAT'] }));
    expect(folder.has('ALPHA.DAT')).toBe(true);
  });
});

describe('rangeDigests', () => {
  const params: GateParams = {
    version: 1, salt: new Uint8Array(32),
    ranges: [{ path: 'ALPHA.DAT', offset: 5000, length: 65000 }, { path: 'SUB/BETA.DAT', offset: 5000, length: 4000 }],
  };

  it('hashes exactly the range', async () => {
    const src = folderSource(fakeFiles({ 'alpha.dat': FILES['ALPHA.DAT'], 'sub/beta.dat': FILES['SUB/BETA.DAT'] }));
    const d = await rangeDigests(src, params);
    expect(d[0]).toEqual(await sha(FILES['ALPHA.DAT'].subarray(5000, 70000)));
    expect(d[1]).toEqual(await sha(FILES['SUB/BETA.DAT'].subarray(5000, 9000)));
  });

  it('the wrong files say wrong-files', async () => {
    const src = folderSource(fakeFiles({ 'alpha.dat': FILES['ALPHA.DAT'].subarray(0, 1000), 'sub/beta.dat': FILES['SUB/BETA.DAT'] }));
    await expect(rangeDigests(src, params)).rejects.toMatchObject({ code: 'wrong-files' });
  });

  it('a missing file says missing-file with its path', async () => {
    const src = folderSource(fakeFiles({ 'alpha.dat': FILES['ALPHA.DAT'] }));
    const err = await rangeDigests(src, params).catch(e => e);
    expect(err).toBeInstanceOf(GateError);
    expect(err.code).toBe('missing-file');
    expect(err.detail).toBe('SUB/BETA.DAT');
  });
});
