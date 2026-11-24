// SPDX-License-Identifier: GPL-3.0-or-later
import type { MapPanel, MapView } from '../sim/astroCamera';
import type { AstroSelection } from '../view/astroSelect';
import type { AstroTime, Course, CourseError, previewCourse } from '../sim/astro';
import type { Ending } from '../sim/ending';
import type { TransporterRoom } from '../sim/transporter';
import type { TransporterMapView } from './transporterDirector';
import type { ShipState, Station } from '../sim/ship';
import type { CombatOutcome } from '../sim/combat';
import type { ViewscreenImage } from '../view/space';
import type { AstroArt, SensorArt, TransporterArt } from '../ui/faces';
import type { ShipClick } from '../sim/events';
import type { SliderKind } from '../sim/shipSystems';
import type { EngineeringView } from './engineeringSession';
import type { LoadedHolodeckArt } from '../view/holodeckArt';
import type { AstroFonts } from '../view/bitmapText';

/** One thing to click on the bridge, from the lifted bridge items. */
export interface BridgeItemView {
  object: string;
  label: string;
  /** What clicking does; 'later' is built in a later plan. */
  action: 'turbolift' | 'astrogation' | 'computer' | 'replay' | 'comms' | 'lounge' | 'tactical' | 'talk' | 'later';
  x: number; y: number; width: number; height: number;
}

/** What astrogation has picked: a sector, then a star in it, then a planet of the star (by index, R3), its moon, outpost or belt; or a station or phenomenon. */
export type { AstroSelection };

/** What the ship's panels need from the session. They read the store through this and act only through it. */
/** The astrogation map's camera, as the buttons around it show it (astrogation.cpp's view, panel, angles, cursor and display switches). */
export interface MapCameraView {
  view: MapView; panel: MapPanel; azimuth: number; elevation: number; spinning: boolean;
  cursorSector: [number, number, number]; cursor: [number, number, number];
  /** The Display tab's nine switches, on or off. */
  display: boolean[];
}

/** What the astrogation screen writes in its plate's fields (drawTitle, drawCoordinates, the Display tab): the sector at the top, the cursor's and ship's coordinates, and the tab's labels when the executable's are published. */
export interface AstroText {
  title: string;
  cursor: [number, number, number];
  ship: [number, number, number];
  labels: readonly string[] | null;
  /** The screen's messages (the executable's `_astroMessages`): the first and the third are the two it shows as it opens. Null until published. */
  messages?: readonly string[] | null;
}

export interface StripReadout {
  transit: { warp: boolean; speed: number; lightYears: number } | null;
  dest: { arriving: boolean; name: string } | null;
}

export interface ShipPort {
  /** Null while the team is away. */
  ship(): ShipState | null;
  /** Rejects unless the game is idle. */
  station(name: Station): Promise<void>;
  /** Any other ship screen code (the turbolift's list holds some that are not stations). */
  screen(code: number): Promise<void>;
  bridgeItems(): BridgeItemView[];
  /** The ids of the bridge's crew who are aboard, so the set stands a card for each (read-only; Plan 16 Task 6). */
  crewOnBridge(): string[];
  turbolift(): { code: number; label: string }[];
  /** performAction TALK on a crew object (R6). */
  talk(object: string): Promise<void>;
  /** Null unless the game is over, then the reason. */
  gameOver(): number | null;
  ending(reason: number): Ending;
  /** A new game. */
  restart(): Promise<void>;
  /** The name of the sector the ship is in, for the bridge strip's readout (Astrogation::sectorName; empty if there is none). */
  sectorName(): string;
  /** The strip's journey readouts (bridge.cpp draw()): the speed and light years left while travelling, and the destination (while arriving or arrived, its name). */
  stripReadout(): StripReadout;
  /** The bridge's sensor records (bridge.cpp draw()): the names of the rows showing (up to three), and whether the arrows can scroll. */
  sensorRecords(): { rows: string[]; up: boolean; down: boolean };
  /** An arrow of the sensor records: 1 for up (towards the newest), -1 for down. Does nothing at the ends. */
  sensorScroll(direction: 1 | -1): void;
  /** A row of the sensor records: goes to astrogation with that place chosen, to go again. */
  sensorGo(row: number): Promise<void>;
  /** The sectors with stars. Names only for charted ones (a sector is charted once any star in it is). */
  sectors(): { index: number; label: string; charted: boolean }[];
  /** A sector's stars, with how many planets each has. Names only for charted or revealed ones. */
  stars(sector: number): { index: number; label: string; planets: number }[];
  /** What the player has picked, from the lists or by clicking the map. A scripted warp's course is shown as picked while it engages. */
  selection(): AstroSelection | null;
  /** False while a scripted warp engages by itself: the exits and Engage wait (AstrogationScreen::exitsEnabled, astrogation.cpp:1180). */
  exitsEnabled(): boolean;
  select(selection: AstroSelection | null): void;
  /** The map camera (views, angles, cursor, tabs, display switches). */
  mapCamera(): MapCameraView;
  /** The rotation pad's button 0 to 4: up, down, left, right, the middle one. */
  mapPad(button: number): void;
  /** The cursor arrows: an axis 0 to 2 and a step of 1 or -1. */
  mapCursor(axis: number, step: number): void;
  mapView(view: MapView): void;
  mapPanel(panel: MapPanel): void;
  /** A Display switch, 0 to 8. */
  mapDisplay(item: number): void;
  /** What the Info tab shows of the chosen place (empty lines when nothing is chosen). */
  selectionInfo(): { title: string; lines: string[] };
  /** The Stop button (Astrogation::stopTransit): the ship stops wherever it has got to. Rejects unless the game is idle. */
  stopTransit(): Promise<void>;
  /** The destination and journey time, or why there is no course. */
  preview(course: Course): ReturnType<typeof previewCourse>;
  /** Rejects unless the game is idle. Resolves with why the course was refused, or null once under way. */
  engage(course: Course): Promise<CourseError | null>;
  /** The journey under way, or null. */
  transit(): { progress: number; eta: AstroTime } | null;
  maxWarp(): number;
  /** How many impulse speeds there are. */
  impulseSteps(): number;
  /** Non-null while the viewscreen runs: the hailing object, if there is one, and what to call it. */
  viewscreen(): { target: string | null; label: string } | null;
  /**
   * What the viewscreen shows (R7, unity.cpp:604-640): space or warp in transit, space with no sector, else a planet in two colours; on the
   * viewscreen screen a hailing object that has a picture shows it as a sprite. Read-only.
   */
  viewscreenImage(): ViewscreenImage;
  /** The transporter room while the ship is at it, else null. */
  transporter(): TransporterRoomView | null;
  /**
   * The transporter room's pads, in the room's 640x480 pixels: where each stands, its scale (256 is full size) and who is on it
   * (null when empty). Read-only, for drawing; empty away from the room.
   */
  /** Each pad: its clickable rectangle in the room ([x1, y1, x2, y2], the original's padAt), where its crew stands, and who is on it. */
  transporterPads(): { pad: number; rect: [number, number, number, number]; stand: [number, number]; scale: number; crew: string | null }[];
  /** Each of these rejects unless the game is idle. */
  recommend(): Promise<void>;
  /** Puts a crew member on the first free pad. */
  pad(crew: string): Promise<void>;
  unpad(pad: number): Promise<void>;
  kit(item: string): Promise<void>;
  unkit(item: string): Promise<void>;
  /** Beams the team down: refused with nothing on the pads or no target. */
  energize(): Promise<void>;
  /** The Map and Lists buttons (`showMap`): the map restarts its scan; the lists put it away. */
  transporterShowMap(show: boolean): void;
  /** Leaves by one of the transporter's exits (a ship screen code). */
  leave(code: number): Promise<void>;
  /** The computer screen while it is open (it leaves the ship's station as it was), else null. */
  computer(): ComputerScreenView | null;
  /** Click the nth list row (ComputerScreen::clickRow). Rejects unless the game is idle. */
  computerRow(index: number): Promise<void>;
  /** The list's up (-1) and down (1) buttons. */
  computerScroll(by: -1 | 1): Promise<void>;
  /** The computer's Bridge, Astrogation and Tactical buttons. */
  computerLeave(to: 'bridge' | 'astrogation' | 'tactical'): Promise<void>;
  /** The conversation log, newest conversation first, each line with its speaker's name (R7). */
  conversationLog(): { speaker: string; text: string }[][];
  /** The bridge's contact lists: Comms' (active, with a sprite) and the lounge's, up to ten each, with names (bridge.cpp:351-378). */
  contacts(which: 'comms' | 'lounge'): { object: string; label: string }[];
  /** Hails the object, or with null says nobody answers (kActionComms). Rejects unless the game is idle. */
  comms(object: string | null): Promise<void>;
  /** Picard talks to the object, or with null the room is said to be empty (kActionLounge). Rejects unless the game is idle. */
  lounge(object: string | null): Promise<void>;
  /** The panel's picture box registers where it is on the page (null when it goes), so the session can draw the station's set into it. */
  screenRect(box: (() => DOMRect | null) | null): void;
  /** Whether a set is drawn behind this station's buttons (art on, and its glb loaded): the panel goes transparent over it. */
  shipArt(station: string): boolean;
  /** Whether the last station's picture is held on show while this station's loads (B5): the panel is hidden meanwhile. */
  shipHeld(): boolean;
  /** Starts loading these stations' pictures (the turbolift's list opening), so a move there shows at once (B5). */
  preloadStations(stations: string[]): void;
  /** The plate drawn for this station (art on and loaded): the areas of its picture, in the original's pixels. Read-only; null with no plate. */
  shipPlate(station: string): { areas: Record<string, [number, number, number, number]> } | null;
  /** The holodeck while the ship is there (runHolodeck): the movies seen so far, in movie.map's order, to see again; else null. */
  holodeck(): { movies: { stem: string; title: string }[] } | null;
  /** The holodeck's own pictures (art.holodeck), once loaded, with the art on; else null and the screen is the plain panel. */
  holodeckArt(): LoadedHolodeckArt | null;
  /** Plays one of those movies again. */
  holodeckPlay(stem: string): Promise<void>;
  /** The holodeck's Bridge button. */
  holodeckLeave(): Promise<void>;
  /** The engineering screen while the ship is at it (EngineeringScreen): the ship's units and their live state, and the original's pictures once loaded; else null. */
  engineering(): EngineeringView | null;
  /** A slider of the screen: the unit, what it sets, and the pointer's distance along it in the original's pixels (setSlider). Ignored unless the game is idle. */
  engineeringSlider(unit: number, kind: SliderKind, x: number): void;
  /** The Delegate button: La Forge takes over, saying so, or gives the screen back. */
  engineeringDelegate(): void;
  /** A sound a ship button makes that the UI alone knows about (the door opening as the turbolift list does, replay): `ShipClick`'s names. */
  sound(name: ShipClick): void;
  /** The hotspots debug view: with a set drawn, the item borders show only while it is on. */
  hotspots(): boolean;
  /** The game's bitmap fonts and the screen's palette (art.fonts, art.astro.palette), once loaded, with the art on; else null and the text is ours. */
  astroFonts(): AstroFonts | null;
  /** The pointer over astrogation's exits, a CSS `cursor` value (AstrogationScreen::mouseMove: `setCursor(3)`, the lit use pointer; the published one when it is, else the drawn). */
  exitCursor(): string;
  /** The text the astrogation plate's fields show. */
  astroText(): AstroText;
  /** The course panel's own sprites (art.astro), when published and the art is on; else null and the buttons are drawn in CSS. */
  astroSprites(): AstroArt | null;
  /** The transporter room's console pictures (art.transporter), when published and the art is on; else null and its buttons and slots are drawn in CSS. */
  transporterSprites(): TransporterArt | null;
  /** The bridge strip's Viewscreen button pictures, when published and the art is on; else null and the button is CSS. */
  sensorSprites(): SensorArt | null;
  /** The item's icon (art.icons) for the kit's slots and the preview box, with the art on; else undefined and the item is its name. */
  itemIcon(id: string): string | undefined;
  /** Whether the bridge's viewscreen is up (BridgeScreen::_viewscreenUp: UI state, not saved). */
  viewscreenUp(): boolean;
  /** The viewscreen button (bridge.cpp:302-305). */
  toggleViewscreen(): void;
  /** The admin button (bridge.cpp:308-311): the game's menu, here the saves panel. */
  adminMenu(): void;
  /** The battle while tactical is open, else null: the ships by name, and whether a hail waits to be answered. */
  combat(): CombatView | null;
  /** The placeholder dialog's win, flee or lose (R3). Rejects unless the game is idle. */
  resolve(outcome: CombatOutcome): Promise<void>;
  /** Answers a waiting hail (TacticalScreen::hail). Rejects unless the game is idle. */
  answerHail(): Promise<void>;
  subscribe(listener: () => void): () => void;
}

/** What the tactical panel shows: the battle's ships (the Enterprise first), and its alert. */
export interface CombatView {
  ships: { id: string; label: string; friendly: boolean; destroyed: boolean }[];
  redAlert: boolean;
  hailWaiting: boolean;
}

/** What the computer panel shows: the list's rows, and the selected entry's heading and text. */
export interface ComputerScreenView {
  rows: { entry: number; child: boolean; title: string; selected: boolean }[];
  heading: string;
  text: string;
  canScrollUp: boolean;
  canScrollDown: boolean;
}

/** The room with names for the panel: crew and items by content name, the exits as lifted. */
export interface TransporterRoomView {
  room: TransporterRoom;
  /** The map the room opens on, and its scan (transporter.cpp showMap and updateLock). */
  map: TransporterMapView;
  /** The pads someone is walking onto or off (`isWalking`): they cannot be clicked. */
  walking: number[];
  name(id: string): string;
  canEnergize: boolean;
  exits: { code: number; label: string }[];
}
