// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The holodeck screen's own pictures (UnityEngine::runHolodeck, unity.cpp:379-426), published as the original has them: holodeck.rm (its 128
 * colours under standard.pal's) and dialog.mrg's 31 entries, which the choice dialog is framed with (drawDialogFrameAround), as indices with the
 * palette, and the game's bitmap fonts (the dialog draws in fonts 2 and 3, normal and highlighted). Drawn at run time from indices
 * (engine/src/view/dialogLayout.ts), as the engineering screen is. Local and git-ignored, like the rest of art/.
 */
import type { IndexedImage } from '../../../engine/src/view/indexed';
import { backgroundIndexed, publishFonts, publishPack, setArtKey } from './indexedart';
import { parseMrg } from './icon';

export interface HolodeckFiles {
  /** holodeck.rm. */
  rm: Uint8Array;
  /** dialog.mrg. */
  dialog: Uint8Array;
  standardPal: Uint8Array;
  /** font0.fon ... font9.fon, in order. */
  fonts: Uint8Array[];
}

/** dialog.mrg has 31 entries (unity.cpp drawDialogFrameAround asserts it). */
export const DIALOG_ENTRIES = 31;

/** The pack's entries: the background, then each of dialog.mrg's, so MRG entry `i` is the pack's `i + 1`. */
export function holodeckPictures(rm: Uint8Array, dialog: Uint8Array, standardPal: Uint8Array): { images: IndexedImage[]; palette: Uint8Array } {
  const { image, palette } = backgroundIndexed(rm, standardPal, 'holodeck.rm');
  const entries = parseMrg(dialog);
  if (entries.length !== DIALOG_ENTRIES) throw new Error(`dialog.mrg has ${entries.length} entries, not ${DIALOG_ENTRIES}`);
  return { images: [image, ...entries.map(e => ({ width: e.width, height: e.height, pixels: e.pixels.slice() }))], palette };
}

/** Publishes the pack, the palette and the fonts, and records them as presentation.yaml's `art.holodeck` and `art.fonts`. */
export async function publishHolodeck(gameDir: string, files: HolodeckFiles): Promise<string[]> {
  const { images, palette } = holodeckPictures(files.rm, files.dialog, files.standardPal);
  const published = await publishPack(gameDir, 'holodeck', 'holodeck', images, palette);
  const fonts = await publishFonts(gameDir, files.fonts);
  await setArtKey(gameDir, 'holodeck', published);
  await setArtKey(gameDir, 'fonts', { files: fonts });
  return [published.pack, published.palette, ...fonts];
}
