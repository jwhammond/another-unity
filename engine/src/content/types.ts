// SPDX-License-Identifier: GPL-3.0-or-later
export type Vec2 = { x: number; z: number };

/** The player's verbs; 'timer' is internal. */
export type Verb = 'use' | 'get' | 'look' | 'timer' | 'walk' | 'talk';
/** The verbs that have rule lists. */
export type RuleVerb = 'use' | 'get' | 'look' | 'timer';

/** condition.other: fail if a second object was given. */
export const NONE = '$none';
/** check.object: the current away-team member. */
export const ANYONE = '$anyone';

export interface Line {
  text: string;
  voice?: string;
}

export type Check =
  | { emptyAt: string }
  | {
      object: string;
      state?: number;
      /** 'inTeam' only applies to crew; for other objects use the inventory checks. */
      status?: 'inTeam' | 'inInventory' | 'notInInventory';
      at?: string;
      screen?: string;
      /** If the object is inactive, the whole condition passes at once; if it is active, the check fails (FAILSCREEN). */
      passIfInactive?: true;
    };

export interface Condition {
  other?: string;
  who?: string;
  /**
   * `dist` is in metres at the row it was lifted at. `px` is the original's own distance in pixels: on a screen with a
   * pixel metric the sim compares that, since an object that has moved is at another row (object.cpp:1129-1132).
   */
  near?: { dist: number; at?: string; px?: number };
  skill?: number;
  counter?: { mode: 'when' | 'until'; value: number };
  checks?: Check[];
  stop?: boolean;
}

/** AlterBlock (object.cpp:1288-1462); the fields apply in the order listed. */
export interface AlterFx {
  /** $anyone: whoever is acting. */
  object: string;
  /** A marker on the object's screen (the current screen for an object with none). */
  at?: string;
  /** A move in the universe, for the starship modes (the Enterprise warps, at `speed`). */
  universe?: { x: number; y: number; z: number; speed?: number };
  get?: true;
  /** Onto the current screen. */
  drop?: true;
  active?: boolean;
  /** The current member talks to the script's object. */
  talkTo?: true;
  halt?: true;
  /** The OBJFLAG_STUNNED flag; it doesn't put anyone down. */
  stunned?: boolean;
  voice?: string;
  /** Seconds between timer actions; 0 stops them. */
  timer?: number;
  anim?: AnimFx;
  /** A new talk string. At most one of talk, sayNow and converseNow. */
  talk?: string;
  /** Said by the object now (the original's "1…" hail text). */
  sayNow?: string;
  /** A conversation started now (the original's "1@…"). */
  converseNow?: string;
  name?: string;
  state?: number;
  describe?: true;
}

export interface ChoiceOption {
  text: string;
  do: RuleGroup[];
}

/** ConversationBlock: changes a response's state. */
export interface ConverseFx {
  conversation: string;
  situation: number;
  key: number;
  to: 'enabled' | 'disabled' | 'locked';
}

/** CommandBlock: someone does something, as if the player had told them to. */
export interface ActFx {
  verb: 'look' | 'get' | 'walk' | 'talk' | 'use';
  /** $anyone: the current member (the original's 0x10 as a command's object, as getWalker reads it). */
  object?: string;
  /** A crew member; $anyone (the default) is the current member, $actor whoever is acting now. */
  who?: string;
  other?: string;
  at?: string;
}

/** ReactionBlock (object.cpp:1465-1620). */
export interface ReactFx {
  /** Whoever is acting, the team here, one active member at random, or an object (brought here). */
  who: 'actor' | 'team' | 'random' | { object: string };
  do: 'stun' | 'kill' | 'revive' | 'beamUp' | { damage: number } | { beamIn: string } | { beamTo: { screen?: string; entrance: string } };
  /**
   * Damage, stun and kill show a phaser shot from the script's object. `shot` and `chodak` are one bit in the original
   * (beam_type, object.cpp:1523-1524); the lifter sets the one that matters for `do`.
   */
  shot?: true;
  /** The beams use the Chodak transporter effect (the same bit as `shot`). */
  chodak?: true;
}

/** BeamBlock: where the transporter sends the next away team; null clears it. */
export interface BeamFx {
  to: string | null;
  /** The original's world number when the screen's world differs from it (8, which lands on world 5's screens). */
  world?: number;
}

/** ScreenBlock's screen change; the change itself waits until the outermost action is done. */
export interface ScreenFx {
  /** A screen, or $ship. */
  to: string;
  /** Needed unless going to the ship. */
  entrance?: string;
  /** The team walks to whoever is acting first (entrance flag 0x40). */
  gather?: true;
  /** Arrivals step in from the entrance in a random direction (entrance flag 0x80). */
  stepIn?: true;
  /** Coming back from a close-up, the team stays where it was (entrance 0xff, awayteam.cpp:309); ignored otherwise. */
  stay?: true;
  /** With $ship: the game is over, for this reason. */
  gameOver?: number;
}

/** ScreenBlock's advice: now, or for a screen's next visit. */
export interface AdviceFx extends AdviceSetting {
  screen?: string;
}

/** ScreenBlock's startup override: the action that runs when the screen is next entered. */
export interface StartupFx {
  screen: string;
  action: StartupActionDef | null;
}

/** ScreenBlock's flags: now (closeup ignored), or for a screen's next visit. */
export interface AwayFlagsFx {
  inputBlocked?: boolean;
  combadge?: boolean;
  closeup?: boolean;
  screen?: string;
}

/** CommunicateBlock: a hail. `type` is the original's hail type: 6 runs now, 0xff clears, 0-3 are unused, the rest wait for the bridge. */
export interface CommunicateFx {
  /** Whose talk string names the conversation (for types other than 7 and 8). */
  from?: string;
  conversation?: string;
  situation?: number;
  /** Types 0xa/0xb/0x10/0x11: the battle scenario (a screen of world 0x10), not a conversation (unity.cpp dispatchPendingHail). */
  scenario?: number;
  type: number;
}

type Stop = { stop?: boolean };

export type Effect =
  | ({ alter: AlterFx } & Stop)
  | ({ path: { enable?: string[]; disable?: string[] } } & Stop)
  | ({ trigger: { id: string; enabled: boolean } } & Stop)
  | ({ screen: ScreenFx } & Stop)
  | ({ say: { who: string; text: string; voice?: string } } & Stop)
  | ({ describe: { object: string } } & Stop)
  | ({ play: { movie?: string; sound?: string } } & Stop)
  | ({ call: { hook: string; args?: Record<string, unknown> } } & Stop)
  | ({ converse: ConverseFx } & Stop)
  | ({ act: ActFx } & Stop)
  | ({ react: ReactFx } & Stop)
  | ({ beam: BeamFx } & Stop)
  | ({ advice: AdviceFx } & Stop)
  | ({ startup: StartupFx } & Stop)
  | ({ awayFlags: AwayFlagsFx } & Stop)
  | ({ communicate: CommunicateFx } & Stop)
  | ({ wait: { seconds: number } } & Stop)
  | ({ restartTimers: true } & Stop)
  | ({ missing: MissingFx } & Stop)
  | ({ ship: ShipFx } & Stop)
  | ({ choose: { question: string; options: [ChoiceOption, ChoiceOption] } } & Stop);

export interface RuleGroup {
  when?: Condition;
  do: Effect[];
}

export interface ObjectDef {
  id: string;
  name: string;
  screen: string | null;
  at?: string;
  pos?: Vec2;
  state?: number;
  active?: boolean;
  inventory?: boolean;
  crew?: boolean;
  skills?: number;
  /** Seconds between 'timer' actions while the object is active on the current screen. */
  timer?: number;
  description?: Line;
  /** Walking to this object walks to the transition object and uses it. */
  transition?: string;
  /** What talking to it does: a line it says, or a talk string (@, !, ^, ~ or |). */
  talk?: string;
  talkVoice?: string;
  /** Where it is in space, for the starship modes (the ship world's Enterprise, planets and stars). */
  universe?: { x: number; y: number; z: number };
  /** Talking walks up to this far to one side of it (the original's width), in metres at its marker's row. */
  width?: number;
  /**
   * The original's raw width in pixels, kept whether or not the object has a screen (crew have none). On a screen with
   * a pixel metric, talking walks up this many pixels to one side of it, unscaled, as the original does
   * (unity.cpp:2028-2029).
   */
  pixelWidth?: number;
  /**
   * An action square (objwalktype 3): a spot on the floor whose `use` rules run for a walker who arrives within
   * ACTION_SQUARE_RADIUS pixels of it. The value is the original id's last byte, which is the object's place in its
   * screen's list and so the order the squares run in.
   */
  actionSquare?: number;
  /** Each crew member's own description; `description` is for anyone without one. */
  descriptions?: Record<string, Line>;
  /** Phaser data (phaser.map and p_XXYYZZ.bst): health, and what shots do. */
  phaser?: PhaserDef;
  on?: Partial<Record<RuleVerb, RuleGroup[]>>;
}

/** The projection the lifter fitted to a screen's floor: how it maps to the original's pixels. */
export interface PixelFit {
  kind: 'perspective' | 'flat';
  /** Scale units per row: scaleAt(y) = slope * (y - horizonY). */
  slope: number;
  horizonY: number;
  /** A flat screen's scale. */
  meanScale: number;
  /** The floor's back edge: rows above it are placed on it. */
  topY: number;
  metersPerPixel: number;
}

/** One of a screen's polygons, in the original's pixels (loadScreenPolys); it is walked on while its region is open. */
export interface PixelPolygon {
  /** Its region, a key of the screen's `regions`. */
  region: string;
  /** Its corners, each with the scale (out of 256) of someone standing there. */
  points: { x: number; y: number; scale: number }[];
}

/**
 * How a screen's floor maps to the original's pixels. With it, the sim measures talk reach, near checks and
 * step-ins in pixels, and walks over the original's polygons with a port of its path finder (walk.cpp), as the
 * original does; the rules' distances are then pixels at full scale (`metersPerPixel` metres each).
 */
export interface PixelMetric extends PixelFit {
  /** Every polygon of the screen, in the original's order (which its path finder depends on). */
  floor: PixelPolygon[];
}

export interface ScreenDef {
  id: string;
  markers: Record<string, Vec2>;
  pixelMetric?: PixelMetric;
  regions?: Record<string, boolean>;
  /** Changing screens within a world leaves anyone down where they are; defaults to the game id. */
  world?: string;
  /** What happens on entering it (w_XXstrt.bst). */
  startup?: ScreenStartupDef;
}

export interface TriggerDef {
  id: string;
  /** 'proximity' never fires here: the starship modes run it (M4). */
  type: 'normal' | 'timer' | 'proximity';
  context: 'away' | 'ship';
  target: string;
  enabled: boolean;
  seconds?: number;
  /** Only on a proximity trigger. */
  proximity?: ProximityDef;
}

export interface GameStart {
  screen: string;
  entrance: string;
  awayTeam: string[];
  /** The crew member that triggers act as (the original's object 0). */
  leader: string;
  seed?: number;
}

/** An away mission the bridge stub offers (M3 Decision 12): where the transporter puts the team. */
export interface MissionDef {
  /** The world's slug. */
  world: string;
  screen: string;
  entrance: string;
  /** The original's world number (1-8): the transporter's recommended team and kit are per number. */
  number?: number;
  /** The original beams this world's team down without the transporter's effect or beam-down piece (world 6). */
  beamEffect?: false;
}

export interface GameContent {
  id: string;
  start: GameStart;
  missions?: MissionDef[];
  screens: Record<string, ScreenDef>;
  objects: Record<string, ObjectDef>;
  triggers: TriggerDef[];
  rules: GameRules;
  conversations: Record<string, ConversationDef>;
  advice: Record<string, AdviceDef>;
  /** The starship's content (universe.yaml, ship.yaml, computer.yaml); unset for a game without a ship. */
  ship?: ShipContent;
}

/** Whoever is acting now (the original's 0x20 in a CommandBlock). */
export const ACTOR = '$actor';
/** screen.to: back to the ship. */
export const SHIP = '$ship';

/** screen.to: the screen the team is on when the effect runs (a world's conversation has none of its own: M3 Decision 2). */
export const CURRENT = '$current';

/** Content the export doesn't have (M3 Decision 3): it does nothing, and says so in the trace. ScummVM would fail here. */
export interface MissingFx {
  kind: 'conversation' | 'object' | 'movie' | 'screen';
  /** The original's id: an IR key (w003c007), an object id (060b05) or a movie number (42). */
  id: string;
}

/** A proximity trigger's test (trigger.cpp proximityTick): the starship's distance to a place in space. Kept, not run (M3 Decision 5). */
export interface ProximityDef {
  dist: number;
  /** Object slugs: the ship world's objects, which carry universe positions. */
  from: string;
  to: string;
  reversed: boolean;
  instant: boolean;
}

export interface PhaserDef {
  /** Health starts here (max_health). */
  health: number;
  /** At or below this, the object is down. */
  threshold: number;
  /** The lowest phaser setting (1 low, 2 medium, 3 high) that does damage. */
  damageFrom: number;
  /** With gtpUpTo unset, damaging shots at this setting or above run the gtp list. */
  gtpFrom: number;
  /** Shots at this setting or below run the gtp list; unset is the original's -1. */
  gtpUpTo?: number;
  on?: { stun?: RuleGroup[]; gtp?: RuleGroup[]; kill?: RuleGroup[] };
}

/** setAdvice's arguments: off, or a new advice id and/or a new interval in seconds. */
export interface AdviceSetting {
  id?: string;
  every?: number;
  off?: true;
}

export type StartupVerb = 'use' | 'get' | 'look' | 'walk' | 'talk';

export interface StartupActionDef {
  verb: StartupVerb;
  target: string;
  /** A crew member; $anyone (the default) is the current one. */
  who?: string;
  other?: string;
  at?: string;
}

export interface ScreenStartupDef {
  advice?: AdviceSetting;
  /** A close-up hides the away team. */
  closeup?: boolean;
  combadge?: boolean;
  inputBlocked?: boolean;
  action?: StartupActionDef;
}

export type ResponseState = 'set' | 'enabled' | 'disabled' | 'locked';

/** Who replies (responderFor, conversation.cpp:270-287). */
export type Replier =
  /** A crew member, who must be with the team for the response to be offered, or any object, which must be active. */
  | { object: string }
  /** A crew member, from wherever they are (0x2n). */
  | { crew: string }
  /** A crew member, but only while with the team (0x3n). */
  | { teamCrew: string };

export interface ReplyDef {
  text: string;
  voice?: string;
}

export interface ChangeDef {
  to: ResponseState;
  situation: number;
  key: number;
}

export interface ResponseDef {
  situation: number;
  /** The original's state field: (situation, key) names the response. */
  key: number;
  /** Said by whoever started the conversation; it is also the menu text. */
  text?: string;
  voice?: string;
  /** A voice for each crew member who might say the text (voice group 0xfd). */
  voices?: Record<string, string>;
  /** The speaker only turns (voice groups 0xfb, 0xfc), and the text isn't said. */
  turn?: 'left' | 'right';
  state: ResponseState;
  /** Crew members who may say it, or $anyone. */
  who: string[];
  replier?: Replier;
  /** One is picked at random, unless `joined`, when the first two make one reply. */
  replies?: ReplyDef[];
  joined?: true;
  /** The situation to go on to; none ends the conversation. */
  next?: number;
  changes?: ChangeDef[];
  results?: RuleGroup[][];
}

export interface ConversationDef {
  id: string;
  /** One of the ship's conversations (world 0x5f), which hails use. */
  ship?: true;
  /** The original's conversation number within its world; a hail finds ship conversations by it. */
  number?: number;
  /** In file order. */
  responses: ResponseDef[];
}

export interface AdviceDef {
  /** By crew member id, or $anyone. */
  easy?: Record<string, string>;
  hard?: Record<string, string>;
}

export interface LineRef {
  conversation: string;
  situation: number;
}

/** The objects that the engine treats specially when used with something. */
export interface ItemRoles {
  phaser?: string;
  tricorder?: string;
  medicalTricorder?: string;
  medkit?: string;
  communicator?: string;
}

/** The fixed lines (sayFailure, the medical items and advice: awayteam.cpp:424-462, 1256-1310; talk.cpp:303). */
export interface FailureLines {
  failLook?: LineRef;
  failTalk?: LineRef;
  failUse?: LineRef;
  failOther?: LineRef;
  failPhaser?: LineRef;
  tricorderNothing?: LineRef;
  noAdvice?: LineRef;
  /** The Admiral's log at the end of the game (endGame); its responses count from reason 1. */
  gameOver?: LineRef;
  /** The medical lines' situations are counted from the patient's place in `order` (the original's crew ids). */
  medical?: { conversation: string; order: string[] };
}

export interface GameRules {
  /** Talking to something further than this walks up to it first (the original's 180 px; on a screen with a pixel metric, measured in its pixels). */
  talkDistance?: number;
  /** How far arriving crew step in from an entrance that asks for it (at full scale, on a screen with a pixel metric). */
  stepIn?: number;
  /** The crew member whose medkit works better (Dr. Crusher). */
  doctor?: string;
  items: ItemRoles;
  lines: FailureLines;
}

/** Changes that only the starship modes can make; they wait in the state until then. */
export type ShipFx =
  | { newWarpMovie: true }
  | { reveal: number }
  | { repair: true }
  | { computer: 'record' | 'hide' | 'show'; entry: number }
  | { universe: { object: string; x: number; y: number; z: number; speed?: number } };

export type AnimFx = { play: number; wait?: true } | { stop: true } | { sprite: number };

/** One tricorder reading's computer entry (computer.db), as the viewer pages through them. */
export interface ReadingPage {
  title: string;
  heading: string;
  text: string;
}

/** One entry of the ship's computer (computer.db): its strings, flags and the entries beneath it. */
export interface ComputerEntry {
  title: string;
  heading: string;
  text: string;
  flags: number;
  /** Indexes into `ComputerTree.entries`. */
  subentries: number[];
}

/** The ship's computer (computer.yaml): the entries, which of them the game numbers (`entryIds`), and each reading's heading. */
export interface ComputerTree {
  entries: ComputerEntry[];
  /** `_computerEntryIds`: a script's computer-entry number n names entry `entryIds[n]` (object.cpp:1786-1790). */
  entryIds: number[];
  /** `_tricorderReadings[].parent` by reading key: the heading entry a reading unhides (carry note 8). */
  readingParents: Record<number, number>;
  /** `compstat`: the entry indexes hidden at the start, ascending. */
  hidden: number[];
  /** `compstat`: the readings recorded at the start (their keys), in file order. */
  startReadings: number[];
  /** `_tricorderReadings`, every world: the key, where it points and the heading it unhides. */
  readings: ComputerReading[];
}

/** One tricorder reading (`_tricorderReadings`). The engine never parses `key`: `world`, `group` and `index` are its parts. */
export interface ComputerReading { key: number; world: string; group: number; index: number; entry: number; parent: number }

/** One astro.db thing (astrogation.cpp readThing). */
export interface AstroThing { id: number; type: number; seed: number; x: number; y: number; z: number; name: string; range: number }
export interface AstroStar extends AstroThing {
  flags: number; spectralClass: number; magnitude: number; orbitScale: number;
  systemName: string; scriptedName: string; scriptedDescription: string;
  /** Index into `Universe.specials` of the outpost or starbase at this star, or -1. */
  special: number;
}
export interface AstroSpecial extends AstroThing { sector: number; star: number; planet: number }
export interface AstroSector {
  numStars: number; numPhenomena: number; alignment: number; firstStar: number; firstPhenomenon: number;
  /** Index into `Universe.stations`, or -1. */
  station: number;
  description: string; name: string; region: number;
}
/** The universe (universe.yaml): astro.db, sector.ast, `_sectorRegions`, `_regionChatter`, `_warpSpeeds`, `_impulseSpeeds` and ast_stat.dat's starting flags. */
export interface Universe {
  sectors: AstroSector[]; stars: AstroStar[]; phenomena: AstroThing[]; stations: AstroThing[]; specials: AstroSpecial[];
  flags: number[]; regionChatter: number[]; warpSpeeds: number[]; impulseSpeeds: number[];
  /** The scripted warps (`_scriptedWarps`, data.cpp:991-1000): the places a story trigger sends the ship, by code. */
  scriptedWarps: ScriptedWarp[];
  /** `_planetOrbits`: the orbit table planetOrbit() scales (universe.cpp:57). */
  planetOrbits: number[];
  /** `_astroReveals`: the astro thing ids a story script reveals, by reveal number. */
  reveals: number[];
}
export interface ScriptedWarp { code: number; sector: number; star: number; planet: number; type: number; index: number }

/** One clickable thing on the bridge (`_bridgeItems`). */
export interface BridgeItem { object: string; x: number; y: number; width: number; height: number; action: number; depth: number; description: string }
export interface ShipScreenEntry { code: number; text: string }
/** Per world: the recommended team and kit (transporter.cpp chooseRecommended reads _awayTeamScreenData[world]). */
export interface AwayTeamDefault { world: number; members: string[]; items: string[] }
export interface ShipUnit {
  name: string; type: number; current: number; target: number; max: number; chargeTicks: number; dischargeTicks: number;
  damage: number; repair: number; baseDamage: number; maxDamage: number;
  /** ShipSystems::load's (ship.cpp:77-79): the efficiency every lift since Plan 18 has (Plan 23 dropped the fallback), the hit weight absent in an older lift. */
  efficiency: number; hitWeight?: number;
  /** ShipUnit::depth (ship.cpp:62): 0 outside, 1 on a deck, 2 in the core, which a hit reaches in turn (Combat::pickUnit, damage.cpp:93-122). Absent in an older lift. */
  depth?: number;
}
/** The triggers and objects astrogation names (astrogation.cpp:76-97), as slugs. */
export interface AstroNames {
  enterprise: string;
  starbaseBattle: number;
  /** The battle a hail without a scenario starts (tactical.cpp:206). */
  defaultBattle: number;
  triggers: { arriveStarbase: string; arriveStar: string; firstVisit: string; runAway: string; secondVisitCheck: string; secondVisit: string };
}
/** The ship kinds `Combat::setup` knows (combat.cpp:38-49), by the first ten letters of an object's name. */
export type ShipKind = 'chodak' | 'romulan' | 'enterprise' | 'klingon' | 'probe' | 'ferengi' | 'starbase' | 'garidian' | 'shuttle' | 'mother';
/** The bridge, the transporter's teams and the ship's stats (ship.yaml). */
export interface ShipData {
  bridge: { items: BridgeItem[]; objects: { object: string; x: number; y: number; depth: number; file: string }[]; turbolift: ShipScreenEntry[] };
  transporter: { exits: ShipScreenEntry[]; teams: AwayTeamDefault[]; targets: { x: number; y: number }[];
    /** The pads' drawing (absent in an older ship.yaml): `rect` is [left, top, right, bottom] (the export's corners) and `stand` [x, y] in the room's 640x480 pixels, `scale` is 256 for full size. View only. */
    pads?: { rect: [number, number, number, number]; stand: [number, number]; scale: number }[];
    /** How the crew walk in from the door and out again (`_transporterWalkOn`, `_transporterWalkOff`: absent in an older ship.yaml): waypoints, in the room's pixels, the animation each leg plays and the size. View only. */
    walkOn?: { x: number; y: number; direction: number; scale: number }[];
    walkOff?: { x: number; y: number; direction: number; scale: number }[];
  };
  /** `voices` by crew number (`_crewVoices`); `voiceOf` the same by crew member, for fe09<voice as four hex digits>.vac, which the computer says as they are chosen on a pad (transporter.cpp:759-763). */
  crew: { leaderOrder: string[]; voices: number[]; voiceOf?: Record<string, number> };
  speeds: { warp: number[]; impulse: number[] };
  units: ShipUnit[];
  astro: AstroNames;
  /** The items the ship carries at the start, in id order, without the communicator (shipEquipment, awayteam.cpp:89-100). */
  equipment: string[];
  /** The bridge's contact lists: ship screen 1 (Comms) and 4 (the lounge), in `listScreenObjects` order. */
  contacts: { comms: { object: string; sprite: boolean; file?: string }[]; lounge: string[] };
  /**
   * The sprite the viewscreen shows for each animation an alter plays on the Enterprise, by its number, as its file (sprite.lst, lower case
   * without the extension): the original shows the Enterprise's anim_index as a sprite (unity.cpp:604-610). Absent in an older ship.yaml.
   */
  viewscreenSprites?: Record<number, string>;
}

/** What the ship modes read: the universe, the bridge and transporter data, and the computer. */
export interface ShipContent {
  universe: Universe;
  data: ShipData;
  computer: ComputerTree;
  /** combat.yaml (Plan 18): absent in an older lift. */
  combat?: CombatData;
}

/** A vector in the original's model space: x right, y down, z forward (space3d.h:38). */
export type Vec3 = [number, number, number];

/** The kind flags combat reads (combat.h:60-76). */
export const SHIP_FLAGS = {
  phasers: 0x200, torpedoes: 0x400, damageTextures: 0x800, debris: 0x1000, canCloak: 0x2000,
  tactics: 0x4000, reduced: 0x8000, blast: 0x80000, friendly: 0x08000000,
} as const;

/** A ship unit as combat reads it: the two fields ShipSystems::load reads besides ShipUnit's (ship.cpp:77-79). */
export interface CombatUnit extends ShipUnit { efficiency: number; hitWeight: number }

/** One kind of ship, `CombatData.kinds[type]`, type as combat.h's kCombatChodak (0) to kCombatMother (9). */
export interface CombatKind {
  /** kShipKinds (combat.cpp:35-49): an active object whose name's first ten letters are this is a ship of the kind. */
  name: ShipKind;
  /** kShipKinds' flags: SHIP_FLAGS. */
  flags: number;
  /** `_combatShips[type]` (data.cpp:827-836): the model and tactics files' name, top speed, and how far the detailed and reduced models are drawn. */
  base: string; maxSpeed: number; detailDistance: number; reducedDistance: number;
  /** Cue ids, -1 for none: Worf names it (combat.cpp:245), says it's destroyed (damage.cpp:607-609), the computer calls it as a target (ai.cpp:138). */
  contactCue: number; destroyedCue: number; targetCue: number;
  /** The scanners' class name, picture and radar colour (tactical.cpp:213-232). */
  className: string; scannerImage: number; radarColour: number;
  /** The files setupWeapons loads (weapons.cpp:101-152), raceFile resolved (weapons.cpp:92-99); null where the kind has no such weapon. Sprites are in the images export, sounds in the audio export. */
  effects: { phaserSprite: string | null; phaserSound: string | null; photonSprite: string | null; photonSound: string | null; shieldSprite: string };
  /** `<base>.bin` when flags has SHIP_FLAGS.tactics and the export has it (loadScript, tactics.cpp:157-173), else null. */
  tactics: string | null;
  /** Keys of CombatData.models (createShip, combat.cpp:291-300, 382-383; destroyShip's debris, damage.cpp:489-497); null where the kind has none or the export lacks it (Task 7 lists the latter as gaps). */
  models: { detail: string | null; reduced: string | null; damaged: string | null; debris: (string | null)[] };
}

/** A ship in a battle, as the space world's screen lists it (Combat::setup, combat.cpp:191-231). */
export interface CombatShipDef {
  object: string;
  /** Index into CombatData.kinds. */
  type: number;
  /** The object's x, y and z × 10, from the file (combat.cpp:305). A script may move it before the battle: the sim reads the object's state where it has one. */
  position: Vec3;
  /** `(int16)sprite_id`, the heading in degrees; null for 0xffff, which is heading 0 (combat.cpp:307-309). */
  heading: number | null;
  /** `y_adjust`: seconds before it decloaks, 0 for none (-1 or 0 in the file; combat.cpp:321-325). Below 2, Data's cue plays a second after the start. */
  decloak: number;
  /** `(byte)phaser_data.max_health`, 100 without phaser data (combat.cpp:347-354), before the difficulty halves or doubles it (combat.cpp:366-377). */
  strength: number;
  /** `(byte)threshold` squared / 100 (integer), 50 without phaser data (combat.cpp:349-352). */
  hullLow: number;
  /** The tactics file it runs: kTacticOverrides' (tactics.cpp:95-106), else its kind's; null for none, or when the export lacks the file. */
  tactics: string | null;
}

/** One battle: a space-world screen (scenario = screen number). Inactive ships are skipped when it starts, by the object's state. */
export interface CombatBattle {
  screen: string;
  enter: string | null; exit: string | null; warp: string | null;
  /** The screen lists one of battle 0x34's surprise objects: no contact cue for chodaks or probes (combat.cpp:197-199, 249-252). */
  quietContacts: boolean;
  ships: CombatShipDef[];
}

/** A model combat draws, built by the space build (Task 8) into `url`. */
export interface CombatModel {
  /** `space/<key>.glb`, relative to the game's directory (AssetIndex.spaceModel). */
  url: string;
  /** The geometry file (`.3dv`, `.3dr`, `.pcN`) and the materials file it is drawn with (null: generic debris takes the dying ship's). */
  geometry: string; materials: string | null;
  /** SpaceModel::_size and _centre (space3d.cpp:134-135): a ship's radius is the largest of size (combat.cpp:299-302); shields and booms scale by size's mean / 412.667 (weapons.cpp:132-136). */
  size: Vec3; centre: Vec3;
  parts: number;
  /**
   * Each part's vertex count, 0 for a part SpaceModel::load keeps without them (not triangles, space3d.cpp:152-156).
   * updateBeams moves the phaser model's first vertex only when its first part has one (weapons.cpp:378-379).
   * Absent from an older lift (combatDataProblems lists it).
   */
  vertices?: number[];
}

/** A tactics file (Plan 18 R5): the whole file as base64, with what TacticScript::load finds in it. */
export interface TacticsScript {
  file: string; size: number;
  /** The last page named KERNEL's first argument, or 0 (tactics.cpp:144-153). */
  kernel: number;
  /** Every page token of at least 0x18 bytes: its name and offset. */
  pages: { name: string; offset: number }[];
  code: string;
}

/** A crew cue (`_cues`): who says it, its file (null for none) and the ticks before it may play again. */
export interface CombatCue { speaker: number; file: string | null; gap: number }

/**
 * The crew cues ScummVM's combat plays by a literal id, each named for the line that plays it (another-unity Plan 23 R1).
 * combat.yaml's `cueIds` gives each its id, and `sources` its line (`kCueIds.<name>`). The cues ScummVM plays from a table
 * (kContactCues, kDestroyedCues, kTargetCues) are each kind's contactCue, destroyedCue and targetCue; the power level's
 * (`play(level)`, weapons.cpp:683) is the level itself.
 */
export const COMBAT_CUE_NAMES = [
  'decloak', 'handFlight',
  'unitPowerGrid', 'unitImpulse', 'unitComputer', 'unitSensor', 'unitTorpedo', 'unitWarp', 'unitShield', 'unitPhaser',
  'phaserHitOdd', 'phaserHitEven', 'shieldHolds', 'shieldHoldsUnshaken', 'torpedoStrikes', 'criticalShields', 'criticalShieldsOther',
  'criticalPhasers', 'systemsOffline', 'systemsOfflineAfter', 'systemsOfflineOther', 'reactorDown',
  'destroyed', 'destroyedLater1', 'destroyedLater2', 'destroyedLater3', 'destroyedLater4', 'debrisBoom',
  'phasersOutOfRange', 'phasersMissed', 'phasersFired', 'enemyFired', 'enemyTorpedoes', 'torpedoesUnloaded', 'torpedoesTooClose',
  'torpedoesAway', 'torpedoHit', 'torpedoLost', 'torpedoHoming', 'torpedoRetargeted', 'lockRefused', 'lockOn', 'shieldsLowered',
  'shieldsRaising', 'shieldsRaised', 'powerLevelFull', 'spreadNarrow', 'spreadWide', 'selfDestructArmed', 'selfDestructDisarmed',
  'selfDestruct15', 'selfDestruct10', 'selfDestruct5',
  'cloak', 'disengage', 'engage',
  'warpFailed', 'warpFailedAfter', 'warp', 'enemySelfDestruct', 'delegateOn', 'delegateOnAfter',
  'hailing', 'noAnswer', 'allStop',
] as const;
export type CombatCueName = (typeof COMBAT_CUE_NAMES)[number];

/**
 * The words TacticalScreen draws on the console itself, each named for what it says (another-unity Plan 27 R15): the units
 * after the status fields' power and speed (tactical.cpp:1051-1052), the scanner's name for an unknown ship (:1208), its
 * shield's power (a format, :1218), its range and heading labels and the separator between the closure and the speed (:1227, :1230, :1238;
 * the speed's unit is `lightspeed`). combat.yaml's `consoleText` gives each, and `sources` its line (`kConsoleText.<name>`).
 */
export const CONSOLE_TEXT_NAMES = ['megawatts', 'lightspeed', 'alien', 'power', 'kilometres', 'mark', 'colon'] as const;
export type ConsoleTextName = (typeof CONSOLE_TEXT_NAMES)[number];

/** combat.yaml: everything the combat sim reads (spec §3, Decision 7). */
export interface CombatData {
  kinds: CombatKind[];
  /** `_enemyShip`: the units every ship but the Enterprise starts with (data.cpp:825). The Enterprise's are ship.yaml's `units`. */
  enemyUnits: CombatUnit[];
  /** The flight model (data.cpp:838-846): turns as int32; speeds and turn scales as float32 values. */
  flight: { turns: number[]; speeds: number[]; turnScales: number[] };
  /** level0-4.dat: each Enterprise unit's power at the CONN page's levels (weapons.cpp:647-656). */
  powerLevels: number[][];
  /** The units a hit through each shield can reach, in order (damage.cpp:36-53), -1 trimmed. */
  hitLists: { enterprise: number[][]; other: number[][] };
  /** Where the phaser banks fire from, and the first phaser bank's and torpedo tube's units (weapons.cpp:51-58). */
  phasers: { enterprise: Vec3[]; other: Vec3[]; units: { enterprisePhaser: number; otherPhaser: number; enterpriseTube: number; otherTube: number } };
  /** The units each of the scanner's 11 areas shows (tactical.cpp:219-226), -1 trimmed. */
  scanner: { enterprise: number[][]; other: number[][] };
  /** kBearing (weapons.cpp:738-740): by the target's facing (0-7), the lamps that bear on it (banks 0-5, tubes 6-7), -1 for none. */
  bearing: number[][];
  /** kShieldNames (damage.cpp:55-58): the Enterprise's shields by facing, as its log names them. */
  shieldNames: string[];
  /** The crew cues combat plays by a literal id (COMBAT_CUE_NAMES; Plan 23 R1). */
  cueIds: Record<CombatCueName, number>;
  /** The console's own words (CONSOLE_TEXT_NAMES; Plan 27 R15). Absent in an older lift: the console draws without them. */
  consoleText?: Record<ConsoleTextName, string>;
  cues: CombatCue[];
  /** The effects' models (combat.cpp:183-186; setupWeapons, weapons.cpp:138-150; shields[i] is ship index i's) and the booms (combat.cpp:186-190). */
  effects: { phaser: string | null; photon: string | null; billboard: string | null; shields: (string | null)[]; genericDebris: (string | null)[]; booms: string[] };
  models: Record<string, CombatModel>;
  tactics: Record<string, TacticsScript>;
  /** By scenario: the space world's screen number. */
  battles: Record<number, CombatBattle>;
  /** The media combat plays and shows, for the audio and images lifts and M8. */
  media: { music: string; pictures: string[]; sprites: string[]; sounds: string[] };
  /**
   * The frames each effect sprite has, as SpaceResources::animation counts them (space3d.cpp:482-517): its sprite
   * entries, at most kMaxAnimationFrames (23, space3d.h:182). A sprite with none, or missing, is left out (a null
   * animation). The booms and each kind's phaser, photon and shield sprites. Absent in an older lift.
   */
  animations?: Record<string, number>;
  /**
   * Each kind's damage materials (`<base>.dmg`, createShip, combat.cpp:380-382), by file: one entry per material,
   * true where it loads a texture (SpaceResources::materials, space3d.cpp:556-561). damageTexture rolls over their
   * number and keeps only textured ones (damage.cpp:172-183). Absent in an older lift.
   */
  damageMaterials?: Record<string, boolean[]>;
  /** Each constant ScummVM hard-codes, by its C++ name: the lines it comes from (Plan 18 R1). */
  sources: Record<string, string>;
  /**
   * ScummVM's sinf and cosf of each whole angle, 16384 to a turn (the export's trig.json: space3d.cpp's
   * angleToRadians, then the C library's sinf and cosf), each 16384 float32 values, little-endian, in base64. The sim
   * reads them in place of Math's (Plan 22's R1). Absent in an older lift: the sim then uses Math's, rounded.
   */
  trig?: { sin: string; cos: string };
}

