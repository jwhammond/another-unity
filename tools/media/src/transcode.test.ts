// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runMedia } from './cli';
import { audioJobs, movieJobs, partPath, readMovies, runJobs, shellLine, stampPath, type Job } from './transcode';

const temps: string[] = [];
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(temps.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

/** An exec that writes the output ffmpeg was given (its last argument), or fails for an output matching `fail`. */
function fakeFfmpeg(ran: string[][], fail?: RegExp) {
  return async (argv: string[]) => {
    ran.push(argv);
    const output = argv.at(-1) ?? '';
    await writeFile(output, 'partial');
    if (fail?.test(output)) throw new Error('ffmpeg exited with code 1');
  };
}

const sounds = [
  { name: 'FE0000E6.VAC', wav: 'audio/FE0000E6.VAC.wav', channels: 1, rate: 22050, frames: 100 },
  { name: 'tricordr.rac', wav: 'audio/tricordr.rac.wav', channels: 1, rate: 22050, frames: 100 },
  { name: 'h3amb01.rac', wav: 'audio/h3amb01.rac.wav', channels: 2, rate: 22050, frames: 100 },
];

describe('audioJobs', () => {
  it('sends voice and effects to Opus, and music to stereo Opus in Ogg, named by stem', () => {
    const jobs = audioJobs(sounds, 'in', 'out');
    expect(jobs.map(j => [j.kind, j.output])).toEqual([
      ['voice', 'out/audio/voice/fe0000e6.opus'],
      ['sfx', 'out/audio/sfx/tricordr.opus'],
      ['music', 'out/audio/music/h3amb01.ogg'],
    ]);
    expect(jobs[0].argv).toEqual([
      '-hide_banner', '-loglevel', 'error', '-y', '-i', 'in/audio/FE0000E6.VAC.wav',
      '-c:a', 'libopus', '-b:a', '32k', '-ac', '1', '-application', 'voip', 'out/audio/voice/fe0000e6.opus',
    ]);
    // (Homebrew's ffmpeg 9 has no libvorbis, so music is Opus too, still at audio/music/<stem>.ogg)
    expect(jobs[2].argv.slice(6, -1)).toEqual(['-c:a', 'libopus', '-b:a', '96k']);
    expect(jobs[0].inputs).toEqual(['in/audio/FE0000E6.VAC.wav']);
  });

  it('with a music pattern, sends only the sounds it matches to music: a stereo effect stays an effect', () => {
    const stereo = [...sounds, { name: 'beamin.rac', wav: 'audio/beamin.rac.wav', channels: 2, rate: 22050, frames: 100 }];
    const jobs = audioJobs(stereo, 'in', 'out', undefined, /^h3amb01\.rac$/i);
    expect(jobs.map(j => [j.kind, j.output])).toEqual([
      ['voice', 'out/audio/voice/fe0000e6.opus'],
      ['sfx', 'out/audio/sfx/tricordr.opus'],
      ['music', 'out/audio/music/h3amb01.ogg'],
      ['sfx', 'out/audio/sfx/beamin.opus'],
    ]);
    // (a stereo effect keeps both channels: no -ac)
    expect(jobs[3].argv).not.toContain('-ac');
  });

  it('keeps only the sounds a filter matches', () => {
    expect(audioJobs(sounds, 'in', 'out', /^fe/i).map(j => j.output)).toEqual(['out/audio/voice/fe0000e6.opus']);
  });

  it('names an output by the file name alone, and rejects a name that is not a plain file name', () => {
    expect(audioJobs([{ ...sounds[1], name: '../../escape/BEEP7.RAC' }], 'in', 'out').map(j => j.output)).toEqual(['out/audio/sfx/beep7.opus']);
    expect(() => audioJobs([{ ...sounds[1], name: 'bad name;rm.rac' }], 'in', 'out')).toThrow('not a plain file name: "bad name;rm.rac"');
    expect(() => movieJobs([{ dir: 'mv/movies/1', file: 'a b.fvf', frameRate: [15, 1] }], 'out')).toThrow('not a plain file name');
  });
});

describe('movieJobs', () => {
  it('makes a WebM of each movie\'s frames and sound', () => {
    const [job] = movieJobs([{ dir: 'mv/movies/55', file: 'HO3ARRIV.FVF', frameRate: [15, 1] }], 'out');
    expect(job).toEqual({
      kind: 'movie',
      inputs: ['mv/movies/55/movie.json', 'mv/movies/55/audio.wav'],
      output: 'out/movies/ho3arriv.webm',
      argv: [
        '-hide_banner', '-loglevel', 'error', '-y', '-framerate', '15/1', '-i', 'mv/movies/55/frames/%05d.png',
        '-i', 'mv/movies/55/audio.wav', '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '32', '-pix_fmt', 'yuv420p',
        '-c:a', 'libopus', '-b:a', '64k', '-shortest', 'out/movies/ho3arriv.webm',
      ],
    });
  });
});

describe('readMovies', () => {
  it('reads only the numbered movie directories, in number order', async () => {
    const dir = await tempDir('media-movies-');
    for (const id of ['10', '9']) {
      await mkdir(join(dir, 'movies', id), { recursive: true });
      await writeFile(join(dir, 'movies', id, 'movie.json'), JSON.stringify({ file: `m${id}.fvf`, frameRate: [15, 1] }));
    }
    await writeFile(join(dir, 'movies', '.DS_Store'), '');
    await writeFile(join(dir, 'movies', 'notes.txt'), '');
    expect((await readMovies(dir)).map(m => m.file)).toEqual(['m9.fvf', 'm10.fvf']);
  });
});

describe('shellLine', () => {
  it('quotes what a shell would split', () => {
    const job: Job = { kind: 'sfx', inputs: [], output: '', argv: ['-i', "my file's.wav", 'out/a.opus'] };
    expect(shellLine(job)).toBe("ffmpeg -i 'my file'\\''s.wav' out/a.opus");
  });
});

describe('runJobs', () => {
  it('skips outputs newer than their inputs, unless forced', async () => {
    const dir = await tempDir('media-');
    await writeFile(join(dir, 'a.wav'), 'x');
    await writeFile(join(dir, 'a.opus'), 'y');
    await utimes(join(dir, 'a.wav'), 1000, 1000);
    await utimes(join(dir, 'a.opus'), 2000, 2000);
    const job: Job = { kind: 'sfx', inputs: [join(dir, 'a.wav')], output: join(dir, 'a.opus'), argv: ['x', join(dir, 'a.opus')] };
    const fresh: Job = { ...job, output: join(dir, 'sub/b.opus'), argv: ['x', join(dir, 'sub/b.opus')] };
    await writeFile(stampPath(join(dir, 'a.opus')), JSON.stringify(['x']));
    const ran: string[][] = [];
    const exec = fakeFfmpeg(ran);
    expect(await runJobs([job, fresh], { exec })).toEqual({ ran: 1, skipped: 1, failed: [] });
    expect(ran).toEqual([['ffmpeg', 'x', join(dir, 'sub/.b.part.opus')]]);
    expect((await readdir(join(dir, 'sub'))).sort()).toEqual(['.b.opus.cmd', 'b.opus']);
    expect(await runJobs([job], { exec, force: true })).toEqual({ ran: 1, skipped: 0, failed: [] });
  });

  it('re-runs a job whose command changed since its output was made, or that has no record of one (a libvorbis-era .ogg)', async () => {
    const dir = await tempDir('media-');
    const out = join(dir, 'a.ogg');
    await writeFile(join(dir, 'a.wav'), 'x');
    await utimes(join(dir, 'a.wav'), 1000, 1000);
    const job: Job = { kind: 'music', inputs: [join(dir, 'a.wav')], output: out, argv: ['-c:a', 'libvorbis', out] };
    await writeFile(out, 'old');
    const exec = fakeFfmpeg([]);
    expect(await runJobs([job], { exec })).toEqual({ ran: 1, skipped: 0, failed: [] });
    expect(await runJobs([job], { exec })).toEqual({ ran: 0, skipped: 1, failed: [] });
    const opus: Job = { ...job, argv: ['-c:a', 'libopus', out] };
    expect(await runJobs([opus], { exec })).toEqual({ ran: 1, skipped: 0, failed: [] });
    expect(await readFile(stampPath(out), 'utf8')).toBe('["-c:a","libopus"]');
  });

  it('writes to a hidden part file with the output\'s extension, renamed only once ffmpeg succeeds', () => {
    expect(partPath('out/audio/music/h3amb01.ogg')).toBe('out/audio/music/.h3amb01.part.ogg');
    expect(partPath('out/movies/arrive.webm')).toBe('out/movies/.arrive.part.webm');
  });

  it('records a job that fails, leaves neither its part file nor an output, and runs the rest', async () => {
    const dir = await tempDir('media-fail-');
    const job = (name: string): Job => ({ kind: 'sfx', inputs: [], output: join(dir, name), argv: ['-i', 'in.wav', join(dir, name)] });
    const ran: string[][] = [];
    const result = await runJobs([job('a.opus'), job('b.opus'), job('c.opus')], { exec: fakeFfmpeg(ran, /b\.part/) });
    expect(result).toEqual({ ran: 2, skipped: 0, failed: [{ output: join(dir, 'b.opus'), error: 'ffmpeg exited with code 1' }] });
    expect(ran).toHaveLength(3);
    expect((await readdir(dir)).sort()).toEqual(['.a.opus.cmd', '.c.opus.cmd', 'a.opus', 'c.opus']);
    expect(await readFile(join(dir, 'a.opus'), 'utf8')).toBe('partial');
  });
});

async function exportWith(files: typeof sounds) {
  const audio = await tempDir('media-audio-');
  const out = await tempDir('media-out-');
  await mkdir(join(audio, 'audio'), { recursive: true });
  await writeFile(join(audio, 'audio/manifest.json'), JSON.stringify({ files }));
  return { audio, out };
}

describe('the media command', () => {
  it('prints the commands in a dry run, and runs nothing', async () => {
    const { audio, out } = await exportWith(sounds);
    const lines: string[] = [];
    const exec = async () => {
      throw new Error('a dry run must not run ffmpeg');
    };
    expect(await runMedia(['--audio', audio, '--out', out, '--dry-run'], line => lines.push(line), exec)).toBe(0);
    expect(lines[0]).toBe(`ffmpeg -hide_banner -loglevel error -y -i ${audio}/audio/FE0000E6.VAC.wav -c:a libopus -b:a 32k -ac 1 -application voip ${out}/audio/voice/fe0000e6.opus`);
    expect(lines.at(-1)).toBe('dry run: 3 jobs (1 voice, 1 sfx, 1 music, 0 movies)');
    expect(await readdir(out)).toEqual([]);
  });

  it('says which jobs failed, runs the rest, and exits 1', async () => {
    const { audio, out } = await exportWith(sounds);
    const lines: string[] = [];
    const ran: string[][] = [];
    const ffmpeg = fakeFfmpeg(ran, /tricordr/);
    const exec = (argv: string[]) => (argv[1] === '-version' ? Promise.resolve() : ffmpeg(argv));
    expect(await runMedia(['--audio', audio, '--out', out], line => lines.push(line), exec)).toBe(1);
    expect(lines).toEqual([
      `failed: ${out}/audio/sfx/tricordr.opus: ffmpeg exited with code 1`,
      '3 jobs (1 voice, 1 sfx, 1 music, 0 movies): ran 2, 0 up to date, 1 failed',
    ]);
    expect(await readdir(join(out, 'audio/sfx'))).toEqual([]);
  });

  it('refuses a sound whose name is not a plain file name, and writes nothing', async () => {
    const { audio, out } = await exportWith([{ ...sounds[1], name: 'two words.rac' }]);
    const lines: string[] = [];
    const exec = async () => {
      throw new Error('nothing may run');
    };
    expect(await runMedia(['--audio', audio, '--out', out], line => lines.push(line), exec)).toBe(1);
    expect(lines).toEqual(['error: not a plain file name: "two words.rac"']);
    expect(await readdir(out)).toEqual([]);
  });

  it('explains its arguments', async () => {
    const lines: string[] = [];
    expect(await runMedia([], line => lines.push(line))).toBe(2);
    expect(lines).toEqual(['usage: media --audio <dir> [--movies <dir>] [--out games/unity] [--filter <regex>] [--music <regex>] [--dry-run] [--force]']);
  });
});
