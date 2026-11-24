// SPDX-License-Identifier: GPL-3.0-or-later
import { useState } from 'preact/hooks';
import { useMedia } from '../media';
import { Figure } from './Figure';

/**
 * A `pair` or `portrait` entry as two stacked pictures: `src` is the original, `pairSrc` the remake. The original is on the left and the remake on the right: the remake is clipped to start at `pos` percent,
 * so the slider (0 to 100, arrow keys move 5) pulls the edge across. `before` and `after` name the two sides.
 */
export function BeforeAfter(p: { id: string; before: string; after: string; ratio?: string }) {
  const m = useMedia(p.id);
  const [pos, setPos] = useState(50);
  if (m === 'loading' || !m || !m.pairSrc) return <Figure id={p.id} alt={`${p.before} and ${p.after}`} ratio={p.ratio ?? '1/1'} />;
  // (only the game's own 48x50 heads, enlarged x4, are pixel art; a room plate or a repainted portrait is smooth)
  const label = p.id.replace(/^(room|portrait)\./, '').replace(/\./g, ' ').replace(/_/g, ' ');
  const head = m.kind === 'portrait';
  const key = (e: KeyboardEvent) => {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 5 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -5 : 0;
    if (!d) return;
    e.preventDefault();
    setPos(Math.max(0, Math.min(100, pos + d)));
  };
  return (
    <figure class="lc-ba">
      <div class="lc-ba-box" style={{ aspectRatio: `${m.w} / ${m.h}` }}>
        <img src={m.src} alt={`${p.before}: ${m.alt}`} loading="lazy" decoding="async" style={head ? { imageRendering: 'pixelated' } : undefined} />
        <img src={m.pairSrc} alt={`${p.after}: ${m.alt}`} loading="lazy" decoding="async" style={{ clipPath: `inset(0 0 0 ${pos}%)` }} />
        <span class="lc-ba-edge" style={{ left: `${pos}%` }} aria-hidden="true" />
      </div>
      <input type="range" min="0" max="100" step="1" value={pos} aria-label={`Compare original and remastered: ${label}`}
        onInput={e => setPos(Number((e.currentTarget as HTMLInputElement).value))} onKeyDown={key} />
      <figcaption><span>{p.before}</span><span>{p.after}</span></figcaption>
    </figure>
  );
}
