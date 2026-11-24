// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';

export interface BuildEnv {
  RAW_DIR?: string;
  AUDIO_DIR?: string;
  IMAGES_DIR?: string;
  MOVIES_DIR?: string;
  GAME_DIR?: string;
}

export interface BuildDirs {
  raw: string;
  audio: string | null;
  images: string | null;
  movies: string | null;
  game: string;
}

/** Runs a command; resolves with its exit code. */
export type Exec = (argv: string[]) => Promise<number>;

/**
 * RAW_DIR is Plan 3's export (…/runs/export/raw). The media exports default to its siblings under …/runs
 * (audio/media, images/media, movies/media, as Plan 3's harness writes them), and are left out if absent.
 */
export function buildDirs(env: BuildEnv, exists: (path: string) => boolean = existsSync): BuildDirs | string {
  if (!env.RAW_DIR) return 'set RAW_DIR to Plan 3\'s export, such as RAW_DIR=$HOME/pcode/unity-raw/runs/export/raw (docs/unity-local.md)';
  const raw = resolve(env.RAW_DIR);
  if (!exists(join(raw, 'manifest.json'))) return `${raw} has no manifest.json: is it Plan 3's export?`;
  const runs = dirname(dirname(raw));
  const pick = (value: string | undefined, sibling: string): string | null => {
    const dir = resolve(value ?? join(runs, sibling));
    return exists(dir) ? dir : null;
  };
  return {
    raw,
    audio: pick(env.AUDIO_DIR, 'audio/media'),
    images: pick(env.IMAGES_DIR, 'images/media'),
    movies: pick(env.MOVIES_DIR, 'movies/media'),
    game: resolve(env.GAME_DIR ?? 'games/unity'),
  };
}

async function yamlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter(e => e.isFile() && e.name.endsWith('.yaml'))
    .map(e => join(e.parentPath, e.name))
    .sort();
}

function escape(stem: string): string {
  return stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * What the lifted game plays as music, the original's playMusic files: each music and ambience loop, beam-down piece,
 * ship station's loop and loop swapped in for an inactive object (presentation.yaml), and space combat's music
 * (combat.yaml). The transcode sends these to audio/music; every other sound stays an effect, stereo or not.
 */
export async function musicAudio(gameDir: string): Promise<RegExp> {
  const stems = new Set<string>();
  const presentation = (parse(await readFile(join(gameDir, 'presentation.yaml'), 'utf8')) ?? {}) as {
    music?: Record<string, unknown>; ambience?: Record<string, unknown>; intro?: Record<string, unknown>;
    musicWhenInactive?: Record<string, unknown>; shipMusic?: Record<string, unknown>;
  };
  // (YAML reads an unquoted stem of digits as a number: take it as its text; anything else isn't a name)
  const addStem = (stem: unknown): void => {
    if ((typeof stem === 'string' && stem !== '') || (typeof stem === 'number' && Number.isFinite(stem))) stems.add(String(stem));
  };
  for (const named of [presentation.music ?? {}, presentation.ambience ?? {}, presentation.shipMusic ?? {}]) for (const stem of Object.values(named)) addStem(stem);
  for (const pieces of Object.values(presentation.intro ?? {})) if (Array.isArray(pieces)) pieces.forEach(addStem);
  for (const swap of Object.values(presentation.musicWhenInactive ?? {})) {
    if (swap !== null && typeof swap === 'object') addStem((swap as { music?: unknown }).music);
  }
  if (existsSync(join(gameDir, 'combat.yaml'))) {
    const combat = (parse(await readFile(join(gameDir, 'combat.yaml'), 'utf8')) ?? {}) as { media?: { music?: unknown } };
    const music = combat.media?.music;
    if (typeof music === 'string' && music !== '') stems.add(music.toLowerCase().replace(/\.[^.]*$/, ''));
  }
  const alternatives = [...stems].sort().map(escape);
  return new RegExp(`^(?:${alternatives.join('|')})\\.rac$`);
}

/**
 * The sounds the lifted game can play (Plan 6 Decision 13): each voice key in voices.yaml, whose '@' is
 * any speaker's byte (Plan 4 Decision 9); each play.sound stem; each music and ambience loop and beam-down
 * piece; and the engine's own sounds (presentation.yaml `sounds`, which the lifter writes from ENGINE_SOUNDS).
 */
export async function wantedAudio(gameDir: string): Promise<RegExp> {
  const stems = new Set<string>();
  const voices = (parse(await readFile(join(gameDir, 'voices.yaml'), 'utf8')) ?? {}) as { lines?: Record<string, string> };
  for (const key of Object.keys(voices.lines ?? {})) stems.add(key);
  const presentation = (parse(await readFile(join(gameDir, 'presentation.yaml'), 'utf8')) ?? {}) as {
    music?: Record<string, unknown>; ambience?: Record<string, unknown>; intro?: Record<string, unknown>; sounds?: Record<string, unknown>;
    musicWhenInactive?: Record<string, unknown>; shipSounds?: Record<string, unknown>; shipMusic?: Record<string, unknown>;
  };
  // (YAML reads an unquoted stem of digits as a number: take it as its text; anything else isn't a name)
  const addStem = (stem: unknown): void => {
    if ((typeof stem === 'string' && stem !== '') || (typeof stem === 'number' && Number.isFinite(stem))) stems.add(String(stem));
  };
  for (const named of [presentation.music ?? {}, presentation.ambience ?? {}, presentation.sounds ?? {}, presentation.shipSounds ?? {}, presentation.shipMusic ?? {}]) for (const stem of Object.values(named)) addStem(stem);
  for (const pieces of Object.values(presentation.intro ?? {})) if (Array.isArray(pieces)) pieces.forEach(addStem);
  for (const swap of Object.values(presentation.musicWhenInactive ?? {})) {
    if (swap !== null && typeof swap === 'object') addStem((swap as { music?: unknown }).music);
  }
  // (the computer's voice as each crew member is put on a pad, transporter.cpp:761: fe09 and the voice as four hex digits)
  if (existsSync(join(gameDir, 'ship.yaml'))) {
    const ship = (parse(await readFile(join(gameDir, 'ship.yaml'), 'utf8')) ?? {}) as { crew?: { voices?: unknown[] } };
    for (const v of ship.crew?.voices ?? []) if (typeof v === 'number' && Number.isInteger(v) && v >= 0) stems.add(`fe09${v.toString(16).padStart(4, '0')}`);
  }
  // (space combat's music, sounds and the crew's cues: combat.yaml, Plan 18)
  if (existsSync(join(gameDir, 'combat.yaml'))) {
    const combat = (parse(await readFile(join(gameDir, 'combat.yaml'), 'utf8')) ?? {}) as {
      media?: { music?: unknown; sounds?: unknown[] }; cues?: { file?: unknown }[];
    };
    for (const file of [combat.media?.music, ...(combat.media?.sounds ?? []), ...(combat.cues ?? []).map(q => q?.file)]) {
      if (typeof file === 'string' && file !== '') stems.add(file.toLowerCase().replace(/\.[^.]*$/, ''));
    }
  }
  for (const dir of ['objects', 'conversations', 'screens']) {
    if (!existsSync(join(gameDir, dir))) continue;
    for (const file of await yamlFiles(join(gameDir, dir))) {
      for (const m of (await readFile(file, 'utf8')).matchAll(/\bsound:\s*['"]?([A-Za-z0-9_.-]+)/g)) stems.add(m[1]);
    }
  }
  const alternatives = [...stems].sort().map(s => escape(s).replace('@', '[0-9a-f]{2}'));
  return new RegExp(`^(?:${alternatives.join('|')})\\.(?:vac|rac|mac)$`);
}

/** The movies the lifted game can play: each world's arrival movie, the opening and warp movies, and every play.movie stem (M3 Decision 10). */
export async function wantedMovies(gameDir: string): Promise<string[]> {
  const stems = new Set<string>();
  const presentation = (parse(await readFile(join(gameDir, 'presentation.yaml'), 'utf8')) ?? {}) as {
    arrival?: Record<string, unknown>; opening?: unknown[]; warpMovies?: unknown[];
  };
  // (the opening and the warp movies, which the ship plays by number: Plan 12)
  for (const stem of [...Object.values(presentation.arrival ?? {}), ...(presentation.opening ?? []), ...(presentation.warpMovies ?? [])]) {
    if (typeof stem === 'string' && stem !== '') stems.add(stem.toLowerCase());
  }
  for (const dir of ['objects', 'conversations']) {
    if (!existsSync(join(gameDir, dir))) continue;
    for (const file of await yamlFiles(join(gameDir, dir))) {
      for (const m of (await readFile(file, 'utf8')).matchAll(/\bmovie:\s*['"]?([A-Za-z0-9_.-]+)/g)) stems.add(m[1].toLowerCase());
    }
  }
  return [...stems].sort();
}

const TSX = ['npx', 'tsx'];

/** Lifts every away world, transcodes the audio it names, and builds its greybox rooms (docs/unity-local.md). */
export async function unityBuild(env: BuildEnv, exec: Exec, log: (line: string) => void, exists?: (path: string) => boolean): Promise<number> {
  const has = exists ?? existsSync;
  const dirs = buildDirs(env, exists);
  if (typeof dirs === 'string') {
    log(`unity:build: ${dirs}`);
    return 2;
  }
  const step = async (argv: string[]): Promise<boolean> => {
    log(`unity:build: ${argv.join(' ')}`);
    return (await exec(argv)) === 0;
  };

  const lift = [...TSX, 'tools/lift/src/cli.ts', '--raw', dirs.raw, '--world', 'all-away', '--out', dirs.game];
  if (dirs.images) lift.push('--images', dirs.images);
  if (dirs.audio) lift.push('--audio', dirs.audio);
  if (!(await step(lift))) return 1;

  // (without ffmpeg the rooms are still worth building; the build fails at the end, as the game would play silent)
  let noFfmpeg = false;
  if (!dirs.audio) {
    log('unity:build: no audio export (set AUDIO_DIR, or make …/runs/audio/media with Plan 3\'s export_audio): the game plays silent');
  } else if ((await exec(['ffmpeg', '-version'])) !== 0) {
    log('unity:build: ffmpeg isn\'t installed (brew install ffmpeg): skipping the audio transcode');
    noFfmpeg = true;
  } else {
    const media = [...TSX, 'tools/media/src/cli.ts', '--audio', dirs.audio];
    if (dirs.movies) media.push('--movies', dirs.movies);
    media.push('--out', dirs.game, '--filter', (await wantedAudio(dirs.game)).source, '--music', (await musicAudio(dirs.game)).source);
    if (!(await step(media))) return 1;
  }

  // (a movie the game names but the export lacks plays as a placeholder: worth saying, not worth failing)
  const absent = (await wantedMovies(dirs.game)).filter(stem => !has(join(dirs.game, 'movies', `${stem}.webm`)));
  if (absent.length > 0) {
    const n = absent.length === 1 ? '1 movie the game names has' : `${absent.length} movies the game names have`;
    log(`unity:build: ${n} no WebM (${absent.join(', ')}): export it with sh tools/rawcheck/run-harness.sh movies 1800, then build again`);
  }

  const greybox = [...TSX, 'tools/greybox/src/cli.ts', '--rooms', join(dirs.game, 'rooms')];
  if (dirs.images) greybox.push('--images', dirs.images);
  greybox.push('--out', join(dirs.game, 'models', 'rooms'));
  if (!(await step(greybox))) return 1;
  // (space combat's models and stills, from combat.yaml and the export's verbatim files: Plan 18; its sprites, from the images export: Plan 24)
  if (has(join(dirs.game, 'combat.yaml'))) {
    const space = [...TSX, 'tools/space/src/cli.ts', '--raw', dirs.raw, '--game', dirs.game];
    if (dirs.images) space.push('--images', dirs.images);
    if (!(await step(space))) return 1;
  }

  if (noFfmpeg) {
    log('unity:build: built without audio, as ffmpeg isn\'t installed (brew install ffmpeg)');
    return 1;
  }
  log('unity:build: done');
  return 0;
}
