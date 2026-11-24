// SPDX-License-Identifier: GPL-3.0-or-later
import type { JellyfinConfig } from './secrets';
import { redact } from './secrets';

export interface Episode {
  item: string;
  season: number;
  episode: number;
  /** Runtime in milliseconds. */
  ms: number;
}

type Auth = 'emby' | 'mediabrowser';

/**
 * A read-only Jellyfin client. The key goes only in a request header: `X-Emby-Token`, or, if the server answers 401,
 * `Authorization: MediaBrowser Token="…"` (also a header). Every log and error line is redacted.
 */
export class Jellyfin {
  private auth: Auth = 'emby';
  private readonly fetchFn: typeof fetch;
  private readonly log: (l: string) => void;

  constructor(
    private readonly cfg: JellyfinConfig,
    opts: { fetchFn?: typeof fetch; log?: (l: string) => void } = {},
  ) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.log = opts.log ?? (() => {});
  }

  /** Which header scheme worked (for the ledger). */
  get scheme(): string {
    return this.auth === 'emby' ? 'X-Emby-Token' : 'Authorization: MediaBrowser';
  }

  private headers(auth: Auth): Record<string, string> {
    return auth === 'emby' ? { 'X-Emby-Token': this.cfg.key } : { Authorization: `MediaBrowser Token="${this.cfg.key}"` };
  }

  private say(line: string): void {
    this.log(redact(line, [this.cfg.key]));
  }

  private async get(path: string): Promise<Response> {
    const url = `${this.cfg.url}${path}`;
    let res = await this.send(url, this.auth);
    if (res.status === 401 && this.auth === 'emby') {
      await res.body?.cancel();
      this.say(`GET ${path}: 401 with X-Emby-Token, trying the Authorization header`);
      res = await this.send(url, 'mediabrowser');
      if (res.status !== 401) this.auth = 'mediabrowser';
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(redact(`Jellyfin GET ${path} failed: HTTP ${res.status}`, [this.cfg.key]));
    }
    return res;
  }

  private async send(url: string, auth: Auth): Promise<Response> {
    try {
      return await this.fetchFn(url, { method: 'GET', headers: this.headers(auth) });
    } catch (e) {
      // a failed fetch's message can echo request details: redact it, and name only the path and host
      const u = new URL(url);
      throw new Error(redact(`Jellyfin GET ${u.pathname} could not reach ${u.host}: ${(e as Error).message}`, [this.cfg.key]));
    }
  }

  async episodes(series: string): Promise<Episode[]> {
    const res = await this.get(`/Shows/${series}/Episodes?Fields=MediaSources`);
    const body = (await res.json()) as { Items?: { Id: string; ParentIndexNumber?: number; IndexNumber?: number; RunTimeTicks?: number }[] };
    const out: Episode[] = [];
    for (const it of body.Items ?? []) {
      if (it.ParentIndexNumber === undefined || it.IndexNumber === undefined) continue;
      out.push({ item: it.Id, season: it.ParentIndexNumber, episode: it.IndexNumber, ms: Math.round((it.RunTimeTicks ?? 0) / 10000) });
    }
    return out.sort((a, b) => a.season - b.season || a.episode - b.episode);
  }

  /** The item's file as a byte stream. */
  async stream(item: string): Promise<ReadableStream<Uint8Array>> {
    const res = await this.get(`/Videos/${item}/stream?static=true`);
    if (!res.body) throw new Error(`Jellyfin stream for ${item} had no body`);
    return res.body;
  }
}
