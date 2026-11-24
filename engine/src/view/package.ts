// SPDX-License-Identifier: GPL-3.0-or-later
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { SourceFile } from '../content/parse';
import type { GameContent } from '../content/types';
import type { HookRegistry } from '../sim/hooks';
import { AssetIndex } from './assets';
import { ReadingTable } from './readings';
import { ScreenTextTable } from './screenTexts';
import { VoiceTable } from './voices';

const presentationSchema = z.object({
  /** A loop for a screen, or for every screen of a world (a screen's `world`, else the game's id). */
  music: z.record(z.string()).default({}),
  ambience: z.record(z.string()).default({}),
  /** Each world's beam-down pieces (Sound::playIntroMusic); the browser plays the first (Plan 6 Decision 11). */
  intro: z.record(z.array(z.string())).default({}),
  /** Each world's arrival movie, which the bridge stub plays before beaming down. */
  arrival: z.record(z.string()).default({}),
  /** The opening movies' stems: the teaser, then the title (kMovieTeaser and kMovieTitle). */
  opening: z.array(z.string()).optional(),
  /** The warp movies' stems by index, which play from 1; null where the movie map has no file. */
  warpMovies: z.array(z.string().nullable()).optional(),
  /** movie.map's films in its order, with their descriptions: what the holodeck lists once they are seen. */
  movieMap: z.array(z.object({ stem: z.string(), title: z.string() }).strict()).optional(),
  /** A loop's gain over its bus level and the second it loops back to (Sound::updateMusic's volume and loop point). */
  loops: z.record(z.object({ gain: z.number().min(0).max(4), loopStart: z.number().nonnegative() }).strict()).optional(),
  /** A screen whose loop depends on an object (lab s06's probe): while the object is inactive, `music` loops instead. */
  musicWhenInactive: z.record(z.object({ object: z.string(), music: z.string() }).strict()).optional(),
  /** The sounds the original's executable plays by name, not its data (the lifter's ENGINE_SOUNDS): their stems. */
  sounds: z.object({
    /** A click on the combadge (awayteam.cpp:824-825). */
    combadge: z.string().optional(),
    /** A condition passing with the tricorder as the other object (object.cpp:1277-1279). */
    tricorderChirp: z.string().optional(),
    /** A crew member firing the hand phaser (phaserShot, awayteam.cpp:1178). */
    phaserCrew: z.string().optional(),
    /** Anyone else firing (awayteam.cpp:1183). */
    phaserOther: z.string().optional(),
    /** The transporter (beamEffect, awayteam.cpp:1106): beaming in, beaming out, and the Chodak's either way. */
    beamIn: z.string().optional(),
    beamOut: z.string().optional(),
    beamChodak: z.string().optional(),
  }).strict().default({}),
  /** The sounds the ship's screens make, by name (the sim's SHIP_CUES and the session's click cues; the lifter's SHIP_SOUNDS): stems of audio/sfx, music or voice files. */
  shipSounds: z.record(z.string()).optional(),
  /** What each ship station loops, by station (bridge, transporter, astrogation, computer, tactical, engineering): a stem, whose gain and loop point `loops` has. */
  shipMusic: z.record(z.string()).optional(),
  /** What tools/art publish made (R8): by screen id, paths under the game's directory (art/...). */
  art: z.object({
    rooms: z.record(z.object({
      plate: z.string().optional(),
      depth: z.string().optional(),
      normal: z.string().optional(),
      gltf: z.string().optional(),
      /** Occlusion layers cut from the plate (R9), one per mask object. */
      masks: z.array(z.object({
        /** The mask object's id. */
        object: z.string(),
        /** art/rooms/<world>/<sNN>/mask.<object>.webp */
        image: z.string(),
        /** Where the original draws it, in its pixels: [x, y, w, h]. */
        rect: z.tuple([z.number(), z.number(), z.number(), z.number()]),
        /** The row the original sorts it by (y_adjust, else y): the floor row it stands on. */
        depth: z.number(),
        /** A repainted sprite (a prop's card) rather than a cut of the plate: it is drawn even when its sorting row is above the horizon. */
        card: z.boolean().optional(),
        /** Where a phaser aims at the sprite, in the original's pixels: its origin and the sprite's own aim point (the `mouthPos` entry). Without it the shot aims halfway up. */
        aim: z.tuple([z.number(), z.number()]).optional(),
        /** Where the object stood at the start, in the original's pixels, on each axis the sprite is drawn by the object's place (null: the sprite's own position, which a move of the object leaves alone). A rule that moves the object moves the layer by the difference. */
        home: z.tuple([z.number().nullable(), z.number().nullable()]).optional(),
        /** What an animated prop plays while it replies (Batch 10): its talk animation (speech sprites), and the one it goes back to when the line ends (-1: it stays on the talk one). */
        talk: z.object({ anim: z.number().int().nonnegative(), idle: z.number().int() }).strict().optional(),
        /** An animated prop (Batch 8): the animation the object starts on (the still `image` is that animation's first frame, the fallback). */
        anim: z.number().int().optional(),
        /** By sprite animation: the strip of cells the layer draws while the object plays it (art masks, from the card's published strips). */
        strips: z.record(z.string().regex(/^[0-9]+$/), z.object({
          /** A strip that is a grid of whole cells: art/cards/<card>/<anim>.webp. An atlas (`images`) has none. */
          image: z.string().optional(),
          /** A strip packed as an atlas (Batch 8b): the pages' files (art/cards/<card>/<anim>.<n>.webp), no side over 4096. Each distinct cell is cropped to the opaque bounds of its own frame. */
          images: z.array(z.string()).optional(),
          /** The pages' sizes in pixels, [w, h] each. */
          pages: z.array(z.tuple([z.number().int().positive(), z.number().int().positive()])).optional(),
          /** Where each distinct cell lies: [page, x, y, w, h, ox, oy], the page's pixels x, y, w, h being the cell's pixels from ox, oy (w and h 0: nothing visible). */
          cells: z.array(z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative(), z.number().int().nonnegative(), z.number().int().nonnegative(), z.number().int().nonnegative(), z.number().int().nonnegative(), z.number().int().nonnegative()])).optional(),
          /** The frames the animation plays. */
          frames: z.number().int().positive(),
          /** The cell each frame is, where the strip holds each distinct frame once (a blinking light's frames are few cells). */
          of: z.array(z.number().int().nonnegative()).optional(),
          /** Cells to a row of the image. */
          columns: z.number().int().positive().optional(),
          /** One cell in card pixels. */
          cell: z.tuple([z.number().int().positive(), z.number().int().positive()]),
          /** Where the original draws the cell: the union of the frames' rectangles, [x, y, w, h]. */
          rect: z.tuple([z.number(), z.number(), z.number(), z.number()]),
          /** Where it draws each frame, [x, y, w, h]: what a check against the original reads. */
          rects: z.array(z.tuple([z.number(), z.number(), z.number(), z.number()])).optional(),
          /** Milliseconds each frame shows. */
          delays: z.array(z.number().nonnegative()),
          loop: z.boolean(),
          /** The animation it falls into when it ends. */
          next: z.number().int().nonnegative().optional(),
        }).strict()).optional(),
      }).strict()).default([]),
    }).strict()).default({}),
    /** By crew object id: the portrait the away team's bar and the subtitles show (art publish-kit): a lossless WebP of pixel art, path under the game's directory. */
    portraits: z.record(z.string()).optional(),
    /** By item object id: its inventory icon (art publish-kit), the same kind of file. The communicator's is the combadge's, and the placeholder for a speaker with no portrait. */
    icons: z.record(z.string()).optional(),
    /**
     * The away team's panel as the original draws it (art panel publish): awayteam.mrg's sprites by name (panel, admin, look, look_on, slot,
     * left, marker0 …), lossless WebP at `scale` times their size, and the palette colours the panel fills itself (the status line, the
     * health bar). Without it, or with the art off, the HUD keeps its own bar.
     */
    panel: z.object({
      scale: z.number().positive(),
      sprites: z.record(z.string()),
      colours: z.record(z.string().regex(/^#[0-9a-f]{6}$/i)).default({}),
    }).strict().optional(),
    /**
     * The astrogation course panel's own sprites (art astro publish): astro.mrg's Faster, Slower, Engage and Stop pictures with their pressed
     * frames, by name, each a lossless WebP at `scale` times its size and the rectangle the original draws it in (its pixels: [x, y, w, h]).
     * Without it, or with the art off, those buttons are drawn in CSS.
     */
    astro: z.object({
      scale: z.number().positive(),
      sprites: z.record(z.object({ image: z.string(), rect: z.tuple([z.number(), z.number(), z.number(), z.number()]) }).strict()),
      /** The screen's 256 colours, 8 bits each (art/astro/palette.rgb): what the game's fonts' own colours (art.fonts) are indices into. */
      palette: z.string().optional(),
      /**
       * The screen's tables from the executable (art astro publish): the Display tab's labels, the screen's messages, the alignments' texts and
       * colours, the stars' magnitudes, the planet numerals and class descriptions, each class's size on the system view, and the palette colours
       * the map's lines are drawn in. Without them the map uses its own.
       */
      tables: z.object({
        labels: z.array(z.string()),
        messages: z.array(z.string()),
        alignmentTexts: z.array(z.string()),
        alignmentColours: z.array(z.string().regex(/^#[0-9a-f]{6}$/i)),
        magnitudes: z.array(z.number()),
        numerals: z.array(z.string()),
        planetDescriptions: z.array(z.string()),
        planetSizes: z.array(z.object({ radius: z.number(), spacing: z.number() }).strict()),
        colours: z.record(z.string().regex(/^#[0-9a-f]{6}$/i)),
      }).strict().optional(),
    }).strict().optional(),
    /**
     * The away team's pointers (art cursors publish): cursor.dat's pictures by name (look, look_lit, use, use_lit, talk, talk_lit, walk, walk_lit and
     * the exit arrows), each a lossless WebP at `scale` times its size, and each verb's click point in the picture's own pixels. The lit one is drawn
     * over something to act on. Without it the pointers are the panel's own sprites, then the drawn ones.
     */
    cursors: z.object({
      scale: z.number().positive(),
      sprites: z.record(z.string()),
      hotspots: z.record(z.tuple([z.number(), z.number()])),
    }).strict().optional(),
    /**
     * The tricorder viewer's pictures (art tricorder publish): tricord.spr's frame and tricord.mrg's buttons (each with its greyed and lit twin) by
     * name, lossless WebP at `scale` times their size. Without it, or with the art off, the viewer is the plain dialog.
     */
    tricorder: z.object({
      scale: z.number().positive(),
      sprites: z.record(z.string()),
    }).strict().optional(),
    /**
     * The admin console's pictures (art admin publish), each a lossless WebP at `scale` times its size: adminmnu.spr's console and its five screen
     * pages (`frames`, in that order), adminmnu.mrg's buttons by name (`row0`-`row5`, `ensign`/`ensignLit` …, `led0`-`led2`, `segOff`/`segOn`,
     * `cancel`, `no`, `yes`, `difficultyOff`), final.spr (the F1 Combat Options screen), and the remake's own, made from the console's pixels: the
     * SETTINGS button plain and lit, and the settings page's tab words on clear (`tabGame`, `tabGameLit` …). Without it, or with the art off, the
     * console is drawn in CSS.
     */
    admin: z.object({
      scale: z.number().positive(),
      frames: z.array(z.string()),
      buttons: z.record(z.string()),
      final: z.string(),
      settings: z.string(),
      settingsLit: z.string(),
      tabs: z.record(z.string()).optional(),
      /**
       * The HD repaints (Plan 32 Task 12) of the console's body (`frame0`) and of final.spr (`final`), and the screen's pages in HD (`frame1` …
       * `frame5`, Plan 33 Task 7), each shown in its picture's place with the art on.
       */
      hd: z.object({
        frame0: z.string().optional(), frame1: z.string().optional(), frame2: z.string().optional(), frame3: z.string().optional(),
        frame4: z.string().optional(), frame5: z.string().optional(), final: z.string().optional(),
      }).strict().optional(),
    }).strict().optional(),
    /**
     * The transporter room's own console pictures (art transporter publish): transp.mrg's arrows with their grey twins, the kit's slot and the Lists
     * and Map buttons lit and not, and the map's own (`map_world_N`: tmaps.spr's picture of world N; `scan_across` and `scan_down`: the scan's two lines;
     * `blip_N`: the lock's blip, a frame each), by name, each a lossless WebP at `scale` times its size and the rectangle the original draws it in ([x, y, w, h]).
     * Without it, or with the art off, those buttons and slots are drawn in CSS.
     */
    transporter: z.object({
      scale: z.number().positive(),
      /** How long each frame of the lock's blip shows (tranblip.spr's), in milliseconds. */
      blipMs: z.number().positive().optional(),
      sprites: z.record(z.object({ image: z.string(), rect: z.tuple([z.number(), z.number(), z.number(), z.number()]) }).strict()),
    }).strict().optional(),
    /**
     * The bridge strip's Viewscreen button (art sensor publish): sensor.mrg's two pictures (`viewscreen`, the button up, and `viewscreenDown`, drawn
     * while the viewscreen is up), each a lossless WebP at `scale` times its size and the rectangle the original draws it in ([x, y, w, h]).
     * Without it, or with the art off, the button is drawn in CSS with its label fitted to the box.
     */
    sensor: z.object({
      scale: z.number().positive(),
      sprites: z.record(z.object({ image: z.string(), rect: z.tuple([z.number(), z.number(), z.number(), z.number()]) }).strict()),
    }).strict().optional(),
    /**
     * The game's bitmap fonts (art engineering publish): the files of font0.fon ... font9.fon, in order, as they are. The engineering screen, the
     * holodeck's dialog and astrogation's text are drawn in them; without them the text is ours.
     */
    fonts: z.object({ files: z.array(z.string()) }).strict().optional(),
    /**
     * The engineering screen as the original has it (art engineering publish): an indexed pack (the background, then eng01b.mrg's entries) and its
     * 256-colour palette, and the executable's tables for the sliders, labels, rows, the shields' order and the schematics' colours. Without it,
     * or with the art off, the screen is a plain list of sliders.
     */
    engineering: z.object({
      pack: z.string(),
      palette: z.string(),
      tables: z.object({
        sliders: z.array(z.object({ x: z.number().int(), y: z.number().int(), flags: z.number().int() }).strict()),
        labels: z.array(z.object({ rect: z.tuple([z.number(), z.number(), z.number(), z.number()]), text: z.string() }).strict()),
        rows: z.array(z.tuple([z.number(), z.number(), z.number(), z.number()])),
        shieldOrder: z.array(z.number().int()),
        paletteIndex: z.array(z.number().int()),
      }).strict(),
    }).strict().optional(),
    /**
     * How a phaser shot is drawn (art phaser publish): the executable's table of where the beam leaves each crew member's sprite in each of the 12 directions
     * (pixels right of and above the feet at full size, and the frame of the firing animation it shows on), the crew ids the table goes by, and the
     * palette colours of the beam. Without it a shot is a plain line.
     */
    phaser: z.object({
      muzzles: z.array(z.tuple([z.number().int(), z.number().int(), z.number().int()])),
      crew: z.array(z.string()),
      colours: z.object({ beam: z.string().regex(/^#[0-9a-f]{6}$/i), beamEdge: z.string().regex(/^#[0-9a-f]{6}$/i), pulse: z.string().regex(/^#[0-9a-f]{6}$/i), pulseEdge: z.string().regex(/^#[0-9a-f]{6}$/i) }).strict(),
    }).strict().optional(),
    /**
     * The holodeck as the original has it (art holodeck publish): an indexed pack (holodeck.rm, then dialog.mrg's 31 entries, which frame the choice
     * dialog) and its 256-colour palette. With `art.fonts`, the screen is the original's picture and dialog; without, or with the art off, a plain panel.
     */
    holodeck: z.object({ pack: z.string(), palette: z.string() }).strict().optional(),
    /**
     * Combat's art (art:space publish, Plan 30): image packs (view/imagePack.ts) of each ship kind's repainted textures by kind index and of the
     * effects' (their models' textures and the upscaled sprite sheets); the console's repainted plate (the view's rectangle clear) and a pack of
     * space.mrg's pictures at `scale` times, with the rectangles the console always draws from its indices; the four backdrop plates. Without it,
     * or with the art off, a battle is drawn in the original's textures, sprites and console.
     */
    space: z.object({
      kinds: z.record(z.string().regex(/^\d+$/), z.string()).default({}),
      effects: z.string().optional(),
      console: z.object({
        plate: z.string(),
        half: z.string().optional(),
        pack: z.string(),
        scale: z.number().int().positive(),
        areas: z.record(z.string().regex(/^[a-z]+$/), z.tuple([z.number().int(), z.number().int(), z.number().int().positive(), z.number().int().positive()])).default({}),
      }).strict().optional(),
      backdrops: z.array(z.string()).max(4).default([]),
    }).strict().optional(),
    /** By object id: a crew member's card (R9). */
    cards: z.record(z.object({
      image: z.string(),
      /** Frames side by side in the image; Plan 14 shows the first. */
      frames: z.number().int().positive().default(1),
      /** The card's point that stands on the floor, as fractions of a frame: [0.5, 1] is bottom centre. */
      anchor: z.tuple([z.number(), z.number()]).default([0.5, 1]),
      /** The standing frame's height in the original's pixels: a card is drawn at that many pixels' height (R9). */
      pixelHeight: z.number().positive().optional(),
      /** By the original's animation index: a strip of equal cells (R8). */
      anims: z.record(z.string().regex(/^\d+$/), z.object({
        image: z.string(),
        frames: z.number().int().positive(),
        /** Cells to a row of the image, when it wraps into rows (a wide strip's texture is limited); else all of them. */
        columns: z.number().int().positive().optional(),
        /** One cell, in card pixels: 4x the original's, or `scale` times (the bridge's strips are the sprites' own pixels, 1). */
        scale: z.number().positive().optional(),
        cell: z.tuple([z.number().int().positive(), z.number().int().positive()]),
        /** The feet, in fractions of a cell: one per animation, so they stay planted. */
        anchor: z.tuple([z.number(), z.number()]),
        /** Milliseconds each frame shows, from the sprite's waits. */
        delays: z.array(z.number().positive()),
        loop: z.boolean().default(true),
        /** The animation it falls into when it ends (the original's jump), if it doesn't loop. */
        next: z.number().int().nonnegative().optional(),
      }).strict()).default({}),
    }).strict()).default({}),
    /**
     * By station (Plan 16 R14): a repainted plate of the station's background with its areas and, on the bridge, the crew's
     * places; or a ship set, a glTF under art/ship/ with the camera node it is seen from (R4, behind `?dev&ship3d`).
     */
    ship: z.record(z.enum(['bridge', 'viewscreen', 'transporter', 'astrogation', 'computer']), z.object({
      /** art/ship/<station>/plate.webp */
      plate: z.string().optional(),
      /** art/ship/<station>/window.webp (the viewscreen's window, Task 9). */
      window: z.string().optional(),
      /** Named rectangles of the 640x480 picture, in the original's pixels [x, y, w, h]: where a panel puts its sections. */
      areas: z.record(z.tuple([z.number(), z.number(), z.number(), z.number()])).default({}),
      /** The bridge's crew over the plate: the sprite's feet in the original's pixels, and its draw order. */
      crew: z.array(z.object({ object: z.string(), at: z.tuple([z.number(), z.number()]), depth: z.number() }).strict()).default([]),
      /**
       * The viewscreen's repainted stills (art hail publish), by the caller's sprite stem: a still of the sprite's first frame, `scale` times
       * its pixels, whose bottom centre goes where the original draws the sprite (its first POSN block, `at`, in the original's pixels).
       */
      hails: z.record(z.string().regex(/^[a-z0-9_]+$/), z.object({ image: z.string(), scale: z.number().int().positive(), at: z.tuple([z.number(), z.number()]) }).strict()).optional(),
      /**
       * The viewscreen's sprites' animations (art ship publish viewscreen), by sprite stem and then the original's animation index: each an
       * atlas as an animated layer's strip is (`images`, `pages`, `cells`: no side over 4096, each cell cropped to its opaque bounds), its
       * cell `scale` times the sprite's pixels, with the sprite's own delays. The viewscreen plays 0, from its object at 320, 240
       * (viewscreen.cpp start).
       */
      views: z.record(z.string().regex(/^[a-z0-9_]+$/), z.record(z.string().regex(/^\d+$/), z.object({
        /** The pages' files, art/ship/view/<stem>.<anim>.<n>.webp. */
        images: z.array(z.string()).min(1),
        /** The pages' sizes in pixels, [w, h] each. */
        pages: z.array(z.tuple([z.number().int().positive(), z.number().int().positive()])).min(1),
        /** Where each frame's cell lies: [page, x, y, w, h, ox, oy], the page's pixels x, y, w, h being the cell's pixels from ox, oy (w and h 0: nothing visible). */
        cells: z.array(z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative(), z.number().int().nonnegative(), z.number().int().nonnegative(), z.number().int().nonnegative(), z.number().int().nonnegative(), z.number().int().nonnegative()])),
        frames: z.number().int().positive(),
        scale: z.number().positive(),
        cell: z.tuple([z.number().int().positive(), z.number().int().positive()]),
        /** Where the viewscreen's object (320, 240 on the original's screen) is in the cell, as fractions of it. */
        anchor: z.tuple([z.number(), z.number()]),
        delays: z.array(z.number().positive()),
        loop: z.boolean().default(true),
        next: z.number().int().nonnegative().optional(),
      }).strict())).optional(),
      gltf: z.string().optional(),
      camera: z.string().default('camera:main'),
      viewscreen: z.string().optional(),
    }).strict().refine(e => e.plate !== undefined || e.gltf !== undefined, 'a ship station needs a plate or a gltf')).default({}),
  }).strict().default({}),
}).strict();

/** presentation.yaml: what plays where, which the rules don't say. */
export type PresentationConfig = z.infer<typeof presentationSchema>;
/** One of the engine's own sounds, by what it marks. */
export type EngineSound = keyof PresentationConfig['sounds'];

export function parsePresentation(text: string | undefined): PresentationConfig {
  return presentationSchema.parse(text === undefined ? {} : parseYaml(text) ?? {});
}

/** The stem that loops on `screen`: its own, else its world's. */
export function loopFor(map: Record<string, string>, content: GameContent, screen: string): string | undefined {
  return map[screen] ?? map[content.screens[screen]?.world ?? content.id];
}

/** The music for `screen` as it is entered (openLocation restarts it on every screen): the other loop while a named object is inactive. */
export function musicFor(config: PresentationConfig, content: GameContent, screen: string, active: (id: string) => boolean): string | undefined {
  const swap = config.musicWhenInactive?.[screen];
  if (swap && !active(swap.object)) return swap.music;
  return loopFor(config.music, content, screen);
}

/** The beam-down piece for `screen`'s world, if it has any. */
export function introPiece(config: PresentationConfig, content: GameContent, screen: string): string | undefined {
  return config.intro[content.screens[screen]?.world ?? content.id]?.[0];
}

/** The arrival movie for `screen`'s world, if it has one. */
export function arrivalMovie(config: PresentationConfig, content: GameContent, screen: string): string | undefined {
  return config.arrival[content.screens[screen]?.world ?? content.id];
}

/** Everything the browser needs to run one game. */
export interface GamePackage {
  id: string;
  /** game.yaml, screens/, objects/ and the rest, as parseGame takes them (it ignores the other YAML). */
  files: SourceFile[];
  assets: AssetIndex;
  voices: VoiceTable;
  presentation: PresentationConfig;
  /** readings.yaml; a game without it shows reading numbers. */
  readings?: ReadingTable;
  /** screentexts.yaml; a game without it shows no screen text. */
  screenTexts?: ScreenTextTable;
  /** The game's TypeScript hooks (games/unity/hooks/register.ts). */
  registerHooks?: (hooks: HookRegistry) => void;
  /** combat.yaml's text, fetched when a battle needs it (M8 spec §8): left out of `files`, so the game starts without it. */
  combat?: () => Promise<string>;
}

export interface GlobSources {
  id: string;
  /** The prefix both globs' keys start with: the game's directory, as the globs spell it. */
  base: string;
  /** import.meta.glob('<dir>/**\/*.yaml', { query: '?raw', import: 'default', eager: true }) */
  yaml: Record<string, string>;
  /** import.meta.glob('<dir>/{art,audio,models,movies,space}/**\/*', { query: '?url', import: 'default', eager: true }) */
  assets: Record<string, string>;
  /** import.meta.glob('<dir>/combat.yaml', { query: '?raw', import: 'default' }): not eager, so its text is a chunk of its own, loaded when asked for. */
  lazyYaml?: Record<string, () => Promise<string>>;
  registerHooks?: (hooks: HookRegistry) => void;
}

/** A package from its text, keyed by path within the game's directory, and its media: what both the globs and the deploy's sealed pack give. */
export function packageFromStrings(src: {
  id: string;
  yaml: Record<string, string>;
  assets: AssetIndex;
  registerHooks?: (hooks: HookRegistry) => void;
  combat?: () => Promise<string>;
}): GamePackage {
  const files = Object.entries(src.yaml).map(([path, text]) => ({ path, text }));
  const text = (path: string) => src.yaml[path];
  return {
    id: src.id,
    files,
    assets: src.assets,
    voices: VoiceTable.parse(text('voices.yaml')),
    presentation: parsePresentation(text('presentation.yaml')),
    readings: ReadingTable.parse(text('readings.yaml')),
    screenTexts: ScreenTextTable.parse(text('screentexts.yaml')),
    registerHooks: src.registerHooks,
    ...(src.combat ? { combat: src.combat } : {}),
  };
}

export function packageFromGlobs(src: GlobSources): GamePackage {
  const yaml: Record<string, string> = {};
  for (const [path, text] of Object.entries(src.yaml)) if (path.startsWith(src.base)) yaml[path.slice(src.base.length)] = text;
  const combat = src.lazyYaml?.[`${src.base}combat.yaml`];
  return packageFromStrings({
    id: src.id,
    yaml,
    assets: AssetIndex.fromGlob(src.base, src.assets),
    registerHooks: src.registerHooks,
    ...(combat ? { combat } : {}),
  });
}

/**
 * The audio to preload on entering `screen` (spec §7.3): every play.sound, and every voice whose speaker
 * the rule names, in the rules of the objects that start there.
 */
export function screenAudio(content: GameContent, screen: string, assets: AssetIndex, voices: VoiceTable): string[] {
  const urls = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    const o = value as Record<string, unknown>;
    const say = o.say as { who?: unknown; voice?: unknown } | undefined;
    if (say && typeof say.who === 'string' && typeof say.voice === 'string') {
      const url = assets.voice(voices.resolve(say.voice, say.who));
      if (url) urls.add(url);
    }
    const play = o.play as { sound?: unknown } | undefined;
    if (play && typeof play.sound === 'string') {
      const found = assets.sound(play.sound);
      if (found) urls.add(found.url);
    }
    for (const child of Object.values(o)) visit(child);
  };
  for (const def of Object.values(content.objects)) if (def.screen === screen) visit(def.on);
  return [...urls].sort();
}
