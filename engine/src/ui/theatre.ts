// SPDX-License-Identifier: GPL-3.0-or-later
/** The class the page wears while a movie plays (base.css dims everything but the movie under it). */
export const THEATRE_CLASS = 'theatre';

/**
 * Theatre mode: `on` puts the class on the document's body, off takes it off. Driven from the one place a movie dialog
 * mounts and unmounts, so every cutscene gets it. Returns how to switch it off (for an unmount).
 */
export function setTheatre(doc: Document, on: boolean): () => void {
  doc.body.classList.toggle(THEATRE_CLASS, on);
  return () => doc.body.classList.remove(THEATRE_CLASS);
}
