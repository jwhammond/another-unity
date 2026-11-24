// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { dialogHit, drawChoices, layoutChoices, wrapText, DIALOG_X, DIALOG_Y, type DialogArt } from './dialogLayout';
import { BitmapFont, IndexedScreen } from './indexed';

/** A colour font of 4-wide glyphs, `height` tall, every pixel of every glyph `colour` (so a string is a bar of 4 pixels a letter in that colour). */
function font(height: number, colour = 55): BitmapFont {
  const size = height * 4;
  const glyph = [4, ...Array<number>(size).fill(colour)];
  return new BitmapFont(new Uint8Array([1, height, 0x20, 0x7e, (size + 1) & 0xff, (size + 1) >> 8, 0, 1, 4, ...Array.from({ length: 0x5f }, () => glyph).flat()]));
}
/** dialog.mrg's 31 entries, each a solid picture of colour 100 + its number, sized as given (the others 2x2). */
function frames(sizes: Record<number, [number, number]> = {}): DialogArt['frames'] {
  return Array.from({ length: 31 }, (_, i) => { const [w, h] = sizes[i] ?? [2, 2]; return { width: w, height: h, pixels: new Uint8Array(w * h).fill(100 + i) }; });
}
const art = (sizes?: Record<number, [number, number]>): DialogArt => ({ frames: frames(sizes), normal: font(16, 55), highlight: font(16, 66) });

describe('wrapText', () => {
  const f = font(16);
  it('gives one line for text that fits, with its width, and nothing for the trailing newline', () => {
    expect(wrapText(f, 'ab cd\n', 313)).toEqual({ lines: ['ab cd'], width: 20 });
    expect(wrapText(f, '\n', 313)).toEqual({ lines: [], width: 0 });
  });
  it('breaks between words where the line would run past the width, and keeps a word wider than the box whole', () => {
    expect(wrapText(f, 'aaa bbb ccc\n', 24).lines).toEqual(['aaa', 'bbb', 'ccc']);
    expect(wrapText(f, 'aa bb cc\n', 24)).toEqual({ lines: ['aa bb', 'cc'], width: 20 });
    expect(wrapText(f, 'abcdefghij\n', 8).lines).toEqual(['abcdefghij']);
  });
});

describe('layoutChoices (initDialog and drawDialogWindow)', () => {
  const a = art({ 4: [8, 12], 5: [8, 12], 6: [10, 8], 7: [10, 8], 11: [20, 18], 13: [20, 18], 14: [20, 18], 16: [20, 18] });
  it('stacks the choices a line of 16 and a gap of 8 apart with a spacing line between them, from the dialog\'s corner', () => {
    const l = layoutChoices(a, ['One', 'Two', 'Three'], 0);
    expect(l.lines).toEqual([['One', ''], ['Two', ''], ['Three']]);
    expect(l.text.map(t => [t.choice, t.line, t.x, t.y])).toEqual([
      [0, 'One', DIALOG_X, 280], [0, '', DIALOG_X, 304], [1, 'Two', DIALOG_X, 320], [1, '', DIALOG_X, 344], [2, 'Three', DIALOG_X, 360],
    ]);
    // (the rows are 40 apart, as the original's: 286, 326, 366 on the turbolift's list)
    expect(l.rects.map(r => r[1])).toEqual([280, 320, 360]);
    expect(l.width).toBe(20);
    expect(l.rects[0]).toEqual([100, 280, 120, 320]);
  });
  it('is as tall as its lines, to 160 at the most, and then the rest scrolls', () => {
    const one = layoutChoices(a, ['One'], 0);
    expect(one.height).toBe(16);
    expect(one.moreBelow).toBe(false);
    const many = layoutChoices(a, Array.from({ length: 8 }, (_, i) => `C${i}`), 0);
    expect(many.height).toBe(160);
    expect(many.moreBelow).toBe(true);
    expect(many.text.length).toBeLessThan(many.lines.flat().length);
    const scrolled = layoutChoices(a, Array.from({ length: 8 }, (_, i) => `C${i}`), 2);
    // (two lines scrolled past: the first choice and its gap are gone, and the first rectangle is empty)
    expect(scrolled.rects[0]).toEqual([0, 0, 0, 0]);
    expect(scrolled.text[0]!.choice).toBe(1);
    expect(scrolled.upEntry).toBe(11);
    expect(many.upEntry).toBe(13);
    expect(many.downEntry).toBe(14);
    expect(one.downEntry).toBe(16);
  });
  it('frames the text 10 across and 20 above and below it, plus the borders, and puts the round buttons at the right, up above the middle and down below', () => {
    const l = layoutChoices(a, ['One', 'Two'], 0);
    // (x: from 100 - 10 - the left border (10) to 100 + 20 + 10 + the right border (10) + half a button (10) - 8; y: 280 - 20 - the top (8) to ... + 12)
    expect(l.frame[0]).toBe(100 - 10 - 10);
    expect(l.frame[2]).toBe(100 + l.width + 10 + 10 + 10 - 8);
    expect(l.frame[1]).toBe(280 - 20 - 8);
    expect(l.frame[3]).toBe(280 + l.height + 20 + 8);
    const mid = Math.trunc((l.frame[1] + l.frame[3]) / 2);
    expect(l.up[1] + 18).toBe(mid);
    expect(l.down[1]).toBe(mid);
    expect(l.up[0]).toBe(l.frame[2] - 10 - 5);
  });
});

describe('drawChoices', () => {
  const a = art({ 4: [8, 12], 5: [8, 12], 6: [10, 8], 7: [10, 8], 11: [20, 18], 13: [20, 18], 14: [20, 18], 16: [20, 18] });
  const px = (s: IndexedScreen, x: number, y: number) => s.pixels[y * 640 + x]!;
  it('draws the box black inside, the corners and the buttons, and the text in the normal font, the selected choice in the highlighted one', () => {
    const s = new IndexedScreen();
    s.fillRect(7, 0, 0, 640, 480);
    const l = layoutChoices(a, ['One', 'Two'], 0);
    drawChoices(s, a, l, 1);
    expect(px(s, l.frame[0], l.frame[1])).toBe(100);
    expect(px(s, l.frame[2] - 1, l.frame[3] - 1)).toBe(103);
    // inside the border, beside the text: black
    expect(px(s, 115, 300)).toBe(0);
    // the up button is greyed (13) with nothing scrolled, the down one too (16)
    expect(px(s, l.up[0], l.up[1])).toBe(113);
    expect(px(s, l.down[0], l.down[1])).toBe(116);
    // 'One' at 100, 280 in the normal font (55), 'Two' at 100, 320 in the highlighted one (66, selected)
    expect(px(s, 100, 280)).toBe(55);
    expect(px(s, 100, 320)).toBe(66);
    // (and a string is only as wide as its letters)
    expect(px(s, 100 + 11, 280)).toBe(55);
    expect(px(s, 100 + 11, 320)).toBe(66);
    expect(px(s, 100 + 12, 320)).toBe(0);
  });
  it('highlights only the selected choice, and none at -1', () => {
    const lit = (selected: number) => {
      const s = new IndexedScreen();
      const l = layoutChoices(a, ['One', 'Two'], 0);
      drawChoices(s, a, l, selected);
      return l.rects.map(r => s.pixels[r[1] * 640 + r[0]]!);
    };
    expect(lit(-1)).toEqual([55, 55]);
    expect(lit(0)).toEqual([66, 55]);
    expect(lit(1)).toEqual([55, 66]);
  });
});

describe('dialogHit', () => {
  const a = art({ 11: [20, 18], 13: [20, 18], 14: [20, 18], 16: [20, 18] });
  it('says which choice or scroll button a point is on', () => {
    const l = layoutChoices(a, ['One', 'Two'], 0);
    expect(dialogHit(l, 105, 285)).toEqual({ choice: 0 });
    expect(dialogHit(l, 105, 325)).toEqual({ choice: 1 });
    // (the gap between them belongs to the choice above, which includes its spacing line)
    expect(dialogHit(l, 105, 310)).toEqual({ choice: 0 });
    expect(dialogHit(l, l.up[0] + 1, l.up[1] + 1)).toEqual({ scroll: -1 });
    expect(dialogHit(l, l.down[0] + 1, l.down[1] + 1)).toEqual({ scroll: 1 });
    expect(dialogHit(l, 5, 5)).toBeNull();
    expect(dialogHit(l, 100, 280 + 200)).toBeNull();
  });
});
