// SPDX-License-Identifier: GPL-3.0-or-later
// The CD as a folder on disk (GAMEDATA_DIR), read through the same CdSource the page uses for a picked folder.
import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { GateError } from '../../../apps/web/src/gate/crypto';
import { normalizeCdPath, type CdSource } from '../../../apps/web/src/gate/disc';

/** Every file under `dir` as its CD path (normalised) and size. */
export function listFolder(dir: string): { path: string; size: number }[] {
  const out: { path: string; size: number }[] = [];
  const walk = (abs: string, rel: string): void => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(abs, e.name), r);
      else if (e.isFile()) out.push({ path: normalizeCdPath(r), size: statSync(join(abs, e.name)).size });
    }
  };
  walk(dir, '');
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function nodeFolderSource(dir: string): CdSource {
  const real = new Map<string, string>();
  const walk = (abs: string, rel: string): void => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(abs, e.name), r);
      else if (e.isFile()) real.set(normalizeCdPath(r), join(abs, e.name));
    }
  };
  walk(dir, '');
  return {
    label: dir,
    has: path => real.has(normalizeCdPath(path)),
    async read(path, offset, length) {
      const norm = normalizeCdPath(path);
      const file = real.get(norm);
      if (!file) throw new GateError('missing-file', norm);
      const fd = openSync(file, 'r');
      try {
        const buf = new Uint8Array(length);
        let got = 0;
        while (got < length) {
          const n = readSync(fd, buf, got, length - got, offset + got);
          if (n === 0) break;
          got += n;
        }
        return got === length ? buf : buf.subarray(0, got);
      } finally {
        closeSync(fd);
      }
    },
  };
}
