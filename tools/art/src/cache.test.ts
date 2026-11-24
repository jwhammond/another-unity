// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { comfyLockHeld } from './cache';

describe.skipIf(!existsSync('/usr/bin/lockf'))('comfyLockHeld', () => {
  it('is false with no lock file or a free one, and true while another process holds it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lock-'));
    try {
      const env = { ART_CACHE: root };
      expect(comfyLockHeld(env)).toBe(false);
      const lock = join(root, '.comfy.lock');
      writeFileSync(lock, '');
      expect(comfyLockHeld(env)).toBe(false);
      const holder = spawn('/usr/bin/lockf', ['-k', lock, 'sleep', '5'], { stdio: 'ignore' });
      try {
        await new Promise(r => setTimeout(r, 500));
        expect(comfyLockHeld(env)).toBe(true);
      } finally {
        holder.kill();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
