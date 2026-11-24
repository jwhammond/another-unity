// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment happy-dom
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseRoom } from '../../../engine/src/view/room';
import { BLENDER_SCRIPTS, blenderPath, inspectGlb, runBlender } from './blender';

const bin = blenderPath();
const skip = !process.env.ART_CACHE || !bin;
if (skip) console.info(`live-blender skipped: ${process.env.ART_CACHE ? 'no Blender binary' : 'ART_CACHE is not set'}`);

describe.skipIf(skip)('live Blender', () => {
  it('probe_room.py makes a .glb whose nodes carry region, object and camera extras, and the engine reads it', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'au-blender-')), 'probe.glb');
    const r = await runBlender(join(BLENDER_SCRIPTS, 'probe_room.py'), out, { size: 6 });
    expect(existsSync(out)).toBe(true);
    expect(r.version).toMatch(/^\d+\.\d+\.\d+$/);
    const bytes = new Uint8Array(readFileSync(out));
    const g = await inspectGlb(bytes);
    expect(g.nodes.find(n => n.name === 'region:floor')!.extras).toMatchObject({ region: 'floor', walkable: true });
    expect(g.nodes.find(n => n.name === 'hotspot:probe')!.extras).toMatchObject({ object: 'probe', pickable: true, kind: 'object' });
    expect(g.nodes.find(n => n.name === 'camera:main')!.extras).toMatchObject({ projection: 'perspective', horizonY: 150 });
    const room = await parseRoom(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    expect(room.camera.type).toBe('PerspectiveCamera');
    expect(room.regions.get('floor')!.walkable).toBe(true);
    expect(room.regions.get('floor')!.triangles.length).toBeGreaterThan(0);
    expect(room.hotspots.get('probe')!.pickable).toBe(true);
  }, 60_000);

  it('a script error fails the run with the traceback', async () => {
    await expect(runBlender(join(BLENDER_SCRIPTS, 'no_such_script.py'), join(tmpdir(), 'x.glb'), {})).rejects.toThrow(/exited/);
  }, 60_000);
});
