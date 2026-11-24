// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * ComfyUI's SDXL noise schedule, reproduced so a ControlNet's window can be given relative to the steps KSampler really
 * samples (Plan 15 R3, Plan 14 final review I2). ComfyUI turns a ControlNet's start/end percent into sigmas over the
 * model's FULL schedule (`percent_to_sigma`), but KSampler(denoise < 1) samples only the tail of a longer schedule, so
 * an absolute window can miss every sampled step.
 * Pinned against ComfyUI's own functions in sigmas.test.ts (tools/art/setup/sigmas_ref.py prints the reference numbers).
 */

const TIMESTEPS = 1000;
let cache: { sigmas: Float64Array; logSigmas: Float64Array } | undefined;

function table(): { sigmas: Float64Array; logSigmas: Float64Array } {
  if (!cache) {
    // betas = linspace(sqrt(0.00085), sqrt(0.012), 1000)^2; sigma = sqrt((1 - abar) / abar)
    const a = Math.sqrt(0.00085);
    const b = Math.sqrt(0.012);
    const sigmas = new Float64Array(TIMESTEPS);
    let abar = 1;
    for (let i = 0; i < TIMESTEPS; i++) {
      const beta = (a + ((b - a) * i) / (TIMESTEPS - 1)) ** 2;
      abar *= 1 - beta;
      sigmas[i] = Math.sqrt((1 - abar) / abar);
    }
    cache = { sigmas, logSigmas: sigmas.map(Math.log) };
  }
  return cache;
}

/**
 * The model's noise schedule (ComfyUI's model_sampling). `sdxl`: ModelSamplingDiscrete (the default). `flow`: ModelSamplingDiscreteFlow,
 * sigma = shift*t / (1 + (shift-1)*t) over t = 1..1000 / 1000 (Qwen-Image under ModelSamplingAuraFlow). `flux`: ModelSamplingFlux,
 * sigma = e^mu / (e^mu + 1/t - 1) over 10000 steps (FLUX dev's default mu 1.15, no ModelSamplingFlux node).
 */
export type NoiseSchedule = { kind: 'sdxl' } | { kind: 'flow'; shift: number } | { kind: 'flux'; shift: number };
export const SDXL: NoiseSchedule = { kind: 'sdxl' };

interface ScheduleFns {
  sampled(steps: number, denoise: number): number[];
  percentToSigma(p: number): number;
  sigmaToPercent(sigma: number): number;
}

function sdxlFns(scheduler: string): ScheduleFns {
  if (scheduler !== 'karras' && scheduler !== 'normal') throw new Error(`no sigma schedule for scheduler "${scheduler}" (karras or normal)`);
  return { sampled: (steps, denoise) => sampledSigmas(steps, denoise, scheduler), percentToSigma, sigmaToPercent };
}

/** The flow models' shift function of t in (0, 1], and its inverse. */
function flowShift(n: Exclude<NoiseSchedule, { kind: 'sdxl' }>): { f: (t: number) => number; inv: (s: number) => number; table: number } {
  if (n.kind === 'flow') {
    const a = n.shift;
    return { f: t => (a === 1 ? t : (a * t) / (1 + (a - 1) * t)), inv: s => (a === 1 ? s : s / (a - (a - 1) * s)), table: 1000 };
  }
  const e = Math.exp(n.shift);
  return { f: t => e / (e + (1 / t - 1)), inv: s => 1 / (e * (1 / s - 1) + 1), table: 10000 };
}

/** ComfyUI's simple_scheduler over a flow model's sigma table, and its percent_to_sigma (0 is sigma 1, 1 is sigma 0). */
export function flowFns(n: Exclude<NoiseSchedule, { kind: 'sdxl' }>, scheduler: string): ScheduleFns {
  if (scheduler !== 'simple') throw new Error(`no ${n.kind} sigma schedule for scheduler "${scheduler}" (simple)`);
  const { f, inv, table } = flowShift(n);
  const sigmaAtIndex = (i: number): number => f((i + 1) / table);
  const schedule = (count: number): number[] => {
    const ss = table / count;
    const out: number[] = [];
    for (let x = 0; x < count; x++) out.push(sigmaAtIndex(table - 1 - Math.floor(x * ss)));
    return [...out, 0];
  };
  return {
    sampled: (steps, denoise) => schedule(denoise > 0.9999 ? steps : Math.floor(steps / denoise)).slice(-(steps + 1)),
    percentToSigma: p => (p <= 0 ? 1 : p >= 1 ? 0 : f(1 - p)),
    sigmaToPercent: sigma => (sigma >= 1 ? 0 : sigma <= 0 ? 1 : 1 - inv(sigma)),
  };
}

/** ComfyUI's SDXL discrete sigmas (scaled_linear, 0.00085-0.012, 1000 steps), ascending. */
export function sdxlSigmas(): Float64Array {
  return table().sigmas.slice();
}

/** ModelSamplingDiscrete.sigma: log-linear interpolation at a fractional timestep. */
function sigmaAt(t: number): number {
  const { logSigmas } = table();
  const c = Math.min(Math.max(t, 0), TIMESTEPS - 1);
  const lo = Math.floor(c);
  const hi = Math.ceil(c);
  const w = c - lo;
  return Math.exp((1 - w) * logSigmas[lo]! + w * logSigmas[hi]!);
}

/** ModelSamplingDiscrete.timestep: the nearest discrete timestep in log sigma. */
function timestepOf(sigma: number): number {
  const { logSigmas } = table();
  const l = Math.log(sigma);
  let best = 0;
  for (let i = 1; i < TIMESTEPS; i++) if (Math.abs(l - logSigmas[i]!) < Math.abs(l - logSigmas[best]!)) best = i;
  return best;
}

function schedule(scheduler: 'karras' | 'normal', n: number): number[] {
  const { sigmas } = table();
  const min = sigmas[0]!;
  const max = sigmas[TIMESTEPS - 1]!;
  if (scheduler === 'karras') {
    const rho = 7;
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const ramp = n === 1 ? 0 : i / (n - 1);
      out.push((max ** (1 / rho) + ramp * (min ** (1 / rho) - max ** (1 / rho))) ** rho);
    }
    return [...out, 0];
  }
  // normal_scheduler: linspace over the discrete timesteps of sigma_max down to sigma_min, then a zero
  const start = timestepOf(max);
  const end = timestepOf(min);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(sigmaAt(n === 1 ? start : start + ((end - start) * i) / (n - 1)));
  return [...out, 0];
}

/** The sigmas KSampler samples: karras over int(steps/denoise) steps, last `steps`+1 values (the last is 0). */
export function sampledSigmas(steps: number, denoise: number, scheduler: 'karras' | 'normal'): number[] {
  const total = denoise > 0.9999 ? steps : Math.floor(steps / denoise);
  return schedule(scheduler, total).slice(-(steps + 1));
}

/** ComfyUI's percent_to_sigma: 0 is "from the start" (infinite sigma), 1 is "to the end" (sigma 0). */
export function percentToSigma(p: number): number {
  if (p <= 0) return 999999999.9;
  if (p >= 1) return 0;
  return sigmaAt((1 - p) * (TIMESTEPS - 1));
}

/** The inverse of percentToSigma, for a sigma inside the schedule. */
export function sigmaToPercent(sigma: number): number {
  const { logSigmas } = table();
  const l = Math.log(sigma);
  if (l <= logSigmas[0]!) return 1;
  if (l >= logSigmas[TIMESTEPS - 1]!) return 0;
  let hi = 1;
  while (logSigmas[hi]! < l) hi++;
  const t = hi - 1 + (l - logSigmas[hi - 1]!) / (logSigmas[hi]! - logSigmas[hi - 1]!);
  return 1 - t / (TIMESTEPS - 1);
}

/**
 * A window [start, end] relative to the sampled steps (0 = the first step, 1 = past the last) -> the absolute start/end
 * percents ComfyUI wants, and the fraction of the sampled steps the ControlNet is active on (ComfyUI runs it while
 * sigma(end) <= sigma <= sigma(start)). `rel.end` 0.5 is active on the first half of the steps, not on the first half
 * of the percent range: the karras tail is far from linear in percent (R3's `p0 + r * (1 - p0)` would give 20% of the
 * steps at denoise 0.25), so the relative position is taken along the sampled sigmas, log-interpolated, and only then
 * converted to a percent.
 */
export function controlWindow(
  steps: number,
  denoise: number,
  scheduler: string,
  rel: { start: number; end: number },
  noise: NoiseSchedule = SDXL,
): { startPercent: number; endPercent: number; activeFraction: number } {
  const fns = noise.kind === 'sdxl' ? sdxlFns(scheduler) : flowFns(noise, scheduler);
  const { percentToSigma, sigmaToPercent } = fns;
  const sigmas = fns.sampled(steps, denoise);
  // the sigma half a step before position `pos` (in steps), so that exactly the steps at or after (start) or before (end) it are inside
  const sigmaBefore = (pos: number): number => {
    const x = Math.min(Math.max(pos - 0.5, 0), steps - 1);
    const lo = Math.floor(x);
    const hi = Math.min(lo + 1, steps - 1);
    const w = x - lo;
    return Math.exp((1 - w) * Math.log(sigmas[lo]!) + w * Math.log(sigmas[hi]!));
  };
  // 0 and 1 stay exact: "from the first step" and "to the last" must not depend on float round trips
  const startPercent = rel.start <= 0 ? 0 : sigmaToPercent(sigmaBefore(rel.start * steps));
  const endPercent = rel.end >= 1 ? 1 : sigmaToPercent(sigmaBefore(rel.end * steps));
  const hi = percentToSigma(startPercent);
  const lo = percentToSigma(endPercent);
  let active = 0;
  for (let i = 0; i < steps; i++) if (sigmas[i]! <= hi && sigmas[i]! >= lo) active++;
  return { startPercent, endPercent, activeFraction: active / steps };
}
