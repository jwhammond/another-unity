// SPDX-License-Identifier: GPL-3.0-or-later
import type { AssetIndex } from '../view/assets';
import type { ArtPicture, ConsoleRepaint } from '../view/combat/spaceArt';
import { parseImagePack } from '../view/imagePack';
import type { PresentationConfig } from '../view/package';

/** What the session lends the console's repaint. */
export interface ConsoleRepaintHost {
  presentation(): PresentationConfig;
  assets(): AssetIndex;
  /** At low resolution (`res=half`) the plate is its half and the pictures are decoded at half their size. */
  lowRes(): boolean;
  bump(): void;
  warn(message: string): void;
  fetchBytes(url: string): Promise<Uint8Array>;
  /** A picture's bytes decoded at `size` (createImageBitmap's resize), for the art layer's canvas. */
  decode(bytes: Uint8Array, type: string, size: [number, number]): Promise<ArtPicture>;
  /** The plate at `url` fetched and decoded, so the console's `<img>` of it draws at once. Default: decodePlate. */
  loadPlate?(url: string): Promise<void>;
}

/** An image at `url` loaded and decoded by the browser (its cache then serves the console's `<img>`); nothing outside a browser. */
export async function decodePlate(url: string): Promise<void> {
  if (typeof Image === 'undefined') return;
  const img = new Image();
  img.src = url;
  await img.decode();
}

/**
 * The console's repaint (Plan 30 R7): `art.space.console`'s plate and pictures, fetched on first use while the art is on and kept for
 * the session, as the console's fonts are (the same every battle). Null until the pack and the plate have both decoded (so no cleared
 * pixel shows the view through a plate still loading), and null, said once, when it isn't published, names files the game lacks or
 * fails: the console is then the original's indices, as with the art off. A new presentation (art published mid-session) is asked again.
 */
export function consoleRepaintLoader(host: ConsoleRepaintHost): { repaint(): ConsoleRepaint | null; free(): void; bytes(): number } {
  let repaint: ConsoleRepaint | null = null;
  let askedOf: PresentationConfig | null = null;
  /** Bumped by `free`, so a load begun before it knows it is stale. */
  let generation = 0;
  // (ImageBitmaps hold their pixels until closed; a stub picture has nothing to close)
  const close = (images: Iterable<ArtPicture>) => { for (const p of images) (p as { close?(): void }).close?.(); };
  return {
    /** Closes every picture and forgets the plate (Plan 31 R3): the next `repaint()` loads them again. */
    free() {
      generation++;
      if (repaint) close(repaint.images.values());
      repaint = null;
      askedOf = null;
    },
    /** The pictures' decoded size, width × height × 4 summed (the plate is the browser's own image, not counted). */
    bytes() {
      let n = 0;
      if (repaint) for (const p of repaint.images.values()) n += p.width * p.height * 4;
      return n;
    },
    repaint() {
      const presentation = host.presentation();
      if (askedOf === presentation) return repaint;
      askedOf = presentation;
      repaint = null;
      const c = presentation.art?.space?.console;
      if (!c) return null;
      const low = host.lowRes();
      const plateFile = low && c.half ? c.half : c.plate;
      const plate = host.assets().url(plateFile), pack = host.assets().url(c.pack);
      if (!plate || !pack) {
        host.warn(`combat: art.space.console names files the game lacks (${[...(plate ? [] : [plateFile]), ...(pack ? [] : [c.pack])].join(', ')}): the console is the original's`);
        return null;
      }
      const mine = generation;
      const scale = low ? Math.max(1, c.scale / 2) : c.scale;
      Promise.all([host.fetchBytes(pack).then(async bytes => {
        const entries = parseImagePack(bytes);
        const images = new Map<number, ArtPicture>();
        await Promise.all(entries.map(async e => {
          const w = Math.round((e.width * scale) / c.scale), h = Math.round((e.height * scale) / c.scale);
          images.set(Number(e.name), await host.decode(e.bytes, e.type, [w, h]));
        }));
        return images;
      }), (host.loadPlate ?? decodePlate)(plate)]).then(([images]) => {
        // (a presentation that changed meanwhile has asked again, and a freed loader has let go: this one is stale, and closes what it made)
        if (askedOf !== presentation || generation !== mine) { close(images.values()); return; }
        const radar = c.areas.radar;
        repaint = { plate, images, scale, opaque: radar ? [radar] : [] };
        host.bump();
      }).catch((err: unknown) => host.warn(`combat: the console's repaint did not load (${err instanceof Error ? err.message : String(err)}): it is the original's`));
      return null;
    },
  };
}
