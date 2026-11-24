// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { controlWindow, percentToSigma, sampledSigmas, sdxlSigmas, sigmaToPercent } from './sigmas';

/*
 * Reference numbers from ComfyUI v0.41.3's own functions (comfy.samplers.calculate_sigmas on a
 * ModelSamplingDiscrete with SDXL's settings, KSampler.set_steps' int(steps/denoise) and last steps+1; and
 * ModelSamplingDiscrete.percent_to_sigma). Command, from the cache:
 *   ~/pcode/unity-art-cache/venv/bin/python tools/art/setup/sigmas_ref.py
 */
const K25 = [0.236651, 0.222274, 0.208652, 0.195752, 0.183542, 0.171991, 0.161068, 0.150745, 0.140995, 0.13179, 0.123106, 0.114916, 0.107198, 0.099929, 0.093086, 0.086649, 0.080598, 0.074912, 0.069574, 0.064565, 0.059868, 0.055467, 0.051347, 0.047492, 0.043887, 0.04052, 0.037377, 0.034444, 0.031712, 0.029167, 0.0];
const K50 = [1.212386, 1.096608, 0.990438, 0.893204, 0.80427, 0.723035, 0.648938, 0.581448, 0.520065, 0.464322, 0.413782, 0.368032, 0.326687, 0.28939, 0.255804, 0.225616, 0.198534, 0.174288, 0.152626, 0.133313, 0.116135, 0.100889, 0.087393, 0.075474, 0.064977, 0.055757, 0.047682, 0.04063, 0.034493, 0.029167, 0.0];
const N50 = [1.570651, 1.484945, 1.40436, 1.328437, 1.256766, 1.188973, 1.124719, 1.063699, 1.00563, 0.950257, 0.897345, 0.846677, 0.798051, 0.751279, 0.706182, 0.662592, 0.620344, 0.579275, 0.539223, 0.500017, 0.461472, 0.423382, 0.385502, 0.347522, 0.309024, 0.269394, 0.227623, 0.181769, 0.126885, 0.029167, 0.0];
const PCT: [number, number][] = [[0.5, 1.6155803], [0.8, 0.5711889], [0.9, 0.3437048]];

const close = (a: number[], b: number[], tol = 1e-4): void => {
  expect(a).toHaveLength(b.length);
  a.forEach((x, i) => expect(Math.abs(x - b[i]!), `index ${i}: ${x} vs ${b[i]}`).toBeLessThan(tol));
};

describe('sigmas', () => {
  it('sampledSigmas and percentToSigma match ComfyUI to 1e-4', () => {
    const s = sdxlSigmas();
    expect(s).toHaveLength(1000);
    expect(s[0]).toBeCloseTo(0.029167, 5);
    expect(s[999]).toBeCloseTo(14.614641, 4);
    close(sampledSigmas(30, 0.25, 'karras'), K25);
    close(sampledSigmas(30, 0.5, 'karras'), K50);
    close(sampledSigmas(30, 0.5, 'normal'), N50);
    for (const [p, sigma] of PCT) expect(Math.abs(percentToSigma(p) - sigma)).toBeLessThan(1e-4);
    expect(percentToSigma(0)).toBeGreaterThan(1e8);
    expect(percentToSigma(1)).toBe(0);
  });

  it('sigmaToPercent inverts percentToSigma', () => {
    for (const p of [0.05, 0.3, 0.5, 0.8, 0.9, 0.99]) expect(sigmaToPercent(percentToSigma(p))).toBeCloseTo(p, 6);
  });

  it('controlWindow({start:0,end:1}) is active on every sampled step; {end:0.5} on about half', () => {
    for (const d of [0.25, 0.45, 0.6]) {
      const all = controlWindow(30, d, 'karras', { start: 0, end: 1 });
      expect(all).toEqual({ startPercent: 0, endPercent: 1, activeFraction: 1 });
      expect(controlWindow(30, d, 'karras', { start: 0, end: 0.5 }).activeFraction).toBeCloseTo(0.5, 1);
      expect(controlWindow(30, d, 'karras', { start: 0.5, end: 1 }).activeFraction).toBeCloseTo(0.5, 1);
    }
    expect(controlWindow(30, 0.25, 'karras', { start: 0.25, end: 0.75 }).activeFraction).toBeCloseTo(0.5, 1);
  });

  it('the Plan 14 recipe (denoise 0.25, absolute end 0.9) would be active on zero steps', () => {
    // I2: the first sampled sigma is 0.2367 and end 0.9 is sigma 0.3437, so sigma >= sigma(end) never holds
    const first = sampledSigmas(30, 0.25, 'karras')[0]!;
    expect(first).toBeLessThan(percentToSigma(0.9));
    expect(sampledSigmas(30, 0.25, 'karras').slice(0, 30).filter(s => s >= percentToSigma(0.9))).toHaveLength(0);
    expect(sampledSigmas(30, 0.25, 'karras').slice(0, 30).filter(s => s >= percentToSigma(0.8))).toHaveLength(0);
  });

  it('refuses a scheduler it has no schedule for', () => {
    expect(() => controlWindow(30, 0.3, 'exponential', { start: 0, end: 1 })).toThrow(/exponential/);
  });
});
