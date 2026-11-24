// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { Rgba } from './image';
import { crewMattes, cutsFor, CREW_CUTS, prepareCrewFrame } from './crewframe';

const blank = (w: number, h: number): Rgba => ({ width: w, height: h, data: new Uint8Array(w * h * 4) });
const put = (img: Rgba, x: number, y: number, rgba: number[]): void => img.data.set(rgba, (y * img.width + x) * 4);
const px = (img: Rgba, x: number, y: number): number[] => [...img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];

describe('prepareCrewFrame', () => {
  it('drops a lone near-black speck and thins the dark rim by a pixel, keeping bright pixels and the dark inside', () => {
    const img = blank(9, 9);
    put(img, 1, 1, [0, 0, 0, 255]);                                  // a speck: all neighbours empty
    for (let x = 3; x < 8; x++) for (let y = 3; y < 8; y++) put(img, x, y, [200, 40, 40, 255]);
    for (let x = 3; x < 8; x++) (put(img, x, 3, [0, 0, 0, 255]), put(img, x, 4, [0, 0, 0, 255]));   // a two-pixel dark rim along the top
    const out = prepareCrewFrame(img);
    expect(px(out, 1, 1)[3]).toBe(0);
    expect(px(out, 5, 3)[3]).toBe(0);                                  // the outer row of the rim goes
    expect(px(out, 5, 4)).toEqual([0, 0, 0, 255]);                     // the row inside it stays
    // (a strip frame, with its mask: what is left of the rim takes the colour inside it, and the dropped row its colour with it)
    const all = new Uint8Array(81).fill(1);
    all[1 * 9 + 1] = 0;
    const strip = prepareCrewFrame(img, undefined, all);
    expect(px(strip, 5, 4)).toEqual([200, 40, 40, 255]);
    expect(px(strip, 5, 3)[3]).toBe(0);
    expect(px(out, 5, 5)).toEqual([200, 40, 40, 255]);
  });

  it('takes the steel-blue ring the figure was cut from, but not skin, hair or a blue uniform', () => {
    const img = blank(14, 14);
    for (let x = 4; x < 12; x++) for (let y = 4; y < 12; y++) put(img, x, y, [156, 92, 68, 255]);   // skin
    for (let x = 3; x < 13; x++) put(img, x, 3, [80, 80, 104, 255]);                                    // the ring above it, two deep
    for (let x = 3; x < 13; x++) put(img, x, 2, [80, 96, 132, 255]);
    for (let y = 4; y < 12; y++) put(img, 3, y, [150, 150, 150, 255]);                                   // grey hair beside it
    const out = prepareCrewFrame(img);
    expect(px(out, 7, 2)[3]).toBe(0);
    expect(px(out, 7, 3)[3]).toBe(0);
    expect(px(out, 7, 5)).toEqual([156, 92, 68, 255]);
    expect(px(out, 3, 7)[3]).toBe(255);
    const troi = blank(12, 12);
    for (let x = 2; x < 10; x++) for (let y = 2; y < 10; y++) put(troi, x, y, [30, 100, 190, 255]);
    const kept = prepareCrewFrame(troi);
    expect(px(kept, 2, 2)[3]).toBe(255);
    expect(px(kept, 5, 5)).toEqual([30, 100, 190, 255]);
  });

  it('gives the empty pixels beside the figure the figure\'s colour, still empty, so filtering leaves no dark halo', () => {
    const img = blank(7, 7);
    for (let x = 2; x < 5; x++) for (let y = 2; y < 5; y++) put(img, x, y, [200, 40, 40, 255]);
    const out = prepareCrewFrame(img);
    expect(px(out, 1, 3)).toEqual([200, 40, 40, 0]);
    expect(px(out, 0, 0)[3]).toBe(0);
  });

  it('makes the pixels that equal the original picture transparent, keeps the figure and a matching hole inside it', () => {
    const bg = blank(20, 20);
    for (let i = 0; i < 400; i++) bg.data.set([30, 60, 90, 255], i * 4);
    const img = blank(10, 10);
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) put(img, x, y, [30, 60, 90, 255]);          // all picture...
    for (let y = 2; y < 8; y++) for (let x = 2; x < 8; x++) put(img, x, y, [200, 40, 40, 255]);            // ...but a figure
    put(img, 4, 4, [30, 60, 90, 255]);                                                                      // with a hole that matches
    const out = prepareCrewFrame(img, { pixels: bg, left: 5, top: 5 });
    expect(px(out, 0, 0)[3]).toBe(0);
    expect(px(out, 4, 4)[3]).toBe(255);
    expect(px(out, 5, 5)[3]).toBe(255);
  });

  it('a still (no matte) keeps its colour matte: takes a light patch the figure encloses (the carpet between the legs) and a pale rim near the picture, in a frame with its own cut-out, but not its black parts', () => {
    const bg = blank(40, 40);
    for (let i = 0; i < 1600; i++) bg.data.set([20, 20, 20, 255], i * 4);
    for (let y = 0; y < 40; y++) for (let x = 20; x < 40; x++) bg.data.set([150, 170, 220, 255], (y * 40 + x) * 4);       // a black display, then carpet
    const img = blank(40, 40);                                   // mostly empty: it has its own cut-out
    for (let y = 5; y < 35; y++) for (let x = 8; x < 32; x++) put(img, x, y, [200, 40, 40, 255]);                       // a red figure
    for (let y = 12; y < 30; y++) for (let x = 24; x < 29; x++) put(img, x, y, [152, 172, 222, 255]);                   // carpet showing between its legs (5x18, enclosed)
    for (let y = 5; y < 35; y++) put(img, 31, y, [150, 168, 216, 255]);                                                  // a one pixel pale rim on the carpet side
    for (let y = 5; y < 12; y++) for (let x = 10; x < 16; x++) put(img, x, y, [20, 20, 20, 255]);                      // a black shoulder over the black display
    put(img, 26, 8, [152, 172, 222, 255]);                                                                                // one light dither dot: stays
    const out = prepareCrewFrame(img, { pixels: bg, left: 0, top: 0 });
    expect(px(out, 26, 20)[3]).toBe(0);                          // the patch goes
    expect(px(out, 31, 20)[3]).toBe(0);                          // the pale rim goes
    expect(px(out, 12, 8)[3]).toBe(255);                         // the black shoulder stays
    expect(px(out, 12, 20)).toEqual([200, 40, 40, 255]);
    expect(px(out, 26, 8)[3]).toBe(255);                         // a lone dot is the figure's own
  });

  it('takes a light gap a moving figure opens (the carpet between the legs) and a pale rim by its own cut-out, but not its black parts', () => {
    const bg = blank(40, 40);
    for (let i = 0; i < 1600; i++) bg.data.set([20, 20, 20, 255], i * 4);
    for (let y = 0; y < 40; y++) for (let x = 20; x < 40; x++) bg.data.set([150, 170, 220, 255], (y * 40 + x) * 4);       // a black display, then carpet
    const frame = (gap: boolean): Rgba => {
      const img = blank(40, 40);                                 // mostly empty: it has its own cut-out
      for (let y = 5; y < 35; y++) for (let x = 8; x < 32; x++) put(img, x, y, [200, 40, 40, 255]);                     // a red figure
      if (gap) for (let y = 12; y < 30; y++) for (let x = 24; x < 29; x++) put(img, x, y, [152, 172, 222, 255]);        // the carpet between its legs (5x18, enclosed)
      for (let y = 5; y < 35; y++) put(img, 31, y, gap ? [150, 168, 216, 255] : [200, 40, 40, 255]);                    // a pale rim on the carpet side
      for (let y = 5; y < 12; y++) for (let x = 10; x < 16; x++) put(img, x, y, gap ? [34, 32, 30, 255] : [40, 36, 30, 255]);   // a black shoulder over the black display (it moves)
      put(img, 26, 8, gap ? [152, 172, 222, 255] : [200, 40, 40, 255]);                                                  // one light dither dot: stays
      return img;
    };
    const frames = [frame(true), frame(false)];
    const [m] = crewMattes(frames.map(img => ({ img, left: 0, top: 0 })), bg);
    const out = prepareCrewFrame(frames[0]!, { pixels: bg, left: 0, top: 0 }, m);
    expect(px(out, 26, 20)[3]).toBe(0);                          // the gap goes
    expect(px(out, 31, 20)[3]).toBe(0);                          // the pale rim goes
    expect(px(out, 12, 8)[3]).toBe(255);                         // the black shoulder stays
    expect(px(out, 12, 20)).toEqual([200, 40, 40, 255]);
    expect(px(out, 26, 8)[3]).toBe(255);                         // a lone dot is the figure's own
  });
});

describe('crewMattes', () => {
  // (a 30x30 picture: dark on the left, a pale pillar on the right; frames are drawn over all of it, as the original's still crew are)
  const picture = (): Rgba => {
    const bg = blank(30, 30);
    for (let y = 0; y < 30; y++) for (let x = 0; x < 30; x++) bg.data.set(x < 15 ? [20, 20, 20, 255] : [225, 215, 195, 255], (y * 30 + x) * 4);
    return bg;
  };
  const over = (bg: Rgba): Rgba => ({ width: bg.width, height: bg.height, data: new Uint8Array(bg.data) });
  const box = (img: Rgba, x0: number, y0: number, x1: number, y1: number, rgba: number[]): void => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) put(img, x, y, rgba); };
  const at = (m: Uint8Array, x: number, y: number): number => m[y * 30 + x]!;

  it('a dark figure pixel over a dark background is kept', () => {
    // (a figure whose dark belt (within 36 of the black display, which the colour matte took) runs out to the picture beside it)
    const bg = picture();
    const frames = [0, 1].map(i => {
      const img = over(bg);
      box(img, 6, 4, 14, 26, [200, 160, 40, 255]);              // a gold tunic
      box(img, 2, 14, 14, 17, [44, 40, 34, 255]);               // a dark belt over the display, reaching the frame's left border
      put(img, 10, 6, i ? [190, 150, 30, 255] : [200, 160, 40, 255]);   // something moves
      return img;
    });
    const m = crewMattes(frames.map(img => ({ img, left: 0, top: 0 })), bg);
    for (const f of m) {
      expect(at(f, 3, 15)).toBe(1);                             // the belt, still, by the border
      expect(at(f, 10, 15)).toBe(1);
      expect(at(f, 1, 1)).toBe(0);                              // the display itself
      expect(at(f, 25, 25)).toBe(0);                            // the pillar
    }
  });

  it('a pale face over a pale pillar is kept', () => {
    const bg = picture();
    const frames = [0, 1].map(i => {
      const img = over(bg);
      box(img, 17, 3, 27, 14, [60, 40, 30, 255]);               // hair round the face (its outline)
      box(img, 18, 5, 26, 13, [205, 190, 165, 255]);            // the face: within 36 of the pillar, its edge at the pillar's
      box(img, 21, 13, 22, 14, [225, 215, 195, 255]);           // a one-pixel gap in the outline under the chin, open to the pillar
      box(img, 21, 8, 23, 10, [225, 215, 195, 255]);            // a patch the pillar's very colour inside the face, enclosed
      put(img, 20, 7, i ? [40, 30, 30, 255] : [205, 190, 165, 255]);   // an eye that blinks
      return img;
    });
    const m = crewMattes(frames.map(img => ({ img, left: 0, top: 0 })), bg);
    for (const f of m) {
      for (const [x, y] of [[18, 5], [25, 12], [21, 12], [22, 9], [20, 7]] as const) expect(at(f, x, y)).toBe(1);
      expect(at(f, 21, 13)).toBe(1);                            // the one-pixel gap in the outline is closed
      expect(at(f, 28, 20)).toBe(0);
    }
  });

  it('only the traced foreground furniture is cut', () => {
    const bg = picture();
    for (let y = 18; y < 20; y++) for (let x = 0; x < 30; x++) bg.data.set([180, 120, 60, 255], (y * 30 + x) * 4);   // a rail across the picture
    const frames = [0, 1].map(i => {
      const img = over(bg);
      box(img, 5, 4, 25, 28, [30, 60, 160, 255]);               // a blue figure behind the rail...
      box(img, 0, 18, 30, 20, [180, 120, 60, 255]);             // ...which crosses it (the rail's own pixels, still)
      box(img, 9, 8, 12, 10, [225, 215, 195, 255]);             // and a pale patch the pillar's colour, enclosed: the figure's own
      box(img, 5, 18, 8, 20, [30, 60, 160, 255]);               // a hand over the rail, still
      put(img, 15, 6, i ? [30, 60, 170, 255] : [30, 60, 160, 255]);
      put(img, 20, 19, i ? [30, 60, 160, 255] : [180, 120, 60, 255]);   // and an arm that crosses the rail in one frame
      return img;
    });
    const rail: [number, number][] = [[10, 18], [30, 18], [30, 20], [10, 20]];
    const m = crewMattes(frames.map(img => ({ img, left: 0, top: 0 })), bg, [rail]);
    for (const f of m) {
      expect(at(f, 15, 19)).toBe(0);                            // the traced rail goes
      expect(at(f, 6, 19)).toBe(1);                             // the hand beside it, outside the trace, stays
      expect(at(f, 10, 9)).toBe(1);                             // the pale patch, not traced, stays
      expect(at(f, 15, 12)).toBe(1);
    }
    expect(at(m[1]!, 20, 19)).toBe(1);                          // a moving pixel in the trace is the figure's
    const untraced = crewMattes(frames.map(img => ({ img, left: 0, top: 0 })), bg);
    expect(at(untraced[0]!, 15, 19)).toBe(1);                   // without the trace, the rail (two pixels, closed over) would stay
  });

  it('keeps a moving sleeve that is near a red-brown wall\'s colour throughout (not a gap)', () => {
    const bg = blank(30, 30);
    for (let i = 0; i < 900; i++) bg.data.set([80, 44, 32, 255], i * 4);
    const frames = [0, 1].map(i => {
      const img = blank(30, 30);
      for (let y = 4; y < 26; y++) for (let x = 4; x < 26; x++) put(img, x, y, [30, 30, 30, 255]);       // a dark figure, cut out by hand
      for (let y = 8; y < 16; y++) for (let x = 8; x < 16; x++) put(img, x, y, i ? [120, 20, 20, 255] : [118, 22, 22, 255]);   // a red sleeve, 40 from the wall
      return img;
    });
    const m = crewMattes(frames.map(img => ({ img, left: 0, top: 0 })), bg);
    expect(at(m[0]!, 11, 11)).toBe(1);
  });

  it('a still sleeve within 24 of the picture at the border is cut (the accepted limit), one just past it is kept', () => {
    // (nothing in the frames tells a still part that is the picture's colour from the picture, when it reaches the frame's border)
    const bg = picture();
    const frames = (sleeve: number[]) => [0, 1].map(i => {
      const img = over(bg);
      box(img, 6, 4, 14, 26, [40, 90, 200, 255]);               // a blue figure
      box(img, 14, 10, 30, 13, sleeve);                         // a still sleeve out over the pillar, to the frame's right border
      put(img, 10, 6, i ? [40, 90, 210, 255] : [40, 90, 200, 255]);
      return img;
    });
    const near = crewMattes(frames([205, 195, 175, 255]).map(img => ({ img, left: 0, top: 0 })), bg);   // 20 from the pillar
    const far = crewMattes(frames([200, 190, 170, 255]).map(img => ({ img, left: 0, top: 0 })), bg);    // 25 from it
    expect(at(near[0]!, 25, 11)).toBe(0);
    expect(at(near[0]!, 10, 15)).toBe(1);
    expect(at(far[0]!, 25, 11)).toBe(1);
  });

  it('a region protected by enclosure is kept, however near the picture', () => {
    const bg = picture();
    const frames = [0, 1].map(i => {
      const img = over(bg);
      box(img, 16, 4, 28, 20, [60, 40, 30, 255]);               // a dark outline round...
      box(img, 17, 5, 27, 19, [225, 215, 195, 255]);            // ...a still patch the pillar's very colour
      put(img, 20, 10, i ? [200, 160, 140, 255] : [225, 215, 195, 255]);
      return img;
    });
    const m = crewMattes(frames.map(img => ({ img, left: 0, top: 0 })), bg);
    for (const f of m) for (const [x, y] of [[17, 5], [26, 18], [22, 12]] as const) expect(at(f, x, y)).toBe(1);
  });

  it('the lamp beside a figure is not kept in its matte', () => {
    // (a still body, a head that moves in every pixel (it turns, reaching a pixel higher in frame 1 and lower in frame 2), and a bright lamp of
    // the picture's that bridge.png doesn't match, the same in every frame, sitting on the head's top edge. The lamp is a cup: the picture inside
    // it, over the head in frames 0 and 2, is walled in by it)
    const bg = picture();
    const frames = [0, 1, 2].map(i => {
      const img = over(bg);
      box(img, 4, 14, 14, 28, [200, 160, 40, 255]);             // the body, still
      box(img, 6, 6 + (i === 2 ? 1 : 0), 12, 14, i === 1 ? [190, 150, 130, 255] : [210, 170, 150, 255]);   // the head
      if (i === 1) box(img, 7, 5, 11, 6, [190, 150, 130, 255]);
      box(img, 6, 2, 12, 5, [255, 170, 40, 255]);               // the lamp, on the head's top edge...
      box(img, 6, 5, 7, 6, [255, 170, 40, 255]);                // ...a cup round the picture over the head
      box(img, 11, 5, 12, 6, [255, 170, 40, 255]);
      put(img, 5, 1, [255, 170, 40, 255]);                      // a speck of it, touching the lamp only at a corner
      put(img, 5, 6, [255, 170, 40, 255]);                      // a speck at the head's top left corner, beside the head
      return img;
    });
    const m = crewMattes(frames.map(img => ({ img, left: 0, top: 0 })), bg);
    m.forEach((f, i) => {
      for (const [x, y] of [[6, 2], [11, 4], [6, 5], [11, 5], [5, 1], [5, 6]] as const) expect(at(f, x, y)).toBe(0);
      expect(at(f, 8, 5)).toBe(i === 1 ? 1 : 0);                // the picture the lamp walled in goes; the head there stays
      for (const [x, y] of [[8, 8], [6, 13], [10, 20]] as const) expect(at(f, x, y)).toBe(1);
    });
  });

  it('takes the light rim the lamp leaves, as the frame\'s own cut-out\'s', () => {
    // (the same over the pale pillar: the picture the lamp walls in is a little off the pillar's colour here, as a rim is)
    const bg = picture();
    const frames = [0, 1].map(i => {
      const img = over(bg);
      box(img, 19, 14, 29, 28, [40, 90, 200, 255]);             // the body, still
      box(img, 21, 6, 27, 14, i ? [150, 110, 90, 255] : [170, 130, 110, 255]);   // the head
      box(img, 22, 5, 26, 6, i ? [150, 110, 90, 255] : [205, 200, 180, 255]);    // in frame 0, a rim 20 off the pillar over it
      box(img, 21, 2, 27, 5, [255, 120, 0, 255]);               // the lamp's cup
      box(img, 21, 5, 22, 6, [255, 120, 0, 255]);
      box(img, 26, 5, 27, 6, [255, 120, 0, 255]);
      return img;
    });
    const m = crewMattes(frames.map(img => ({ img, left: 0, top: 0 })), bg);
    expect(at(m[0]!, 23, 5)).toBe(0);
    expect(at(m[1]!, 23, 5)).toBe(1);
    for (const f of m) expect(at(f, 23, 3)).toBe(0);
  });

  it('takes the lamp\'s dark housing, the picture\'s colour, in a frame cut round the figure, but not dark hair beside the lamp', () => {
    // (frames cut out by hand, over the dark half of the picture: a dark moving pixel is normally the figure's own there)
    const bg = picture();
    const frames = [0, 1, 2].map(i => {
      const img = blank(30, 30);
      box(img, 4, 14, 14, 28, [200, 160, 40, 255]);             // the body, still
      box(img, 6, 6, 13, 14, i === 1 ? [190, 150, 130, 255] : [210, 170, 150, 255]);   // the head, moving
      box(img, 7, 3, 12, 6, [255, 170, 40, 255]);               // the lamp, still, on the head's top edge
      put(img, 6, 5, i === 1 ? [24, 24, 24, 255] : [20, 20, 20, 255]);   // its dark housing beside it: the picture's colour, moving
      put(img, 12, 5, i === 1 ? [62, 42, 32, 255] : [60, 40, 30, 255]);  // dark hair beside it, on the head, moving
      return img;
    });
    const m = crewMattes(frames.map(img => ({ img, left: 0, top: 0 })), bg);
    for (const f of m) {
      expect(at(f, 9, 4)).toBe(0);                              // the lamp
      expect(at(f, 6, 5)).toBe(0);                              // its housing
      expect(at(f, 12, 5)).toBe(1);                             // the hair
      expect(at(f, 9, 9)).toBe(1);
    }
  });

  it('keeps a still part of the figure that touches its moving part from the side or below', () => {
    // (hair that never moves beside a face that does, and a still collar under it: the figure's own)
    const bg = picture();
    const frames = [0, 1].map(i => {
      const img = over(bg);
      box(img, 4, 14, 14, 28, [200, 160, 40, 255]);
      box(img, 7, 6, 12, 14, i ? [190, 150, 130, 255] : [210, 170, 150, 255]);   // the face moves
      box(img, 5, 4, 7, 14, [60, 40, 30, 255]);                 // hair at its side, still, up to above it
      return img;
    });
    const m = crewMattes(frames.map(img => ({ img, left: 0, top: 0 })), bg);
    for (const f of m) for (const [x, y] of [[5, 4], [6, 10], [9, 9], [9, 20]] as const) expect(at(f, x, y)).toBe(1);
  });

  it('traces only the sprite they were traced for', () => {
    expect(CREW_CUTS.length).toBeGreaterThan(0);
    for (const c of CREW_CUTS) expect(cutsFor(c.sprite.toUpperCase())).toContainEqual(c.poly);
    expect(cutsFor('nobody.spr')).toEqual([]);
  });
});
