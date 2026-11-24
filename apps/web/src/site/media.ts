// SPDX-License-Identifier: GPL-3.0-or-later
// The site's pictures: made from the local game data by `npm run site:media` (never committed), listed in /site-media/manifest.json.
// Without the manifest every Figure shows a placeholder and nothing else is requested.
import { useEffect, useState } from 'preact/hooks';

export type MediaEntry = { src: string; w: number; h: number; alt: string; kind: 'shot' | 'pair' | 'sheet' | 'portrait' | 'hotspots'; pairSrc?: string };
export type MediaManifest = { version: 1; built: string; items: Record<string, MediaEntry> };

const EMPTY: MediaManifest = { version: 1, built: '', items: {} };
let cache: Promise<MediaManifest> | null = null;
let loaded: MediaManifest | null = null;

/** The manifest, or an empty one on a 404, a non-JSON answer (a login page) or a failed request. Never throws. */
export async function loadMedia(fetchFn: typeof fetch = fetch): Promise<MediaManifest> {
  try {
    const r = await fetchFn('/site-media/manifest.json');
    if (!r.ok || !(r.headers.get('content-type') ?? '').includes('json')) return EMPTY;
    const m = (await r.json()) as MediaManifest;
    return m?.version === 1 && m.items ? m : EMPTY;
  } catch {
    return EMPTY;
  }
}

/** One entry: 'loading' until the manifest is in, then the entry or undefined. */
export function useMedia(id: string): MediaEntry | undefined | 'loading' {
  const [v, setV] = useState<MediaEntry | undefined | 'loading'>('loading');
  useEffect(() => {
    cache ??= loadMedia().then(m => (loaded = m));
    void cache.then(m => setV(m.items[id]));
  }, [id]);
  return v;
}

/** How many manifest ids start with a prefix: 'loading' until the manifest is in, 0 when there is none. */
export function useMediaCount(prefix: string): number | 'loading' {
  const [v, setV] = useState<number | 'loading'>('loading');
  useEffect(() => {
    cache ??= loadMedia().then(m => (loaded = m));
    void cache.then(m => setV(Object.keys(m.items).filter(k => k.startsWith(prefix)).length));
  }, [prefix]);
  return v;
}

/** The entry for an id once the manifest has loaded (through `useMedia`); undefined before that and for a missing id. */
export function media(id: string): MediaEntry | undefined {
  return loaded?.items[id];
}

/** Tests only: the manifest the hooks will see, instead of fetching one. */
export function primeMedia(manifest: MediaManifest): void {
  loaded = manifest;
  cache = Promise.resolve(manifest);
}
