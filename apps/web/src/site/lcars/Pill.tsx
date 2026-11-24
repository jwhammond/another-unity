// SPDX-License-Identifier: GPL-3.0-or-later
import type { ComponentChildren } from 'preact';
import { chirp } from './chirp';
export type Tone = 'orange' | 'peach' | 'lavender' | 'blue' | 'gold' | 'red' | 'a1' | 'a2' | 'a3';

export function Pill(p: { href?: string; onClick?: () => void; tone?: Tone; disabled?: boolean; current?: boolean; children: ComponentChildren }) {
  const cls = `lc-pill tone-${p.tone ?? 'a1'}`;
  if (p.href) return <a class={cls} href={p.href} aria-current={p.current ? 'page' : undefined} onClick={() => chirp('press')}>{p.children}</a>;
  // (aria-disabled, not the disabled attribute: a disabled button never gets the click, so it could not buzz, and it would drop out of the tab order)
  return <button type="button" class={cls} aria-disabled={p.disabled ? 'true' : undefined} onClick={() => { if (p.disabled) { chirp('deny'); return; } chirp('press'); p.onClick?.(); }}>{p.children}</button>;
}
