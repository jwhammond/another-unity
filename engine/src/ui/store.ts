// SPDX-License-Identifier: GPL-3.0-or-later
import type { ReadingPage } from '../content/types';
import type { ScreenTextBox } from '../view/screenTexts';
/**
 * The original's four modes. It has no Get mode: things are got by dragging them onto the inventory in Use mode
 * (handleAwayTeamMouseUp, awayteam.cpp:656-676).
 */
export type VerbMode = 'walk' | 'look' | 'use' | 'talk';
export const VERBS: readonly VerbMode[] = ['walk', 'look', 'use', 'talk'];
/** The right button's cycle, as the original's (awayteam.cpp:678-692). */
export const CYCLE: readonly VerbMode[] = ['look', 'use', 'walk', 'talk'];

export interface SpokenLine {
  who: string;
  /** The speaker's name as the game shows it now. */
  name: string;
  text: string;
  /**
   * Said with no box (TEXT OFF for a voiced line, the original's Dialogs 1e701): the line is still being said, so a click or Space skips it
   * and the bridge's speaker talks; only the subtitle box leaves it out. Never in the transcript.
   */
  hidden?: true;
}

/** What the sim is waiting for the player to answer; components answer it with UiStore.answer. */
export type Dialog =
  | { kind: 'choice'; question: string; options: [string, string] }
  | { kind: 'menu'; options: string[]; conversation?: string; situation?: number }
  | { kind: 'prompt'; text: string; buttons: string[] }
  | { kind: 'tricorder'; reading: number; pages: ReadingPage[]; index: number }
  | { kind: 'movie'; title: string; url: string | null };

/** The HUD's panel up. 'admin' is the admin PADD (Plan 32), which stops the game while it is up. */
export type Panel = 'none' | 'transcript' | 'admin';

export interface UiState {
  mode: VerbMode;
  /** The inventory item picked up to use with something. */
  held: string | null;
  /** The object being dragged in Use mode, once the pointer has moved far enough from where it was pressed. */
  dragging: string | null;
  /** The name of the object under the pointer. */
  hover: string | null;
  /** Whether the pointer is over open floor to walk on (a pointer in Walk mode is lit there, as over an object: handleAwayTeamMouseMove). */
  hoverFloor: boolean;
  /** The phaser setting (0 to 3) under the pointer while it is over the panel's phaser gauge. */
  phaserHover: number | null;
  subtitle: SpokenLine | null;
  transcript: SpokenLine[];
  dialog: Dialog | null;
  /** The text a script put on the screen itself, until the team enters another screen. */
  screenTexts: ScreenTextBox[];
  panel: Panel;
  /** A notice for the player: the team went back to the ship, a save didn't load. */
  message: string | null;
  /** Bumped on every sim change the HUD shows (inventory, team, flags). */
  revision: number;
  /** The page the admin console opens on, when something other than its own button opened it (the bar's Feedback); it takes it and clears it. */
  adminStart: 'feedback' | null;
}

export const TRANSCRIPT_LIMIT = 200;

const INITIAL: UiState = {
  mode: 'walk', held: null, dragging: null, hover: null, hoverFloor: false, phaserHover: null, subtitle: null, transcript: [], dialog: null, screenTexts: [], panel: 'none', message: null, revision: 0, adminStart: null,
};

/** The overlay's state. The presenter and input controller write it; the Preact components read it. */
export class UiStore {
  private current: UiState = { ...INITIAL };
  private readonly listeners = new Set<() => void>();
  private pending: ((value: unknown) => void) | null = null;

  get state(): UiState {
    return this.current;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  set(patch: Partial<UiState>): void {
    this.current = { ...this.current, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  bump(): void {
    this.set({ revision: this.current.revision + 1 });
  }

  /** `show` false says the line with no box (TEXT OFF for a spoken line): it is `hidden`, and the transcript keeps it. */
  say(line: SpokenLine, show = true): void {
    const { hidden: _, ...logged } = line;
    this.set({ subtitle: show ? logged : { ...logged, hidden: true }, transcript: [...this.current.transcript, logged].slice(-TRANSCRIPT_LIMIT) });
  }

  endSay(): void {
    this.set({ subtitle: null });
  }

  /** Puts up a dialog and resolves with the answer. The sim asks one thing at a time. */
  ask<T>(dialog: Dialog): Promise<T> {
    if (this.pending) throw new Error(`a ${this.current.dialog?.kind ?? 'dialog'} dialog is already up`);
    return new Promise<T>(resolve => {
      this.pending = value => resolve(value as T);
      this.set({ dialog });
    });
  }

  answer(value: unknown): void {
    const resolve = this.pending;
    if (!resolve) return;
    this.pending = null;
    this.set({ dialog: null });
    resolve(value);
  }

  /** For a new world: the old world's question is dropped unanswered, and (unless keepLog) its lines and message go. */
  reset(keepLog = false): void {
    this.pending = null;
    this.set({ dialog: null, screenTexts: [], subtitle: null, held: null, dragging: null, hover: null, phaserHover: null, panel: 'none', ...(keepLog ? {} : { transcript: [], message: null }) });
  }
}

const VERB_WORDS: Record<VerbMode, string> = { walk: 'Walk to', look: 'Look at', use: 'Use', talk: 'Talk to' };

/** The line that says what a click will do: "Use Tricorder with Control Panel". Takes names. */
export function actionLine(mode: VerbMode, held: string | null, target: string | null): string {
  if (mode === 'use' && held !== null) return `Use ${held} with ${target ?? '…'}`;
  return target === null ? VERB_WORDS[mode] : `${VERB_WORDS[mode]} ${target}`;
}
