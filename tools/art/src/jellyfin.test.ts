// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { Jellyfin } from './jellyfin';
import { fakeJellyfin, type FakeJellyfin } from './testing/fakeJellyfin';

const KEY = 'SENTINEL-KEY-0f9e';
const ITEMS = [
  { Id: 'aa11', ParentIndexNumber: 6, IndexNumber: 2, RunTimeTicks: 26_000_000_000 },
  { Id: 'bb22', ParentIndexNumber: 1, IndexNumber: 1, RunTimeTicks: 30_000_000_000 },
  { Id: 'cc33', IndexNumber: 3 },
];
let fake: FakeJellyfin | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

describe('Jellyfin', () => {
  it('sends the key only as the X-Emby-Token header, never in the URL', async () => {
    fake = await fakeJellyfin({ key: KEY, items: ITEMS, video: new Uint8Array([1, 2, 3]) });
    const j = new Jellyfin({ url: fake.url, key: KEY });
    await j.episodes('abc123');
    const body = await j.stream('aa11');
    expect([...new Uint8Array(await new Response(body).arrayBuffer())]).toEqual([1, 2, 3]);
    expect(fake.requests).toHaveLength(2);
    for (const r of fake.requests) {
      expect(r.method).toBe('GET');
      expect(r.url).not.toContain(KEY);
      expect(r.headers['x-emby-token']).toBe(KEY);
      expect(r.headers.authorization).toBeUndefined();
    }
    expect(fake.requests[0]!.url).toBe('/Shows/abc123/Episodes?Fields=MediaSources');
    expect(fake.requests[1]!.url).toBe('/Videos/aa11/stream?static=true');
  });

  it('falls back to the Authorization MediaBrowser header on a 401', async () => {
    fake = await fakeJellyfin({ key: KEY, accepts: 'mediabrowser', items: ITEMS });
    const j = new Jellyfin({ url: fake.url, key: KEY });
    expect(await j.episodes('abc123')).toHaveLength(2);
    expect(j.scheme).toMatch(/Authorization/);
    await j.episodes('abc123');
    // the second call goes straight to the header that worked
    expect(fake.requests.map(r => !!r.headers.authorization)).toEqual([false, true, true]);
    for (const r of fake.requests) expect(r.url).not.toContain(KEY);
  });

  it('episodes() maps items to season, episode and ms, in order, skipping unnumbered items', async () => {
    fake = await fakeJellyfin({ key: KEY, items: ITEMS });
    const eps = await new Jellyfin({ url: fake.url, key: KEY }).episodes('abc123');
    expect(eps).toEqual([
      { item: 'bb22', season: 1, episode: 1, ms: 3_000_000 },
      { item: 'aa11', season: 6, episode: 2, ms: 2_600_000 },
    ]);
  });

  it('an HTTP error message carries no key (sentinel absent from message, stack and log)', async () => {
    fake = await fakeJellyfin({ key: 'other-key' });
    const logs: string[] = [];
    const err = await new Jellyfin({ url: fake.url, key: KEY }, { log: l => logs.push(l) }).episodes('abc123').catch(e => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/401/);
    expect(`${(err as Error).message}\n${(err as Error).stack}\n${logs.join('\n')}`).not.toContain(KEY);
  });

  it('a network failure that echoes the key is redacted', async () => {
    const fetchFn = (async () => {
      throw new Error(`connect failed, headers X-Emby-Token: ${KEY}`);
    }) as typeof fetch;
    const err = await new Jellyfin({ url: 'http://10.0.0.1', key: KEY }, { fetchFn }).episodes('abc').catch(e => e as Error);
    expect((err as Error).message).not.toContain(KEY);
    expect((err as Error).message).toContain('[redacted]');
  });
});
