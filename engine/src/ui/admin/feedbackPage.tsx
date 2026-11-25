// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState } from 'preact/hooks';
import { FEEDBACK_EMAIL_MAX, FEEDBACK_MESSAGE_MAX, type FeedbackCheck, type FeedbackPort } from '../../web/feedback';
import { at, Control, errorText, type Rect } from './parts';

/**
 * The console's FEEDBACK page (from SETTINGS > GAME): the player writes what happened and sends it. The game fills in where they are, their
 * settings, the build, recent errors and, if they leave it on, their save (Session.feedbackPort, apps/web/src/feedback). A check against bots
 * (Cloudflare Turnstile) sits in its box under the form, and shows itself only if it needs the player. Every rectangle is in the original's
 * pixels, from the console's top left, inside the settings page's cleared screen.
 */

const INSIDE: Rect = [56, 59, 308, 190];
const MESSAGE: Rect = [64, 64, 292, 74];
const EMAIL: Rect = [64, 142, 292, 17];
const SAVE_LABEL: Rect = [64, 164, 170, 18];
const SAVE_OFF: Rect = [238, 164, 58, 18];
const SAVE_ON: Rect = [300, 164, 58, 18];
const NOTE: Rect = [64, 186, 292, 14];
const CHECK: Rect = [64, 202, 292, 20];
const CANCEL: Rect = [112, 226, 86, 18];
const SEND: Rect = [222, 226, 86, 18];

export const FEEDBACK_NOTE = 'Also sent: where you are in the game, your settings, the build and any recent errors.';
export const SENT = (id: string) => `Thank you: report ${id} sent`;
export const NOT_ROBOT = 'Checking you are not a robot: try again in a moment';
const SENDING = 'Sending...';
const EMPTY = 'Write what happened first';

/** What the player has written, kept while the console is closed and opened again (Escape closes it from any page). */
let draft = { message: '', email: '', includeSave: true };
/** For a test: a fresh draft. */
export const clearFeedbackDraft = () => { draft = { message: '', email: '', includeSave: true }; };

export function FeedbackPage({ feedback, say, back }: {
  feedback: FeedbackPort;
  /** The console's message strip. */
  say: (note: string | null) => void;
  back: () => void;
}) {
  const [message, setMessage] = useState(draft.message);
  const [email, setEmail] = useState(draft.email);
  const [includeSave, setIncludeSave] = useState(draft.includeSave);
  const [sending, setSending] = useState(false);
  /** Null until the check is drawn; false if feedback can't be sent from here. */
  const [ready, setReady] = useState<boolean | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const trap = useRef<HTMLInputElement>(null);
  const check = useRef<FeedbackCheck | null>(null);
  draft = { message, email, includeSave };

  useEffect(() => {
    let live = true;
    if (!box.current) return;
    feedback.check(box.current).then(
      c => {
        if (!live) { c.dispose(); return; }
        check.current = c;
        setReady(true);
      },
      (err: unknown) => {
        if (!live) return;
        setReady(false);
        say(errorText(err));
      },
    );
    return () => {
      live = false;
      check.current?.dispose();
      check.current = null;
    };
  }, [feedback]);

  const send = async () => {
    if (sending || !ready) return;
    if (message.trim() === '') { say(EMPTY); return; }
    const token = check.current?.token();
    if (!token) { say(NOT_ROBOT); return; }
    setSending(true);
    say(SENDING);
    try {
      const id = await feedback.send({ message: message.trim(), email: email.trim(), includeSave, token, trap: trap.current?.value ?? '' });
      setMessage('');
      say(SENT(id));
    } catch (err) {
      say(errorText(err));
    } finally {
      // (a token is good for one send)
      check.current?.reset();
      setSending(false);
    }
  };

  return (
    <div class="au-admin-feedback">
      <div class="au-admin-inside" style={at(INSIDE)} aria-hidden="true" />
      <textarea
        class="au-admin-field au-admin-message-field"
        style={at(MESSAGE)}
        tabIndex={0}
        aria-label="What happened"
        placeholder="What happened, and what did you expect?"
        maxLength={FEEDBACK_MESSAGE_MAX}
        value={message}
        onInput={e => setMessage((e.currentTarget as HTMLTextAreaElement).value)}
      />
      <input
        class="au-admin-field"
        style={at(EMAIL)}
        tabIndex={0}
        type="email"
        autocomplete="email"
        aria-label="Email, if you would like a reply"
        placeholder="Email, if you would like a reply (optional)"
        maxLength={FEEDBACK_EMAIL_MAX}
        value={email}
        onInput={e => setEmail((e.currentTarget as HTMLInputElement).value)}
      />
      {/* (a field no person sees or reaches: a bot that fills every field fills this one, and its report is dropped) */}
      <input ref={trap} class="au-admin-trap" type="text" name="website" tabIndex={-1} autocomplete="off" aria-hidden="true" />
      <div class="au-admin-field-label" style={at(SAVE_LABEL)}>INCLUDE MY SAVE</div>
      <Control name="INCLUDE MY SAVE: OFF" r={SAVE_OFF} kind="cell" label="OFF" on={!includeSave} data={{ 'aria-pressed': String(!includeSave) }} onClick={() => setIncludeSave(false)} />
      <Control name="INCLUDE MY SAVE: ON" r={SAVE_ON} kind="cell" label="ON" on={includeSave} data={{ 'aria-pressed': String(includeSave) }} onClick={() => setIncludeSave(true)} />
      <p class="au-admin-field-note" style={at(NOTE)}>{FEEDBACK_NOTE}</p>
      <div class="au-admin-check" style={at(CHECK)} ref={box} data-ready={ready === null ? 'waiting' : String(ready)} />
      <Control name="CANCEL" r={CANCEL} kind="cap" label="CANCEL" onClick={back} />
      <Control name="SEND" r={SEND} kind="cap" label="SEND" disabled={!ready || sending} onClick={() => void send()} />
    </div>
  );
}
