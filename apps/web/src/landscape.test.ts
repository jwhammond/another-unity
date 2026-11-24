// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { bindFullscreenButtons, requestLandscape } from './landscape';

describe('requestLandscape', () => {
  it('asks for fullscreen and then the lock, in that order', async () => {
    const calls: string[] = [];
    const r = await requestLandscape({
      documentElement: { requestFullscreen: async () => { calls.push('fullscreen'); } },
      screen: { orientation: { lock: async o => { calls.push(`lock ${o}`); } } },
    });
    expect(calls).toEqual(['fullscreen', 'lock landscape']);
    expect(r).toEqual({ fullscreen: true, locked: true });
  });

  it('does not throw when either is refused, and still tries the other', async () => {
    const r = await requestLandscape({
      documentElement: { requestFullscreen: () => Promise.reject(new Error('denied')) },
      screen: { orientation: { lock: () => Promise.reject(new DOMException('no', 'NotSupportedError')) } },
    });
    expect(r).toEqual({ fullscreen: false, locked: false });
  });

  it('does not throw when a call throws at once or neither exists (iOS)', async () => {
    expect(await requestLandscape({ documentElement: {}, screen: {} })).toEqual({ fullscreen: false, locked: false });
    const r = await requestLandscape({
      documentElement: { requestFullscreen: () => { throw new Error('sync'); } },
      screen: { orientation: { lock: async () => {} } },
    });
    expect(r).toEqual({ fullscreen: false, locked: true });
  });
});

describe('bindFullscreenButtons', () => {
  it('makes the HUD button once, wires every button once, and asks on a click', () => {
    document.body.innerHTML = '<div id="game"></div><button class="au-fs"></button>';
    let asked = 0;
    const request = async () => { asked++; return { fullscreen: false, locked: false }; };
    bindFullscreenButtons(document, request);
    bindFullscreenButtons(document, request);
    const buttons = document.querySelectorAll<HTMLElement>('.au-fs');
    expect(buttons).toHaveLength(2);
    expect(document.querySelectorAll('#game .au-fs')).toHaveLength(1);
    buttons.forEach(b => b.click());
    expect(asked).toBe(2);
  });
});
