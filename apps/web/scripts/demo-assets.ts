// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { greyboxGlb, toneWav, type GreyboxRoom } from '@another-unity/engine';

/** The demo game's directory: its media go next to its YAML, where Plan 4's layout puts a game's. */
const demo = fileURLToPath(new URL('../../../tools/play/fixtures/demo/', import.meta.url));
const camera = (x: number, z: number): GreyboxRoom['camera'] => ({ position: [x, 3, z], yfov: 0.8181, horizonY: 100 });

const rooms: Record<string, GreyboxRoom> = {
  corridor: {
    regions: [
      // (the floor's edge has the doorway's corners too, so the two share an edge; T-junctions would also join: Task 6)
      { name: 'floor', walkable: true, points: [{ x: -1.5, z: -1.5 }, { x: 7, z: -1.5 }, { x: 7, z: -1 }, { x: 7, z: 1 }, { x: 7, z: 1.5 }, { x: -1.5, z: 1.5 }] },
      // (opened when the power is rerouted: the panel's path effect)
      { name: 'doorway', walkable: false, points: [{ x: 7, z: -1 }, { x: 9, z: -1 }, { x: 9, z: 1 }, { x: 7, z: 1 }] },
    ],
    markers: { arrival: { x: 0, z: 0 }, panel: { x: 4, z: 0 }, door: { x: 8, z: 0 } },
    hotspots: [
      { object: 'panel', at: { x: 4, z: 0 }, width: 0.8, height: 1.4, depth: 0.4 },
      { object: 'door', at: { x: 8, z: 0 }, width: 1.6, height: 2.4, depth: 0.3, kind: 'transition' },
    ],
    camera: camera(3.5, 10),
  },
  lab: {
    regions: [{ name: 'floor', walkable: true, points: [{ x: -1, z: -2 }, { x: 7, z: -2 }, { x: 7, z: 3 }, { x: -1, z: 3 }] }],
    markers: { entry: { x: 0, z: 0 }, bench: { x: 3, z: 2 }, guard: { x: 6, z: 0 } },
    hotspots: [
      { object: 'chip', at: { x: 3, z: 2 }, width: 0.4, height: 0.9, depth: 0.4 },
      { object: 'guard', at: { x: 6, z: 0 }, width: 0.7, height: 1.9, depth: 0.5, kind: 'walker' },
    ],
    camera: camera(3, 11),
  },
};

const files: Record<string, Uint8Array> = {
  'models/rooms/corridor.glb': greyboxGlb(rooms.corridor),
  'models/rooms/lab.glb': greyboxGlb(rooms.lab),
  // d@01 said by Data (02), and the guard's reply (ff: not crew)
  'audio/voice/d0201.wav': toneWav(1.2, 440),
  'audio/voice/dff01.wav': toneWav(0.8, 330),
  'audio/sfx/chime.wav': toneWav(0.3, 880),
  'audio/sfx/combadge.wav': toneWav(0.2, 1320),
  'audio/sfx/tricorder.wav': toneWav(0.4, 990),
  'audio/sfx/phaser.wav': toneWav(0.5, 1760),
  'audio/music/hum.wav': toneWav(2, 110),
};

for (const [path, bytes] of Object.entries(files)) {
  await mkdir(dirname(join(demo, path)), { recursive: true });
  await writeFile(join(demo, path), bytes);
}
console.log(`wrote ${Object.keys(files).length} demo assets`);
