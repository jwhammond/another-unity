// SPDX-License-Identifier: GPL-3.0-or-later
import type { ComponentChildren } from 'preact';
import { chirp } from '../lcars/chirp';

export function launchGame(open: typeof window.open = window.open.bind(window), nav: (url: string) => void = u => location.assign(u)): void {
  chirp('engage');
  // (a second press focuses the game's tab: opening the URL again would navigate it and restart the game)
  const w = open('', 'au-afu');
  if (!w) { nav('/play/afu/'); return; }
  try {
    if (w.location.href === 'about:blank') w.location.href = '/play/afu/';
  } catch {
    // (cross-origin can't happen here; fall through to the focus)
  }
  w.focus();
}

/** A game on the select screen. A card that is off stays focusable (aria-disabled, like Pill) so it can buzz. */
export function GameCard(p: { id: string; title: string; tag: string; disabled?: boolean; expanded?: boolean; onToggle?: () => void; picture: ComponentChildren }) {
  return (
    <button type="button" class={`lc-game${p.disabled ? ' is-off' : ''}`} data-game={p.id}
      aria-expanded={p.disabled ? undefined : !!p.expanded} aria-disabled={p.disabled ? true : undefined}
      aria-controls={p.disabled ? undefined : `${p.id}-detail`}
      onClick={() => { if (p.disabled) { chirp('deny'); return; } chirp('press'); p.onToggle?.(); }}>
      <span class="lc-game-pic">{p.picture}</span>
      <span class="lc-game-meta"><span class="lc-game-title">{p.title}</span><span class="lc-game-tag">{p.tag}</span></span>
    </button>
  );
}
