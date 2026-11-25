// SPDX-License-Identifier: GPL-3.0-or-later
import type { Settings } from './settings';

/**
 * A player's feedback from the admin console's FEEDBACK page: what they wrote, and what the game knows about where they are, filled in for them.
 * The session gathers the game's part (Session.feedbackPort); the site's transport adds the browser's and the build's and sends it, behind its
 * anti-bot check (apps/web/src/feedback).
 */

/** Where the player is and how the game is set, at the moment they send. */
export interface FeedbackGame {
  game: string;
  screen: string;
  onShip: boolean;
  station: string | null;
  gameOver: boolean;
  awayTeam: string[];
  currentActor: string;
  beamWorld: number | null;
  /** The battle under way, if any: its scenario and, at tactical, how many steps it has run. */
  combat: { scenario: number; step: number | null } | null;
  difficulty: number;
  settings: Settings | null;
  /** The last lines of the conversation log (the player's own game), for what was just said. */
  recentLines: string[];
}

/** What the session hands the transport to send. */
export interface FeedbackReport {
  message: string;
  email: string;
  /** The game as a save (the current one, or the last autosave mid-battle), or null if the player left it out or there is none. */
  save: string | null;
  /** Why the save is not the current game, when it isn't. */
  saveNote: string | null;
  game: FeedbackGame;
}

/** The anti-bot check, drawn into the page's box: its token once the check has passed. */
export interface FeedbackCheck {
  token(): string | undefined;
  /** A token is good for one send: a new check after each try. */
  reset(): void;
  dispose(): void;
}

/** What the site gives the session: the check, and the send. */
export interface FeedbackTransport {
  /** Draws the check into `box`; rejects with the words to show when feedback can't be sent from here (offline, not set up). */
  check(box: HTMLElement): Promise<FeedbackCheck>;
  /** Sends the report with the check's token and the form's trap field (empty for a person); resolves to the report's id. */
  send(report: FeedbackReport, token: string, trap: string): Promise<string>;
}

/** The console page's side of it (UiSession.feedback). */
export interface FeedbackPort {
  check(box: HTMLElement): Promise<FeedbackCheck>;
  send(input: { message: string; email: string; includeSave: boolean; token: string; trap: string }): Promise<string>;
}

/** How long a message may be (the function's limit too: functions/api/feedback.ts). */
export const FEEDBACK_MESSAGE_MAX = 4000;
export const FEEDBACK_EMAIL_MAX = 200;
/** A save bigger than this is left out, with a note saying so. */
export const FEEDBACK_SAVE_MAX = 3_000_000;
/** How many of the conversation log's last lines go with a report, and how long each may be. */
export const FEEDBACK_LINES = 30;
const LINE_MAX = 300;

export const recentLines = (lines: readonly { name: string; text: string }[]): string[] =>
  lines.slice(-FEEDBACK_LINES).map(l => `${l.name}: ${l.text}`.slice(0, LINE_MAX));
