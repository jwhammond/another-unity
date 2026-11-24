// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { greyboxGlb, type GreyboxRoom } from './greybox';
import { toneWav } from './media';

const room: GreyboxRoom = {
  regions: [
    { name: 'r1', walkable: true, points: [{ x: 0, z: 0 }, { x: 2, z: 0 }, { x: 2, z: 2 }, { x: 0, z: 2 }] },
    { name: 'r2', walkable: false, points: [{ x: 2, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 2 }, { x: 2, z: 2 }] },
  ],
  markers: { door: { x: 0.5, z: 0.5 } },
  hotspots: [{ object: 'panel', at: { x: 1.5, z: 0.5 }, width: 0.5, height: 1, depth: 0.5 }],
  camera: { position: [1, 3, 8], yfov: 0.8181, horizonY: 100 },
};

function read(glb: Uint8Array) {
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const jsonLength = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength))) as {
    nodes: { name: string; extras?: unknown; translation?: number[]; scale?: number[] }[];
  };
  return { magic: dv.getUint32(0, true), version: dv.getUint32(4, true), length: dv.getUint32(8, true), json };
}

describe('greyboxGlb', () => {
  it("writes a .glb with Plan 4's node names and extras", () => {
    const glb = greyboxGlb(room);
    const { magic, version, length, json } = read(glb);
    expect([magic, version, length]).toEqual([0x46546c67, 2, glb.length]);
    expect(glb.length % 4).toBe(0);
    expect(json.nodes.map(n => n.name)).toEqual(['region:r1', 'region:r2', 'marker:door', 'hotspot:panel', 'camera:main']);
    expect(json.nodes[1].extras).toEqual({ region: 'r2', walkable: false, type: 0 });
    expect(json.nodes[2]).toMatchObject({ translation: [0.5, 0, 0.5], extras: { marker: 'door' } });
    expect(json.nodes[3]).toMatchObject({ translation: [1.5, 0.5, 0.5], scale: [0.5, 1, 0.5], extras: { object: 'panel', pickable: true, kind: 'object' } });
    expect(json.nodes[4]).toMatchObject({ translation: [1, 3, 8], extras: { projection: 'perspective', horizonY: 100 } });
  });
});

describe('toneWav', () => {
  it('writes a 16-bit mono PCM WAV', () => {
    const wav = toneWav(0.5, 440, 8000);
    const text = (from: number) => String.fromCharCode(...wav.subarray(from, from + 4));
    const dv = new DataView(wav.buffer);
    expect([text(0), text(8), text(12), text(36)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data']);
    expect(wav.length).toBe(44 + 8000);
    expect([dv.getUint16(22, true), dv.getUint32(24, true), dv.getUint16(34, true)]).toEqual([1, 8000, 16]);
  });
});
