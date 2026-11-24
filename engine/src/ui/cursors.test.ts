// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { cursorCss, cursorImage, loadSpriteCursors, originalCursorSource, panelCursorSource, SPRITE_CURSOR_W, SPRITE_HOTSPOTS, spriteHotspot } from './cursors';

describe('the room cursors', () => {
  it('are the drawn ones until the panel\'s sprites are made, and for any verb a sprite is missing for', () => {
    expect(cursorCss('look')).toMatch(/^url\("data:image\/svg\+xml,/);
    expect(cursorCss('look', {})).toBe(cursorCss('look'));
    const sprites = { look: { url: 'data:image/png;base64,AAAA', x: 24, y: 16 } };
    expect(cursorCss('look', sprites)).toBe('url("data:image/png;base64,AAAA") 24 16, help');
    expect(cursorCss('use', sprites)).toBe(cursorCss('use'));
  });

  it('keep the arrow and the hand for everything but the verbs', () => {
    const sprites = { look: { url: 'data:image/png;base64,AAAA', x: 1, y: 1 } };
    expect(cursorCss('default', sprites)).toBe(cursorCss('default'));
    expect(cursorCss('pointer', sprites)).toBe(cursorCss('pointer'));
  });

  it('click at a natural spot of each sprite, inside it', () => {
    const w = SPRITE_CURSOR_W;
    const h = 32;
    for (const mode of ['walk', 'look', 'use', 'talk'] as const) {
      const { x, y } = spriteHotspot(mode, w, h);
      expect(x).toBeGreaterThan(0);
      expect(x).toBeLessThan(w);
      expect(y).toBeGreaterThan(0);
      expect(y).toBeLessThan(h);
    }
    // (the eye and the balloon in the middle; the hand's fingertips and the boot's toe towards the right)
    expect(spriteHotspot('look', w, h)).toEqual({ x: 24, y: 16 });
    expect(SPRITE_HOTSPOTS.use[0]).toBeGreaterThan(0.6);
    expect(SPRITE_HOTSPOTS.walk[0]).toBeGreaterThan(0.6);
  });

  it('leave a verb out when its sprite cannot be loaded', async () => {
    const doc = { createElement: () => ({ set src(_: string) {}, decode: () => Promise.reject(new Error('no image')) }) } as unknown as Document;
    expect(await loadSpriteCursors({ walk: panelCursorSource('walk', 'a'), look: panelCursorSource('look', 'b'), walk_lit: panelCursorSource('walk', 'c') }, doc)).toEqual({});
  });

  it('light up over something to act on: the lit sprite when there is one, else the plain one, else a brighter drawn ring', () => {
    const sprites = { look: { url: 'data:image/png;base64,AAAA', x: 24, y: 16 }, look_lit: { url: 'data:image/png;base64,BBBB', x: 24, y: 16 }, use: { url: 'data:image/png;base64,CCCC', x: 1, y: 1 } };
    expect(cursorCss('look', sprites, true)).toBe('url("data:image/png;base64,BBBB") 24 16, help');
    expect(cursorCss('look', sprites, false)).toBe('url("data:image/png;base64,AAAA") 24 16, help');
    // (no lit twin published for use: the plain one)
    expect(cursorCss('use', sprites, true)).toBe(cursorCss('use', sprites));
    // (drawn: a lit verb differs from the plain one; the arrow and hand do not light)
    for (const verb of ['walk', 'look', 'use', 'talk'] as const) expect(cursorImage(verb, true)).not.toBe(cursorImage(verb));
    expect(cursorCss('default', sprites, true)).toBe(cursorCss('default'));
  });

  it('draw the original\'s pointers at twice their size, clicking at its point', () => {
    // (published at 4x: 148 by 92 is the original\'s 37 by 23; the eye clicks at 18, 11 of its own pixels)
    const source = originalCursorSource('look.webp', 4, [18, 11]);
    expect(source.size(148, 92)).toEqual({ width: 74, height: 46 });
    expect(source.hotspot(74, 46)).toEqual({ x: 36, y: 22 });
  });
});
