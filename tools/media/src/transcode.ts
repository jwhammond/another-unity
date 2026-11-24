// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

export interface AudioFile {
  name: string;
  /** Relative to the audio export's directory. */
  wav: string;
  channels: number;
  rate: number;
  frames: number;
}

export interface MovieInfo {
  /** The movie's export directory (movies/<id>). */
  dir: string;
  /** The original FVF file. */
  file: string;
  frameRate: [number, number];
}

export interface Job {
  kind: 'voice' | 'sfx' | 'music' | 'movie';
  /** The files whose changes make the output stale. */
  inputs: string[];
  output: string;
  /** ffmpeg's arguments; the last is the output. */
  argv: string[];
}

export interface JobFailure {
  output: string;
  error: string;
}

const QUIET = ['-hide_banner', '-loglevel', 'error', '-y'];
/** A file's lowercase name without its directory or extension; a name that isn't plain letters, digits, `_`, `.` and `-` is an error. */
function stem(name: string): string {
  const base = basename(name);
  if (!/^[\w.-]+$/.test(base)) throw new Error(`not a plain file name: ${JSON.stringify(name)}`);
  return base.toLowerCase().replace(/\.[^.]*$/, '');
}

/**
 * Voice to mono Opus, the engine's stereo music and ambience to stereo Opus in an Ogg file (`.ogg`: Homebrew's
 * ffmpeg 9 has no libvorbis, and its own `vorbis` encoder is experimental), every other sound to Opus. `music`
 * names what the game plays as music; without it, a stereo sound is taken for music. (Every .rac file is stereo,
 * effects too, so the build passes it: a stereo effect stays an effect.)
 */
export function audioJobs(files: AudioFile[], audioDir: string, outDir: string, filter?: RegExp, music?: RegExp): Job[] {
  return files.filter(f => !filter || filter.test(f.name)).map(f => {
    const input = join(audioDir, f.wav);
    const name = stem(f.name);
    if (f.name.toLowerCase().endsWith('.vac')) {
      const output = join(outDir, 'audio/voice', `${name}.opus`);
      return { kind: 'voice', inputs: [input], output, argv: [...QUIET, '-i', input, '-c:a', 'libopus', '-b:a', '32k', '-ac', '1', '-application', 'voip', output] };
    }
    if (music ? music.test(f.name) : f.channels === 2) {
      const output = join(outDir, 'audio/music', `${name}.ogg`);
      return { kind: 'music', inputs: [input], output, argv: [...QUIET, '-i', input, '-c:a', 'libopus', '-b:a', '96k', output] };
    }
    const output = join(outDir, 'audio/sfx', `${name}.opus`);
    return { kind: 'sfx', inputs: [input], output, argv: [...QUIET, '-i', input, '-c:a', 'libopus', '-b:a', '48k', output] };
  });
}

/** Each exported movie's PNG frames and WAV as one WebM (VP9 and Opus). */
export function movieJobs(movies: MovieInfo[], outDir: string): Job[] {
  return movies.map(m => {
    const output = join(outDir, 'movies', `${stem(m.file)}.webm`);
    const audio = join(m.dir, 'audio.wav');
    return {
      kind: 'movie',
      inputs: [join(m.dir, 'movie.json'), audio],
      output,
      argv: [
        ...QUIET, '-framerate', `${m.frameRate[0]}/${m.frameRate[1]}`, '-i', join(m.dir, 'frames/%05d.png'), '-i', audio,
        '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '32', '-pix_fmt', 'yuv420p', '-c:a', 'libopus', '-b:a', '64k', '-shortest', output,
      ],
    };
  });
}

/** The job as a line a POSIX shell runs. */
export function shellLine(job: Job): string {
  const quote = (a: string) => (/^[\w./:%=+,@-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);
  return ['ffmpeg', ...job.argv].map(quote).join(' ');
}

export async function readAudioManifest(audioDir: string): Promise<AudioFile[]> {
  const manifest = JSON.parse(await readFile(join(audioDir, 'audio/manifest.json'), 'utf8')) as { files: AudioFile[] };
  return manifest.files;
}

export async function readMovies(moviesDir: string): Promise<MovieInfo[]> {
  // only the numbered movie directories (anything else, such as a stray file, is not a movie)
  const ids = (await readdir(join(moviesDir, 'movies'))).filter(id => /^\d+$/.test(id)).sort((a, b) => Number(a) - Number(b));
  const out: MovieInfo[] = [];
  for (const id of ids) {
    const dir = join(moviesDir, 'movies', id);
    const movie = JSON.parse(await readFile(join(dir, 'movie.json'), 'utf8')) as { file: string; frameRate: [number, number] };
    out.push({ dir, file: movie.file, frameRate: movie.frameRate });
  }
  return out;
}

const mtime = async (path: string) => (await stat(path).catch(() => undefined))?.mtimeMs;

/** Where ffmpeg writes a job's output until it succeeds: hidden, beside it, with the same extension (ffmpeg picks the format by it). */
export function partPath(output: string): string {
  const ext = extname(output);
  return join(dirname(output), `.${basename(output, ext)}.part${ext}`);
}

/** Where a job's command is kept once it succeeds: a new codec or bit rate makes the output stale (hidden, beside it). */
export function stampPath(output: string): string {
  return join(dirname(output), `.${basename(output)}.cmd`);
}

const commandOf = (job: Job) => JSON.stringify(job.argv.slice(0, -1));

/**
 * Runs each stale job (its output missing, older than an input, or made by another command), one at a time. ffmpeg writes to the
 * job's part path, which is renamed to the output only once it succeeds; a job that fails leaves no part
 * file and no output, is recorded, and the rest still run.
 */
export async function runJobs(
  jobs: Job[], options: { force?: boolean; exec: (argv: string[]) => Promise<void> },
): Promise<{ ran: number; skipped: number; failed: JobFailure[] }> {
  let ran = 0;
  let skipped = 0;
  const failed: JobFailure[] = [];
  for (const job of jobs) {
    const out = await mtime(job.output);
    const inputs = await Promise.all(job.inputs.map(mtime));
    const stamp = await readFile(stampPath(job.output), 'utf8').catch(() => undefined);
    if (!options.force && out !== undefined && inputs.every(t => t !== undefined && t <= out) && stamp === commandOf(job)) {
      skipped++;
      continue;
    }
    const part = partPath(job.output);
    try {
      await mkdir(dirname(job.output), { recursive: true });
      await options.exec(['ffmpeg', ...job.argv.slice(0, -1), part]);
      await rename(part, job.output);
      await writeFile(stampPath(job.output), commandOf(job));
      ran++;
    } catch (e) {
      await rm(part, { force: true });
      failed.push({ output: job.output, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { ran, skipped, failed };
}
