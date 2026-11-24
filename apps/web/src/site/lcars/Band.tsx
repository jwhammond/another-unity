// SPDX-License-Identifier: GPL-3.0-or-later
import type { Tone } from './Pill';
export function Band({ tone }: { tone: Tone }) { return <div class={`lc-band tone-${tone}`} aria-hidden="true" />; }
