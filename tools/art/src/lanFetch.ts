// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { PassThrough, Readable, Writable } from 'node:stream';

type SpawnFn = (
  cmd: string,
  args: string[],
  opts: {
    stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'];
    env: NodeJS.ProcessEnv;
  },
) => ChildProcess;

export interface LanTimeouts {
  /** Seconds curl may spend on the whole request (curl --max-time) for this URL and method. */
  maxTime?: (url: string, method: string, bodyBytes: number) => number;
  /** Seconds curl may spend connecting (curl --connect-timeout). */
  connectTimeout?: number;
  /** Seconds past curl's own --max-time before the child is killed outright (default 5). */
  killGrace?: number;
}

/**
 * Default per-request ceilings. Polls and job submissions are short; uploads and `/view` downloads carry images; an
 * episode stream can legitimately run for many minutes. Anything else gets the middle value.
 */
export function defaultMaxTime(url: string, _method: string, bodyBytes = 0): number {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    // keep the raw string
  }
  if (/\/(history|queue|system_stats|prompt|object_info)(\/|$)/.test(path)) return 30;
  // an upload is sized to its file at 1 MiB/s plus 10 s, never under 30 s
  if (/\/upload(\/|$)/.test(path)) return Math.max(30, Math.ceil(bodyBytes / 1048576) + 10);
  if (/\/view(\/|$)/.test(path)) return 300;
  if (/\/Videos\/|\/stream(\/|$)/.test(path)) return 1800;
  return 120;
}

const quote = (s: string): string => `"${s.replace(/[\\"]/g, c => `\\${c}`).replace(/\r?\n/g, ' ')}"`;

/**
 * A `fetch` for LAN requests that goes through curl. macOS can refuse a Node process the local network (EHOSTUNREACH)
 * where the system curl is let through, and the media server is on the LAN. Headers (so the Jellyfin key) go to curl
 * on stdin as a config, never in its argv or environment. A body (JSON string, bytes, FormData) is serialised with
 * `new Response(body)`, which also yields the multipart content-type with its boundary, and goes to curl on an extra
 * pipe (fd 4), never in argv. Every request carries curl's `--connect-timeout` and `--max-time`, so a hung transfer
 * fails instead of waiting for ever. The result is the status, the headers and a streamed body.
 */
export function curlLanFetch(spawnFn: SpawnFn = nodeSpawn as unknown as SpawnFn, timeouts: LanTimeouts = {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headerMap = new Headers(init?.headers);
    let payload: Uint8Array | undefined;
    if (init?.body !== undefined && init.body !== null) {
      const r = new Response(init.body);
      payload = new Uint8Array(await r.arrayBuffer());
      const type = r.headers.get('content-type');
      if (type && !headerMap.has('content-type')) headerMap.set('content-type', type);
    } else if (method !== 'GET' && method !== 'HEAD') {
      throw new Error(`lanFetch: ${method} needs a body`);
    }
    if (payload) headerMap.set('expect', ''); // no 100-continue round trip
    const config = [...headerMap].map(([k, v]) => `header = ${quote(`${k}: ${v}`)}`).join('\n');
    const host = new URL(url).host;
    const own = (timeouts.maxTime ?? defaultMaxTime)(url, method, payload?.length ?? 0);
    // a caller with a shared budget may ask for less, never more
    const cap = (init as { lanMaxTime?: number } | undefined)?.lanMaxTime;
    const maxTime = cap === undefined ? own : Math.max(1, Math.min(own, Math.ceil(cap)));
    const args = [
      '--silent',
      '--show-error',
      '--connect-timeout',
      String(timeouts.connectTimeout ?? 10),
      '--max-time',
      String(maxTime),
      '--config',
      '-',
      '--dump-header',
      '/dev/fd/3',
    ];
    if (payload) args.push('--request', method, '--data-binary', '@/dev/fd/4');
    const p = spawnFn('curl', [...args, '--', url], {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });
    p.stdin!.on('error', () => {});
    p.stdin!.end(`${config}\n`);
    const bodyPipe = p.stdio[4] as Writable | undefined;
    if (bodyPipe) {
      bodyPipe.on('error', () => {});
      bodyPipe.end(payload ? Buffer.from(payload) : undefined);
    }
    // backstop: if curl does not honour its own --max-time, kill it and fail with a clear error
    let hardKilled: Error | undefined;
    let rejectHead: (e: Error) => void = () => {};
    const body = new PassThrough();
    body.on('error', () => {}); // a reader that attaches later still sees the error
    const hardKill = setTimeout(() => {
      hardKilled = new Error(`lanFetch: curl still running ${maxTime + (timeouts.killGrace ?? 5)} s after its ${maxTime} s limit; killed (${method} ${host})`);
      p.kill('SIGKILL');
      p.stdout!.destroy();
      p.stderr!.destroy();
      rejectHead(hardKilled);
      body.destroy(hardKilled);
    }, (maxTime + (timeouts.killGrace ?? 5)) * 1000);
    p.on('close', () => clearTimeout(hardKill));
    p.on('error', () => clearTimeout(hardKill));
    let err = '';
    p.stderr!.on('data', d => (err += d));
    // stdout's EOF comes before curl's exit code, so the body ends only once curl has exited 0: a transfer cut short
    // (--max-time, a partial read, a kill) is an error for the reader, never a clean short body
    p.stdout!.pipe(body, { end: false });
    p.on('error', e => body.destroy(e));
    p.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (hardKilled) return;
      if (code === 0) return void body.end();
      if (signal) return void body.destroy(new Error(`curl killed by ${signal}`));
      // curl's stderr can name the URL; it never holds the header values
      body.destroy(new Error(`curl exited ${code}: ${err.trim()}`));
    });
    // the status line and headers arrive on fd 3 before any body
    const head = await new Promise<string>((resolve, reject) => {
      let text = '';
      const pipe = p.stdio[3] as Readable;
      pipe.on('data', d => {
        text += d;
        const end = text.search(/\r?\n\r?\n/);
        if (end >= 0) resolve(text.slice(0, end));
      });
      pipe.on('end', () => setImmediate(() => reject(new Error(`curl got no response${err ? `: ${err.trim()}` : ''}`))));
      p.on('error', reject);
      rejectHead = reject;
      if (hardKilled) reject(hardKilled);
    });
    const status = Number(/^HTTP\/\S+ (\d{3})/.exec(head)?.[1]);
    const headers = new Headers();
    for (const line of head.split(/\r?\n/).slice(1)) {
      const i = line.indexOf(':');
      if (i > 0) headers.append(line.slice(0, i).trim(), line.slice(i + 1).trim());
    }
    const noBody = status === 204 || status === 304;
    return new Response(noBody ? null : (Readable.toWeb(body) as ReadableStream), { status, headers });
  }) as typeof fetch;
}
