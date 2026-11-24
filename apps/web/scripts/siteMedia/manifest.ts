// SPDX-License-Identifier: GPL-3.0-or-later
import type { MediaEntry, MediaManifest } from '../../src/site/media';

export type { MediaEntry, MediaManifest };

export function newManifest(built = new Date().toISOString()): MediaManifest {
  return { version: 1, built, items: {} };
}

function inside(p: string): boolean {
  return p.startsWith('/site-media/') && !p.split('/').includes('..');
}

/** Adds one picture; a src outside /site-media/ or a repeated id is a bug in the build, not something to skip. */
export function addItem(m: MediaManifest, id: string, e: MediaEntry): void {
  if (!inside(e.src) || (e.pairSrc !== undefined && !inside(e.pairSrc))) throw new Error(`site media ${id}: path outside /site-media/: ${e.src} ${e.pairSrc ?? ''}`);
  if (id in m.items) throw new Error(`site media: duplicate id ${id}`);
  m.items[id] = e;
}

/** JSON with every key sorted, so two builds of the same pictures differ only in `built`. */
export function serialize(m: MediaManifest): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort((v as Record<string, unknown>)[k])])) : v;
  return JSON.stringify(sort(m), null, 2) + '\n';
}
