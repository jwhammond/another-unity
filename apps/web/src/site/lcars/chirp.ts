// SPDX-License-Identifier: GPL-3.0-or-later
const KEY = 'au-site-sound';
let ctx: AudioContext | null = null;

export function soundOn(): boolean {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}
export function setSound(on: boolean): void {
  try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* private mode: stays off next visit */ }
}
const TONES = { press: [1040, 0.07, 'sine'], engage: [520, 0.12, 'sine'], deny: [220, 0.14, 'square'] } as const;

/** A short synthesized console chirp; nothing plays unless the visitor turned sound on. */
export function chirp(kind: keyof typeof TONES): void {
  if (!soundOn()) return;
  try {
    ctx ??= new AudioContext();
    const [f, d, type] = TONES[kind];
    const o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime;
    o.type = type; o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(f * 1.5, t + d);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.12, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.05);
    o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + d + 0.06);
  } catch { /* no audio: silent */ }
}
