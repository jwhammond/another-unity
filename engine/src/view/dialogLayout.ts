// SPDX-License-Identifier: GPL-3.0-or-later
import type { BitmapFont, IndexedImage, IndexedScreen } from './indexed';

/**
 * The original's choice dialog (UnityEngine::runChoice: initDialog, drawDialogFrameAround and drawDialogWindow, unity.cpp:1475-1700) drawn from
 * dialog.mrg and fonts 2 (normal) and 3 (highlighted) onto an indexed screen: a black box framed by the MRG's borders and corners, the choices a
 * line at a time with a gap between them, and the round scroll buttons at the right. Pure; the holodeck uses it for its list of movies.
 */

/** Where the dialog comes up (`_dialog_x`, `_dialog_y`, unity.cpp:117) and the widest its text goes (initDialog's maxWidth). */
export const DIALOG_X = 100, DIALOG_Y = 280, MAX_WIDTH = 313;
/** The gap between a choice's lines (drawDialogWindow's fontSpacing) and the most height the choices have. */
const FONT_SPACING = 8, MAX_HEIGHT = 160;

export const NORMAL_FONT = 2, HIGHLIGHT_FONT = 3;

export type Rect = [number, number, number, number];

/** What the dialog draws with: dialog.mrg's 31 entries (`frames[i]` is entry i) and the two fonts. */
export interface DialogArt {
  frames: readonly IndexedImage[];
  normal: BitmapFont;
  highlight: BitmapFont;
}

/** Font::wordWrapText for text that is a choice and a newline: the lines, greedy by words, and the width of the widest. */
export function wrapText(font: BitmapFont, text: string, maxWidth: number): { lines: string[]; width: number } {
  const lines: string[] = [];
  let width = 0;
  for (const paragraph of text.split('\n')) {
    let line = '';
    let lineWidth = 0;
    for (const word of paragraph.split(' ')) {
      const trial = line === '' ? word : `${line} ${word}`;
      const w = font.stringWidth(trial);
      if (line !== '' && w > maxWidth) {
        lines.push(line);
        width = Math.max(width, lineWidth);
        line = word;
        lineWidth = font.stringWidth(word);
      } else {
        line = trial;
        lineWidth = w;
      }
    }
    // (the text ends in a newline: the empty last paragraph adds no line)
    if (line !== '') {
      lines.push(line);
      width = Math.max(width, lineWidth);
    }
  }
  return { lines, width };
}

export interface DialogLayout {
  /** Each choice's lines (a gap line after all but the last), as initDialog makes them. */
  lines: string[][];
  width: number;
  height: number;
  /** The frame's outer corners and the scroll buttons' places, from drawDialogFrameAround. */
  frame: Rect;
  up: Rect;
  down: Rect;
  /** What is drawn: each line's text and top left, by choice, and each choice's clickable rectangle (empty ones are scrolled past). */
  text: { choice: number; line: string; x: number; y: number }[];
  rects: Rect[];
  /** Whether choices run on below the box. */
  moreBelow: boolean;
  /** The entries the buttons are drawn with (up and down, normal, highlighted or greyed: 11 to 16). */
  upEntry: number;
  downEntry: number;
}

/**
 * Lays the dialog out: initDialog's wrapping and spacing, drawDialogWindow's height, text positions and scrolling, and drawDialogFrameAround's frame and
 * buttons (the plain frame, entries 0 to 16, with the buttons). `startLine` is how many lines are scrolled past.
 */
export function layoutChoices(art: DialogArt, choices: readonly string[], startLine: number): DialogLayout {
  const widths = art.frames.map(f => f.width), heights = art.frames.map(f => f.height);
  const fontHeight = art.normal.height;

  // initDialog
  const lines: string[][] = [];
  let width = 0;
  choices.forEach((choice, i) => {
    const wrapped = wrapText(art.normal, `${choice}\n`, MAX_WIDTH);
    width = Math.max(width, wrapped.width);
    // (an empty spacing line, but after the last)
    if (i !== choices.length - 1 && (wrapped.lines.length === 0 || wrapped.lines[wrapped.lines.length - 1] !== '')) wrapped.lines.push('');
    lines.push(wrapped.lines);
  });

  // drawDialogWindow's height
  let height = 0;
  for (const l of lines) {
    height += l.length * fontHeight;
    if (l.length) height += (l.length - 1) * FONT_SPACING;
  }
  height = Math.min(height, MAX_HEIGHT);

  // the text, and whether it runs on
  const text: DialogLayout['text'] = [];
  const rects: Rect[] = [];
  let y = DIALOG_Y;
  let moreBelow = false;
  let linesSeen = 0;
  for (let j = 0; j < lines.length; j++) {
    const own = lines[j]!;
    // (skipping the lines scrolled past)
    let begin = 0;
    if (linesSeen < startLine) begin = Math.min(startLine - linesSeen, own.length);
    linesSeen += own.length;
    if (begin === own.length) { rects.push([0, 0, 0, 0]); continue; }
    const oldY = y;
    for (let i = begin; i < own.length; i++) {
      if (y - DIALOG_Y + fontHeight > height) {
        // done drawing (but there is more to scroll to)
        j = lines.length;
        moreBelow = true;
        break;
      }
      text.push({ choice: rects.length, line: own[i]!, x: DIALOG_X, y });
      y += fontHeight;
      if (i !== own.length - 1) y += FONT_SPACING;
    }
    rects.push([DIALOG_X, oldY, DIALOG_X + width, y]);
  }

  // drawDialogFrameAround (not thick, no icon, with the buttons)
  const base = 0;
  let x1 = DIALOG_X - 10, x2 = DIALOG_X + width + 10, y1 = DIALOG_Y - 20, y2 = DIALOG_Y + height + 20;
  y1 -= widths[base + 4]!;
  y2 += widths[base + 5]!;
  x1 -= widths[base + 6]!;
  x2 += widths[base + 7]!;
  x2 += Math.trunc(widths[11]! / 2) - 8;
  const upEntry = startLine ? 11 : 13, downEntry = moreBelow ? 14 : 16;
  const upX = x2 - Math.trunc(widths[upEntry]! / 2) - Math.trunc(widths[base + 7]! / 2), upY = Math.trunc((y1 + y2) / 2) - heights[upEntry]!;
  const downX = x2 - Math.trunc(widths[downEntry]! / 2) - Math.trunc(widths[base + 7]! / 2), downY = Math.trunc((y1 + y2) / 2);
  return {
    lines, width, height, frame: [x1, y1, x2, y2], text, rects, moreBelow, upEntry, downEntry,
    up: [upX, upY, upX + widths[upEntry]!, upY + heights[upEntry]!],
    down: [downX, downY, downX + widths[downEntry]!, downY + heights[downEntry]!],
  };
}

/**
 * Draws the choice dialog on the screen: the frame (drawDialogFrameAround), then the choices, the one at `selected` in the highlighted font
 * (index -1 for none), and the buttons last, as the original's frame draws them.
 */
export function drawChoices(screen: IndexedScreen, art: DialogArt, layout: DialogLayout, selected: number): void {
  const w = (i: number) => art.frames[i]!.width, h = (i: number) => art.frames[i]!.height;
  const [x1, y1, x2, y2] = layout.frame;
  const base = 0;
  const frame = (i: number, x: number, y: number) => screen.blit(art.frames[i]!, x, y);
  // black background inside the border (the arguments mix widths and heights, as the original's do)
  screen.fillRect(0, x1 + w(base + 4), y1 + h(base + 6), x2 - w(base + 5), y2 - h(base + 7));
  // top
  let bx = x1 + w(base + 0);
  for (; bx + w(base + 4) < x2 - w(base + 1); bx += w(base + 4)) frame(base + 4, bx, y1);
  frame(base + 4, x2 - w(base + 1) - w(base + 4), y1);
  // bottom
  for (bx = x1 + w(base + 2); bx + w(base + 5) < x2 - w(base + 3); bx += w(base + 5)) frame(base + 5, bx, y2 - h(base + 5));
  frame(base + 5, x2 - w(base + 3) - w(base + 5), y2 - h(base + 5));
  // left
  let by = y1 + h(base + 0);
  for (; by + h(base + 6) < y2 - h(base + 2); by += h(base + 6)) frame(base + 6, x1, by);
  frame(base + 6, x1, y2 - h(base + 2) - h(base + 6));
  // right
  for (by = y1 + h(base + 1); by + h(base + 7) < y2 - h(base + 3); by += h(base + 7)) frame(base + 7, x2 - w(base + 7), by);
  frame(base + 7, x2 - w(base + 7), y2 - h(base + 3) - h(base + 7));
  // corners
  frame(base + 0, x1, y1);
  frame(base + 1, x2 - w(base + 1), y1);
  frame(base + 2, x1, y2 - h(base + 2));
  frame(base + 3, x2 - w(base + 3), y2 - h(base + 3));
  // the scroll buttons
  frame(layout.upEntry, layout.up[0], layout.up[1]);
  frame(layout.downEntry, layout.down[0], layout.down[1]);
  // the text
  for (const t of layout.text) screen.drawString(t.choice === selected ? art.highlight : art.normal, t.x, t.y, t.line, 0);
}

/** What a click or the pointer at a point is on in the dialog: a choice, a scroll button, or nothing. */
export function dialogHit(layout: DialogLayout, x: number, y: number): { choice: number } | { scroll: -1 | 1 } | null {
  const inside = (r: Rect) => x >= r[0] && x < r[2] && y >= r[1] && y < r[3];
  if (inside(layout.up)) return { scroll: -1 };
  if (inside(layout.down)) return { scroll: 1 };
  for (let i = 0; i < layout.rects.length; i++) if (inside(layout.rects[i]!)) return { choice: i };
  return null;
}
