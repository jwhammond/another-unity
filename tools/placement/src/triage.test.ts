// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { triage, type Pixels } from './triage';

const solid = (w: number, h: number, rgb: [number, number, number], alpha = 255): Pixels => {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([...rgb, alpha], i * 4);
  return { width: w, height: h, data };
};
const room = (rgb: [number, number, number]): Pixels => solid(640, 480, rgb);
const rect: [number, number, number, number] = [10, 20, 8, 8];

describe('triage', () => {
  it('calls a sprite the background already shows in-plate', () => {
    expect(triage({ frames: [solid(8, 8, [100, 90, 80])], rect, background: room([102, 92, 78]) }).bucket).toBe('in-plate');
  });
  it('calls one frame the background does not show static-missing', () => {
    expect(triage({ frames: [solid(8, 8, [200, 10, 10])], rect, background: room([20, 20, 20]) }).bucket).toBe('static-missing');
  });
  it('calls distinct frames that the background does not show animated', () => {
    expect(triage({ frames: [solid(8, 8, [200, 10, 10]), solid(8, 8, [10, 200, 10])], rect, background: room([20, 20, 20]) }).bucket).toBe('animated');
  });
  it('calls frames that are all baked in in-plate, not animated', () => {
    expect(triage({ frames: [solid(8, 8, [60, 60, 60]), solid(8, 8, [62, 62, 62])], rect, background: room([60, 60, 60]) }).bucket).toBe('in-plate');
  });
  it('treats near-identical frames as one picture', () => {
    expect(triage({ frames: [solid(8, 8, [200, 10, 10]), solid(8, 8, [205, 12, 10])], rect, background: room([20, 20, 20]) }).bucket).toBe('static-missing');
  });
  it('calls a transparent frame, a speck, and a zero-scale sprite invisible', () => {
    expect(triage({ frames: [solid(8, 8, [1, 2, 3], 0)], rect, background: room([0, 0, 0]) }).bucket).toBe('invisible');
    expect(triage({ frames: [solid(2, 2, [200, 10, 10])], rect, background: room([0, 0, 0]) }).bucket).toBe('invisible');
    expect(triage({ frames: [solid(8, 8, [200, 10, 10])], rect, background: room([0, 0, 0]), scale: 2 }).bucket).toBe('invisible');
  });
  it('does not match pixels that fall off the background', () => {
    expect(triage({ frames: [solid(8, 8, [0, 0, 0])], rect: [636, 20, 8, 8], background: room([0, 0, 0]) }).bucket).toBe('static-missing');
  });
  it('is static-missing without a background to compare', () => {
    expect(triage({ frames: [solid(8, 8, [9, 9, 9])], rect, background: null }).bucket).toBe('static-missing');
  });
});
