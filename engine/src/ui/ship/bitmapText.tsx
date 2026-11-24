// SPDX-License-Identifier: GPL-3.0-or-later
import { useLayoutEffect, useMemo, useRef } from 'preact/hooks';
import { ASTRO_FONT, textImage, type AstroFace, type AstroFonts } from '../../view/bitmapText';
import { areaStyle } from './areas';

/**
 * A string in one of the game's own bitmap fonts, drawn at the pixel the original draws it from (`x`, `y` in its 640x480; `align` 'centre' puts `x` at the
 * middle), as a canvas of the string's own size that the box scales: the original's hard pixels stay hard. The words are in the page already (the control or
 * readout the text belongs to), so this is for the eye only.
 */
export function BitmapText({ fonts, face, text, x, y, align = 'left', colour, ink }: {
  fonts: AstroFonts; face: AstroFace; text: string; x: number; y: number; align?: 'left' | 'centre'; colour?: number | readonly [number, number, number];
  /** Draw the shapes in this colour, each pixel as strong as the font's own is bright: for a ground the font's blues do not read on. */
  ink?: readonly [number, number, number];
}) {
  const font = fonts.fonts[ASTRO_FONT[face]];
  const image = useMemo(() => (font ? textImage(font, text, fonts.palette, colour, ink) : null), [font, text, fonts.palette, colour, ink]);
  const canvas = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    if (!image) return;
    try {
      const context = canvas.current?.getContext('2d');
      if (context) context.putImageData(new ImageData(image.data as never, image.width, image.height), 0, 0);
    } catch {
      // (no canvas: the words are in the page)
    }
  }, [image]);
  if (!image) return null;
  const left = align === 'centre' ? x - (image.width >> 1) : x;
  return <canvas ref={canvas} class="au-bt" width={image.width} height={image.height} aria-hidden="true" data-bitmap-text={text} style={areaStyle([left, y, image.width, image.height])} />;
}
