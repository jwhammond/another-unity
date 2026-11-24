// SPDX-License-Identifier: GPL-3.0-or-later
import { useMedia } from '../media';

/** A picture from the site-media manifest, or a quiet placeholder: never an <img> for an id the manifest lacks. */
export function Figure(p: { id: string; alt: string; ratio: string; pixelated?: boolean }) {
  const m = useMedia(p.id);
  if (m === 'loading') return <div class="lc-noimg is-loading" style={{ aspectRatio: p.ratio }} aria-hidden="true" />;
  if (!m)
    return (
      <div class="lc-noimg" style={{ aspectRatio: p.ratio }} role="img" aria-label={p.alt || 'No image'}>
        <span>No image · {p.id}</span>
      </div>
    );
  return <img src={m.src} width={m.w} height={m.h} alt={p.alt || m.alt} loading="lazy" decoding="async" style={p.pixelated ? { imageRendering: 'pixelated' } : undefined} />;
}
