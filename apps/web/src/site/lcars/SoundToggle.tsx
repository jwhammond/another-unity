// SPDX-License-Identifier: GPL-3.0-or-later
import { Volume2, VolumeX } from 'lucide-preact';
import { useState } from 'preact/hooks';
import { chirp, setSound, soundOn } from './chirp';

export function SoundToggle() {
  const [on, setOn] = useState(soundOn());
  return (
    <button type="button" class="lc-sound" aria-pressed={on} onClick={() => { setSound(!on); setOn(!on); if (!on) chirp('press'); }}>
      {on ? <Volume2 size={16} aria-hidden="true" /> : <VolumeX size={16} aria-hidden="true" />}<span>{on ? 'Sound on' : 'Sound off'}</span>
    </button>
  );
}
