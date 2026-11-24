// SPDX-License-Identifier: GPL-3.0-or-later
// A fixture server for the sw-auth e2e: serves the deploy output as a host would, and on request answers as a gate does when a
// session has expired. Not a deploy tool. `GET /__mode?m=<mode>` sets how files (and pages) are answered:
//   ok     the file                                  401    401 with a Basic challenge
//   login  302 to a sign-in page (Access)            html   200 with the sign-in page in place of the file (a gate that doesn't redirect)
// (`/__mode` and `/login` always answer.) `GET /__build?dir=<folder>` lays a folder over the output (its files answer first; no `dir`,
// none): the next build, for the update e2e (sw-update.spec.ts).

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { OUT } from './common';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json', '.webp': 'image/webp', '.png': 'image/png', '.opus': 'audio/ogg', '.ogg': 'audio/ogg',
  '.wav': 'audio/wav', '.webm': 'video/webm', '.glb': 'model/gltf-binary',
};
const LOGIN = '<!doctype html><title>Sign in</title><h1 id="login">Sign in to continue</h1>';
let mode = 'ok';
let overlay = '';

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/__mode') {
    mode = url.searchParams.get('m') ?? 'ok';
    res.end(mode);
    return;
  }
  if (url.pathname === '/__build') {
    overlay = url.searchParams.get('dir') ?? '';
    res.end(overlay ? 'overlay' : 'output');
    return;
  }
  if (url.pathname === '/login') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(LOGIN);
    return;
  }
  if (mode === '401') {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="x"', 'Content-Type': 'text/plain' }).end('Sign in to continue');
    return;
  }
  if (mode === 'login') {
    res.writeHead(302, { Location: '/login' }).end();
    return;
  }
  if (mode === 'html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(LOGIN);
    return;
  }
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  const find = (root: string): string | undefined => {
    let file = join(root, rel === '/' ? 'index.html' : rel);
    // (a directory serves its own index.html, as the host does)
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    return existsSync(file) ? file : undefined;
  };
  // (the root's index.html is the fallback for an unknown path)
  const file = (overlay ? find(overlay) : undefined) ?? find(OUT) ?? (overlay && existsSync(join(overlay, 'index.html')) ? join(overlay, 'index.html') : join(OUT, 'index.html'));
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
  createReadStream(file).pipe(res);
});
server.listen(Number(process.env.E2E_PORT ?? 5292), '127.0.0.1', () => console.log('authsim ready'));
