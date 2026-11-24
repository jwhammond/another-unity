// SPDX-License-Identifier: GPL-3.0-or-later
import { Figure } from './Figure';

/** A sprite sheet (the build lays 12 frames out in 6 columns by 2 rows, so a missing one holds a roughly square place)  from the manifest at its own pixels (no smoothing), with a caption. */
export function SpriteSheet(p: { id: string; caption: string }) {
  return (
    <figure class="lc-sheet">
      <Figure id={p.id} alt={p.caption} ratio="1/1" pixelated />
      <figcaption>{p.caption}</figcaption>
    </figure>
  );
}
