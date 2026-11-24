// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { devGate, perfOverlayAsked } from './devGate';

describe('devGate (Decision 16; Plan 23 R2)', () => {
  const gate = (search: string, devServer = false, deploy = false) => devGate(new URLSearchParams(search), { devServer, deploy });

  it('gives players real combat (M8 spec §10)', () => {
    expect(gate('?game=unity&speed=4')).toEqual({ devParam: false, dev: false, realCombat: true });
    expect(gate('')).toEqual({ devParam: false, dev: false, realCombat: true });
    expect(gate('?game=unity&combat=real&speed=4', false, true)).toEqual({ devParam: false, dev: false, realCombat: true });
  });

  it('gives ?dev the dev tools and real combat, and keeps the M4 dialog behind ?dev&combat=dialog', () => {
    expect(gate('?game=unity&dev')).toEqual({ devParam: true, dev: true, realCombat: true });
    expect(gate('?game=unity&dev&combat=dialog')).toEqual({ devParam: true, dev: true, realCombat: false });
    expect(gate('?game=unity&dev&combat=real')).toEqual({ devParam: true, dev: true, realCombat: true });
  });

  it('ignores combat=dialog without the dev tools, and on a deploy build', () => {
    expect(gate('?game=unity&combat=dialog')).toEqual({ devParam: false, dev: false, realCombat: true });
    expect(gate('?game=unity&dev&combat=dialog', false, true)).toEqual({ devParam: false, dev: false, realCombat: true });
  });

  it('gives the dev server\'s page the dev tools without ?dev, with the dialog only by ?combat=dialog', () => {
    expect(gate('?game=unity', true)).toEqual({ devParam: false, dev: true, realCombat: true });
    expect(gate('?game=unity&combat=dialog', true)).toEqual({ devParam: false, dev: true, realCombat: false });
  });
});

describe('perfOverlayAsked (Plan 34 Task 8)', () => {
  it('loads the frame-rate overlay only with a bare ?perf, not the perf runner\'s ?perf=<scenario>', () => {
    const asked = (search: string) => perfOverlayAsked(new URLSearchParams(search));
    expect(asked('?game=unity&perf')).toBe(true);
    expect(asked('?perf=')).toBe(true);
    expect(asked('?game=unity&dev&mute&perf=82')).toBe(false);
    expect(asked('?game=unity')).toBe(false);
    expect(asked('?performance')).toBe(false);
  });
});
