// SPDX-License-Identifier: GPL-3.0-or-later
import type { AssetIndex } from '../view/assets';
import { loadHolodeckArt, type LoadedHolodeckArt } from '../view/holodeckArt';
import type { PresentationConfig } from '../view/package';

/** What the session lends the holodeck screen. */
export interface HolodeckHost {
  /** Whether the art is on (`&art=0` turns it off). */
  artOn(): boolean;
  presentation(): PresentationConfig;
  assets(): AssetIndex;
  /** Tells the panels something changed. */
  bump(): void;
  /** The browser's fetch of a URL's bytes; a test's own. */
  fetchBytes(url: string): Promise<Uint8Array>;
}

/** The holodeck's half of the ship port: the original's pictures, fetched on first use (null until they are loaded, and with the art off or unpublished). */
export function holodeckPort(host: HolodeckHost): { holodeckArt(): LoadedHolodeckArt | null } {
  let art: LoadedHolodeckArt | null = null;
  let loading = false;
  return {
    holodeckArt() {
      if (!host.artOn()) return null;
      if (!loading) {
        loading = true;
        loadHolodeckArt(host.presentation(), host.assets(), host.fetchBytes).then(loaded => {
          art = loaded;
          if (loaded) host.bump();
        }).catch((err: unknown) => console.warn('the holodeck art did not load', err));
      }
      return art;
    },
  };
}
