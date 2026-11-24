// SPDX-License-Identifier: GPL-3.0-or-later
import type { AssetIndex } from '../view/assets';
import type { PresentationConfig } from '../view/package';
import type { VerbMode } from './store';

/**
 * The pictures the HUD shows beside names: a crew member's portrait, an item's icon, and for a speaker who has no portrait the communicator's
 * icon (the combadge). Every lookup is undefined for a picture that isn't published, and the HUD keeps its text then.
 */
export interface Faces {
  /** The crew member's portrait (art.portraits[id]). */
  portrait(id: string): string | undefined;
  /** The item's icon (art.icons[id]). */
  icon(id: string): string | undefined;
  /** The combadge: the communicator's icon. */
  combadge(): string | undefined;
  /** What is drawn beside a spoken line: the speaker's portrait, else the combadge as a placeholder (an NPC, the computer, a caller, nobody the game knows). */
  speaker(who: string): { url: string; placeholder: boolean } | undefined;
  /** The original's panel (art.panel), when every sprite it needs is published; else undefined and the HUD keeps its own bar. */
  panel(): PanelArt | undefined;
  /** The astrogation course panel's sprites (art.astro), when every one is published; else undefined and those buttons are CSS. */
  astro(): AstroArt | undefined;
  /** The astrogation map's pictures and tables (art.astro), when every picture is published; else undefined and the map draws its own shapes. */
  astroMap(): AstroMapArt | undefined;
  /** The astrogation screen's tables (art.astro.tables), when published (they need no pictures). */
  astroTables(): AstroTables | undefined;
  /** The transporter room's console pictures (art.transporter), when every one is published; else undefined and its buttons and slots are CSS. */
  transporter(): TransporterArt | undefined;
  /** The bridge strip's Viewscreen button pictures (art.sensor), when both are published; else undefined and the button is drawn in CSS. */
  sensor(): SensorArt | undefined;
  /** The original's pointers (art.cursors), when its eight verb pictures are published; else undefined and the pointers are the panel's sprites, or drawn. */
  cursors(): CursorArt | undefined;
  /** The tricorder viewer's frame and buttons (art.tricorder), when every one is published; else undefined and the viewer is the plain dialog. */
  tricorder(): TricorderArt | undefined;
}

/** The pointers cursor.dat holds: each verb's, and its lit one, at `scale` times their size, with the click point in their own pixels. */
export interface CursorArt {
  scale: number;
  sprite(name: `${VerbMode}` | `${VerbMode}_lit`): string;
  hotspot(verb: VerbMode): readonly [number, number];
}

/** The tricorder viewer's pictures by name (frame, and each button's: page_up, page_down, prev, next each with _off and _hover, resume and resume_hover, mode_readings), at `scale` times their size. */
export interface TricorderArt { scale: number; sprite(name: TricorderSprite): string }
export const TRICORDER_SPRITES = ['frame', 'page_up_off', 'page_up', 'page_up_hover', 'page_down_off', 'page_down', 'page_down_hover', 'prev_off', 'prev', 'prev_hover', 'next_off', 'next', 'next_hover', 'resume', 'resume_hover', 'mode_readings', 'mode_conversations'] as const;
export type TricorderSprite = (typeof TRICORDER_SPRITES)[number];

/** The admin console's buttons (adminmnu.mrg, by the names art admin publish gives them). */
export const ADMIN_BUTTONS = [
  'row0', 'row1', 'row2', 'row3', 'row4', 'row5', 'ensign', 'ensignLit', 'lieutenant', 'lieutenantLit', 'captain', 'captainLit',
  'textOff', 'textOffLit', 'textOn', 'textOnLit', 'resume', 'resumeLit', 'led0', 'led1', 'led2', 'soundLevels', 'soundLevelsLit',
  'segOff', 'segOn', 'cancel', 'no', 'yes', 'difficultyOff',
] as const;
export type AdminButton = (typeof ADMIN_BUTTONS)[number];
/** How many pictures adminmnu.spr has: the console, then the load, save, new, quit and sound pages. */
export const ADMIN_FRAMES = 6;

/**
 * The admin console's pictures (art.admin), at `scale` times their size: the original's pixels, so drawn whatever the art setting, but for the
 * console's body, its screen's pages and final.spr, which are their HD pictures (art.admin.hd) with the art on, where those are published.
 */
export interface AdminArt {
  scale: number;
  /** adminmnu.spr's picture `i`: 0 the console, 1-5 the screen's pages (each its HD picture with the art on, where published). */
  frame(i: number): string;
  button(name: AdminButton): string;
  /** The remake's SETTINGS button, plain and lit. */
  settings: string;
  settingsLit: string;
  /** The SETTINGS page's tab words, plain and lit, when all are published (else the tabs' words are drawn in the game's font, or in CSS). */
  tabs?: Readonly<Record<AdminTab | `${AdminTab}Lit`, string>>;
  /** final.spr, Tactical's F1 Combat Options screen (562 by 334), when published. */
  final?: string;
  /**
   * The console's body is its HD repaint (art on, art.admin.hd.frame0), whose publish has painted the lower LED row's groove out already: the
   * console draws no cover over it (Plan 32 Task 12).
   */
  bodyHd?: boolean;
}
/** The SETTINGS page's tabs' words (art admin publish's `tabs`), each with its lit twin. */
export const ADMIN_TABS = ['tabGame', 'tabCombat', 'tabKeys'] as const;
export type AdminTab = (typeof ADMIN_TABS)[number];

/**
 * The admin console's pictures, when every one it draws is published; else undefined and the console is drawn in CSS. With `artOn`, the console's
 * body, the screen's pages and final.spr are their HD pictures where those are published (else the original's).
 */
export function adminArtFromPresentation(config: PresentationConfig, assets: AssetIndex, artOn = false): AdminArt | undefined {
  const a = config.art?.admin;
  if (a === undefined || a.frames.length < ADMIN_FRAMES) return undefined;
  const frames: string[] = [];
  for (const path of a.frames.slice(0, ADMIN_FRAMES)) {
    const url = assets.url(path);
    if (url === undefined) return undefined;
    frames.push(url);
  }
  const buttons = new Map<string, string>();
  for (const name of ADMIN_BUTTONS) {
    const path = Object.hasOwn(a.buttons, name) ? a.buttons[name] : undefined;
    const url = path === undefined ? undefined : assets.url(path);
    if (url === undefined) return undefined;
    buttons.set(name, url);
  }
  const settings = assets.url(a.settings), settingsLit = assets.url(a.settingsLit);
  if (settings === undefined || settingsLit === undefined) return undefined;
  const tabs: Record<string, string> = {};
  for (const name of ADMIN_TABS.flatMap(t => [t, `${t}Lit`])) {
    const path = a.tabs !== undefined && Object.hasOwn(a.tabs, name) ? a.tabs[name] : undefined;
    const url = path === undefined ? undefined : assets.url(path);
    if (url !== undefined) tabs[name] = url;
  }
  const allTabs = Object.keys(tabs).length === ADMIN_TABS.length * 2;
  const hd = (name: keyof NonNullable<typeof a.hd>): string | undefined => {
    const path = artOn ? a.hd?.[name] : undefined;
    return path === undefined ? undefined : assets.url(path);
  };
  for (const i of [1, 2, 3, 4, 5] as const) frames[i] = hd(`frame${i}`) ?? frames[i]!;
  const body = hd('frame0');
  if (body !== undefined) frames[0] = body;
  const final = hd('final') ?? assets.url(a.final);
  return { scale: a.scale, frame: i => frames[i]!, button: name => buttons.get(name)!, settings, settingsLit, ...(allTabs ? { tabs: tabs as AdminArt['tabs'] } : {}), ...(final !== undefined ? { final } : {}), ...(body !== undefined ? { bodyHd: true } : {}) };
}

/** One of the course panel's pictures: where it is (the original's pixels, [x, y, w, h]) and its image. */
export interface AstroSprite { url: string; rect: readonly [number, number, number, number] }
export interface AstroArt {
  sprite(name: AstroSpriteName): AstroSprite;
  /** The panel's own pictures (the tab strips, the Display tab's swatches, the course panel for warp and impulse), when published. */
  panel(name: AstroPanelSprite): AstroSprite | undefined;
  /** An engine's animation on the course panel, its frames in order, when all are published. */
  engine(warp: boolean): AstroSprite[] | undefined;
}
/** The pictures of the info, course and display tabs (art astro publish writes these): optional beside the course buttons' own. */
export const ASTRO_PANEL_SPRITES = [
  'info_tab', 'display_tab', 'display_bottom', 'course_warp', 'course_impulse',
  // (the original's pictures of a button held, and of the view the map shows: drawn over the plate's own buttons at the button's corner)
  'view_galaxy_lit', 'view_sector_lit', 'view_system_lit', 'arrow_up_down', 'arrow_down_down',
  'pad_up_down', 'pad_down_down', 'pad_right_down', 'pad_left_down', 'pad_stop_down',
  'exit_bridge_down', 'exit_computer_down', 'exit_engineering_down',
] as const;
/** How many frames each engine runs on the course panel (engine.spr's animations 4 and 3), each shown for 166 ms (kEngineFrameTime). */
export const ASTRO_ENGINE_FRAMES = { warp: 6, impulse: 5 } as const;
export const ASTRO_ENGINE_FRAME_MS = 166;
export type AstroPanelSprite = (typeof ASTRO_PANEL_SPRITES)[number];

/** The sprites the course panel needs (art astro publish writes these); each button's pressed frame is `<name>_down`. */
export const ASTRO_SPRITES = ['faster_warp', 'faster_warp_down', 'faster_impulse', 'faster_impulse_down', 'slower', 'slower_down', 'engage', 'engage_down', 'stop', 'stop_down'] as const;
export type AstroSpriteName = (typeof ASTRO_SPRITES)[number];

/** The pictures the astrogation map draws (art astro publish writes these): stars by class, hazards by type, stations by type, planets by class, and the markers. */
export const ASTRO_MAP_SPRITES = [
  'belt', 'starbase_icon', 'selected', 'moon', 'star', 'companion', 'ship', 'outpost_icon', 'starbase_big', 'buoy', 'deep_space_station', 'outpost', 'relay',
  'ship_marker', 'destination_marker',
  ...Array.from({ length: 7 }, (_, i) => `star_class${i}`),
  ...Array.from({ length: 7 }, (_, i) => `hazard${i}`),
  ...Array.from({ length: 4 }, (_, i) => `station${i}`),
  ...Array.from({ length: 16 }, (_, i) => `planet${i}`),
] as const;
/** One map picture: its image, its own size in the original's pixels, and how much bigger the file is than that (`AstroMapArt.scale`). */
export interface AstroMapSprite { url: string; width: number; height: number }
export interface AstroMapArt { scale: number; sprite(name: string): AstroMapSprite }
export type AstroTables = NonNullable<NonNullable<NonNullable<PresentationConfig['art']>['astro']>['tables']>;

/** The bridge strip's Viewscreen button: its picture up and down (`viewscreen`, `viewscreenDown`), each with the rectangle the original draws it in. */
export const SENSOR_SPRITES = ['viewscreen', 'viewscreenDown'] as const;
export type SensorSpriteName = (typeof SENSOR_SPRITES)[number];
export interface SensorArt { sprite(name: SensorSpriteName): AstroSprite }

export interface TransporterArt {
  sprite(name: TransporterSpriteName): AstroSprite;
  /** The map's own pictures (art transporter publish), when every one is published; else undefined and the map is drawn in CSS. */
  map(): TransporterMapArt | undefined;
}
/** The transporter map's pictures: a picture for each world, the scan's two lines, and the lock's blip frames. */
export interface TransporterMapArt {
  /** tmaps.spr's picture of world `n`, if it has one. */
  world(n: number): AstroSprite | undefined;
  across: AstroSprite;
  down: AstroSprite;
  blip: { frames: AstroSprite[]; ms: number };
}

/** The sprites the transporter room needs (art transporter publish writes these): the arrows and their grey twins, the kit's slot, the Lists and Map buttons lit and not. */
export const TRANSPORTER_SPRITES = ['up', 'up_grey', 'down', 'down_grey', 'left', 'left_grey', 'right', 'right_grey', 'kit_slot', 'lists', 'lists_on', 'map', 'map_on'] as const;
export type TransporterSpriteName = (typeof TRANSPORTER_SPRITES)[number];

/** The panel's sprites by name, as URLs, and the colours it fills itself (art.panel). */
export interface PanelArt {
  sprite(name: PanelSprite): string;
  colours: { status: string; empty: string; healthy: string; injured: string; injuredEdge: string; separator: string };
}

/** The sprites the panel needs (art panel publish writes these). */
export const PANEL_SPRITES = ['panel', 'admin', 'marker0', 'marker1', 'marker2', 'left', 'left_lit', 'left_off', 'right', 'right_lit', 'right_off', 'slot', 'look', 'look_on', 'use', 'use_on', 'talk', 'talk_on', 'walk', 'walk_on', 'no_phaser'] as const;
export type PanelSprite = (typeof PANEL_SPRITES)[number];

const PANEL_COLOURS: PanelArt['colours'] = { status: '#000000', separator: '#000000', empty: '#404040', healthy: '#00904c', injured: '#a41c1c', injuredEdge: '#781414' };

/** `communicator` is the object id the rules call the communicator (rules.items.communicator). */
export function facesFromPresentation(config: PresentationConfig, assets: AssetIndex, communicator: string | undefined, opts: { panel?: boolean } = {}): Faces {
  const find = (table: Record<string, string> | undefined, id: string): string | undefined => {
    const path = table !== undefined && Object.hasOwn(table, id) ? table[id] : undefined;
    return path === undefined ? undefined : assets.url(path);
  };
  const portrait = (id: string) => find(config.art?.portraits, id);
  const icon = (id: string) => find(config.art?.icons, id);
  const combadge = () => (communicator === undefined ? undefined : icon(communicator));
  const panelArt = ((): PanelArt | undefined => {
    const p = config.art?.panel;
    if (opts.panel === false || p === undefined) return undefined;
    const urls = new Map<string, string>();
    for (const name of PANEL_SPRITES) {
      const url = find(p.sprites, name);
      if (url === undefined) return undefined;
      urls.set(name, url);
    }
    return { sprite: name => urls.get(name)!, colours: { ...PANEL_COLOURS, ...p.colours } };
  })();
  const astroArt = ((): AstroArt | undefined => {
    const a = config.art?.astro;
    if (a === undefined) return undefined;
    const found = new Map<string, AstroSprite>();
    for (const name of ASTRO_SPRITES) {
      const entry = Object.hasOwn(a.sprites, name) ? a.sprites[name] : undefined;
      const url = entry === undefined ? undefined : assets.url(entry.image);
      if (entry === undefined || url === undefined) return undefined;
      found.set(name, { url, rect: entry.rect });
    }
    const panel = new Map<string, AstroSprite>();
    for (const name of ASTRO_PANEL_SPRITES) {
      const entry = Object.hasOwn(a.sprites, name) ? a.sprites[name] : undefined;
      const url = entry === undefined ? undefined : assets.url(entry.image);
      if (entry !== undefined && url !== undefined) panel.set(name, { url, rect: entry.rect });
    }
    const engine = (prefix: string, n: number): AstroSprite[] | undefined => {
      const frames: AstroSprite[] = [];
      for (let i = 0; i < n; i++) {
        const entry = Object.hasOwn(a.sprites, `${prefix}${i}`) ? a.sprites[`${prefix}${i}`] : undefined;
        const url = entry === undefined ? undefined : assets.url(entry.image);
        if (entry === undefined || url === undefined) return undefined;
        frames.push({ url, rect: entry.rect });
      }
      return frames;
    };
    const warpFrames = engine('engine_warp', ASTRO_ENGINE_FRAMES.warp), impulseFrames = engine('engine_impulse', ASTRO_ENGINE_FRAMES.impulse);
    return { sprite: name => found.get(name)!, panel: name => panel.get(name), engine: warp => (warp ? warpFrames : impulseFrames) };
  })();
  const astroMapArt = ((): AstroMapArt | undefined => {
    const a = config.art?.astro;
    if (a === undefined) return undefined;
    const found = new Map<string, AstroMapSprite>();
    for (const name of ASTRO_MAP_SPRITES) {
      const entry = Object.hasOwn(a.sprites, name) ? a.sprites[name] : undefined;
      const url = entry === undefined ? undefined : assets.url(entry.image);
      if (entry === undefined || url === undefined) return undefined;
      found.set(name, { url, width: entry.rect[2], height: entry.rect[3] });
    }
    return { scale: a.scale, sprite: name => found.get(name)! };
  })();
  const transporterArt = ((): TransporterArt | undefined => {
    const t = config.art?.transporter;
    if (t === undefined) return undefined;
    const found = new Map<string, AstroSprite>();
    for (const name of TRANSPORTER_SPRITES) {
      const entry = Object.hasOwn(t.sprites, name) ? t.sprites[name] : undefined;
      const url = entry === undefined ? undefined : assets.url(entry.image);
      if (entry === undefined || url === undefined) return undefined;
      found.set(name, { url, rect: entry.rect });
    }
    const map = ((): TransporterMapArt | undefined => {
      const at = (name: string): AstroSprite | undefined => {
        const entry = Object.hasOwn(t.sprites, name) ? t.sprites[name] : undefined;
        const url = entry === undefined ? undefined : assets.url(entry.image);
        return entry === undefined || url === undefined ? undefined : { url, rect: entry.rect };
      };
      const across = at('scan_across');
      const down = at('scan_down');
      const worlds: AstroSprite[] = [];
      for (let w = at(`map_world_${worlds.length}`); w !== undefined; w = at(`map_world_${worlds.length}`)) worlds.push(w);
      const frames: AstroSprite[] = [];
      for (let f = at(`blip_${frames.length}`); f !== undefined; f = at(`blip_${frames.length}`)) frames.push(f);
      if (across === undefined || down === undefined || worlds.length === 0 || frames.length === 0) return undefined;
      return { world: n => worlds[n], across, down, blip: { frames, ms: t.blipMs ?? 100 } };
    })();
    return { sprite: name => found.get(name)!, map: () => map };
  })();
  const sensorArt = ((): SensorArt | undefined => {
    const t = config.art?.sensor;
    if (t === undefined) return undefined;
    const found = new Map<string, AstroSprite>();
    for (const name of SENSOR_SPRITES) {
      const entry = Object.hasOwn(t.sprites, name) ? t.sprites[name] : undefined;
      const url = entry === undefined ? undefined : assets.url(entry.image);
      if (entry === undefined || url === undefined) return undefined;
      found.set(name, { url, rect: entry.rect });
    }
    return { sprite: name => found.get(name)! };
  })();
  const cursorArt = ((): CursorArt | undefined => {
    const c = config.art?.cursors;
    if (c === undefined) return undefined;
    const found = new Map<string, string>();
    for (const verb of ['look', 'use', 'talk', 'walk']) {
      for (const name of [verb, `${verb}_lit`]) {
        const url = find(c.sprites, name);
        if (url === undefined || !Object.hasOwn(c.hotspots, verb)) return undefined;
        found.set(name, url);
      }
    }
    return { scale: c.scale, sprite: name => found.get(name)!, hotspot: verb => c.hotspots[verb]! };
  })();
  const tricorderArt = ((): TricorderArt | undefined => {
    const t = config.art?.tricorder;
    if (t === undefined) return undefined;
    const found = new Map<string, string>();
    for (const name of TRICORDER_SPRITES) {
      const url = find(t.sprites, name);
      if (url === undefined) return undefined;
      found.set(name, url);
    }
    return { scale: t.scale, sprite: name => found.get(name)! };
  })();
  return {
    portrait,
    icon,
    combadge,
    speaker(who) {
      // an object that is also an item shows the item's icon (the tricorder's readings speak as the tricorder: the original's dialog icon is its sprite)
      const own = portrait(who) ?? icon(who);
      if (own !== undefined) return { url: own, placeholder: false };
      const badge = combadge();
      return badge === undefined ? undefined : { url: badge, placeholder: true };
    },
    panel: () => panelArt,
    astro: () => astroArt,
    astroMap: () => astroMapArt,
    astroTables: () => config.art?.astro?.tables,
    transporter: () => transporterArt,
    sensor: () => sensorArt,
    cursors: () => cursorArt,
    tricorder: () => tricorderArt,
  };
}
