// SPDX-License-Identifier: GPL-3.0-or-later
import { WARP_SPRITES, type CombatSpriteSheet, type SpriteEntry } from './files';

// (the list itself is files.ts', which the main bundle's battle set loader reads without bringing this module in)
export { WARP_SPRITES };

/**
 * The warp overlay (TacticalScreen::showWarp, tactical.cpp:818-854): while the Enterprise warps away, the screen is
 * cheap.pic with three sprites over it, each run by a SpritePlayer (sprite_player.cpp), for combatTicks(0x369) ms. Pure:
 * which frames show where, at a time into the overlay. warpOverlay.ts draws it.
 */

/** A sprite wait's milliseconds: the original's clock runs at 291.3 ticks a second and a wait is in sixteenths of a tick (sprite_player.cpp:34-36, 377-379). */
export function spriteWait(wait: number): number {
  return Math.trunc(((wait >> 4) * 10000) / 2913);
}

/** One sprite of the overlay at a moment: the frames drawn, oldest first (a masked sprite's build up), at the frame's top left. */
export interface WarpLayer { file: string; frames: number[]; left: number; top: number }

/**
 * Where SpritePlayer::update (sprite_player.cpp:241-438) has a sprite `ms` into its animation 0: its entries run from the
 * start, a wait holding them until its time has passed (strictly, :382), a pause or exit for good. A frame is drawn while
 * the player waits on it, at its position less half its width and its full height (Graphics::drawSprite, graphics.cpp:472-473).
 * After a `mask` the frames drawn build up on the sprite's canvas (:346-352, graphics.cpp:474-478); else the last alone.
 * A jump goes to its animation's first entry; the warp's sprites jump only to animation 0, entry 0 (measured), so any other
 * target ends the player. Null before the sprite has a frame.
 *
 * The waits are nominal, each from where the last ended. ScummVM's are not: SpritePlayer::update sets a wait's target at
 * the update that reaches it, and updates come once a waitAndDraw pass (a draw and delayMillis(10), unity.cpp:1001-1008),
 * so each wait runs over by up to a pass, how much depending on the machine. Over vwwarped's 30 waits its build-up ends
 * about 2.7-2.85 s into ScummVM's overlay, against 2.55 s here. The port keeps the nominal waits: deterministic, and
 * within a pass a wait of the original's.
 */
export function warpLayerAt(sheet: Pick<CombatSpriteSheet, 'entries' | 'cell'>, file: string, ms: number): WarpLayer | null {
  const entries: readonly SpriteEntry[] = sheet.entries;
  let at = 0, t = 0, masked = false, x = 0, y = 0;
  let current: number | null = null;
  let canvas: number[] = [];
  const draw = () => {
    if (current === null) return;
    if (masked) {
      if (canvas.at(-1) !== current) canvas.push(current);
    } else canvas = [current];
  };
  // (each entry at most a few times over: a sprite that loops with no wait would hang the original, :393-396)
  for (let guard = 0; guard < entries.length * 64 && at < entries.length; guard++) {
    const e = entries[at]!;
    if (e.type === 'sprite') {
      current = typeof e.frame === 'number' ? e.frame : current;
      at++;
    } else if (e.type === 'position') {
      x = Number(e.x);
      y = Number(e.y);
      at++;
    } else if (e.type === 'mask') {
      masked = true;
      canvas = [];
      at++;
    } else if (e.type === 'wait') {
      draw();
      const wait = spriteWait(Number(e.wait));
      if (ms <= t + wait) break;
      t += wait;
      at++;
    } else if (e.type === 'jump') {
      if (Number(e.target) !== 0) break;
      at = 0;
    } else if (e.type === 'pause' || e.type === 'exit') {
      draw();
      break;
    } else {
      at++;
    }
  }
  if (current === null) return null;
  if (at >= entries.length) draw();
  const [w, h] = sheet.cell;
  return { file, frames: masked ? canvas : [current], left: x - Math.trunc(w / 2), top: y - h };
}

/**
 * Common::sort (common/algorithm.h:285-357), in place: the middle element the pivot, swapped to the end; the elements not
 * after it moved before it in order; then each side. Unstable, so a tie comes out as this, not as given.
 */
export function scummSort<T>(a: T[], less: (x: T, y: T) => boolean, first = 0, last = a.length): void {
  if (last - first <= 0) return;
  const swap = (i: number, j: number) => { const t = a[i]!; a[i] = a[j]!; a[j] = t; };
  const end = last - 1;
  swap(first + Math.trunc((last - first) / 2), end);
  let sorted = first;
  for (let i = first; i !== end; i++) {
    if (!less(a[end]!, a[i]!)) {
      if (i !== sorted) swap(i, sorted);
      sorted++;
    }
  }
  if (end !== sorted) swap(end, sorted);
  scummSort(a, less, first, sorted);
  scummSort(a, less, sorted + 1, last);
}

/**
 * The overlay's sprites at `ms` into it, in drawObjects' order (the first drawn first): those whose sheets the set has and
 * that have a frame (a sprite with none isn't sorted in, unity.cpp:1435-1437), in showWarp's order, then sorted as
 * Common::sort sorts them by depth.
 */
export function warpOverlayAt(sheets: ReadonlyMap<string, Pick<CombatSpriteSheet, 'entries' | 'cell'>>, ms: number): WarpLayer[] {
  const out: { layer: WarpLayer; depth: number }[] = [];
  for (const { file, depth } of WARP_SPRITES) {
    const sheet = sheets.get(file);
    const layer = sheet ? warpLayerAt(sheet, file, ms) : null;
    if (layer) out.push({ layer, depth });
  }
  scummSort(out, (x, y) => x.depth < y.depth);
  return out.map(o => o.layer);
}
