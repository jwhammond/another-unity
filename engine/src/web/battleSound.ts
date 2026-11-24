// SPDX-License-Identifier: GPL-3.0-or-later
import { NUM_CHANNELS, type SoundChannels } from '../audio/channels';
import { CuePlayer } from '../audio/cues';
import { effectPan, playEffect } from '../audio/effects';
import type { CombatCue } from '../content/types';
import type { CueRequest, SoundRequest } from '../sim/combat/types';
import type { AssetIndex } from '../view/assets';

/** A battle's frame of audio (the battleAudio event): its requests, the battle's clock it ran to, and whether the Enterprise is lost. */
export interface BattleAudioFrame { now: number; silenced: boolean; cues: readonly CueRequest[]; sounds: readonly SoundRequest[] }

/** What the battle's sound needs from the session. */
export interface BattleSoundParts {
  /** combat.yaml's crew cues (CombatData.cues): read when a cue is asked for, as combat.yaml loads lazily. */
  cues(): readonly CombatCue[];
  /** combat.yaml's effect sounds (CombatData.media.sounds), loaded as a battle starts. */
  sounds(): readonly string[];
  /** A game file's URL (audioUrl), or undefined: the game lacks it. */
  url(file: string): string | undefined;
  /** The Enterprise's computer has power (computerPercent, cues.cpp:65), read as a cue is asked for. */
  computerOn(): boolean;
  /** 3D SOUND (Settings.threeD), read at each effect: off, nothing is panned, the original's mono mix. */
  threeD(): boolean;
  preload(urls: string[]): void;
}

/**
 * A cue's or an effect's file in the game's audio (`unity:build` transcodes them by stem): a `.vac` is a voice line
 * (audio/voice), the rest effects (audio/sfx); undefined for a file the game lacks (Plan 24's 11 cue files, `4_explo.mac`).
 */
export function audioUrl(assets: AssetIndex, file: string): string | undefined {
  const stem = file.toLowerCase().replace(/\.[^.]*$/, '');
  return /\.vac$/i.test(file) ? assets.voice(stem) : assets.sound(stem)?.url;
}

/**
 * The battle's sound (M8 spec §6.3; Plan 28): the crew's cues by the CuePlayer and the effects by playEffect, on Sound's
 * eight channels. The sim hands each frame at tactical on (battleAudio, R3): none while paused, under the warp overlay,
 * away from tactical or auto-resolving, so nothing new starts then and what plays plays on.
 */
export class BattleSound {
  private readonly cues: CuePlayer;
  /** The files it preloaded or played, for the session to release as the battle ends. */
  private readonly used = new Set<string>();

  constructor(private readonly channels: SoundChannels, private readonly parts: BattleSoundParts) {
    this.cues = new CuePlayer(channels, { cues: () => parts.cues(), url: file => this.url(file), computerOn: () => parts.computerOn() });
  }

  private url(file: string): string | undefined {
    const url = this.parts.url(file);
    if (url !== undefined) this.used.add(url);
    return url;
  }

  /** The effect and cue files it preloaded or played (the mixer's `release` takes them as the battle ends). */
  urls(): string[] {
    return [...this.used];
  }

  /**
   * A battle set up or ended (the combat event): CuePlayer::reset, as TacticalScreen::start (tactical.cpp:302) and endCombat
   * (:361) call it: the cue channels stop, the effects ring on. As one starts, its effect sounds load (R11).
   */
  combat(on: boolean): void {
    this.cues.reset();
    if (!on) return;
    const urls: string[] = [];
    for (const sound of this.parts.sounds()) {
      const url = this.url(sound);
      if (url !== undefined) urls.push(url);
    }
    this.parts.preload(urls);
  }

  /**
   * Auto-resolve ran (the port's assist; ScummVM has none): the crew starts afresh, CuePlayer::reset, so the later cues, chains
   * and gaps it left waiting don't all fall due on the first frame back, the battle's clock having run on; the cue channels
   * stop and the effects ring on. Auto-resolve is silent (Plan 28 final review; §6.3).
   */
  autoResolved(): void {
    this.cues.reset();
  }

  /**
   * A frame (tactical.cpp:456-474): the cues it asked for and its effects, in order (the two use separate channels), then
   * _cues->update() at its clock. A request made after the Enterprise was lost silences the cues from there, and a frame that
   * lost it silences the update (damage.cpp:534, cues.cpp:132-133). A delay of 0 is play's: the original's playLater
   * delays are all over 0 (combat.cpp:324; combatTicks of a positive count).
   */
  frame(f: BattleAudioFrame): void {
    for (const c of f.cues) {
      if (c.silenced) this.cues.silenced = true;
      if (c.after) this.cues.playAfter(c.cue, f.now, c.interrupt);
      else if (c.delay > 0) this.cues.playLater(c.cue, c.delay, f.now, c.interrupt);
      else this.cues.play(c.cue, f.now, c.interrupt);
    }
    // (only an effect from a ship has a bearing: one at the camera, and the crew's cues, are never panned)
    for (const s of f.sounds) {
      const pan = s.bearing !== undefined && this.parts.threeD() ? effectPan(s.bearing) : undefined;
      playEffect(this.channels, s.distance, this.url(s.sound), pan);
    }
    if (f.silenced) this.cues.silenced = true;
    this.cues.update(f.now);
  }

  /** Which of the eight channels play, and whether the crew is silenced: for the dev tools and the tests. */
  state(): { channels: boolean[]; silenced: boolean } {
    return { channels: Array.from({ length: NUM_CHANNELS }, (_, i) => this.channels.playing(i)), silenced: this.cues.silenced };
  }
}
