// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkComfyUrl, isLoopback, withGenerator } from './comfy';
import { isLanAddress } from './secrets';
import { Jellyfin } from './jellyfin';
import { ComfyHttp } from './comfy';
import { curlLanFetch, defaultMaxTime } from './lanFetch';
import { fakeJellyfin, type FakeJellyfin } from './testing/fakeJellyfin';

const KEY = 'SENTINEL-KEY-0f9e';
let fake: FakeJellyfin | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

describe('curlLanFetch', () => {
  it('carries the key to the server as a header, and puts it in neither argv nor env', async () => {
    fake = await fakeJellyfin({
      key: KEY,
      video: new Uint8Array([4, 5, 6]),
      items: [{ Id: 'aa', ParentIndexNumber: 1, IndexNumber: 1, RunTimeTicks: 10000 }],
    });
    const seen: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const spy = ((cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      seen.push({ args, env: opts.env });
      return (spawn as never as (...a: unknown[]) => never)(cmd, args, opts);
    }) as never;
    const j = new Jellyfin({ url: fake.url, key: KEY }, { fetchFn: curlLanFetch(spy) });
    expect(await j.episodes('abc')).toHaveLength(1);
    const bytes = new Uint8Array(await new Response(await j.stream('aa')).arrayBuffer());
    expect([...bytes]).toEqual([4, 5, 6]);
    expect(seen).toHaveLength(2);
    for (const s of seen) {
      expect(JSON.stringify(s.args)).not.toContain(KEY);
      expect(JSON.stringify(s.env)).not.toContain(KEY);
    }
    expect(fake.requests.every(r => r.headers['x-emby-token'] === KEY && !r.url.includes(KEY))).toBe(true);
  });

  it('reports a 401 as a status so the client can fall back, and the fallback header arrives intact', async () => {
    fake = await fakeJellyfin({ key: KEY, accepts: 'mediabrowser', items: [] });
    const j = new Jellyfin({ url: fake.url, key: KEY }, { fetchFn: curlLanFetch() });
    expect(await j.episodes('abc')).toEqual([]);
    expect(j.scheme).toMatch(/Authorization/);
  });

  it('an unreachable host fails with a message free of the key', async () => {
    const j = new Jellyfin({ url: 'http://127.0.0.1:9', key: KEY }, { fetchFn: curlLanFetch() });
    const err = await j.episodes('abc').catch(e => e as Error);
    expect((err as Error).message).not.toContain(KEY);
    expect(err).toBeInstanceOf(Error);
  });
});

describe('curlLanFetch with a body', () => {
  /** A fake curl: records argv, the stdin config and what arrives on fd 4, answers 200 with the body "ok". */
  const fakeSpawn = () => {
    const seen: {
      args: string[];
      config: string;
      sent: Buffer[];
      env: NodeJS.ProcessEnv;
    }[] = [];
    const spawnFn = ((_cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      const rec = { args, config: '', sent: [] as Buffer[], env: opts.env };
      seen.push(rec);
      const stdin = new PassThrough();
      stdin.on('data', d => (rec.config += d));
      const fd3 = new PassThrough();
      const fd4 = new PassThrough();
      fd4.on('data', d => rec.sent.push(Buffer.from(d)));
      const stdout = new PassThrough();
      const proc = new EventEmitter() as EventEmitter & Record<string, unknown>;
      Object.assign(proc, {
        stdin,
        stdout,
        stderr: new PassThrough(),
        stdio: [stdin, stdout, null, fd3, fd4],
      });
      fd4.on('end', () => {
        fd3.end('HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\n\r\n');
        stdout.end('ok');
        setImmediate(() => proc.emit('close', 0));
      });
      return proc;
    }) as never;
    return { seen, spawnFn };
  };

  it('POSTs a JSON body on fd 4, not in argv, with the caller content-type', async () => {
    const { seen, spawnFn } = fakeSpawn();
    const res = await curlLanFetch(spawnFn)('http://192.168.1.9:8188/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: { a: 1 }, secret: 'SENTINEL-BODY' }),
    });
    expect(await res.text()).toBe('ok');
    const s = seen[0]!;
    expect(s.args).toEqual(expect.arrayContaining(['--request', 'POST', '--data-binary', '@/dev/fd/4']));
    expect(s.args.at(-1)).toBe('http://192.168.1.9:8188/prompt');
    expect(JSON.stringify(s.args)).not.toContain('SENTINEL-BODY');
    expect(JSON.stringify(s.env)).not.toContain('SENTINEL-BODY');
    expect(s.config).toContain('header = "content-type: application/json"');
    expect(Buffer.concat(s.sent).toString()).toBe('{"prompt":{"a":1},"secret":"SENTINEL-BODY"}');
  });

  it('sends FormData as multipart bytes on fd 4 with the boundary in the content-type header', async () => {
    const { seen, spawnFn } = fakeSpawn();
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array([0, 255, 10, 13, 7])], { type: 'image/png' }), 'in.png');
    form.append('overwrite', 'true');
    await curlLanFetch(spawnFn)('http://192.168.1.9:8188/upload/image', {
      method: 'POST',
      body: form,
    });
    const s = seen[0]!;
    const type = /header = "content-type: (multipart\/form-data; boundary=[^"]+)"/.exec(s.config)?.[1];
    expect(type).toBeDefined();
    const boundary = type!.split('boundary=')[1]!;
    const sent = Buffer.concat(s.sent);
    expect(sent.toString('latin1')).toContain(`--${boundary}`);
    expect(sent.toString('latin1')).toContain('filename="in.png"');
    expect(sent.includes(Buffer.from([0, 255, 10, 13, 7]))).toBe(true);
    expect(s.args.join(' ')).not.toContain(boundary);
  });

  it('gives every request a connect timeout and a max time: short for polls, long for uploads and views', async () => {
    const { seen, spawnFn } = fakeSpawn();
    const fetchLan = curlLanFetch(spawnFn);
    const flag = (args: string[], name: string) => Number(args[args.indexOf(name) + 1]);
    await fetchLan('http://192.168.1.9:8188/history/abc');
    await fetchLan('http://192.168.1.9:8188/view?filename=a.png&type=output');
    const form = new FormData();
    form.append('overwrite', 'true');
    await fetchLan('http://192.168.1.9:8188/upload/image', { method: 'POST', body: form });
    for (const s of seen) expect(flag(s.args, '--connect-timeout')).toBeGreaterThan(0);
    const [poll, view, upload] = seen.map(s => flag(s.args, '--max-time'));
    expect(poll).toBeGreaterThan(0);
    expect(poll).toBeLessThanOrEqual(60);
    expect(view).toBe(300);
    expect(upload).toBe(30); // a tiny file gets the 30 s floor
  });

  it('takes the timeouts from the caller when given', async () => {
    const { seen, spawnFn } = fakeSpawn();
    await curlLanFetch(spawnFn, { maxTime: () => 7, connectTimeout: 3 })('http://192.168.1.9:8188/view');
    expect(seen[0]!.args).toEqual(expect.arrayContaining(['--max-time', '7', '--connect-timeout', '3']));
  });

  it('really times out a server that never answers', async () => {
    const server = createServer(() => {});
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const err = await curlLanFetch(undefined, { maxTime: () => 1 })(`http://127.0.0.1:${port}/x`).catch(e => e as Error);
      expect(err).toBeInstanceOf(Error);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  }, 15_000);

  it('an upload to a server that never answers fails within its max time', async () => {
    const server = createServer(req => req.pause());
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const t0 = Date.now();
    try {
      const form = new FormData();
      form.append('image', new Blob([new Uint8Array(4 * 1024 * 1024)]), 'a.png');
      const err = await curlLanFetch(undefined, { maxTime: () => 3 })(`http://127.0.0.1:${port}/upload/image`, { method: 'POST', body: form }).catch(e => e as Error);
      expect(err).toBeInstanceOf(Error);
      expect(Date.now() - t0).toBeLessThan(6000);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  }, 15_000);

  it('kills a curl that outlives its max time and says so', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdio: [null, null, null, new PassThrough(), new PassThrough()],
      killed: [] as string[],
      kill(sig: string) {
        this.killed.push(sig);
        return true;
      },
    });
    const t0 = Date.now();
    const err = await curlLanFetch((() => child) as never, { maxTime: () => 1, killGrace: 1 })('http://127.0.0.1:9/upload/image', {
      method: 'POST',
      body: new Uint8Array(4),
    }).catch(e => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/still running 2 s after its 1 s limit; killed/);
    expect(child.killed).toEqual(['SIGKILL']);
    expect(Date.now() - t0).toBeLessThan(4000);
  }, 10_000);

  it('sizes an upload max time to its file', () => {
    const u = 'http://h:8188/upload/image';
    expect(defaultMaxTime(u, 'POST', 1048576)).toBe(30);
    expect(defaultMaxTime(u, 'POST', 40 * 1048576)).toBe(50);
  });

  it('a malformed URL rejects instead of throwing from the timer', async () => {
    await expect(curlLanFetch(undefined, { maxTime: () => 1 })('not a url')).rejects.toThrow();
  });

  it("a job's second stalled upload fails at the shared 120 s budget, naming the input, and the third is never sent", async () => {
    vi.useFakeTimers();
    try {
      const sent: string[] = [];
      let n = 0;
      const fetchFn = ((_u: string, init: RequestInit) => {
        sent.push(String(((init.body as FormData).get('image') as File).name));
        n++;
        if (n === 1) return new Promise<Response>(r => setTimeout(() => r(new Response('{}')), 100_000));
        return new Promise<Response>(() => {});
      }) as never;
      const http = new ComfyHttp('http://h:8188', { fetchFn });
      const bytes = new Uint8Array(4);
      const run = http.run({ inputs: { a: bytes, b: bytes, c: bytes }, graph: {}, outputs: {} } as never).catch(e => e as Error);
      await vi.advanceTimersByTimeAsync(119_000);
      expect(sent).toEqual(['a', 'b']);
      await vi.advanceTimersByTimeAsync(2_000);
      const err = await run;
      expect((err as Error).message).toMatch(/input "b" did not finish within the 120 s budget/);
      expect(sent).toEqual(['a', 'b']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a GET sends no body and no --data-binary', async () => {
    const { seen, spawnFn } = fakeSpawn();
    await curlLanFetch(spawnFn)('http://192.168.1.9:8188/system_stats');
    expect(seen[0]!.args).not.toContain('--data-binary');
    expect(Buffer.concat(seen[0]!.sent)).toHaveLength(0);
  });

  it('really POSTs through curl to a local server', async () => {
    const got: { type?: string; body: string }[] = [];
    const server = createServer((req, rsp) => {
      let body = '';
      req.on('data', d => (body += d));
      req.on('end', () => {
        got.push({ type: req.headers['content-type'], body });
        rsp.end('{"prompt_id":"x"}');
      });
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const form = new FormData();
      form.append('overwrite', 'true');
      const res = await curlLanFetch()(`http://127.0.0.1:${port}/upload/image`, { method: 'POST', body: form });
      expect(res.status).toBe(200);
      const res2 = await curlLanFetch()(`http://127.0.0.1:${port}/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"a":1}',
      });
      expect(await res2.json()).toEqual({ prompt_id: 'x' });
      expect(got[0]!.type).toMatch(/^multipart\/form-data; boundary=/);
      expect(got[0]!.body).toContain('name="overwrite"');
      expect(got[1]).toEqual({ type: 'application/json', body: '{"a":1}' });
    } finally {
      server.close();
    }
  });
});

describe('curlLanFetch when curl fails after the headers', () => {
  /** A fake curl that sends a 200, its headers and part of the body, closes stdout, then exits as given. */
  const cutShort = (code: number | null, signal: NodeJS.Signals | null) =>
    ((_cmd: string, _args: string[]) => {
      const stdin = new PassThrough();
      stdin.resume();
      const fd3 = new PassThrough();
      const stdout = new PassThrough();
      const proc = new EventEmitter() as EventEmitter & Record<string, unknown>;
      Object.assign(proc, { stdin, stdout, stderr: new PassThrough(), stdio: [stdin, stdout, null, fd3, new PassThrough()] });
      setImmediate(() => {
        fd3.end('HTTP/1.1 200 OK\r\ncontent-type: image/png\r\ncontent-length: 1000\r\n\r\n');
        stdout.end(Buffer.alloc(100, 7));
        // as with a real child, stdout's EOF is seen before the exit
        stdout.on('end', () => setImmediate(() => proc.emit('close', code, signal)));
      });
      return proc;
    }) as never;

  it('rejects the body when curl exits 28 (--max-time) mid-transfer', async () => {
    const res = await curlLanFetch(cutShort(28, null))('http://192.168.1.9:8188/view?filename=a.png');
    expect(res.status).toBe(200);
    await expect(res.arrayBuffer()).rejects.toThrow(/curl exited 28/);
  });

  it('rejects the body when curl is killed by a signal', async () => {
    const res = await curlLanFetch(cutShort(null, 'SIGKILL'))('http://192.168.1.9:8188/view?filename=a.png');
    await expect(res.arrayBuffer()).rejects.toThrow(/killed by SIGKILL/);
  });

  it('still accepts the whole body on a clean exit', async () => {
    const res = await curlLanFetch(cutShort(0, null))('http://192.168.1.9:8188/view?filename=a.png');
    expect(new Uint8Array(await res.arrayBuffer())).toHaveLength(100);
  });

  it('rejects a body cut short by a real curl hitting --max-time', async () => {
    const server = createServer((_req, rsp) => {
      rsp.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': '100000' });
      rsp.write(Buffer.alloc(1000, 1)); // then stall
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const res = await curlLanFetch(undefined, { maxTime: () => 1 })(`http://127.0.0.1:${port}/view`);
      await expect(res.arrayBuffer()).rejects.toThrow(/curl exited 28/);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  }, 15_000);
});

describe('withGenerator host selection', () => {
  it('treats loopback hosts as local and anything else as LAN', () => {
    for (const u of ['http://127.0.0.1:8188', 'http://localhost:8188', 'http://[::1]:8188', 'http://127.1.2.3:1']) expect(isLoopback(u)).toBe(true);
    for (const u of ['http://192.168.1.50:8188', 'http://box.local:8188', 'http://10.0.0.2']) expect(isLoopback(u)).toBe(false);
  });

  it('uses curl for a LAN COMFY_URL and plain fetch for loopback, taking no GPU lock either way', async () => {
    const calls: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (u: string) => (
      calls.push(`fetch ${u}`),
      new Response(
        JSON.stringify({
          system: { comfyui_version: 'v1', pytorch_version: 't' },
          devices: [],
        }),
      )
    )) as never;
    try {
      const cache = { root: '/nonexistent-art-cache' } as never;
      const local = await withGenerator(cache, g => g.info(), {}, { COMFY_URL: 'http://127.0.0.1:1' });
      expect(local.comfyui).toBe('v1');
      expect(calls).toEqual(['fetch http://127.0.0.1:1/system_stats']);
      calls.length = 0;
      // port 9 of a private address that answers nothing: curl (not the stubbed fetch) must be the one asked
      await expect(withGenerator(cache, g => g.info(), {}, { COMFY_URL: 'http://10.255.255.1:9' })).rejects.toThrow();
      expect(calls).toEqual([]);
      // and a public address is refused before anything is sent
      await expect(withGenerator(cache, g => g.info(), {}, { COMFY_URL: 'http://192.0.2.1:9' })).rejects.toThrow(/not a loopback, private/);
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = real;
    }
  }, 30_000);
});

describe('COMFY_URL stays on the local network', () => {
  it('knows loopback, RFC 1918 and link-local addresses from public ones', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.50', '169.254.10.20', '::1', 'fe80::1', '::ffff:192.168.0.2']) expect(isLanAddress(a), a).toBe(true);
    for (const a of ['8.8.8.8', '172.32.0.1', '192.0.2.1', '100.64.0.1', '2001:db8::1', '::ffff:8.8.8.8', '256.1.1.1', 'box.local']) expect(isLanAddress(a), a).toBe(false);
  });

  it('accepts a private address or a name that resolves only to private ones, and refuses anything else before a request', async () => {
    const dns = (table: Record<string, string[]>) => async (h: string) => (table[h] ?? []).map(address => ({ address }));
    await expect(checkComfyUrl('http://192.168.1.50:8188')).resolves.toBeUndefined();
    await expect(checkComfyUrl('http://[fe80::1]:8188')).resolves.toBeUndefined();
    await expect(checkComfyUrl('http://gpu.lan:8188', dns({ 'gpu.lan': ['192.168.1.50'] }))).resolves.toBeUndefined();
    await expect(checkComfyUrl('http://203.0.113.9:8188')).rejects.toThrow(/203\.0\.113\.9/);
    await expect(checkComfyUrl('http://gpu.example:8188', dns({ 'gpu.example': ['192.168.1.2', '203.0.113.9'] }))).rejects.toThrow(/not a loopback, private/);
    await expect(checkComfyUrl('http://nowhere.invalid:8188', dns({}))).rejects.toThrow(/does not resolve/);
    await expect(checkComfyUrl('ftp://192.168.1.2/')).rejects.toThrow(/http/);
  });
});
