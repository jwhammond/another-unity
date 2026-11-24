// SPDX-License-Identifier: GPL-3.0-or-later
import { Figure } from './Figure';

/** A `hotspots.*` picture: a room with the objects a player can click outlined. The outlines are the pickable objects, not what is live at entry. */
export function HotspotOverlay(p: { id: string }) {
  return (
    <figure class="lc-hotspots">
      <Figure id={p.id} alt="A room with the hotspots a player can click outlined in gold" ratio="4/3" />
      <figcaption>These are the hotspots a player can click: every pickable object in the room, outlined in gold.</figcaption>
    </figure>
  );
}
