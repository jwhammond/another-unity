// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { MapCommand } from './astroLayout';
import { measurer, paintMap, type Paint2D } from './astroPaint';

/** A context that writes down what it is asked to do. */
function recorder(): { ctx: Paint2D; log: string[] } {
  const log: string[] = [];
  const state: Record<string, unknown> = {};
  const ctx = new Proxy({} as Paint2D, {
    get(_t, name: string) {
      if (name in state) return state[name];
      if (name === 'measureText') return (text: string) => ({ width: text.length * 4.2 });
      return (...args: unknown[]) => { log.push(`${name}(${args.map(a => (typeof a === 'object' && a !== null ? '[img]' : String(a))).join(',')})${state.fillStyle ? ` f=${state.fillStyle}` : ''}${state.strokeStyle ? ` s=${state.strokeStyle}` : ''}`); };
    },
    set(_t, name: string, value) { state[name] = value; return true; },
  });
  return { ctx, log };
}
const paint = (commands: MapCommand[], extra: Partial<Parameters<typeof paintMap>[2]> = {}) => {
  const { ctx, log } = recorder();
  paintMap(ctx, { commands }, { scale: 3, ticks: 0, ...extra });
  return log;
};

describe('paintMap', () => {
  it('scales and moves the original\'s pixels to the window\'s corner', () => {
    expect(paint([])[0]).toBe('setTransform(3,0,0,3,-30,-57)');
  });
  it('fills inclusively, plots a pixel as one original pixel, and draws a line through pixel centres', () => {
    const log = paint([
      { kind: 'fill', x1: 10, y1: 19, x2: 12, y2: 20, colour: '#000' },
      { kind: 'pixel', x: 50, y: 60, colour: '#fff' },
      { kind: 'line', x1: 1, y1: 2, x2: 3, y2: 4, colour: '#0f0' },
    ]);
    expect(log).toContain('fillRect(10,19,3,2) f=#000');
    expect(log).toContain('fillRect(50,60,1,1) f=#fff');
    expect(log.some(l => l.startsWith('moveTo(1.5,2.5)') && l.endsWith('s=#0f0'))).toBe(true);
    expect(log.some(l => l.startsWith('lineTo(3.5,4.5)') && l.endsWith('s=#0f0'))).toBe(true);
  });
  it('writes text in its font, centred when asked', () => {
    const log = paint([{ kind: 'text', x: 199, y: 30, text: 'Name', font: 'info', colour: '#208ce0', align: 'centre' }]);
    expect(log.some(l => l.startsWith('fillText(Name,199,30)') && l.includes('f=#208ce0'))).toBe(true);
  });
  it('draws a text as the game\'s own font\'s picture when it is given one, from its corner or about x, with the pixels left hard, and without the browser\'s font', () => {
    const picture = { image: {} as unknown, width: 20, height: 8 };
    const asked: string[] = [];
    const log = paint([
      { kind: 'text', x: 30, y: 40, text: 'Sol', font: 'map', colour: '#abcdef' },
      { kind: 'text', x: 199, y: 30, text: 'Centre', font: 'info', colour: '#fff', align: 'centre' },
    ], { text: (font, text, colour) => { asked.push(`${font} ${text} ${colour}`); return picture; } });
    expect(asked).toEqual(['map Sol #abcdef', 'info Centre #fff']);
    expect(log).toContain('drawImage([img],30,40,20,8)');
    expect(log).toContain('drawImage([img],189,30,20,8)');
    expect(log.some(l => l.startsWith('fillText'))).toBe(false);
  });
  it('falls back to the browser\'s font for a text that has no picture', () => {
    const log = paint([{ kind: 'text', x: 5, y: 6, text: 'Sol', font: 'map', colour: '#abcdef' }], { text: () => undefined });
    expect(log.some(l => l.startsWith('fillText(Sol,5,6)'))).toBe(true);
  });
  it('draws a published picture at its own size from its corner, centred, or standing; smaller when it is dimmer; and not one still loading', () => {
    const sprite = (name: string) => (name === 'loading' ? { image: null, width: 10, height: 10 } : { image: {}, width: 22, height: 20 });
    const log = paint([
      { kind: 'sprite', name: 'a', x: 100, y: 100, anchor: 'centre' },
      { kind: 'sprite', name: 'a', x: 10, y: 25, anchor: 'corner' },
      { kind: 'sprite', name: 'a', x: 195, y: 296, anchor: 'bottom' },
      { kind: 'sprite', name: 'a', x: 50, y: 50, anchor: 'corner', scale: 128 },
      { kind: 'sprite', name: 'loading', x: 5, y: 5, anchor: 'centre' },
    ], { sprite });
    expect(log.filter(l => l.startsWith('drawImage'))).toEqual([
      'drawImage([img],89,90,22,20)', 'drawImage([img],10,25,22,20)', 'drawImage([img],184,276,22,20)', 'drawImage([img],50,50,11,10)',
    ]);
  });
  it('draws a shape for a picture that is not published', () => {
    const log = paint([
      { kind: 'sprite', name: 'planet6', x: 100, y: 76, anchor: 'centre' },
      { kind: 'sprite', name: 'star_class2', x: 60, y: 60, anchor: 'centre' },
      { kind: 'sprite', name: 'belt', x: 200, y: 76, anchor: 'centre' },
    ]);
    expect(log.filter(l => l.startsWith('arc')).length).toBe(2);
    expect(log.some(l => l.startsWith('fillRect(199'))).toBe(true);
    expect(log.some(l => l.startsWith('drawImage'))).toBe(false);
  });
  it('draws the globe with the tools it is given, at the original\'s place and size', () => {
    const put: unknown[] = [];
    const canvas = { getContext: () => ({ putImageData: (d: unknown) => { put.push(d); } }) };
    const log = paint([{ kind: 'globe', type: 10, seed: 5 }], { makeCanvas: () => canvas, makeImageData: (data, w, h) => ({ w, h, n: data.length }) });
    expect(put).toEqual([{ w: 120, h: 120, n: 120 * 120 * 4 }]);
    expect(log).toContain('drawImage([img],140,176,120,120)');
  });
  it('measures text in a font, rounding up', () => {
    const { ctx } = recorder();
    expect(measurer(ctx)('map', 'abcde')).toBe(21);
  });
});
