// SPDX-License-Identifier: GPL-3.0-or-later
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { greyboxGlb } from '../../../engine/src/testing/greybox';
import { BLENDER_APP, blenderArgs, blenderPath, inspectGlb, runBlender } from './blender';
import type { SpawnLike } from './comfy';
import { parseRecipe } from './recipe';

describe('blenderPath', () => {
  it('prefers $BLENDER, then the app, else undefined', () => {
    expect(blenderPath({ BLENDER: '/x/blender' }, () => true)).toBe('/x/blender');
    expect(blenderPath({}, p => p === BLENDER_APP)).toBe(BLENDER_APP);
    expect(blenderPath({}, () => false)).toBeUndefined();
    expect(blenderPath({ BLENDER: '/gone' }, () => false)).toBeUndefined();
  });
});

describe('blenderArgs', () => {
  it('runs headless, factory settings, no audio, failing on a Python error, with params as JSON after --', () => {
    expect(blenderArgs('/s/a.py', '/o/a.glb', { size: 6 })).toEqual([
      '-b', '--factory-startup', '-noaudio', '--python-exit-code', '1', '-P', '/s/a.py', '--', '--out', '/o/a.glb', '--params', '{"size":6}',
    ]);
  });
});

function mock(code: number, stderr = '', stdout = 'Blender 9.9.9 (hash abc)\n'): { spawnFn: SpawnLike; kills: string[]; child: ChildProcess } {
  const kills: string[] = [];
  const child = Object.assign(new EventEmitter(), {
    pid: 1, stdout: new PassThrough(), stderr: new PassThrough(),
    kill: (s: string) => (kills.push(s), true),
  }) as unknown as ChildProcess;
  const spawnFn: SpawnLike = () => {
    setImmediate(() => {
      (child.stdout as PassThrough).write(stdout);
      (child.stderr as PassThrough).write(stderr);
      if (code >= 0) child.emit('close', code);
    });
    return child;
  };
  return { spawnFn, kills, child };
}
const env = { BLENDER: process.execPath }; // any file that exists

describe('runBlender', () => {
  it('resolves with the Blender version on exit 0', async () => {
    const r = await runBlender('/s.py', '/o.glb', {}, { spawnFn: mock(0).spawnFn, env, log: () => {} });
    expect(r.version).toBe('9.9.9');
    expect(r.seconds).toBeGreaterThanOrEqual(0);
  });
  it('rejects with the last stderr lines on a non-zero exit', async () => {
    const err = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const p = runBlender('/s.py', '/o.glb', {}, { spawnFn: mock(1, err).spawnFn, env, log: () => {} });
    await expect(p).rejects.toThrow(/exited 1[\s\S]*line 29/);
    await expect(runBlender('/s.py', '/o.glb', {}, { spawnFn: mock(1, err).spawnFn, env, log: () => {} })).rejects.not.toThrow(/line 0\b/);
  });
  it('kills on timeout', async () => {
    const m = mock(-1);
    await expect(runBlender('/s.py', '/o.glb', {}, { spawnFn: m.spawnFn, env, log: () => {}, timeoutMs: 20 })).rejects.toThrow(/timed out/);
    expect(m.kills).toContain('SIGKILL');
  });
  it('says so when there is no Blender', async () => {
    await expect(runBlender('/s.py', '/o.glb', {}, { spawnFn: mock(0).spawnFn, env: { BLENDER: '/nope/blender' } })).rejects.toThrow(/Blender/);
  });
});

describe('inspectGlb', () => {
  it("reads names and extras from greyboxGlb's output", async () => {
    const bytes = greyboxGlb({
      regions: [{ name: 'r1', walkable: true, points: [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 1, z: 1 }] }],
      markers: { door: { x: 0, z: 0 } },
      hotspots: [{ object: 'thing', at: { x: 0.5, z: 0.5 }, width: 1, height: 1, depth: 1 }],
      camera: { position: [0, 3, 8], yfov: 0.8, horizonY: 100 },
    });
    const g = await inspectGlb(bytes);
    expect(g.nodes.map(n => n.name)).toEqual(expect.arrayContaining(['region:r1', 'marker:door', 'hotspot:thing']));
    expect(g.nodes.find(n => n.name === 'region:r1')!.extras).toMatchObject({ region: 'r1', walkable: true });
    expect(g.cameras).toBe(1);
    expect(g.meshes).toBeGreaterThan(0);
  });
});

describe('blender recipe', () => {
  it('parses, with defaults', () => {
    const r = parseRecipe('id: p\nkind: blender\nscript: a/b.py\n', 'p.yaml');
    expect(r).toMatchObject({ kind: 'blender', script: 'a/b.py', params: {}, textures: [], out: 'glb' });
    expect(() => parseRecipe('id: p\nkind: blender\nscript: ../x.py\n', 'p.yaml')).toThrow();
  });
});
