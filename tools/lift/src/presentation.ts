// SPDX-License-Identifier: GPL-3.0-or-later
import { screenKey, screenSlug, worldSlug } from './ids';
import type { Problems } from './problems';
import { round3 } from './projection';

/** A loop as Sound::updateMusic plays it: playMusic(file, volume, loopPos) (sound.cpp:154-165). */
export interface Loop {
  stem: string;
  /** 0-0xff, as ScummVM's mixer takes it. */
  volume: number;
  /** Where it loops back to, in bytes of IMA ADPCM. */
  loop: number;
}

export interface WorldRow {
  /** The loop for any screen not listed (the switch's `default:`). */
  music: Loop;
  /** By screen number. */
  screens?: Record<number, Loop>;
  /** By screen number: while the object (an original id) is inactive, `music` loops instead. */
  inactive?: Record<number, { object: string; music: Loop }>;
  arrival?: string;
  source: string;
}

const loop = (stem: string, volume: number, at: number): Loop => ({ stem, volume, loop: at });
/** Two 4-bit samples a byte: one stereo frame (Unity_ADPCMStream::readBuffer, sound.cpp:53-93), at 22050 Hz (sound.cpp:160). */
const FRAMES_PER_SECOND = 22050;
/** Audio::Mixer::kMaxChannelVolume: playMusic's volume byte is a mixer volume (sound.cpp:165), so a loop's gain is that over 255. */
const FULL_VOLUME = 255;

/**
 * What each world plays that the original hard-codes rather than keeps in its data: each screen's music
 * loop (Sound::updateMusic) and the movie of arriving in orbit. Keyed by world slug; stems name
 * audio/music/<stem>.ogg and movies/<stem>.webm. Check each citation's lines against sound.cpp when editing.
 */
export const WORLD_PRESENTATION: Record<string, WorldRow> = {
  allanor: {
    music: loop('adamb11', 0x19, 0xab40),
    screens: {
      1: loop('adamb01', 0x1f, 0xab40), 2: loop('adamb01', 0x1f, 0xab40), 3: loop('adamb03', 0x19, 0xae80),
      4: loop('adamb04', 0x1f, 0xcbc0), 5: loop('adamb04', 0x1f, 0xcbc0), 6: loop('adamb04', 0x1f, 0xcbc0), 7: loop('adamb04', 0x1f, 0xcbc0),
      8: loop('adamb08', 0x19, 0xa1c0), 9: loop('adamb08', 0x19, 0xa1c0), 10: loop('adamb08', 0x19, 0xa1c0), 12: loop('adamb08', 0x19, 0xa1c0),
    },
    arrival: 'admarriv',
    source: 'music: engines/unity/sound.cpp:244-270 (Sound::updateMusic, world 2); arrival: movie 50, which the ship script o_5f0320 plays',
  },
  zoo: {
    music: loop('zoobirds', 0x30, 0x1b1ee),
    screens: {
      3: loop('zootree', 0x30, 0x548e), 10: loop('zootree', 0x30, 0x548e), 4: loop('zoolab', 0x30, 0x5b9c), 6: loop('zoodesrt', 0x30, 0x8b82),
      7: loop('zooswamp', 0x30, 0x5c08), 8: loop('zoosulfr', 0x30, 0x419c), 16: loop('powersta', 0x30, 0xad80),
    },
    arrival: 'zooarriv',
    source: 'music: engines/unity/sound.cpp:272-298 (Sound::updateMusic, world 3); arrival: movie 45, which the ship script o_5f0333 plays (a proximity trigger\'s target)',
  },
  lab: {
    music: loop('lbctrfar', 0x3f, 0x4e9c),
    screens: {
      2: loop('lbbigfar', 0x3f, 0x3160), 3: loop('lbbigfar', 0x3f, 0x3160), 4: loop('lbbigfar', 0x3f, 0x3160),
      6: loop('probroom', 0x3f, 0x5a00), 10: loop('lbctnear', 0x3f, 0x4896), 11: loop('lbctnear', 0x3f, 0x4896),
    },
    inactive: { 6: { object: '040603', music: loop('lbbignr', 0x3f, 0x4ebc) } },
    arrival: 'labarriv',
    source: 'music: engines/unity/sound.cpp:300-323 (Sound::updateMusic, world 4; s06 checks objectID(4, 6, 3)\'s OBJFLAG_ACTIVE); arrival: movie 44, which the ship script o_5f034c plays',
  },
  frigis: {
    music: loop('s5amb08', 0x1f, 0x13388),
    screens: {
      1: loop('s5amb01', 0x1f, 0xa7c0), 2: loop('s5amb01', 0x1f, 0xa7c0), 3: loop('s5amb03', 0x1f, 0xeb80), 4: loop('s5amb04', 0x1f, 0xb778),
      5: loop('s5amb05', 0x1f, 0x9a00), 6: loop('s5amb06', 0x1f, 0xb0c0), 7: loop('s5amb07', 0x1f, 0xb980),
    },
    arrival: '5tharriv',
    source: 'music: engines/unity/sound.cpp:325-351 (Sound::updateMusic, world 5); arrival: movie 46, which the ship script o_5f0351 plays',
  },
  unity: {
    // (the default is Horst III's loop)
    music: loop('h3amb01', 0x2f, 0x162b0),
    screens: {
      1: loop('udamb01', 0x1f, 0x4c00), 2: loop('udamb02', 0x1f, 0x6c32), 6: loop('udamb06', 0x1f, 0x7a40),
      9: loop('udamb09', 0x1f, 0x62c0), 12: loop('udamb12', 0x1f, 0x5c80),
    },
    arrival: 'udarriv1',
    source: 'music: engines/unity/sound.cpp:353-376 (Sound::updateMusic, world 6); arrival: movie 20, which the ship script o_5f0366 plays (Plan 7 Task 7 Step 1)',
  },
  // (every Horst III screen plays the same loop)
  horst3: {
    music: loop('h3amb01', 0x2f, 0x162b0),
    arrival: 'ho3arriv',
    source: 'music: engines/unity/sound.cpp:379-381 (Sound::updateMusic, world 7); arrival: movie 55, which the ship script o_5f0376 plays on arriving in orbit',
  },
};

/** The engine's own sounds, by what they mark. */
export type EngineSoundName = 'combadge' | 'tricorderChirp' | 'phaserCrew' | 'phaserOther' | 'beamIn' | 'beamOut' | 'beamChodak';

/**
 * The sounds the original's executable plays by name rather than from its data, for every world. Keyed by
 * what they mark, as presentation.yaml's `sounds` names them; stems name audio/sfx/<stem>.ogg. (softbop.mac, which
 * the panel's inventory arrows play at awayteam.cpp:816 and 821, isn't here: the browser's inventory has no arrows.)
 */
export const ENGINE_SOUNDS: Record<EngineSoundName, { stem: string; source: string }> = {
  combadge: { stem: 'combadge', source: 'engines/unity/awayteam.cpp:824-825 (a click on the combadge)' },
  tricorderChirp: {
    stem: 'tricordr',
    source: 'engines/unity/object.cpp:1277-1279 (a condition passes with the tricorder as the other object)',
  },
  phaserCrew: { stem: 'hphaser', source: 'engines/unity/awayteam.cpp:1178 (phaserShot: a crew member fires the hand phaser)' },
  phaserOther: { stem: 'c_phaser', source: 'engines/unity/awayteam.cpp:1183 (phaserShot: anyone else fires)' },
  beamIn: { stem: 'beamin', source: 'engines/unity/awayteam.cpp:1106 (beamEffect: the Federation transporter, beaming in)' },
  beamOut: { stem: 'beamout', source: 'engines/unity/awayteam.cpp:1106 (beamEffect: the Federation transporter, beaming out)' },
  beamChodak: { stem: 'acid', source: 'engines/unity/awayteam.cpp:1106 (beamEffect: the Chodak transporter, either way)' },
};

/**
 * The sounds the ship's own screens make by name (the engine's SHIP_CUES and click cues), for presentation.yaml's `shipSounds`: the stem of the
 * file (audio/sfx, music or voice) and where in the original it plays. The holodeck's and the computer's are cues the sim sends.
 */
export const SHIP_SOUNDS: Record<string, { stem: string; source: string }> = {
  holodeckDoor: { stem: 'holodoor', source: 'engines/unity/unity.cpp:394 and 424 (runHolodeck: the door, going in and out)' },
  holodeckOn: { stem: 'holoon', source: 'engines/unity/unity.cpp:397 (runHolodeck: the projector comes on)' },
  holodeckPick: { stem: 'baknwlgd', source: 'engines/unity/unity.cpp:417 (runHolodeck: a movie is chosen)' },
  holodeckOff: { stem: 'holooff', source: 'engines/unity/unity.cpp:421 (runHolodeck: the movie is over)' },
  computerOffline: { stem: 'fe090098', source: 'engines/unity/unity.cpp:382 (runHolodeck: the computer is below 80 percent) and computer.cpp:313 (it is at 0)' },
  computerOnline: { stem: 'fe090081', source: 'engines/unity/computer.cpp:307 (the screen opens with the computer above 0)' },
  computerFull: { stem: 'fe090082', source: 'engines/unity/computer.cpp:311 (the screen opens with the computer at 100)' },
  computerPartial: { stem: 'fe0900aa', source: 'engines/unity/computer.cpp:315 (the screen opens with the computer between 1 and 99)' },
  // (the buttons: beep7 is the console's click, softbop its scrolls and the sensor arrows)
  shipBeep: { stem: 'beep7', source: 'engines/unity/bridge.cpp:303, 333, 419, 435; computer.cpp:424-438; astrogation.cpp:1643, 1695, 1706, 1843, 1974-1989 (a console button)' },
  shipSoftbop: { stem: 'softbop', source: 'engines/unity/bridge.cpp:317, 324; computer.cpp:401-419 (a list or text scrolls)' },
  doorOpen: { stem: 'dooropen', source: 'engines/unity/bridge.cpp:387, 401 (the lounge or turbolift door opens); transporter.cpp:300' },
  doorClose: { stem: 'doorclos', source: 'engines/unity/bridge.cpp:396, 413 (the door closes again); transporter.cpp:309' },
  tacticalAlert: { stem: 'tactical', source: 'engines/unity/bridge.cpp:429 (the tactical station)' },
  advice: { stem: 'advice', source: 'engines/unity/bridge.cpp:440 (replay conversation)' },
  computerSelect: { stem: 'level2', source: 'engines/unity/computer.cpp:368 (a row of the list is clicked)' },
  delegateTakeOver: { stem: 'fe00029d', source: 'engines/unity/engineering.cpp:187 (Delegate: "Mr La Forge, take over")' },
  delegateAye: { stem: 'fe0602c7', source: 'engines/unity/engineering.cpp:197 (La Forge answers Picard once he has finished)' },
  transporterConfirm: { stem: 'trnscnfm', source: 'engines/unity/transporter.cpp:563 (Energize)' },
  transporterScan: { stem: 'scann', source: 'engines/unity/transporter.cpp:249 (showMap: the console starts scanning)' },
  transporterNoTarget: { stem: 'fe0900b0', source: 'engines/unity/transporter.cpp:259 (showMap with no target: the computer says so)' },
  transporterLocked: { stem: 'fe0900b3', source: 'engines/unity/transporter.cpp:302 (updateLock: the scan has found the target)' },
  // (the admin console, Plan 32: not in ScummVM's engine; the executable's adminmnu.cpp, as phase4_rest.md §6.2 gives it. beep7 and softbop are shipBeep and shipSoftbop)
  adminOpen: { stem: 'rgcd', source: 'main/adminmnu.cpp (phase4_rest.md §6.2: rgcd.mac plays as the admin menu opens)' },
  adminLevel: { stem: 'beep14', source: 'main/adminmnu.cpp (phase4_rest.md §6.2: beep14.mac at the new level, as a sound bar is clicked)' },
};

/**
 * What each ship station loops (the station's start: bridge.cpp:167, transporter.cpp:211, astrogation.cpp:1091, computer.cpp:318 once the computer
 * has spoken, tactical.cpp:287, engineering.cpp:143), by station, for presentation.yaml's `shipMusic`. The volume and loop point are playMusic's.
 */
export const SHIP_MUSIC: Record<string, Loop & { source: string }> = {
  bridge: { ...loop('bridgamb', 0x3f, 0), source: 'engines/unity/bridge.cpp:167' },
  transporter: { ...loop('bridgamb', 0x3f, 0), source: 'engines/unity/transporter.cpp:211' },
  astrogation: { ...loop('astro', 0x5f, 0x1b140), source: 'engines/unity/astrogation.cpp:1091' },
  computer: { ...loop('compute', 0x3f, 0x19740), source: 'engines/unity/computer.cpp:318' },
  tactical: { ...loop('enterpri', 0x3f, 0), source: 'engines/unity/tactical.cpp:287' },
  engineering: { ...loop('engamb', 0x3f, 0), source: 'engines/unity/engineering.cpp:143' },
};

/** presentation.yaml: Plan 5's PresentationConfig, plus the beam-down pieces, the arrival movie (Task 12) and the engine's own sounds. */
export interface PresentationFile {
  music: Record<string, string>;
  ambience: Record<string, string>;
  intro: Record<string, string[]>;
  arrival: Record<string, string>;
  sounds: Record<EngineSoundName, string>;
  /** Each loop's gain (its volume over the beam-down pieces' 0x3f) and the second it loops back to. */
  loops: Record<string, { gain: number; loopStart: number }>;
  /** A screen whose loop depends on an object: while it is inactive, `music` loops instead. */
  musicWhenInactive: Record<string, { object: string; music: string }>;
  /** The ship screens' own sounds by name (SHIP_SOUNDS): stems. */
  shipSounds: Record<string, string>;
  /** Each ship station's loop, by station (SHIP_MUSIC): the stem, whose gain and loop point are in `loops`. */
  shipMusic: Record<string, string>;
  /** The opening movies' stems: kMovieTeaser (0), then kMovieTitle (4). Absent when the movie map lacks either. */
  opening?: string[];
  /** `_warpMovies` by index (they play from 1, astrogation.cpp playWarpMovie): the stem, or null where the movie map has no such file. */
  warpMovies?: (string | null)[];
  /** movie.map's films in its order with their descriptions: the holodeck's list of what has been seen (UnityEngine::runHolodeck). */
  movieMap?: { stem: string; title: string }[];
}

/** The movie ids the original names (unity.h kMovie*). */
export const MOVIE_TEASER = 0;
export const MOVIE_TITLE = 4;

const stemOf = (filename: string) => filename.replace(/\.[^.]*$/, '').toLowerCase();

/**
 * The movies the original plays by number or by name: the opening (the teaser, then the title: `run`, unity.cpp:1700-1780) and the warp
 * movies (`_warpMovies`, which name movie.map's files; R11). Index 0 of `_warpMovies` is not a movie (they play from 1), so it is null without a warning.
 */
export function liftMovies(
  movies: readonly { id: number; filename: string; description?: string }[], warpMovies: readonly string[], problems: Problems,
): Pick<PresentationFile, 'opening' | 'warpMovies' | 'movieMap'> {
  const byId = new Map(movies.map(m => [m.id, stemOf(m.filename)]));
  const byName = new Map(movies.map(m => [m.filename.toLowerCase(), stemOf(m.filename)]));
  const opening = [MOVIE_TEASER, MOVIE_TITLE].map(id => byId.get(id));
  for (const [i, id] of [MOVIE_TEASER, MOVIE_TITLE].entries()) {
    if (opening[i] === undefined) problems.warn('maps.movie', `no movie ${id} (${i === 0 ? 'the teaser' : 'the title'}): the opening is not lifted`);
  }
  const warp = warpMovies.map((name, i) => {
    if (i === 0) return null;
    const stem = byName.get(name.toLowerCase());
    if (stem === undefined) problems.warn(`executable._warpMovies[${i}]`, `${JSON.stringify(name)} is not a file of movie.map: this warp movie plays nothing`);
    return stem ?? null;
  });
  // (what the holodeck lists once they are seen, in movie.map's order: _movieOrder, data.cpp:513; the comment is the choice's text)
  const movieMap = movies.map(m => ({ stem: stemOf(m.filename), title: m.description ?? stemOf(m.filename) }));
  return { ...(opening.every(o => o !== undefined) ? { opening: opening as string[] } : {}), warpMovies: warp, movieMap };
}

const NOTHING_LIFTED = { screens: new Set<string>(), objectSlug: (): string | undefined => undefined };

/**
 * Each lifted world's presentation. The beam-down pieces come from the executable's
 * _backgroundSoundDefaults: world w's entry is w - 1, its formatString filled with first..last
 * (Sound::playIntroMusic, sound.cpp:225-236). A screen's own loop is kept only if the screen was lifted.
 */
export function presentationFor(
  worlds: number[],
  defaults: readonly { formatString: string; first: number; last: number }[],
  lifted: { screens: ReadonlySet<string>; objectSlug: (id: string) => string | undefined } = NOTHING_LIFTED,
): PresentationFile {
  const sounds = Object.fromEntries(Object.entries(ENGINE_SOUNDS).map(([name, { stem }]) => [name, stem])) as Record<EngineSoundName, string>;
  const shipSounds = Object.fromEntries(Object.entries(SHIP_SOUNDS).map(([name, { stem }]) => [name, stem]));
  const out: PresentationFile = { music: {}, ambience: {}, intro: {}, arrival: {}, sounds, shipSounds, shipMusic: {}, loops: {}, musicWhenInactive: {} };
  const use = (l: Loop): string => {
    out.loops[l.stem] = { gain: round3(l.volume / FULL_VOLUME), loopStart: round3(l.loop / FRAMES_PER_SECOND) };
    return l.stem;
  };
  for (const [station, l] of Object.entries(SHIP_MUSIC)) out.shipMusic[station] = use(l);
  for (const n of [...worlds].sort((a, b) => a - b)) {
    const slug = worldSlug(n);
    const row = WORLD_PRESENTATION[slug];
    if (row) {
      out.music[slug] = use(row.music);
      for (const [screen, l] of Object.entries(row.screens ?? {})) {
        if (lifted.screens.has(screenKey(n, Number(screen)))) out.music[screenSlug(n, Number(screen))] = use(l);
      }
      for (const [screen, swap] of Object.entries(row.inactive ?? {})) {
        const object = lifted.objectSlug(swap.object);
        if (object && lifted.screens.has(screenKey(n, Number(screen)))) out.musicWhenInactive[screenSlug(n, Number(screen))] = { object, music: use(swap.music) };
      }
      if (row.arrival) out.arrival[slug] = row.arrival;
    }
    const entry = defaults[n - 1];
    if (!entry) continue;
    const { formatString, first, last } = entry;
    if (formatString === '' || last < first) continue;
    out.intro[slug] = Array.from({ length: last - first + 1 }, (_, i) =>
      formatString.replace('%02d', String(first + i).padStart(2, '0')).replace(/\.[a-z]+$/i, ''));
  }
  return out;
}
