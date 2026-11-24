// SPDX-License-Identifier: GPL-3.0-or-later
// content.pack, the deploy's text (unitySealed.ts): one JSON map of path to yaml, opened by the service worker on its way to the page.

/** What the page shows when content.pack arrives but isn't the text: still sealed (a worker of another build passed it through), or damaged. */
export const CONTENT_UNREADABLE = "The game's files didn't open: the offline worker may be out of date. Reload to try again.";

/** The map of path to yaml, or an error the player can act on (never the parser's, which would quote the bytes). */
export function parseContentPack(text: string): Record<string, string> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(CONTENT_UNREADABLE);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(CONTENT_UNREADABLE);
  return value as Record<string, string>;
}
