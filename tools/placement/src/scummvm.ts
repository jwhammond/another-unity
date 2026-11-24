// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * What ScummVM's Unity engine has on a screen when the away team arrives: each object's flags, state, position, sprite and animation, read from
 * the console's `object` command in a harness run (tools/scummvm-harness). The run goes through run.sh, which keeps the game muted.
 */

export interface ScummObject {
  id: string;
  name: string;
  screen: number;
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
  flags: number;
  active: boolean;
  state: number;
  sprite: number;
  anim: number;
  /** `playing animation` was printed: the object has a sprite player. */
  player: boolean;
  /** The animation the player is on (-1 when none has started). */
  playing: number;
  nothingShown: boolean;
  stopped: boolean;
}

/** The harness script for one run: each screen is started, given time to load, and every object asked after. */
export function harnessScript(rooms: { world: number; screen: number; objects: string[] }[], waitMs = 2500): string {
  const lines: string[] = [];
  // (the ship's triggers a new game has enabled, as tools/tracediff/run-scummvm.sh turns them off)
  for (const t of ['0x10', '3', '0x13', '0x14', '0x15', '0x40', '0x4a']) lines.push(`trigger ${t} off`);
  for (const r of rooms) {
    // (`objects` says which screen the player is on, which marks where the room's objects start in the log)
    lines.push(`screen ${r.world} ${r.screen}`, `wait ${waitMs}`, 'objects');
    for (const o of r.objects) lines.push(`object ${o}`);
  }
  lines.push('wait 500', 'quit');
  return lines.join('\n') + '\n';
}

/** Parses a run's log into the objects it printed, by screen ("world/screen"). */
export function parseLog(log: string): Map<string, ScummObject[]> {
  const out = new Map<string, ScummObject[]>();
  let room: string | null = null;
  let cur: ScummObject | null = null;
  for (const line of log.split('\n')) {
    const r = /^Screen (\d+)\/(\d+) has \d+ object/.exec(line);
    if (r) {
      room = `${r[1]}/${r[2]}`;
      out.set(room, []);
      cur = null;
      continue;
    }
    if (!room) continue;
    const row = /^ *\d+: ([0-9a-f]{6}) (.*?) +flags ([0-9a-f]{2}) state (-?\d+) at \((-?\d+), (-?\d+)\)$/.exec(line);
    if (row) {
      const flags = parseInt(row[3]!, 16);
      out.get(room)!.push({ id: row[1]!, name: row[2]!, screen: 0, x: Number(row[5]), y: Number(row[6]), z: 0, width: 0, height: 0, flags, active: (flags & 0x20) !== 0, state: Number(row[4]), sprite: 0xffff, anim: 0, player: false, playing: -1, nothingShown: false, stopped: false });
      cur = null;
      continue;
    }
    const head = /^(.*) \(([0-9a-f]{6})\)$/.exec(line);
    if (head) {
      const known = out.get(room)!.find(o => o.id === head[2]);
      if (known) {
        cur = known;
        continue;
      }
      cur = { id: head[2]!, name: head[1]!, screen: 0, x: 0, y: 0, z: 0, width: 0, height: 0, flags: 0, active: false, state: 0, sprite: 0xffff, anim: 0, player: false, playing: -1, nothingShown: false, stopped: false };
      out.get(room)!.push(cur);
      continue;
    }
    if (!cur) continue;
    let m: RegExpExecArray | null;
    if ((m = /^ {2}screen (\d+), position \((-?\d+), (-?\d+), (-?\d+)\), size (\d+)x(\d+)/.exec(line))) {
      [cur.screen, cur.x, cur.y, cur.z, cur.width, cur.height] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
    } else if ((m = /^ {2}flags ([0-9a-f]{2}):/.exec(line))) {
      cur.flags = parseInt(m[1]!, 16);
      cur.active = (cur.flags & 0x20) !== 0;
    } else if ((m = /^ {2}state (-?\d+),/.exec(line))) {
      cur.state = Number(m[1]);
    } else if ((m = /^ {2}sprite (\d+), animation (-?\d+)/.exec(line))) {
      cur.sprite = Number(m[1]);
      cur.anim = Number(m[2]);
    } else if ((m = /^ {2}playing animation (-?\d+)(.*)$/.exec(line))) {
      cur.player = true;
      cur.playing = Number(m[1]);
      cur.nothingShown = m[2]!.includes('nothing shown');
      cur.stopped = m[2]!.includes('stopped');
    }
  }
  return out;
}
