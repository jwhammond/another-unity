// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback } from 'preact/hooks';
import type { ShipPort } from '../../web/shipPort';
import { areaStyle } from './areas';

/**
 * The viewscreen (runViewscreen, unity.cpp:697): the hailing object's name, over the plate of viewscr.rm. With a plate, a 4:3
 * `.au-ship-screen` box registers where the session draws it (the picture is in its keyed window, drawn by the session), and the name sits
 * in the strip's text box (the `name` area). Without one it is a framed greybox with the name behind it. The hail's conversation itself
 * is the ordinary dialog, drawn over this by the game's UI.
 */
export function Viewscreen({ port }: { port: ShipPort }) {
  const view = port.viewscreen();
  const plate = view === null ? null : port.shipPlate('viewscreen');
  // (the box registers while it is up and goes with it, as the bridge's does)
  const screenRef = useCallback((el: HTMLDivElement | null) => port.screenRect(el ? () => el.getBoundingClientRect() : null), [port]);
  if (view === null) return null;
  if (plate !== null) {
    const name = plate.areas.name;
    return (
      <div class="au-ship-viewscreen au-ship-viewscreen-plate" role="region" aria-label="Viewscreen">
        <div class="au-ship-screen" ref={screenRef} style={{ aspectRatio: '640 / 480' }}>
          {name && <p class="au-area au-ship-viewscreen-name" data-area="name" style={areaStyle(name)}>{view.label}</p>}
        </div>
      </div>
    );
  }
  return (
    <div class="au-ship-viewscreen" role="region" aria-label="Viewscreen">
      <div class="au-ship-viewscreen-frame">
        <p class="au-ship-viewscreen-name">{view.label}</p>
      </div>
    </div>
  );
}
