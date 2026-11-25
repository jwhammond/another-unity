// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment happy-dom
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedbackPort } from '../../web/feedback';
import { DEFAULT_SETTINGS, type Settings } from '../../web/settings';
import type { SettingsPort } from '../../web/settingsPort';
import { UiStore } from '../store';
import { AdminConsole } from './adminConsole';
import { clearFeedbackDraft, FEEDBACK_NOTE, NOT_ROBOT, SENT } from './feedbackPage';

const settleUi = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

function ports(over: { checkFails?: string; token?: string | undefined; sendFails?: string } = {}) {
  const store = new UiStore();
  store.set({ panel: 'admin' });
  const now: Settings = structuredClone(DEFAULT_SETTINGS as Settings);
  const settings: SettingsPort = {
    get: () => structuredClone(now),
    set: () => {},
    canChangeDifficulty: () => true,
    adminOpen: () => store.state.panel === 'admin',
    openAdmin: () => { store.set({ panel: 'admin' }); return true; },
    closeAdmin: () => { store.set({ panel: 'none' }); },
    sound: () => {},
    gameOver: () => false,
    newGame: async () => {},
    quit: async () => {},
  };
  const check = { token: vi.fn(() => ('token' in over ? over.token : 'tok')), reset: vi.fn(), dispose: vi.fn() };
  const sent: Parameters<FeedbackPort['send']>[0][] = [];
  const feedback: FeedbackPort = {
    check: vi.fn(async (box: HTMLElement) => {
      if (over.checkFails) throw new Error(over.checkFails);
      box.dataset.widget = 'drawn';
      return check;
    }),
    send: vi.fn(async input => {
      if (over.sendFails) throw new Error(over.sendFails);
      sent.push(input);
      return 'abcd1234';
    }),
  };
  return { store, settings, feedback, check, sent };
}

const mounted: HTMLElement[] = [];
beforeEach(() => clearFeedbackDraft());
afterEach(() => {
  for (const root of mounted.splice(0)) act(() => render(null, root));
  document.body.innerHTML = '';
});

const named = (root: HTMLElement, name: string) => root.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
async function press(root: HTMLElement, name: string) {
  const b = named(root, name);
  if (!b) throw new Error(`no button "${name}"`);
  act(() => b.click());
  await settleUi();
}
const status = (root: HTMLElement) => root.querySelector('[role="status"]')!.textContent;
function type(el: HTMLTextAreaElement | HTMLInputElement, text: string) {
  act(() => {
    el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** The console, opened at SETTINGS and then SEND FEEDBACK. */
async function feedbackPage(p: ReturnType<typeof ports>, withFeedback = true) {
  const root = document.body.appendChild(document.createElement('div'));
  mounted.push(root);
  act(() => render(<AdminConsole settings={p.settings} store={p.store} measure={t => t.length * 8} feedback={withFeedback ? p.feedback : undefined} />, root));
  await settleUi();
  await press(root, 'SETTINGS');
  if (withFeedback) await press(root, 'SEND FEEDBACK');
  return root;
}
const message = (root: HTMLElement) => root.querySelector<HTMLTextAreaElement>('textarea[aria-label="What happened"]')!;

describe('the FEEDBACK page', () => {
  it('is on SETTINGS > GAME only where the site has feedback', async () => {
    const without = await feedbackPage(ports(), false);
    expect(named(without, 'SEND FEEDBACK')).toBeNull();
    const root = await feedbackPage(ports());
    expect(root.querySelector('.au-admin-console')!.getAttribute('data-page')).toBe('feedback');
    expect(status(root)).toBe('Send feedback');
    expect(root.textContent).toContain(FEEDBACK_NOTE);
  });

  it("draws the site's check into its box as it opens, and lets it go as it closes", async () => {
    const p = ports();
    const root = await feedbackPage(p);
    const box = root.querySelector<HTMLElement>('.au-admin-check')!;
    expect(p.feedback.check).toHaveBeenCalledWith(box);
    expect(box.dataset.ready).toBe('true');
    await press(root, 'CANCEL');
    expect(p.check.dispose).toHaveBeenCalled();
    expect(root.querySelector('.au-admin-console')!.getAttribute('data-page')).toBe('settings');
  });

  it('sends the message, the email and the save choice with the check\'s token and an empty trap, then thanks the player and clears the message', async () => {
    const p = ports();
    const root = await feedbackPage(p);
    type(message(root), '  The door would not open.  ');
    type(root.querySelector<HTMLInputElement>('input[type="email"]')!, 'player@example.com');
    await press(root, 'INCLUDE MY SAVE: OFF');
    await press(root, 'SEND');
    expect(p.sent).toEqual([{ message: 'The door would not open.', email: 'player@example.com', includeSave: false, token: 'tok', trap: '' }]);
    expect(status(root)).toBe(SENT('abcd1234'));
    expect(message(root).value).toBe('');
    // (a token is good for one send)
    expect(p.check.reset).toHaveBeenCalled();
  });

  it('includes the save unless the player turns it off', async () => {
    const p = ports();
    const root = await feedbackPage(p);
    expect(named(root, 'INCLUDE MY SAVE: ON')!.getAttribute('aria-pressed')).toBe('true');
    type(message(root), 'Hi');
    await press(root, 'SEND');
    expect(p.sent[0]!.includeSave).toBe(true);
  });

  it('sends nothing with no message, or before the check has passed', async () => {
    const p = ports({ token: undefined });
    const root = await feedbackPage(p);
    await press(root, 'SEND');
    expect(status(root)).toBe('Write what happened first');
    type(message(root), 'Hello');
    await press(root, 'SEND');
    expect(status(root)).toBe(NOT_ROBOT);
    expect(p.feedback.send).not.toHaveBeenCalled();
  });

  it("says why it can't send when the check doesn't load, and keeps SEND off", async () => {
    const root = await feedbackPage(ports({ checkFails: 'Feedback needs an internet connection' }));
    expect(status(root)).toBe('Feedback needs an internet connection');
    expect(named(root, 'SEND')!.disabled).toBe(true);
  });

  it("says why a send failed and keeps the player's message", async () => {
    const p = ports({ sendFails: 'The check against bots did not pass: try again' });
    const root = await feedbackPage(p);
    type(message(root), 'Keep me');
    await press(root, 'SEND');
    expect(status(root)).toBe('The check against bots did not pass: try again');
    expect(message(root).value).toBe('Keep me');
    expect(named(root, 'SEND')!.disabled).toBe(false);
  });

  it('keeps the draft when the console is closed with Escape and opened again', async () => {
    const p = ports();
    let root = await feedbackPage(p);
    type(message(root), 'Half a thought');
    act(() => { message(root).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    await settleUi();
    expect(p.store.state.panel).toBe('none');
    act(() => render(null, root));
    p.store.set({ panel: 'admin' });
    root = await feedbackPage(p);
    expect(message(root).value).toBe('Half a thought');
  });

  it('lets typing reach the fields (Enter and Space stay in the message) and Tab go round them', async () => {
    const root = await feedbackPage(ports());
    const field = message(root);
    field.focus();
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    act(() => { field.dispatchEvent(enter); });
    expect(enter.defaultPrevented).toBe(false);
    act(() => { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })); });
    expect(document.activeElement).toBe(root.querySelector('input[type="email"]'));
  });

  it('hides the trap field from people and from the Tab order', async () => {
    const root = await feedbackPage(ports());
    const trap = root.querySelector<HTMLInputElement>('input[name="website"]')!;
    expect(trap.tabIndex).toBe(-1);
    expect(trap.getAttribute('aria-hidden')).toBe('true');
  });

  it("opens straight on its page from the bar's Feedback, and its CANCEL goes back to the paused page", async () => {
    const p = ports();
    p.store.set({ adminStart: 'feedback' });
    const root = document.body.appendChild(document.createElement('div'));
    mounted.push(root);
    act(() => render(<AdminConsole settings={p.settings} store={p.store} measure={t => t.length * 8} feedback={p.feedback} />, root));
    await settleUi();
    expect(root.querySelector('.au-admin-console')!.getAttribute('data-page')).toBe('feedback');
    // (taken: the next opening is the console's own)
    expect(p.store.state.adminStart).toBeNull();
    await press(root, 'CANCEL');
    expect(root.querySelector('.au-admin-console')!.getAttribute('data-page')).toBe('paused');
  });

  it("has FEEDBACK on the console's face, one press from the paused page, and its CANCEL goes back there; from SETTINGS, back to SETTINGS", async () => {
    const p = ports();
    const root = document.body.appendChild(document.createElement('div'));
    mounted.push(root);
    act(() => render(<AdminConsole settings={p.settings} store={p.store} measure={t => t.length * 8} feedback={p.feedback} />, root));
    await settleUi();
    const page = () => root.querySelector('.au-admin-console')!.getAttribute('data-page');
    await press(root, 'FEEDBACK');
    expect(page()).toBe('feedback');
    await press(root, 'CANCEL');
    expect(page()).toBe('paused');
    await press(root, 'SETTINGS');
    await press(root, 'SEND FEEDBACK');
    await press(root, 'CANCEL');
    expect(page()).toBe('settings');
  });

  it('has no FEEDBACK on the face where the site has none', async () => {
    const root = await feedbackPage(ports(), false);
    expect(named(root, 'FEEDBACK')).toBeNull();
  });
});
