// SPDX-License-Identifier: GPL-3.0-or-later
import { hex2, worldSlug } from './ids';
import type { Problems } from './problems';
import type { RawIR } from './raw';

/** One screen text as the game draws it: a box in the 640 by 480 screen's pixels and its lines. */
export interface ScreenTextDef {
  x: number;
  y: number;
  width: number;
  height: number;
  font: number;
  lines: string[];
}

/** screentexts.yaml: by screen slug, then by record number. */
export type ScreenTextsFile = Record<string, Record<number, ScreenTextDef>>;

const latin1 = new TextDecoder('latin1');

/**
 * t_WWSS00.bst as UnityEngine::showScreenText reads it (talk.cpp:341-385): records of "id x y width height font @text@", the
 * text running over lines (a line ends at a carriage return), and `#` starting a comment. A record the parser can't read ends the file.
 */
export function parseScreenTexts(bytes: Uint8Array): Map<number, ScreenTextDef> {
  let contents = latin1.decode(bytes);
  const eof = contents.indexOf('\x1a');
  if (eof >= 0) contents = contents.slice(0, eof);
  const out = new Map<number, ScreenTextDef>();
  let p = 0;
  while (p < contents.length) {
    while (contents[p] === '\r' || contents[p] === '\n') p++;
    if (contents[p] === '#') {
      while (p < contents.length && contents[p] !== '\n') p++;
      continue;
    }
    const start = contents.indexOf('@', p);
    const head = /^\s*(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)/.exec(contents.slice(p, start < 0 ? p : start));
    if (start < 0 || !head) break;
    const end = contents.indexOf('@', start + 1);
    if (end < 0) break;
    p = end + 1;
    const [id, x, y, width, height, font] = head.slice(1).map(Number);
    const lines: string[] = [];
    let line = '';
    for (const c of contents.slice(start + 1, end)) {
      if (c === '\r' || c === '\n') {
        if (c === '\r') lines.push(line);
        line = '';
      } else line += c;
    }
    lines.push(line);
    // (the first record with an id is the one the game finds)
    if (!out.has(id)) out.set(id, { x, y, width, height, font: font & 0xff, lines });
  }
  return out;
}

/** The lifted worlds' screen texts: showScreenText's t_WWSS00.bst for each of their screens the export has. */
export function liftScreenTexts(raw: RawIR, worlds: readonly number[], problems: Problems): ScreenTextsFile {
  const out: ScreenTextsFile = {};
  for (const [name, bytes] of [...(raw.screenTexts ?? [])].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const world = parseInt(name.slice(0, 2), 16);
    const screen = parseInt(name.slice(2, 4), 16);
    if (!worlds.includes(world)) continue;
    const records = parseScreenTexts(bytes);
    if (records.size === 0) {
      problems.warn(`verbatim/t_${name}00.bst`, 'no screen text records');
      continue;
    }
    out[`${worldSlug(world)}.s${hex2(screen)}`] = Object.fromEntries([...records].sort(([a], [b]) => a - b));
  }
  return out;
}
