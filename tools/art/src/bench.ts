// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ArtCache } from './cache';
import type { withGenerator } from './comfy';
import { DEFAULT_NEGATIVE } from './gen';
import { areaResize, decodePng, encodePng } from './image';
import { repaintGraph, txt2imgGraph, upscaleGraph, type Models, type Sampling } from './graphs';

export interface BenchCase {
  id: 'txt2img-1024' | 'repaint-1152' | 'upscale-4x';
  /** Which models make up the candidate, joined by "+" (the result's `candidate`). */
  candidate: string;
  models: Models;
  sampling: Sampling;
  /** ComfyUI flags, e.g. ['--force-fp16']. */
  flags: string[];
}
export interface BenchResult {
  case: BenchCase['id'];
  candidate: string;
  flags: string[];
  /** The median of `runs` timed runs after one warm-up, in seconds. */
  seconds: number;
  runs: number[];
  /** /usr/bin/time -l's "peak memory footprint" of the ComfyUI process over the candidate's session, in bytes. */
  peakFootprint: number;
  vramTotal: number;
  vramFree: number;
  /** repaint only: the alignment check on lab.s01 (Task 5 fills this in on its re-run), else null. */
  aligned: boolean | null;
}
export interface BenchFile {
  machine: { model: string; chip: string; memoryGb: number; macos: string };
  stack: { torch: string; comfyui: string; aux: string; python: string };
  date: string;
  results: BenchResult[];
}

/** Parses "peak memory footprint" (and "maximum resident set size") from macOS /usr/bin/time -l's stderr. */
export function parseTimeL(stderr: string): {
  peakFootprint: number;
  maxRss: number;
} {
  const num = (label: string): number => {
    const m = new RegExp(`^\\s*(\\d+)\\s+${label}\\s*$`, 'm').exec(stderr);
    if (!m) throw new Error(`/usr/bin/time -l printed no "${label}"`);
    return Number(m[1]);
  };
  return {
    peakFootprint: num('peak memory footprint'),
    maxRss: num('maximum resident set size'),
  };
}

const CASE_FOR = {
  checkpoint: 'txt2img-1024',
  controlnet: 'repaint-1152',
  upscaler: 'upscale-4x',
} as const;
export const BUDGET_BYTES = 18 * 2 ** 30;

/**
 * The selection rule: over-budget candidates go, then (repaint) unaligned ones, then the lowest median seconds wins, and
 * a tie within 10% goes to the smaller footprint. `aligned: null` (not yet checked) is not a failure, only `false` is.
 */
export function choose(results: BenchResult[], budgetBytes: number): Record<'checkpoint' | 'controlnet' | 'upscaler', string> {
  const out = {} as Record<'checkpoint' | 'controlnet' | 'upscaler', string>;
  for (const [role, id] of Object.entries(CASE_FOR) as [keyof typeof CASE_FOR, BenchCase['id']][]) out[role] = chosenResult(results, id, budgetBytes).candidate;
  return out;
}

/** The single result `choose` would pick for a case id (so the caller can read its flags). */
export function chosenResult(results: BenchResult[], id: BenchCase['id'], budgetBytes: number): BenchResult {
  const ok = results.filter(r => r.case === id && r.peakFootprint <= budgetBytes && r.aligned !== false);
  if (ok.length === 0) throw new Error(`no ${id} candidate is within ${(budgetBytes / 2 ** 30).toFixed(0)} GB and aligned`);
  const fastest = Math.min(...ok.map(r => r.seconds));
  const tied = ok.filter(r => r.seconds <= fastest * 1.1).sort((a, b) => a.peakFootprint - b.peakFootprint || a.seconds - b.seconds);
  return tied[0]!;
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export interface BenchDeps {
  generator: typeof withGenerator;
  /** IMAGES_DIR: holds images/backgrounds/s_0401.png. */
  originals: string;
  runs?: number;
  now?: () => number;
  read?: (path: string) => Uint8Array;
  writeImage?: (name: string, png: Uint8Array) => void;
  log?: (line: string) => void;
  prompt?: string;
}

export const BENCH_PROMPT = 'a 1990s science-fiction research laboratory interior, wide view, detailed';

/** Runs each case in its own fresh server wrapped in /usr/bin/time -l; one warm-up, then `runs` timed runs. */
export async function runBench(cache: ArtCache, cases: BenchCase[], deps: BenchDeps): Promise<Pick<BenchFile, 'results' | 'stack'>> {
  const now = deps.now ?? (() => performance.now());
  const read = deps.read ?? (p => readFileSync(p));
  const runs = deps.runs ?? 3;
  const prompt = deps.prompt ?? BENCH_PROMPT;
  const log = deps.log ?? (() => {});
  const results: BenchResult[] = [];
  let stack = { torch: '', comfyui: '' };
  let original: ReturnType<typeof decodePng> | undefined;
  const loadOriginal = (): NonNullable<typeof original> => (original ??= decodePng(read(join(deps.originals, 'images', 'backgrounds', 's_0401.png'))));

  for (const c of cases) {
    const times: number[] = [];
    let info = { vramTotal: 0, vramFree: 0 };
    let serverOut: (() => string) | undefined;
    await deps.generator(
      cache,
      async (g, server) => {
        if (server) serverOut = server.output;
        let job: ReturnType<typeof txt2imgGraph>;
        if (c.id === 'txt2img-1024') {
          job = txt2imgGraph(c.models, c.sampling, prompt, DEFAULT_NEGATIVE, [1024, 1024]);
        } else if (c.id === 'upscale-4x') {
          job = upscaleGraph(c.models, 'bench-in.png');
          job.inputs['bench-in.png'] = encodePng(loadOriginal());
        } else {
          // Untimed set-up in the same session: U = the original upscaled 4x; the repaint input is U at 1152x864.
          const up = upscaleGraph(c.models, 'bench-in.png');
          up.inputs['bench-in.png'] = encodePng(loadOriginal());
          const u = (await g.run(up)).image!;
          const small = encodePng(areaResize(decodePng(u), 1152, 864));
          job = repaintGraph(
            c.models,
            c.sampling,
            {
              prompt,
              negative: DEFAULT_NEGATIVE,
              denoise: 0.3,
              size: [1152, 864],
              depth: { strength: 0.6, end: 0.8 },
              lineart: { strength: 0.5, end: 0.7 },
            },
            'bench-in.png',
            'bench-guide.png',
          );
          job.inputs['bench-in.png'] = small;
          job.inputs['bench-guide.png'] = u;
        }
        let last: Uint8Array | undefined;
        for (let i = 0; i < runs + 1; i++) {
          // ComfyUI skips a graph it has already run, so every run gets its own seed.
          for (const n of Object.values(job.graph)) if (n.class_type === 'KSampler') n.inputs.seed = c.sampling.seed + i;
          // The upscale graph has no seed, so its input changes by one pixel value instead.
          if (c.id === 'upscale-4x') {
            const o = loadOriginal();
            const data = o.data.slice();
            data[0] = (data[0]! + i) & 255;
            job.inputs['bench-in.png'] = encodePng({ ...o, data });
          }
          const t0 = now();
          last = (await g.run(job)).image;
          const dt = (now() - t0) / 1000;
          if (i > 0) times.push(dt);
          log(`  ${c.id} ${c.candidate} ${c.flags.join(' ')} ${i === 0 ? 'warm-up' : 'run'} ${dt.toFixed(1)} s`);
        }
        if (last && deps.writeImage) deps.writeImage(`${c.id}-${c.candidate}${c.flags.length ? '-' + c.flags.join('').replace(/-/g, '') : ''}.png`, last);
        const i = await g.info();
        info = { vramTotal: i.vramTotal, vramFree: i.vramFree ?? 0 };
        stack = { torch: i.torch, comfyui: i.comfyui };
      },
      { wrap: ['/usr/bin/time', '-l'], flags: c.flags },
    );
    // The server is stopped now, so /usr/bin/time has printed its report.
    // A COMFY_URL server is not ours to wrap in /usr/bin/time: its footprint is not measured (0)
    const peakFootprint = serverOut ? parseTimeL(serverOut()).peakFootprint : 0;
    results.push({
      case: c.id,
      candidate: c.candidate,
      flags: c.flags,
      seconds: Number(median(times).toFixed(2)),
      runs: times.map(t => Number(t.toFixed(2))),
      peakFootprint,
      vramTotal: info.vramTotal,
      vramFree: info.vramFree,
      aligned: null,
    });
  }
  return { results, stack: { ...stack, aux: '', python: '' } };
}
