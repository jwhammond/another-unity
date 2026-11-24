// SPDX-License-Identifier: GPL-3.0-or-later
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { artCache } from './cache';
import { ComfyHttp, DEFAULT_LOCK, startComfy, withGenerator, type SpawnLike } from './comfy';
import type { Job } from './generator';
import { FakeComfy } from './testing/fakeComfy';

const job: Job = {
  graph: { '1': { class_type: 'X', inputs: {} } },
  inputs: { 'in.png': new Uint8Array([1, 2, 3]) },
  outputs: { a: '9', b: '10' },
};
const live: FakeComfy[] = [];
async function fake(opts?: ConstructorParameters<typeof FakeComfy>[0]): Promise<FakeComfy> {
  const f = await new FakeComfy(opts).start();
  live.push(f);
  return f;
}
afterEach(async () => {
  await Promise.all(live.splice(0).map(f => f.stop()));
});

describe('ComfyHttp', () => {
  it('uploads inputs, queues the graph, polls history and fetches each named output', async () => {
    const f = await fake({ pendingPolls: 2 });
    f.image = new Uint8Array([9, 8, 7]);
    const out = await new ComfyHttp(f.url, { pollMs: 1 }).run(job);
    expect(f.uploads.map(u => u.name)).toEqual(['in.png']);
    expect(f.prompts).toHaveLength(1);
    expect(Object.keys(out)).toEqual(['a', 'b']);
    expect([...out.a!]).toEqual([9, 8, 7]);
    expect(f.views).toEqual(['out9.png', 'out10.png']);
  });

  it("throws with ComfyUI's node_errors when it refuses a graph", async () => {
    const f = await fake({ nodeErrors: { '3': { message: 'bad input' } } });
    await expect(new ComfyHttp(f.url, { pollMs: 1 }).run(job)).rejects.toThrow(/refused the graph.*bad input/);
  });

  it('throws with the messages when a run errors, and on timeout', async () => {
    const e = await fake({ errorMessages: ['out of memory'] });
    await expect(new ComfyHttp(e.url, { pollMs: 1 }).run(job)).rejects.toThrow(/failed.*out of memory/);
    const h = await fake({ hang: true });
    await expect(new ComfyHttp(h.url, { pollMs: 1, timeoutMs: 30 }).run(job)).rejects.toThrow(/took over 30 ms/);
  });

  it('reports info and the node types the server knows', async () => {
    const f = await fake({ classTypes: ['KSampler', 'SaveImage'] });
    const c = new ComfyHttp(f.url);
    expect(await c.info()).toMatchObject({ comfyui: '0.0.0-fake', torch: '2.0', device: 'mps', vramTotal: 100 });
    expect([...(await c.nodeTypes())]).toEqual(['KSampler', 'SaveImage']);
  });
});

/** A spawn whose child "serves" by answering the fake fetch; records its arguments and signals. */
function mockSpawn(): { spawnFn: SpawnLike; calls: { cmd: string; args: string[] }[]; signals: string[]; child: ChildProcess } {
  const calls: { cmd: string; args: string[] }[] = [];
  const child = Object.assign(new EventEmitter(), { pid: 4242, stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true }) as unknown as ChildProcess;
  const signals: string[] = [];
  return { spawnFn: (cmd, args) => (calls.push({ cmd, args }), child), calls, signals, child };
}
const readyFetch = (async () => new Response('{}')) as unknown as typeof fetch;

describe('startComfy', () => {
  const cache = artCache({ ART_CACHE: '/tmp/au-art-test-cache' });

  it("binds 127.0.0.1 with --disable-auto-launch and the cache's model paths, and is stopped when the run throws", async () => {
    const m = mockSpawn();
    const signal = (c: ChildProcess, sig: NodeJS.Signals): void => {
      m.signals.push(sig);
      c.emit('close', 0);
    };
    await expect(
      withGenerator(
        cache,
        async () => {
          throw new Error('boom');
        },
        { lock: false, spawnFn: m.spawnFn, signal, fetchFn: readyFetch, pollMs: 1 },
        {},
      ),
    ).rejects.toThrow('boom');
    const { cmd, args } = m.calls[0]!;
    expect(cmd).toBe(cache.python);
    expect(args[args.indexOf('--listen') + 1]).toBe('127.0.0.1');
    expect(Number(args[args.indexOf('--port') + 1])).toBeGreaterThan(0);
    expect(args).toContain('--disable-auto-launch');
    expect(args[args.indexOf('--extra-model-paths-config') + 1]).toBe(cache.modelPaths);
    expect(args[args.indexOf('--input-directory') + 1]).toBe(cache.io.input);
    expect(m.signals).toEqual(['SIGINT']);
  });

  it('puts the wrapper first and keeps its output for the benchmark', async () => {
    const m = mockSpawn();
    const server = await startComfy(cache, { lock: false, spawnFn: m.spawnFn, fetchFn: readyFetch, wrap: ['/usr/bin/time', '-l'], flags: ['--force-fp16'], pollMs: 1, signal: (c) => void c.emit('close', 0) });
    m.child.stderr!.emit('data', Buffer.from('  12345  peak memory footprint\n'));
    expect(m.calls[0]!.cmd).toBe('/usr/bin/time');
    expect(m.calls[0]!.args.slice(0, 2)).toEqual(['-l', cache.python]);
    expect(m.calls[0]!.args).toContain('--force-fp16');
    expect(server.output()).toContain('peak memory footprint');
    await server.stop();
  });

  it('stops the process and throws when it exits before it is ready', async () => {
    const m = mockSpawn();
    const failing = (async () => {
      m.child.emit('close', 1);
      throw new Error('refused');
    }) as unknown as typeof fetch;
    await expect(startComfy(cache, { lock: false, spawnFn: m.spawnFn, fetchFn: failing, pollMs: 1 })).rejects.toThrow(/exited before it was ready/);
  });

  describe('the shared GPU lock', () => {
    it('spawns through /usr/bin/lockf -k -t 7200 <lock> before python, with a wrap inside lockf', async () => {
      const m = mockSpawn();
      const p = startComfy(cache, { spawnFn: m.spawnFn, fetchFn: readyFetch, wrap: ['/usr/bin/time', '-l'], pollMs: 1, signal: c => void c.emit('close', 0) });
      await vi.waitFor(() => expect(m.calls).toHaveLength(1));
      m.child.stdout!.emit('data', Buffer.from('starting\n'));
      const server = await p;
      expect(m.calls[0]!.cmd).toBe('/usr/bin/lockf');
      expect(m.calls[0]!.args.slice(0, 6)).toEqual(['-k', '-t', '7200', join(cache.root, '.comfy.lock'), '/usr/bin/time', '-l']);
      expect(m.calls[0]!.args[6]).toBe(cache.python);
      expect(DEFAULT_LOCK(cache)).toBe(join(cache.root, '.comfy.lock'));
      await server.stop();
    });

    it('a lock path and timeout can be set, and plain python follows lockf when there is no wrap', async () => {
      const m = mockSpawn();
      const lock = '/tmp/au-art-test-cache/other.lock';
      const p = startComfy(cache, { spawnFn: m.spawnFn, fetchFn: readyFetch, lock, lockTimeoutS: 5, pollMs: 1, signal: c => void c.emit('close', 0) });
      await vi.waitFor(() => expect(m.calls).toHaveLength(1));
      m.child.stdout!.emit('data', Buffer.from('x\n'));
      const server = await p;
      expect(m.calls[0]!.args.slice(0, 5)).toEqual(['-k', '-t', '5', lock, cache.python]);
      await server.stop();
    });

    it('the ready deadline starts at the first output line, not at spawn: a 10 s silent wait for the lock does not time out a 1 s start', async () => {
      vi.useFakeTimers();
      try {
        const m = mockSpawn();
        let up = false;
        const fetchFn = (async () => (up ? new Response('{}') : Promise.reject(new Error('no')))) as unknown as typeof fetch;
        let result: unknown = 'pending';
        const p = startComfy(cache, { spawnFn: m.spawnFn, fetchFn, startTimeoutMs: 1000, pollMs: 100, signal: c => void c.emit('close', 0) }).then(
          s => (result = s),
          e => (result = e),
        );
        await vi.advanceTimersByTimeAsync(10_000);
        expect(result).toBe('pending');
        m.child.stdout!.emit('data', Buffer.from('Total VRAM\n'));
        await vi.advanceTimersByTimeAsync(300);
        up = true;
        await vi.advanceTimersByTimeAsync(300);
        await p;
        expect(result).toMatchObject({ pid: 4242 });
        // and once output has started, 1 s of not answering is a timeout
      } finally {
        vi.useRealTimers();
      }
    });

    it('a lockf timeout (exit 75) rejects naming the lock path', async () => {
      const m = mockSpawn();
      const p = startComfy(cache, { spawnFn: m.spawnFn, lock: '/tmp/au-art-test-cache/x.lock', lockTimeoutS: 3, pollMs: 1 });
      setTimeout(() => m.child.emit('close', 75), 5);
      await expect(p).rejects.toThrow(/GPU lock \/tmp\/au-art-test-cache\/x\.lock/);
    });

    it('lock:false and COMFY_URL spawn no lockf', async () => {
      const m = mockSpawn();
      const server = await startComfy(cache, { lock: false, spawnFn: m.spawnFn, fetchFn: readyFetch, pollMs: 1, signal: c => void c.emit('close', 0) });
      expect(m.calls[0]!.cmd).toBe(cache.python);
      await server.stop();
      const f = await fake();
      const m2 = mockSpawn();
      await withGenerator(cache, g => g.info(), { spawnFn: m2.spawnFn }, { COMFY_URL: f.url });
      expect(m2.calls).toHaveLength(0);
    });
  });

  it("withGenerator uses COMFY_URL's server and never stops it", async () => {
    const f = await fake();
    const m = mockSpawn();
    const info = await withGenerator(cache, g => g.info(), { spawnFn: m.spawnFn }, { COMFY_URL: f.url });
    expect(info.comfyui).toBe('0.0.0-fake');
    expect(m.calls).toHaveLength(0);
  });

  describe('withGenerator handlers', () => {
    const cache2 = artCache({ ART_CACHE: '/tmp/au-art-test-cache' });
    function setup() {
      const m = mockSpawn();
      const proc = new EventEmitter() as unknown as NodeJS.Process;
      const exits: number[] = [];
      const kills: [number, string][] = [];
      const signal = (c: ChildProcess, sig: NodeJS.Signals): void => {
        m.signals.push(sig);
        c.emit('close', 0);
      };
      const opts = { lock: false as const, spawnFn: m.spawnFn, signal, fetchFn: readyFetch, pollMs: 1, proc, exit: (c: number) => void exits.push(c), killGroup: (p: number, s: string) => void kills.push([p, s]) };
      return { m, proc, exits, kills, opts };
    }

    it('SIGINT and SIGTERM stop the owned server, then exit 130 / 143', async () => {
      for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
        const { m, proc, exits, opts } = setup();
        let release!: () => void;
        const done = withGenerator(cache2, () => new Promise<void>(r => (release = r)), opts, {});
        await vi.waitFor(() => expect((proc as unknown as EventEmitter).listenerCount(sig)).toBe(1));
        (proc as unknown as EventEmitter).emit(sig);
        await vi.waitFor(() => expect(exits).toEqual([code]));
        expect(m.signals).toEqual(['SIGINT']);
        release();
        await done;
      }
    });

    it('a synchronous exit handler kills the process group, and every handler is removed afterwards', async () => {
      const { proc, kills, opts } = setup();
      let during = 0;
      await withGenerator(cache2, async () => {
        during = (proc as unknown as EventEmitter).listenerCount('exit');
        (proc as unknown as EventEmitter).emit('exit');
      }, opts, {});
      expect(during).toBe(1);
      expect(kills).toEqual([[4242, 'SIGKILL']]);
      for (const e of ['SIGINT', 'SIGTERM', 'exit']) expect((proc as unknown as EventEmitter).listenerCount(e)).toBe(0);
    });

    it("installs nothing for COMFY_URL's server, which isn't ours to stop", async () => {
      const f = await fake();
      const { proc, opts } = setup();
      await withGenerator(cache2, async () => expect((proc as unknown as EventEmitter).listenerCount('SIGINT')).toBe(0), opts, { COMFY_URL: f.url });
    });
  });
});
