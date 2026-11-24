// SPDX-License-Identifier: GPL-3.0-or-later
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadJellyfin, redact } from './secrets';

const KEY = 'SENTINEL-KEY-0f9e';
const dir = mkdtempSync(join(tmpdir(), 'secrets-'));
let n = 0;
function envFile(text: string, mode = 0o600): string {
  const p = join(dir, `j${n++}.env`);
  writeFileSync(p, text);
  chmodSync(p, mode);
  return p;
}
const good = (url = 'http://192.168.1.50:8096') => `JELLYFIN_URL=${url}\nJELLYFIN_KEY=${KEY}\n`;

describe('loadJellyfin', () => {
  it('loads URL and key from a mode-600 file', async () => {
    const cfg = await loadJellyfin({ JELLYFIN_ENV: envFile(good() + '# note\n') });
    expect(cfg).toEqual({ url: 'http://192.168.1.50:8096', key: KEY });
  });

  it('defaults to $ART_CACHE/jellyfin.env', async () => {
    const d = mkdtempSync(join(tmpdir(), 'cache-'));
    writeFileSync(join(d, 'jellyfin.env'), good(), { mode: 0o600 });
    expect((await loadJellyfin({ ART_CACHE: d })).key).toBe(KEY);
  });

  it('refuses a group- or world-readable file, naming the mode but not the contents', async () => {
    for (const mode of [0o644, 0o640, 0o660]) {
      const err = await loadJellyfin({ JELLYFIN_ENV: envFile(good(), mode) }).catch(e => e as Error);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain(mode.toString(8));
      expect((err as Error).message).not.toContain(KEY);
    }
  });

  it('refuses a file inside the repo root', async () => {
    const p = envFile(good());
    await expect(loadJellyfin({ JELLYFIN_ENV: p }, { repoRoot: dir })).rejects.toThrow(/inside the repo/);
  });

  it('refuses a missing file and missing variables without leaking the key', async () => {
    await expect(loadJellyfin({ JELLYFIN_ENV: join(dir, 'nope.env') })).rejects.toThrow(/no Jellyfin env file/);
    const err = await loadJellyfin({ JELLYFIN_ENV: envFile(`JELLYFIN_KEY=${KEY}\n`) }).catch(e => e as Error);
    expect((err as Error).message).toMatch(/JELLYFIN_URL/);
    expect((err as Error).message).not.toContain(KEY);
  });

  it('refuses a public URL; accepts 192.168.x, 10.x, 172.16-31.x and loopback', async () => {
    for (const u of ['http://8.8.8.8:8096', 'https://jellyfin.example.com', 'http://172.32.0.1', 'http://172.15.0.1', 'http://11.0.0.1']) {
      await expect(loadJellyfin({ JELLYFIN_ENV: envFile(good(u)) }), u).rejects.toThrow(/private/);
    }
    for (const u of ['http://192.168.0.2:8096', 'http://10.1.2.3', 'http://172.16.0.1', 'http://172.31.255.1', 'http://127.0.0.1:8096', 'http://localhost:8096', 'http://[::1]:8096']) {
      expect((await loadJellyfin({ JELLYFIN_ENV: envFile(good(u)) })).key, u).toBe(KEY);
    }
  });
});

describe('redact', () => {
  it('replaces every occurrence of every secret', () => {
    expect(redact(`a ${KEY} b ${KEY} c tok2`, [KEY, 'tok2'])).toBe('a [redacted] b [redacted] c [redacted]');
  });
  it('ignores empty secrets', () => {
    expect(redact('abc', [''])).toBe('abc');
  });
});
