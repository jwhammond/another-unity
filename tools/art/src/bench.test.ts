// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { chosenResult, choose, median, parseTimeL, runBench, type BenchCase, type BenchResult } from './bench';
import { artCache } from './cache';
import type { withGenerator } from './comfy';
import type { Generator, Job } from './generator';
import { encodePng } from './image';
import type { Models, Sampling } from './graphs';
import { FakeGenerator } from './testing/fakeGenerator';

// A synthetic sample in the shape macOS prints (numbers made up).
const TIME_L = `ComfyUI log line
        61.50 real        20.10 user         8.20 sys
          3500000000  maximum resident set size
                   0  average shared memory size
               12345  page reclaims
          9100000000  peak memory footprint
`;

describe('parseTimeL', () => {
  it('reads macOS /usr/bin/time -l output (a captured synthetic sample)', () => {
    expect(parseTimeL(TIME_L)).toEqual({ peakFootprint: 9_100_000_000, maxRss: 3_500_000_000 });
    expect(() => parseTimeL('nothing here')).toThrow(/peak memory footprint/);
  });
});

const M: Models = { checkpoint: 'c', upscaler: 'u' };
// FakeGenerator needs a KSampler to carry a seed: txt2imgGraph builds one.
const S: Sampling = { seed: 1, steps: 1, cfg: 1, sampler: 'euler', scheduler: 'normal' };
const orig = encodePng({ width: 640, height: 480, data: new Uint8Array(640 * 480 * 4).fill(90) });

describe('runBench', () => {
  it('warms up once, times N runs, takes the median, and stops each server', async () => {
    let clock = 0;
    const durations = [50, 9, 3, 6]; // warm-up 50 s, then 9, 3, 6: the median is 6
    let runIdx = 0;
    const seeds: unknown[] = [];
    const fake = new FakeGenerator();
    const timed: Generator = {
      run: async (job: Job) => {
        seeds.push(Object.values(job.graph).find(n => n.class_type === 'KSampler')?.inputs.seed);
        const out = await fake.run(job);
        clock += (runIdx++ === 0 ? durations[0]! : durations[runIdx - 1]!) * 1000;
        return out;
      },
      info: async () => ({ comfyui: 'c1', torch: 't1', device: 'mps', vramTotal: 24, vramFree: 5 }),
      nodeTypes: async () => new Set(),
    };
    const wraps: (string[] | undefined)[] = [];
    let stops = 0;
    const generator = (async (_cache, use, opts) => {
      wraps.push(opts?.wrap);
      const server = { url: 'u', pid: 1, output: () => TIME_L, stop: async () => void stops++ };
      try {
        return await use(timed, server);
      } finally {
        await server.stop();
      }
    }) as typeof withGenerator;
    const cases: BenchCase[] = [
      { id: 'txt2img-1024', candidate: 'a', models: M, sampling: S, flags: ['--force-fp16'] },
      { id: 'upscale-4x', candidate: 'u', models: M, sampling: S, flags: [] },
    ];
    const written: string[] = [];
    runIdx = 0;
    const r = await runBench(artCache({ ART_CACHE: '/c' }), cases.slice(0, 1), {
      generator,
      originals: '/o',
      runs: 3,
      now: () => clock,
      read: () => orig,
      writeImage: n => void written.push(n),
    });
    expect(r.results[0]).toMatchObject({ case: 'txt2img-1024', candidate: 'a', flags: ['--force-fp16'], seconds: 6, runs: [9, 3, 6], peakFootprint: 9_100_000_000, vramFree: 5, aligned: null });
    expect(fake.jobs).toHaveLength(4); // one warm-up and three timed
    expect(stops).toBe(1);
    expect(wraps[0]).toEqual(['/usr/bin/time', '-l']);
    expect(written).toEqual(['txt2img-1024-a-forcefp16.png']);
    expect(new Set(seeds).size).toBe(4); // a fresh seed per run, or ComfyUI serves its cache
    expect(r.stack).toMatchObject({ torch: 't1', comfyui: 'c1' });

    // The upscale case sends the original and asks for 4x; a repaint also gets U and an 1152x864 input.
    const fake2 = new FakeGenerator();
    const timed2: Generator = { ...timed, run: job => fake2.run(job) };
    const gen2 = (async (_c, use) => use(timed2, { url: 'u', pid: 1, output: () => TIME_L, stop: async () => {} })) as typeof withGenerator;
    await runBench(artCache({ ART_CACHE: '/c' }), [cases[1]!, { ...cases[0]!, id: 'repaint-1152', models: { ...M, depth: { controlnet: 'd', annotator: 'x' } } }], {
      generator: gen2, originals: '/o', runs: 1, read: () => orig,
    });
    const upload = fake2.jobs[0]!;
    expect(Object.keys(upload.inputs)).toEqual(['bench-in.png']);
    const repaint = fake2.jobs.find(j => 'bench-guide.png' in j.inputs)!;
    expect(repaint).toBeDefined();
  });
});

const R = (id: BenchResult['case'], candidate: string, seconds: number, gb: number, aligned: boolean | null = null): BenchResult => ({
  case: id, candidate, flags: [], seconds, runs: [seconds], peakFootprint: gb * 2 ** 30, vramTotal: 0, vramFree: 0, aligned,
});

describe('choose', () => {
  const budget = 18 * 2 ** 30;
  it('drops candidates over budget or unaligned, picks the fastest, and breaks ties by footprint', () => {
    const results = [
      R('txt2img-1024', 'fast-but-huge', 5, 20),
      R('txt2img-1024', 'slow', 40, 10),
      R('txt2img-1024', 'mid', 20, 12),
      R('repaint-1152', 'quick-misaligned', 10, 10, false),
      R('repaint-1152', 'a', 30, 14, true),
      R('repaint-1152', 'b', 32, 9, true), // within 10% of a: the smaller footprint wins
      R('upscale-4x', 'x', 8, 5),
      R('upscale-4x', 'y', 12, 4),
    ];
    expect(choose(results, budget)).toEqual({ checkpoint: 'mid', controlnet: 'b', upscaler: 'x' });
    expect(chosenResult(results, 'txt2img-1024', budget).candidate).toBe('mid');
  });
  it('fails when nothing fits', () => {
    expect(() => choose([R('txt2img-1024', 'a', 1, 30)], budget)).toThrow(/within 18 GB/);
  });
  it('takes the median of an even count as the mean of the middle two', () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe('the bench file', () => {
  it('holds numbers and ids only: no paths under unity-raw, no image bytes', () => {
    const text = stringify({ results: [R('repaint-1152', 'cn-union-sdxl', 30, 9)] });
    expect(text).not.toMatch(/unity-raw|\.png|PNG|\/Users\//);
    expect(text).toMatch(/cn-union-sdxl/);
  });
});
