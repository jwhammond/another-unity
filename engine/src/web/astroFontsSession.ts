// SPDX-License-Identifier: GPL-3.0-or-later
import type { AssetIndex } from '../view/assets';
import { loadAstroFonts, type AstroFonts } from '../view/bitmapText';
import type { PresentationConfig } from '../view/package';

/** What the session lends astrogation's fonts. */
export interface AstroFontsHost {
  /** Whether the art is on (`&art=0` turns it off). */
  artOn(): boolean;
  presentation(): PresentationConfig;
  assets(): AssetIndex;
  /** Tells the panels something changed. */
  bump(): void;
  /** The browser's fetch of a URL's bytes; a test's own. */
  fetchBytes(url: string): Promise<Uint8Array>;
}

/** Astrogation's half of the ship port for text: the game's bitmap fonts and the screen's palette, fetched on first use (null until loaded, and with the art off or unpublished). */
export function astroFontsPort(host: AstroFontsHost): { astroFonts(): AstroFonts | null } {
  let fonts: AstroFonts | null = null;
  let loading = false;
  return {
    astroFonts() {
      if (!host.artOn()) return null;
      if (!loading) {
        loading = true;
        loadAstroFonts(host.presentation(), host.assets(), host.fetchBytes).then(loaded => {
          fonts = loaded;
          if (loaded) host.bump();
        }).catch((err: unknown) => console.warn('the astrogation fonts did not load', err));
      }
      return fonts;
    },
  };
}
