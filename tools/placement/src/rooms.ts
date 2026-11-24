// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

export interface RoomIds {
  /** "lab.s03" */
  room: string;
  world: number;
  screen: number;
  /** The raw ids (wwssii, lower-case hex) of the objects ids.yaml names on the screen, with their slugs. */
  objects: { raw: string; slug: string }[];
}

/** The rooms (by id like "lab" or "lab.s03") and the objects ids.yaml has on each, in raw id order. */
export function roomsOf(idsYamlPath: string, wanted: string[]): RoomIds[] {
  const ids = parse(readFileSync(idsYamlPath, 'utf8')) as { screens: Record<string, string>; objects: Record<string, string> };
  const out: RoomIds[] = [];
  for (const [stem, room] of Object.entries(ids.screens)) {
    if (!/^s_[0-9a-f]{4}$/.test(stem)) continue;
    if (!wanted.some(w => room === w || room.startsWith(`${w}.`))) continue;
    const world = parseInt(stem.slice(2, 4), 16);
    const screen = parseInt(stem.slice(4, 6), 16);
    const prefix = stem.slice(2);
    const objects = Object.entries(ids.objects)
      .filter(([raw]) => /^[0-9a-f]{6}$/.test(raw) && raw.startsWith(prefix))
      .map(([raw, slug]) => ({ raw, slug }))
      .sort((a, b) => a.raw.localeCompare(b.raw));
    out.push({ room, world, screen, objects });
  }
  return out.sort((a, b) => a.room.localeCompare(b.room));
}
