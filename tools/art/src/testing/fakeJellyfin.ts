// SPDX-License-Identifier: GPL-3.0-or-later
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeJellyfin {
  url: string;
  /** Every request seen: method, url (path and query), and the auth-bearing headers. */
  requests: { method: string; url: string; headers: Record<string, string | undefined> }[];
  close(): Promise<void>;
}

export interface FakeOpts {
  key: string;
  /** Which header the server accepts. `legacy` (default) is X-Emby-Token; `mediabrowser` refuses it with a 401. */
  accepts?: 'legacy' | 'mediabrowser';
  /** The items `/Shows/<series>/Episodes` returns. */
  items?: { Id: string; ParentIndexNumber?: number; IndexNumber?: number; RunTimeTicks?: number }[];
  /** The bytes `/Videos/<id>/stream` serves. */
  video?: Uint8Array;
}

function authed(req: IncomingMessage, o: FakeOpts): boolean {
  const legacy = req.headers['x-emby-token'] === o.key;
  const mb = typeof req.headers.authorization === 'string' && req.headers.authorization === `MediaBrowser Token="${o.key}"`;
  return o.accepts === 'mediabrowser' ? mb : legacy;
}

/** A `node:http` stand-in for the Jellyfin routes the tools use. It checks the key only in a header. */
export async function fakeJellyfin(o: FakeOpts): Promise<FakeJellyfin> {
  const requests: FakeJellyfin['requests'] = [];
  const server: Server = createServer((req, res) => {
    requests.push({
      method: req.method ?? '',
      url: req.url ?? '',
      headers: { 'x-emby-token': req.headers['x-emby-token'] as string | undefined, authorization: req.headers.authorization },
    });
    if (!authed(req, o)) {
      res.writeHead(401).end('unauthorized');
      return;
    }
    const url = req.url ?? '';
    if (/^\/Shows\/[0-9a-f]+\/Episodes\?/.test(url)) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ Items: o.items ?? [] }));
    } else if (/^\/Videos\/[0-9a-f]+\/stream\?/.test(url)) {
      res.writeHead(200, { 'content-type': 'video/x-matroska' }).end(Buffer.from(o.video ?? new Uint8Array()));
    } else {
      res.writeHead(404).end('nope');
    }
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () => new Promise<void>(r => server.close(() => r())),
  };
}
