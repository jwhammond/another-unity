// SPDX-License-Identifier: GPL-3.0-or-later
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { SourceFile } from '@another-unity/engine';

/** Every .yaml file under dir, with paths relative to it, using '/'. */
export async function readGameDir(dir: string): Promise<SourceFile[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files: SourceFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.yaml')) continue;
    const full = join(entry.parentPath, entry.name);
    files.push({ path: relative(dir, full).split(sep).join('/'), text: await readFile(full, 'utf8') });
  }
  return files;
}
