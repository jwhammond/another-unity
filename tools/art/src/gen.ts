// SPDX-License-Identifier: GPL-3.0-or-later
import type { Generator } from './generator';
import { txt2imgGraph, type Models, type Sampling } from './graphs';

export const DEFAULT_NEGATIVE = 'text, watermark, blurry, low quality';
export const DEFAULT_SAMPLING: Omit<Sampling, 'seed'> = { steps: 30, cfg: 5.5, sampler: 'dpmpp_2m', scheduler: 'karras' };

export function parseSize(s: string): [number, number] {
  const m = /^(\d+)x(\d+)$/.exec(s);
  if (!m || Number(m[1]) % 8 || Number(m[2]) % 8 || Number(m[1]) < 64 || Number(m[2]) < 64) throw new Error(`--size "${s}": want WIDTHxHEIGHT, multiples of 8, at least 64`);
  return [Number(m[1]), Number(m[2])];
}

/** `art gen`: one txt2img through the generator; returns PNG bytes. */
export async function gen(
  g: Generator,
  models: Models,
  o: { prompt: string; negative?: string; seed: number; size: [number, number]; sampling?: Omit<Sampling, 'seed'> },
): Promise<Uint8Array> {
  const job = txt2imgGraph(models, { ...(o.sampling ?? DEFAULT_SAMPLING), seed: o.seed }, o.prompt, o.negative ?? DEFAULT_NEGATIVE, o.size);
  return (await g.run(job)).image!;
}

/** Sampling per recipe family: the Lightning LoRA wants 8 steps and low cfg, plain SDXL base the long schedule. */
export const LIGHTNING_SAMPLING: Omit<Sampling, 'seed'> = { steps: 8, cfg: 1.5, sampler: 'euler', scheduler: 'sgm_uniform' };
export const samplingFor = (m: Models): Omit<Sampling, 'seed'> => (m.lora ? LIGHTNING_SAMPLING : DEFAULT_SAMPLING);
