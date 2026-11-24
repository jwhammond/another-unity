// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn, type ChildProcess } from 'node:child_process';
import { lookup as dnsLookup } from 'node:dns/promises';
import { mkdirSync } from 'node:fs';
import { createServer, isIP } from 'node:net';
import { dirname, join } from 'node:path';
import type { ArtCache } from './cache';
import { curlLanFetch } from './lanFetch';
import { isLanAddress } from './secrets';
import type { Generator, GeneratorInfo, Job } from './generator';

interface HistoryEntry {
  status?: { status_str?: string; completed?: boolean; messages?: unknown };
  outputs: Record<string, { images?: { filename: string; subfolder: string; type: string }[] }>;
}

const UPLOAD_BUDGET_S = 120;

export class ComfyHttp implements Generator {
  private readonly fetchFn: typeof fetch;
  private readonly pollMs: number;
  private readonly timeoutMs: number;

  constructor(
    private readonly base: string,
    opts: { fetchFn?: typeof fetch; pollMs?: number; timeoutMs?: number } = {},
  ) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.pollMs = opts.pollMs ?? 250;
    this.timeoutMs = opts.timeoutMs ?? 600_000;
  }

  private async ok(res: Response): Promise<Response> {
    if (!res.ok) throw new Error(`ComfyUI answered ${res.status} for ${res.url}: ${(await res.text()).slice(0, 500)}`);
    return res;
  }

  async run(job: Job): Promise<Record<string, Uint8Array>> {
    // one budget for all of a job's uploads, so a stalled host fails the job once, not once per input
    const uploadEnd = Date.now() + UPLOAD_BUDGET_S * 1000;
    for (const [name, bytes] of Object.entries(job.inputs)) {
      const form = new FormData();
      form.append('image', new Blob([bytes], { type: 'image/png' }), name);
      form.append('overwrite', 'true');
      const left = uploadEnd - Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stalled = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`ComfyUI upload of input "${name}" did not finish within the ${UPLOAD_BUDGET_S} s budget for a job's uploads`)), Math.max(0, left));
      });
      try {
        // lanMaxTime is read by curlLanFetch only; plain fetch ignores it
        const init = { method: 'POST', body: form, lanMaxTime: Math.max(1, left / 1000) } as RequestInit;
        await Promise.race([this.fetchFn(`${this.base}/upload/image`, init).then(r => this.ok(r)), stalled]);
      } catch (e) {
        if (e instanceof Error && !e.message.includes(`"${name}"`)) throw new Error(`ComfyUI upload of input "${name}" failed: ${e.message}`);
        throw e;
      } finally {
        clearTimeout(timer);
      }
    }
    const queued = await this.fetchFn(`${this.base}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: job.graph, client_id: 'tools-art' }),
    });
    if (queued.status === 400) {
      // ComfyUI answers a refused graph with 400 and the reasons in the body.
      throw new Error(`ComfyUI refused the graph: ${(await queued.text()).slice(0, 2000)}`);
    }
    const { prompt_id, node_errors } = (await (await this.ok(queued)).json()) as { prompt_id: string; node_errors?: Record<string, unknown> };
    if (node_errors && Object.keys(node_errors).length > 0) throw new Error(`ComfyUI refused the graph: ${JSON.stringify(node_errors)}`);
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      const history = (await (await this.ok(await this.fetchFn(`${this.base}/history/${prompt_id}`))).json()) as Record<string, HistoryEntry>;
      const entry = history[prompt_id];
      if (entry?.status?.status_str === 'error') throw new Error(`ComfyUI failed: ${JSON.stringify(entry.status.messages)}`);
      if (entry?.status?.completed) {
        const out: Record<string, Uint8Array> = {};
        for (const [name, node] of Object.entries(job.outputs)) {
          const image = entry.outputs[node]?.images?.[0];
          if (!image) throw new Error(`ComfyUI made no image at node ${node} (${name})`);
          const q = new URLSearchParams({
            filename: image.filename,
            subfolder: image.subfolder,
            type: image.type,
          });
          out[name] = new Uint8Array(await (await this.ok(await this.fetchFn(`${this.base}/view?${q}`))).arrayBuffer());
        }
        return out;
      }
      if (Date.now() > deadline) throw new Error(`ComfyUI took over ${this.timeoutMs} ms on ${prompt_id}`);
      await new Promise(r => setTimeout(r, this.pollMs));
    }
  }

  async info(): Promise<GeneratorInfo> {
    const s = (await (await this.ok(await this.fetchFn(`${this.base}/system_stats`))).json()) as {
      system: { comfyui_version: string; pytorch_version: string };
      devices: { type: string; vram_total: number; vram_free: number }[];
    };
    const d = s.devices[0];
    return {
      comfyui: s.system.comfyui_version,
      torch: s.system.pytorch_version,
      device: d?.type ?? 'unknown',
      vramTotal: d?.vram_total ?? 0,
      vramFree: d?.vram_free ?? 0,
    };
  }

  /** The server's whole /object_info: node types, with each loader's list of installed files. */
  async objectInfo(): Promise<Record<string, unknown>> {
    return (await (await this.ok(await this.fetchFn(`${this.base}/object_info`))).json()) as Record<string, unknown>;
  }

  async nodeTypes(): Promise<Set<string>> {
    const o = (await (await this.ok(await this.fetchFn(`${this.base}/object_info`))).json()) as Record<string, unknown>;
    return new Set(Object.keys(o));
  }
}

export interface ComfyServer {
  url: string;
  pid: number;
  /** Everything the process (and its `wrap`, e.g. /usr/bin/time -l) wrote to stdout and stderr. */
  output(): string;
  stop(): Promise<void>;
}
export interface SpawnLike {
  (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; detached?: boolean }): ChildProcess;
}
export interface StartOpts {
  flags?: string[];
  spawnFn?: SpawnLike;
  wrap?: string[];
  log?: (line: string) => void;
  /** Sends a signal to the server's process group (default), so a `wrap` lives to print its report. */
  signal?: (child: ChildProcess, sig: NodeJS.Signals) => void;
  startTimeoutMs?: number;
  /** The shared GPU lock file (default DEFAULT_LOCK): the server runs inside `lockf -k -t lockTimeoutS`, so parallel art runs take turns. `false` takes no lock. */
  lock?: string | false;
  lockTimeoutS?: number;
  /** Test hook: poll interval while waiting for /system_stats. */
  pollMs?: number;
  fetchFn?: typeof fetch;
  /** Test hooks for withGenerator's handlers: the process (default `process`), its exit, and a synchronous group kill. */
  proc?: Pick<NodeJS.Process, 'once' | 'on' | 'removeListener'>;
  exit?: (code: number) => void;
  killGroup?: (pid: number, sig: NodeJS.Signals) => void;
}

/** One lock per cache: every worktree's art runs that share the cache (and the GPU) queue on it. */
export const DEFAULT_LOCK = (cache: ArtCache): string => join(cache.root, '.comfy.lock');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

const groupSignal = (child: ChildProcess, sig: NodeJS.Signals): void => {
  try {
    process.kill(-child.pid!, sig);
  } catch {
    child.kill(sig);
  }
};

/**
 * Starts ComfyUI from the cache's venv on 127.0.0.1 and a free port, and waits for /system_stats (up to 120 s).
 * `wrap` prefixes the command (the benchmark's /usr/bin/time -l).
 */
export async function startComfy(cache: ArtCache, opts: StartOpts = {}): Promise<ComfyServer> {
  const spawnFn: SpawnLike = opts.spawnFn ?? ((cmd, args, o) => spawn(cmd, args, { ...o, stdio: ['ignore', 'pipe', 'pipe'] }));
  const signal = opts.signal ?? groupSignal;
  const fetchFn = opts.fetchFn ?? fetch;
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  mkdirSync(cache.io.input, { recursive: true });
  mkdirSync(cache.io.output, { recursive: true });
  const comfyArgs = [
    join(cache.comfy, 'main.py'),
    '--listen', '127.0.0.1',
    '--port', String(port),
    '--disable-auto-launch',
    '--extra-model-paths-config', cache.modelPaths,
    '--input-directory', cache.io.input,
    '--output-directory', cache.io.output,
    ...(opts.flags ?? []),
  ];
  const wrap = opts.wrap ?? [];
  const lock = opts.lock === undefined ? DEFAULT_LOCK(cache) : opts.lock;
  const lockTimeoutS = opts.lockTimeoutS ?? 7200;
  let cmd: string;
  let args: string[];
  {
    const inner = wrap.length ? [...wrap, cache.python, ...comfyArgs] : [cache.python, ...comfyArgs];
    if (lock) {
      mkdirSync(dirname(lock), { recursive: true });
      [cmd, args] = ['/usr/bin/lockf', ['-k', '-t', String(lockTimeoutS), lock, ...inner]];
    } else {
      [cmd, args] = [inner[0]!, inner.slice(1)];
    }
  }
  const child = spawnFn(cmd, args, {
    cwd: cache.comfy,
    env: {
      ...process.env,
      HF_HUB_OFFLINE: '1',
      HF_HUB_DISABLE_TELEMETRY: '1',
      PYTHONUNBUFFERED: '1',
    },
    detached: true,
  });
  let output = '';
  // With the lock, the clock starts at the process's first output line: waiting for another run's turn is silent.
  const startMs = opts.startTimeoutMs ?? 120_000;
  let deadline: number | undefined = lock ? undefined : Date.now() + startMs;
  const onData = (d: Buffer | string): void => {
    const text = String(d);
    output += text;
    if (deadline === undefined && text.trim()) deadline = Date.now() + startMs;
    if (opts.log) for (const line of text.split('\n')) if (line.trim()) opts.log(line);
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  let exited = false;
  let exitCode: number | null = null;
  const closed = new Promise<void>(resolve => {
    child.once('close', (code: number | null) => {
      exited = true;
      exitCode = code;
      resolve();
    });
    child.once('error', () => {
      exited = true;
      resolve();
    });
  });

  const stop = async (): Promise<void> => {
    if (exited) return;
    // SIGINT first: /usr/bin/time ignores it, so it waits for ComfyUI to leave and then prints its report.
    signal(child, 'SIGINT');
    const wait = (ms: number): Promise<boolean> => new Promise(r => { const t = setTimeout(() => r(false), ms); void closed.then(() => { clearTimeout(t); r(true); }); });
    if (await wait(8000)) return;
    signal(child, 'SIGTERM');
    if (await wait(4000)) return;
    signal(child, 'SIGKILL');
    await wait(4000);
  };

  try {
    for (;;) {
      if (exited && lock && exitCode === 75) throw new Error(`gave up waiting ${lockTimeoutS} s for the GPU lock ${lock} (another art run holds it)`);
      if (exited) throw new Error(`ComfyUI exited before it was ready:\n${output.slice(-2000)}`);
      if (deadline !== undefined) {
        try {
          const r = await fetchFn(`${url}/system_stats`);
          if (r.ok) break;
        } catch {
          // not listening yet
        }
      }
      if (deadline !== undefined && Date.now() > deadline) throw new Error(`ComfyUI was not ready after ${startMs} ms:\n${output.slice(-2000)}`);
      await new Promise(r => setTimeout(r, opts.pollMs ?? 250));
    }
  } catch (e) {
    await stop();
    throw e;
  }
  return { url, pid: child.pid ?? 0, output: () => output, stop };
}

export function isLoopback(url: string): boolean {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '::1' || /^127\./.test(host);
}

/**
 * Refuses a COMFY_URL whose host is not on the user's own network (spec Decision 3): the server is sent the game's originals
 * and the reference crops, so it must be loopback, RFC 1918 or link-local. A name is resolved, and every address it has must be.
 */
export async function checkComfyUrl(url: string, lookup: (host: string) => Promise<{ address: string }[]> = h => dnsLookup(h, { all: true })): Promise<void> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`COMFY_URL "${url}" is not a URL`);
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error(`COMFY_URL must be http(s), not ${u.protocol}`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : await lookup(host).then(as => as.map(a => a.address), () => [] as string[]);
  if (addresses.length === 0) throw new Error(`COMFY_URL host ${host} does not resolve`);
  const outside = addresses.filter(a => !isLanAddress(a));
  if (outside.length > 0) throw new Error(`COMFY_URL host ${host} (${outside.join(', ')}) is not a loopback, private (RFC 1918) or link-local address: nothing is sent off the local network`);
}

/** COMFY_URL's server if set, else a fresh one; always stopped (if ours) after `use`, even when it throws. */
export async function withGenerator<T>(
  cache: ArtCache,
  use: (g: Generator, server?: ComfyServer) => Promise<T>,
  opts: StartOpts = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  // A remote server queues its own jobs, so no GPU lock; macOS may bar Node from the LAN, so go through curl.
  if (env.COMFY_URL) {
    await checkComfyUrl(env.COMFY_URL);
    return use(
      new ComfyHttp(env.COMFY_URL, {
        fetchFn: isLoopback(env.COMFY_URL) ? undefined : curlLanFetch(),
      }),
    );
  }
  const server = await startComfy(cache, opts);
  // The server is detached (its own process group), so the terminal's Ctrl-C doesn't reach it: stop it ourselves,
  // and as a last resort kill the group synchronously when the process exits some other way.
  const proc = opts.proc ?? process;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const killGroup =
    opts.killGroup ??
    ((pid: number, sig: NodeJS.Signals) => {
      try {
        process.kill(-pid, sig);
      } catch {
        // already gone
      }
    });
  const onSignal = (code: number) => () => {
    void server.stop().finally(() => exit(code));
  };
  const onInt = onSignal(130);
  const onTerm = onSignal(143);
  const onExit = (): void => {
    if (server.pid) killGroup(server.pid, 'SIGKILL');
  };
  proc.once('SIGINT', onInt);
  proc.once('SIGTERM', onTerm);
  proc.on('exit', onExit);
  try {
    return await use(new ComfyHttp(server.url), server);
  } finally {
    proc.removeListener('SIGINT', onInt);
    proc.removeListener('SIGTERM', onTerm);
    proc.removeListener('exit', onExit);
    await server.stop();
  }
}
