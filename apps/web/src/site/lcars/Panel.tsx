// SPDX-License-Identifier: GPL-3.0-or-later
import type { ComponentChildren } from 'preact';
import type { Tone } from './Pill';
export function Panel(p: { tone: Tone; heading?: string; id?: string; children: ComponentChildren }) {
  return <section id={p.id} class={`lc-panel tone-${p.tone}`}>{p.heading && <h2 class="lc-panel-h">{p.heading}</h2>}{p.children}</section>;
}
