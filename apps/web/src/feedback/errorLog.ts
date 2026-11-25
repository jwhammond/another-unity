// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The last errors and warnings the page saw, for a feedback report: console.error and console.warn, uncaught errors and unhandled rejections,
 * each with its time. Kept in memory only, never stored or sent but with a report the player sends.
 */

export interface LoggedError {
  at: string;
  level: 'error' | 'warn';
  text: string;
}

export const ERROR_LOG_MAX = 50;
const TEXT_MAX = 1000;
const log: LoggedError[] = [];
let installed = false;

const show = (v: unknown): string => {
  if (v instanceof Error) return `${v.name}: ${v.message}${v.stack ? `\n${v.stack}` : ''}`;
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
};

/** Adds one entry (the oldest goes past ERROR_LOG_MAX). */
export function logError(level: 'error' | 'warn', parts: readonly unknown[], now = new Date()): void {
  log.push({ at: now.toISOString(), level, text: parts.map(show).join(' ').slice(0, TEXT_MAX) });
  if (log.length > ERROR_LOG_MAX) log.splice(0, log.length - ERROR_LOG_MAX);
}

/** The entries so far, oldest first. */
export const recentErrors = (): LoggedError[] => log.map(e => ({ ...e }));

/** For a test: an empty log, and the hooks off. */
export function clearErrorLog(): void {
  log.length = 0;
}

/** Hooks console.error, console.warn and the window's error events, once; the console still prints as before. */
export function installErrorLog(target: Window = window, out: Console = console): void {
  if (installed) return;
  installed = true;
  for (const level of ['error', 'warn'] as const) {
    const original = out[level].bind(out);
    out[level] = (...args: unknown[]) => {
      logError(level, args);
      original(...args);
    };
  }
  target.addEventListener('error', e => logError('error', [e.error ?? e.message]));
  target.addEventListener('unhandledrejection', e => logError('error', ['Unhandled rejection:', e.reason]));
}
