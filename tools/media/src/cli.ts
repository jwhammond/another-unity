// SPDX-License-Identifier: GPL-3.0-or-later
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { audioJobs, type Job, movieJobs, readAudioManifest, readMovies, runJobs, shellLine } from './transcode';

const USAGE = 'usage: media --audio <dir> [--movies <dir>] [--out games/unity] [--filter <regex>] [--music <regex>] [--dry-run] [--force]';

function run(argv: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(argv[0], argv.slice(1), error => (error ? reject(error) : resolve()));
  });
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    options: {
      audio: { type: 'string' }, movies: { type: 'string' }, out: { type: 'string', default: 'games/unity' },
      filter: { type: 'string' }, music: { type: 'string' }, 'dry-run': { type: 'boolean', default: false }, force: { type: 'boolean', default: false },
    },
  }).values;
}

export async function runMedia(argv: string[], log: (line: string) => void, exec: (argv: string[]) => Promise<void> = run): Promise<number> {
  let values: ReturnType<typeof parse>;
  try {
    values = parse(argv);
  } catch {
    log(USAGE);
    return 2;
  }
  if (!values.audio) {
    log(USAGE);
    return 2;
  }
  const out = values.out ?? 'games/unity';
  let jobs: Job[];
  try {
    jobs = [
      ...audioJobs(await readAudioManifest(values.audio), values.audio, out, values.filter ? new RegExp(values.filter, 'i') : undefined,
        values.music ? new RegExp(values.music, 'i') : undefined),
      ...(values.movies ? movieJobs(await readMovies(values.movies), out) : []),
    ];
  } catch (e) {
    // an unreadable export, or a name that isn't a plain file name: nothing is written
    log(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const count = (kind: string) => jobs.filter(j => j.kind === kind).length;
  const summary = `${jobs.length} jobs (${count('voice')} voice, ${count('sfx')} sfx, ${count('music')} music, ${count('movie')} movies)`;
  if (values['dry-run']) {
    for (const job of jobs) log(shellLine(job));
    log(`dry run: ${summary}`);
    return 0;
  }
  try {
    await exec(['ffmpeg', '-version']);
  } catch {
    log('ffmpeg is not installed (or not on PATH); use --dry-run to see the commands');
    return 1;
  }
  const result = await runJobs(jobs, { force: values.force, exec });
  for (const f of result.failed) log(`failed: ${f.output}: ${f.error}`);
  log(`${summary}: ran ${result.ran}, ${result.skipped} up to date, ${result.failed.length} failed`);
  return result.failed.length > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMedia(process.argv.slice(2), line => console.log(line)).then(
    code => process.exit(code),
    (e: unknown) => {
      console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
