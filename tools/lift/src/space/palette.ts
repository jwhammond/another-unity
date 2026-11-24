// SPDX-License-Identifier: GPL-3.0-or-later
import { hasTexture, parseSpaceMaterials } from './materials';
import { decodeTexture } from './texture';

/** The space palette: the colours of enterprs.mtl's first texture, which TacticalScreen::start sets for the whole battle (tactical.cpp:271-276). Files by lowercase name. Null means there is no space palette and the space build stops (tactical.cpp:275-276 keeps whatever palette was set before: run-time state, no file holds it). */
export function spacePalette(files: ReadonlyMap<string, Uint8Array>): Uint8Array | null {
  const mtl = files.get('enterprs.mtl');
  const first = mtl ? parseSpaceMaterials(mtl)[0] : undefined;
  if (!first || !hasTexture(first)) return null;
  const bytes = files.get(first.texture.toLowerCase());
  return (bytes && decodeTexture(first.texture, bytes)?.palette) ?? null;
}
