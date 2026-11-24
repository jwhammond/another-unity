// SPDX-License-Identifier: GPL-3.0-or-later
import type { Bus, Playing } from '../audio/mixer';
import type { AnimFx, ReadingPage, Vec2 } from '../content/types';
import type { MenuAt, Presenter, Visual } from '../sim/presenter';
import type { StopSignal } from '../sim/stop';
import type { World } from '../sim/world';
import type { Dialog, UiStore } from '../ui/store';
import type { AssetIndex } from './assets';
import type { EngineSound } from './package';
import type { ReadingTable } from './readings';
import type { ScreenTextTable } from './screenTexts';
import type { PresentationClock } from './timeline';
import type { Settings } from '../web/settings';
import type { VoiceTable } from './voices';

/** The stage's part in presenting (Stage implements it). */
export interface StagePort {
  walk(actor: string, from: Vec2, to: Vec2, stop: StopSignal): Promise<Vec2>;
  anim(object: string, anim: AnimFx): Promise<void>;
  show(visual: Visual): Promise<void>;
  /** A line starts (on) or ends (off) in `who`'s voice: the crew member's talk animation (R8). */
  speak?(who: string, on: boolean): void;
}

/** The audio's part in presenting (Mixer implements it). */
export interface SoundPort {
  play(url: string | undefined, bus: Bus): Promise<Playing | null>;
}

export interface PresenterParts {
  stage: StagePort;
  /** Null without Web Audio: lines are timed, and nothing plays. */
  sound: SoundPort | null;
  store: UiStore;
  clock: PresentationClock;
  assets: AssetIndex;
  voices: VoiceTable;
  /** What each tricorder reading shows; without it the viewer shows reading numbers. */
  readings?: ReadingTable;
  /** The text a script shows on the screen itself (screentexts.yaml); without it none is shown. */
  screenTexts?: ScreenTextTable;
  /** presentation.yaml's `warpMovies`: the stem of each warp movie by index. */
  warpMovies?: (string | null)[];
  /** Plays one of the engine's own sounds (presentation.yaml's `sounds`), if the game names it. */
  effect?: (sound: EngineSound) => void;
  /** The settings in force (TEXT and MOVIES); without it text and movies are on. */
  settings?: () => Settings;
}

/** The tag of the waits a click cuts short. */
const SAY = 'say';
/** A voice that hasn't reported its end this long after its length is given up on. */
export const VOICE_GRACE = 0.5;
/** The least a clock speed counts as here: a paused game stops calling `update` rather than setting 0. */
const MIN_SPEED = 0.01;
/** How long a missing movie's title card stays up. */
export const MOVIE_PLACEHOLDER_SECONDS = 2;

/** How long a line without a voice stays up, in seconds. */
export function readingTime(text: string): number {
  return Math.min(8, Math.max(1.5, 0.8 + 0.05 * text.length));
}

/** The real presenter: each call resolves when the player has seen, heard or answered it (spec §7.1). */
export class BrowserPresenter implements Presenter {
  private disposed = false;

  constructor(private readonly world: World, private readonly parts: PresenterParts) {}

  /** A click: the line being said ends now. */
  skipLine(): void {
    if (!this.disposed) this.parts.clock.finish(SAY);
  }

  /**
   * The world was replaced (a load or restart: Decision 11). From now on nothing this presenter waits for
   * resolves, so the old world stays frozen, and it never touches the store, stage or clock again.
   */
  dispose(): void {
    this.disposed = true;
  }

  async say(who: string, text: string, voice?: string): Promise<void> {
    if (this.disposed) return never();
    const { store, clock, sound, assets, voices } = this.parts;
    // (waiting for a click from the start, so one that comes while the voice loads still counts)
    const skipped = clock.after(Infinity, SAY);
    const url = voice === undefined ? undefined : assets.voice(voices.resolve(voice, who));
    // (TEXT OFF, the original's Dialogs 1e701: a line that is spoken shows no text box; the log still keeps it)
    const hidden = url !== undefined && sound !== null && this.parts.settings?.().text === false;
    const line = { who, name: this.world.state.objects[who]?.name ?? who, text };
    store.say(line, !hidden);
    this.parts.stage.speak?.(who, true);
    let playing: Playing | null = null;
    try {
      if (url !== undefined && sound) {
        // (a voice that fails to load is a line without a voice)
        const loading = Promise.resolve().then(() => sound.play(url, 'voice')).catch(() => null);
        // (a click while the voice loads wins; a voice that arrives after it is stopped, not left talking)
        const first = await Promise.race([loading.then(p => ({ p })), skipped.then(() => null)]);
        if (first) {
          playing = first.p;
          // (a voice that failed is a line without one: its text shows after all, the line no longer hidden)
          if (hidden && !playing && !this.disposed) store.set({ subtitle: line });
        }
        else void loading.then(late => late?.stop());
      }
      const heard = playing
        // (the voice plays in real time, and presentation time runs `speed` times faster than that)
        // (tagged, so the line's end clears the wait the voice's end or a click left behind: it would keep the game busy)
        ? Promise.race([playing.ended, clock.after((playing.duration + VOICE_GRACE) * Math.max(clock.speed, MIN_SPEED), SAY)])
        : clock.after(readingTime(text), SAY);
      await Promise.race([heard, skipped]);
    } finally {
      playing?.stop();
      // (a disposed presenter leaves the new world's line alone)
      if (!this.disposed) {
        clock.finish(SAY);
        store.endSay();
        this.parts.stage.speak?.(who, false);
      }
    }
    if (this.disposed) return never();
  }

  walk(actor: string, from: Vec2, to: Vec2, stop: StopSignal): Promise<Vec2> {
    if (this.disposed) return never();
    return this.live(this.parts.stage.walk(actor, from, to, stop));
  }

  async play(media: { movie?: string; sound?: string; warpMovie?: number }): Promise<void> {
    if (this.disposed) return never();
    const { store, clock, assets, sound } = this.parts;
    // (a warp movie is an index into the game's list; one the list lacks plays nothing, R11)
    if (media.warpMovie !== undefined) {
      const stem = this.parts.warpMovies?.[media.warpMovie];
      if (stem) return this.play({ movie: stem });
      return;
    }
    if (media.movie !== undefined && this.parts.settings?.().movies !== false) {
      // (MOVIES OFF skips the film as a Skip at once would: no dialog, and the game carries on)
      const dialog: Dialog = { kind: 'movie', title: media.movie, url: assets.movie(media.movie) ?? null };
      const shown = store.ask<void>(dialog);
      // (without the film, a title card stands in for it for a moment)
      if (dialog.url === null) {
        void clock.after(MOVIE_PLACEHOLDER_SECONDS).then(() => {
          if (!this.disposed && store.state.dialog === dialog) store.answer(undefined);
        });
      }
      await this.live(shown);
    }
    if (media.sound !== undefined) {
      const found = assets.sound(media.sound);
      if (found && sound) void sound.play(found.url, found.bus);
      await this.live(clock.after(0));
    }
  }

  // (async, so a dialog already being up rejects the promise rather than throwing at the caller)
  async choose(question: string, options: [string, string]): Promise<0 | 1> {
    if (this.disposed) return never();
    return this.live(this.parts.store.ask<0 | 1>({ kind: 'choice', question, options }));
  }

  async menu(options: string[], at?: MenuAt): Promise<number | null> {
    if (this.disposed) return never();
    return this.live(this.parts.store.ask<number | null>({ kind: 'menu', options, ...(at ? { conversation: at.conversation, situation: at.situation } : {}) }));
  }

  /**
   * showScreenText (talk.cpp:331-396): the record's box drawn on the screen, in place of any text at the same corner, with no wait.
   * A screen without the record shows nothing and the line says false, as the original's warning does.
   */
  async screenText(id: number): Promise<boolean> {
    if (this.disposed) return never();
    const text = this.parts.screenTexts?.get(this.world.state.screen, id);
    if (!text) return false;
    const shown = this.parts.store.state.screenTexts.filter(t => t.x !== text.x || t.y !== text.y);
    this.parts.store.set({ screenTexts: [...shown, text] });
    return true;
  }

  async tricorder(reading: number): Promise<void> {
    if (this.disposed) return never();
    // (runTricorder: this world's readings, the newest first, open at the one just taken; silent, but for its buttons)
    const s = this.world.state;
    const where = this.world.content.screens[s.screen]?.world ?? this.world.content.id;
    const pages: ReadingPage[] = [];
    let index = 0;
    for (const { group } of s.readings.filter(r => r.world === where).reverse()) {
      const found = this.parts.readings?.pages(where, group) ?? [];
      if (group === Math.abs(reading) && found.length > 0) index = pages.length;
      pages.push(...found);
    }
    await this.live(this.parts.store.ask<void>({ kind: 'tricorder', reading, pages, index }));
  }

  anim(object: string, anim: AnimFx): Promise<void> {
    if (this.disposed) return never();
    return this.live(this.parts.stage.anim(object, anim));
  }

  show(visual: Visual): Promise<void> {
    if (this.disposed) return never();
    this.parts.effect?.(this.soundOf(visual));
    return this.live(this.parts.stage.show(visual));
  }

  /**
   * The sound the original plays with a visual: phaserShot's, a crew member's hand phaser or anyone else's
   * (awayteam.cpp:1156-1183; every crew member's id is under its NUM_PHASER_MUZZLE_CREW, 10), and beamEffect's
   * (awayteam.cpp:1106).
   */
  private soundOf(visual: Visual): EngineSound {
    if (visual.kind === 'phaserShot') return this.world.content.objects[visual.from]?.crew ? 'phaserCrew' : 'phaserOther';
    if (visual.chodak) return 'beamChodak';
    return visual.out ? 'beamOut' : 'beamIn';
  }

  /** Passes a result on, unless the world was replaced meanwhile: then it never arrives. */
  private async live<T>(promise: Promise<T>): Promise<T> {
    const value = await promise;
    return this.disposed ? never<T>() : value;
  }
}

/** A promise that never settles: what a replaced world waits on. */
function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}
