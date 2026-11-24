// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { palHex } from './panel';

/**
 * How a phaser shot is drawn (UnityEngine::phaserShot, awayteam.cpp): the executable's table of where the beam leaves each crew member's sprite in each
 * of 12 directions, and the palette colours the beam is drawn in. Written to presentation.yaml's art.phaser, the local file, so nothing of the game's data
 * is committed.
 */
export const BEAM_COLOURS = { beam: 0xcd, beamEdge: 0xa6, pulse: 0xa5, pulseEdge: 0xa7 } as const;
/** The crew the muzzle table goes by: the first ten objects of the ship world (NUM_PHASER_MUZZLE_CREW). */
export const MUZZLE_CREW = 10;
export const MUZZLE_DIRECTIONS = 12;

export interface PhaserTable {
  muzzles: [number, number, number][];
  crew: string[];
  colours: Record<keyof typeof BEAM_COLOURS, string>;
}

/** The table from the executable's `_phaserMuzzles`, the ids' first ten objects, and standard.pal. */
export function phaserTable(muzzles: { x: number; y: number; frame: number }[], objects: Record<string, string>, standardPal: Uint8Array): PhaserTable {
  if (muzzles.length < MUZZLE_CREW * MUZZLE_DIRECTIONS) throw new Error(`the executable has ${muzzles.length} muzzles, need ${MUZZLE_CREW * MUZZLE_DIRECTIONS}`);
  const crew: string[] = [];
  for (let i = 0; i < MUZZLE_CREW; i++) {
    const slug = objects[`00000${i}`.slice(-6)];
    if (!slug) throw new Error(`ids.yaml has no object 00000${i}`);
    crew.push(slug);
  }
  return {
    muzzles: muzzles.slice(0, MUZZLE_CREW * MUZZLE_DIRECTIONS).map(m => [m.x, m.y, m.frame]),
    crew,
    colours: Object.fromEntries(Object.entries(BEAM_COLOURS).map(([k, i]) => [k, palHex(standardPal, i)])) as PhaserTable['colours'],
  };
}

/** Sets art.phaser in presentation.yaml, keeping everything else. */
export async function publishPhaser(gameDir: string, table: PhaserTable): Promise<void> {
  const path = join(gameDir, 'presentation.yaml');
  const doc = parseDocument(existsSync(path) ? await readFile(path, 'utf8') : '');
  doc.setIn(['art', 'phaser'], table);
  await writeFile(path, String(doc));
}
