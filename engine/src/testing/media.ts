// SPDX-License-Identifier: GPL-3.0-or-later
/** A sine tone as a 16-bit mono PCM WAV: a stand-in voice or sound that every browser decodes. */
export function toneWav(seconds: number, hz: number, rate = 8000): Uint8Array {
  const samples = Math.round(seconds * rate);
  const out = new Uint8Array(44 + samples * 2);
  const dv = new DataView(out.buffer);
  const text = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i);
  };
  text(0, 'RIFF');
  dv.setUint32(4, 36 + samples * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  text(36, 'data');
  dv.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++) {
    // (a short fade at each end, so it doesn't click)
    const fade = Math.min(1, i / 200, (samples - i) / 200);
    dv.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 8000 * fade), true);
  }
  return out;
}
