// SPDX-License-Identifier: GPL-3.0-or-later
import type { SpriteSheet, ViewscreenImage } from '../view/space';
import type { World } from '../sim/world';

/** A 32-bit hash of the location (FNV-1a over its numbers): the same place always gives the same planet. */
function hash(...n: number[]): number {
  let h = 0x811c9dc5;
  for (const v of n) {
    for (let i = 0; i < 4; i++) {
      h ^= (v >> (i * 8)) & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return h >>> 0;
}

const hex = (r: number, g: number, b: number): string => `#${[r, g, b].map(c => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('')}`;

/** HSV to RGB, each 0..1. */
function hsv(h: number, s: number, v: number): [number, number, number] {
  const f = (n: number): number => {
    const k = (n + h * 6) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5) * 255, f(3) * 255, f(1) * 255];
}

/**
 * The planet's two colours (R7): drawn from a hash of the location, not the original's presentation RNG, so the view is stable and the sim's
 * RNG is never touched. The brighter one comes first, as the original orders them (unity.cpp:628-630). The original draws from the
 * universe's globe palette (makeGlobeColours), which isn't lifted: these are earth, ocean, desert or ice tones chosen the same way.
 */
export function planetColours(sector: number, star: number, planet: number): [string, string] {
  const h = hash(sector, star, planet);
  const pick = (shift: number): [number, number, number] => {
    const bits = (h >>> shift) & 0xff;
    const hue = (bits / 256 + (shift === 0 ? 0 : 0.17)) % 1;
    return hsv(hue, 0.35 + ((h >>> (shift + 3)) & 0x1f) / 64, 0.45 + ((h >>> (shift + 11)) & 0x0f) / 36);
  };
  const a = pick(0);
  const b = pick(13);
  const sum = (c: number[]): number => c[0]! + c[1]! + c[2]!;
  const [bright, dark] = sum(a) >= sum(b) ? [a, b] : [b, a];
  return [hex(...bright), hex(...dark)];
}

/**
 * unity.cpp:604-640 viewscreenImage, over the sim's state (read-only). Out of transit, the Enterprise's animation (its anim_index, which an
 * alter sets and a journey's start clears) is the sprite shown, when one is set (not -1, 0xffff or 0xfffe) and the lift's
 * `viewscreenSprites` names its file (unity.cpp:604-610). Otherwise, in transit it is warp or space; with no sector, space; else a planet.
 * `hailing` is the viewscreen screen: ViewscreenScreen::start shows the hailing object's own sprite, when it has one (`sprite`, its file
 * from the lift's comms contacts).
 */
export function viewscreenImage(world: World, hailing: boolean): ViewscreenImage {
  const ship = world.state.ship;
  // (a hail with no target shows whoever replies: the caller's sprite beats the transit, whatever the ship is doing)
  const target = hailing ? world.viewscreen?.target ?? world.viewscreen?.caller ?? null : null;
  if (target !== null) {
    const file = world.content.ship?.data.contacts.comms.find(c => c.object === target)?.file;
    if (file !== undefined) return { kind: 'sprite', sprite: file };
  }
  const data = world.content.ship?.data;
  const anim = data ? world.state.objects[data.astro.enterprise]?.anim : undefined;
  if (ship.transit === null && anim !== undefined && anim >= 0 && anim !== 0xffff && anim !== 0xfffe) {
    const file = data?.viewscreenSprites?.[anim];
    if (file !== undefined) return { kind: 'sprite', sprite: file };
  }
  if (ship.transit !== null) return ship.transit.warp ? { kind: 'warp' } : { kind: 'space' };
  if (ship.location.sector === -1) return { kind: 'space' };
  return { kind: 'planet', colours: planetColours(ship.location.sector, ship.location.star, ship.location.planet) };
}

/** A published still for a hail's caller (art.ship.viewscreen.hails): where it is, how many times the sprite's pixels, and where the original draws the sprite. */
export interface HailStill {
  url: string;
  scale: number;
  at: [number, number];
}

/**
 * The still for the sprite `stem`, or undefined: with no entry (every other caller), or an entry whose file isn't in the game's assets (art
 * off, or not published), the caller keeps its sprite's own frame.
 */
export function hailStill(
  hails: Record<string, { image: string; scale: number; at: [number, number] }> | undefined,
  stem: string,
  assets: { url(path: string): string | undefined },
): HailStill | undefined {
  const entry = hails?.[stem];
  const url = entry === undefined ? undefined : assets.url(entry.image);
  return entry === undefined || url === undefined ? undefined : { url, scale: entry.scale, at: entry.at };
}

/** One animation's entry in art.ship.viewscreen.views (package.ts). */
export interface ViewEntry {
  images: string[];
  pages: [number, number][];
  cells: [number, number, number, number, number, number, number][];
  frames: number;
  scale: number;
  cell: [number, number];
  anchor: [number, number];
  delays: number[];
  loop: boolean;
  next?: number;
}

/**
 * The sheets for the sprite `stem`, or undefined: with no entry, or no sheet for animation 0 (the one the viewscreen starts: viewscreen.cpp
 * startAnim(0)) among those whose pages are all in the game's assets. Undefined leaves the sprite's first frame (art/ship/view/<stem>.webp). Each
 * animation's cell is in the sprite's own pixels (`rect`'s size), however many times its sheet's pixels are.
 */
export function viewSheet(
  views: Record<string, Record<string, ViewEntry>> | undefined,
  stem: string,
  assets: { url(path: string): string | undefined },
): SpriteSheet | undefined {
  const urls: SpriteSheet['urls'] = {};
  const strips: SpriteSheet['strips'] = {};
  for (const [index, a] of Object.entries(views?.[stem] ?? {})) {
    const pages = a.images.map(image => assets.url(image));
    if (pages.some(u => u === undefined)) continue;
    const n = Number(index);
    urls[n] = pages as string[];
    strips[n] = {
      frames: a.frames, cell: a.cell, pages: a.pages, cells: a.cells, delays: a.delays, loop: a.loop, ...(a.next !== undefined ? { next: a.next } : {}),
      rect: [0, 0, a.cell[0] / a.scale, a.cell[1] / a.scale], anchor: a.anchor,
    };
  }
  return strips[0] === undefined ? undefined : { urls, strips };
}
