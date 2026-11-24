// SPDX-License-Identifier: GPL-3.0-or-later
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

// Every NearScreen on the page, so keyboard use and printing can render them all: Tab would otherwise skip a room that is not rendered yet
// (its placeholder has nothing to focus), and a printed page would have empty boxes.
const waiting = new Set<() => void>();
let listening = false;
export function renderAllNearScreens() { for (const show of [...waiting]) show(); }
function listen() {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('beforeprint', renderAllNearScreens);
  window.addEventListener('keydown', e => { if (e.key === 'Tab') renderAllNearScreens(); }, true);
}

/** Renders its children once it is within `margin` px of the viewport (at once where there is no IntersectionObserver, when a keyboard user first presses Tab, or before printing); until then a box of the same ratio holds the place. */
export function NearScreen(p: { ratio: string; margin?: number; children: ComponentChildren }) {
  const box = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (near || !box.current) return;
    listen();
    const show = () => setNear(true);
    waiting.add(show);
    const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) show(); }, { rootMargin: `${p.margin ?? 300}px` });
    io.observe(box.current);
    return () => { io.disconnect(); waiting.delete(show); };
  }, [near]);
  return near ? <>{p.children}</> : <div ref={box} class="lc-noimg is-loading" style={{ aspectRatio: p.ratio }} aria-hidden="true" />;
}
