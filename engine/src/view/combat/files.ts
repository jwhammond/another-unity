// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Where the space build (tools/space) publishes combat's original pictures beside its models, under the game's `space/`
 * (git-ignored, served by the asset glob like the .glb files): the paths both sides use. Pure: no three, no DOM.
 */

/** Tactical's stills (TacticalScreen::start, tactical.cpp:264-278; showWarp, :818-854), as indexed packs and 8-bit palettes. */
export const COMBAT_STILLS = {
  /** Entry 0 is spc00a.pic, the console; entry i + 1 is space.mrg's entry i (its buttons, pages, scanner pictures and digits). */
  console: 'space/console.pack',
  /** The space palette (the Enterprise's first texture's, tactical.cpp:272-278): the console and the effect sprites are drawn in it. */
  palette: 'space/space.rgb',
  /** Entry 0 is cheap.pic, the warp's background. */
  warp: 'space/warp.pack',
  /** cheap.pic's own palette, which showWarp sets (tactical.cpp:819) and the warp overlay's sprites are drawn in. */
  warpPalette: 'space/warp.rgb',
} as const;

/**
 * showWarp's sprites and their depths, in the order it adds them to the screen's objects (tactical.cpp:823-827). drawObjects
 * sorts them by depth each frame with Common::sort (unity.cpp:1443, DrawOrderComparison :204-215), which is an unstable
 * quicksort: warpOverlayAt (warp.ts) orders them as it does, so the -1500 tie comes out viewscan, vwwarped, viewscr (on top).
 * Here, not in warp.ts, so the battle set's loader (in the main bundle) lists them without bringing the overlay's code in.
 */
export const WARP_SPRITES = [
  { file: 'viewscan.spr', depth: -2000 },
  { file: 'viewscr.spr', depth: -1500 },
  { file: 'vwwarped.spr', depth: -1500 },
] as const;

/**
 * TacticalScreen's _radarScroll and _radarCentre (tactical.h:97-98; the scroll zeroed at tactical.cpp:249): where the radar's
 * grid has scrolled to and where the Enterprise was at its last draw. Here, as WARP_SPRITES, so the session (main bundle) keeps one without the radar's code.
 */
export interface RadarMemory { scroll: [number, number, number]; centre: { x: number; y: number; z: number } }
/** The constructor's: no scroll, the centre at the origin (Vector3's zero). */
export const newRadarMemory = (): RadarMemory => ({ scroll: [0, 0, 0], centre: { x: 0, y: 0, z: 0 } });

/** The red flash's strength under prefers-reduced-motion (M8 spec §3.2); here for the main bundle's view host, as WARP_SPRITES. */
export const REDUCED_FLASH = 0.4;

/** The sprite sheets' index: by sprite file (lower case), a CombatSpriteSheet. */
export const SPRITE_INDEX = 'space/sprites.json';

/** A sheet is at most this wide: its frames wrap into rows past it (WebGL 2 guarantees textures of 2048; every phone this game runs on takes 4096). */
export const SPRITE_SHEET_MAX = 4096;

/** One entry of a sprite, as the images export lists it (docs/raw-ir.md `images/`), with a frame's picture as its index in the sheet. */
export type SpriteEntry = { type: string; frame?: number } & Record<string, unknown>;

/**
 * A sprite's frames in one picture, left to right then top to bottom, each `cell` pixels: every frame the sprite has, in file
 * order (combat draws the first CombatData.animations of them, SpaceResources::animation, space3d.cpp:482-517).
 */
export interface CombatSpriteSheet {
  /** The PNG's path in the game: `space/sprites/<stem>.png`. */
  image: string;
  frames: number;
  columns: number;
  cell: [number, number];
  /** The images export's palette name: `space` for the effects (colours 0 and 13 clear), `cheap` for the warp overlay (13 clear). */
  palette: string;
  /** The sprite's entries in file order (positions, waits, jumps): what a SpritePlayer runs (the warp overlay's, showWarp). */
  entries: SpriteEntry[];
}

/** The sheet's path for a sprite file: `space/sprites/<stem>.png`. */
export function spriteSheetPath(file: string): string {
  return `space/sprites/${file.toLowerCase().replace(/\.spr$/, '')}.png`;
}

/** How many frames a row of a sheet holds: as many as fit in SPRITE_SHEET_MAX, at least one, at most all of them. */
export function sheetColumns(frames: number, width: number): number {
  return Math.max(1, Math.min(frames, Math.floor(SPRITE_SHEET_MAX / Math.max(1, width))));
}

/** How many backdrop plates there are (M8 spec Decision 14). */
export const BACKDROP_PLATES = 4;
/**
 * Each battle's backdrop plate (M9 spec §4.2). Scenario mod 4 split the 40 battles 12/10/9/9 and leaned to plate 0 (purple), so the
 * table starts from mod 4 and moves five battles: each plate takes 10, and neighbouring battle numbers (n, n+1), and the route's 51,
 * 71, 52, never share one. Battle numbers only.
 */
export const BACKDROP_TABLE: Readonly<Record<number, 0 | 1 | 2 | 3>> = {
  1: 0, 2: 2, 3: 3, 4: 0, 6: 2, 7: 3, 8: 0, 16: 2,
  32: 0, 33: 1, 34: 2, 35: 3, 36: 0, 37: 1, 38: 2, 39: 3, 40: 0, 41: 1,
  48: 3, 49: 1, 50: 2, 51: 3, 52: 0, 53: 1, 54: 2, 55: 3, 56: 0, 57: 1,
  64: 0, 65: 1, 66: 2, 67: 3, 68: 0, 69: 1, 70: 2, 71: 1,
  80: 3, 81: 1, 82: 2, 83: 3,
};
/** A battle's backdrop plate, as the art publishes it (Plan 30 R13: under art/space, M8 spec §7): `art/space/backdrop/plate<n>.webp`. An unknown battle takes scenario mod 4. */
export function backdropPlate(scenario: number): string {
  const plate = BACKDROP_TABLE[scenario] ?? ((scenario % BACKDROP_PLATES) + BACKDROP_PLATES) % BACKDROP_PLATES;
  return `art/space/backdrop/plate${plate}.webp`;
}
