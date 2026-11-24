// SPDX-License-Identifier: GPL-3.0-or-later
import type { CombatData, ShipUnit } from '../content/types';
import type { CombatAssists } from '../sim/combat/assists';
import type { CombatCommand, ConsolePage } from '../sim/combat/commands';
import type { BattleState } from '../sim/combat/types';
import type { BattleResult } from '../sim/tacticalScreen';
import type { BindableAction } from '../view/combat/bindings';
import type { ConsoleArt } from '../view/combat/console';
import type { RadarMemory } from '../view/combat/files';
import type { AstroFonts } from '../view/bitmapText';
import type { SpaceSceneModule } from './combatView';
import type { SettingsPort } from './settingsPort';

/** The world's battle as the console and the dev view show it (Plan 23, Plan 27): the battle itself, read-only, and how its assists stand. */
export interface BattleView {
  b: Readonly<BattleState>;
  combat: CombatData;
  /** The Enterprise's unit definitions (ship.yaml's): the scanner reads their names and damage limits. */
  enterpriseUnits: readonly ShipUnit[];
  paused: boolean;
  /** The last frame flashed the bridge red (tactical.cpp:484-487). */
  redFlash: boolean;
  /** Auto-resolve's result, waiting for the player to go on. */
  resolved: BattleResult | null;
  /** Auto-resolve is running. */
  resolving: boolean;
  /** The console's page (WorldBattle.page: TacticalScreen::_page). */
  page: ConsolePage;
  /** The warp overlay is up (WorldBattle.warpHold): the console isn't drawn and takes no input (showWarp's screen has none, tactical.cpp:818-846). */
  warp: boolean;
  /** The orders given since the last frame, oldest first (WorldBattle.queue): a toggle reads what they will leave (pendingSwitches, Plan 29 R3). */
  queued: readonly CombatCommand[];
  /**
   * What the game shows over tactical: a dialog (a hail's conversation, a message to answer, the admin console), whose keys are its own;
   * a panel (the log), which Escape closes; or nothing. The battle's keys and pads go by it (Plan 29 R2).
   */
  overlay: 'dialog' | 'panel' | null;
}

/** What Tactical's F1 Combat Options screen needs (Plan 32 Task 11): the settings record, final.spr's picture (art.admin.final) and the game's fonts. */
export interface OptionsScreen {
  settings: SettingsPort;
  /** final.spr, when published (the original's pixels, whatever the art setting); without it the screen is drawn in CSS at the same places. */
  picture?: string;
  fonts: AstroFonts | null;
}

/** What the battle's console (and the dev view behind ?dev) needs from the session. */
export interface BattlePort {
  /** The battle the world is fighting at tactical, or null (none, or the dialog's). */
  battle(): BattleView | null;
  /** An order (spec §4.5), applied before the next frame: dropped while the warp overlay shows (battleCommand). */
  command(cmd: CombatCommand): void;
  pause(on: boolean): void;
  /** Auto-resolve (spec §5): resolves once the battle has an end, or is handed back. */
  autoResolve(): Promise<void>;
  /** Goes on from auto-resolve's result: the battle ends through endCombat. */
  finish(): Promise<void>;
  /** The player's assists, kept with the settings. */
  assists(): CombatAssists;
  setAssists(assists: CombatAssists): void;
  /** The player's key bindings (the settings'), read at each key; the defaults where a port has none. */
  keys?(): Readonly<Record<BindableAction, string>>;
  /** A tab clicked (mouseClick, tactical.cpp:655-658): the page at once, the sim's CONN at the next step (consolePage). */
  page(page: ConsolePage): void;
  /** The console's pictures, palette, fonts and words: null while the battle's set loads, or when the game's export has no stills. */
  consoleArt(): ConsoleArt | null;
  /** The red flash the view shows now (CombatViewHost: 1, 0.4 under prefers-reduced-motion, or 0), which the console's palette takes too (Plan 27 R11). */
  flash(): number;
  /** Where the space view is drawn: `box(wide)` is the console's 640 x 480 box, or the game frame when wide; null as the console goes (Plan 27 R3). */
  viewBox(box: ((wide: boolean) => DOMRect | null) | null): void;
  /** What the wide view's HUD covers of it (ui/combat/hudPanels.ts: CSS pixels, read each frame), for the target's arrow; null as the console goes. */
  hudBoxes(boxes: (() => readonly Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom' | 'width' | 'height'>[]) | null): void;
  /** The scanner showed ship `index`'s log this frame: its lines scroll on (scrollLog, tactical.cpp:1250-1255). */
  logShown(index: number): void;
  /** A console button's beep (pressButton's beep7.mac, tactical.cpp:526). */
  beep(): void;
  /** The radar's grid memory (TacticalScreen's _radarScroll and _radarCentre), kept for the session as TacticalScreen is. */
  radar(): RadarMemory;
  /** The combat chunk, which holds the console's own code: null until the space view has loaded it (M8 spec §8). */
  chunk(): SpaceSceneModule | null;
  /**
   * The ship drawn at (fx, fy) of the space view, each a fraction of the view's width and height from its top left: a click or
   * tap on the view (M8 spec §6.1; Plan 29 R6). Null when none is there, never the Enterprise.
   */
  pick(fx: number, fy: number): number | null;
  /** What the Combat Options screen (F1) is drawn from, or null where there is no settings record (Plan 32 Task 11). */
  optionsScreen?(): OptionsScreen | null;
  /**
   * The Combat Options screen came up or went: up, the battle pauses and the screen is its dialog (`overlay`), as the original's F1 screen is
   * modal; gone, the battle gets back the pause it had, if it is the same battle.
   */
  showOptions?(open: boolean): void;
  /** Where the screen's preview window is (CSS pixels, read each frame), the Enterprise drawn there with the options; null as it goes. */
  previewBox?(box: (() => DOMRect | null) | null): void;
}
