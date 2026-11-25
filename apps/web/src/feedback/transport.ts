// SPDX-License-Identifier: GPL-3.0-or-later
import type { FeedbackCheck, FeedbackReport, FeedbackTransport } from '@another-unity/engine/web';
import { VERSION_META } from '../swRules';
import { recentErrors } from './errorLog';

/**
 * The site's side of a feedback report (the engine's FeedbackTransport): the check against bots, Cloudflare Turnstile, drawn into the console
 * page's box, and the post to the Pages Function (functions/api/feedback.ts) with the browser's and the build's details added to the game's.
 * The function holds the keys: it hands out the public site key, and checks each send's token with the secret one.
 */

export const FEEDBACK_URL = '/api/feedback';
export const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
/** The action the widget names, and the function requires. */
export const FEEDBACK_ACTION = 'feedback';
export const OFFLINE = 'Feedback needs an internet connection';
export const NOT_HERE = 'Feedback cannot be sent from here';
const CHECK_FAILED = 'The check against bots did not load: try again later';

/** The part of Turnstile's API used here (https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/). */
export interface Turnstile {
  render(el: HTMLElement, options: Record<string, unknown>): string | undefined;
  reset(id: string): void;
  remove(id: string): void;
}

export interface TransportDeps {
  fetch: typeof fetch;
  /** Loads Turnstile's script once, and resolves to its API. */
  turnstile: () => Promise<Turnstile>;
  doc: Document;
  nav: Navigator;
  win: Window;
}

let scriptLoad: Promise<Turnstile> | null = null;
/** Turnstile's script, added to the page the first time the FEEDBACK page opens (not before: most players never send one). */
export function loadTurnstile(doc: Document = document, win: Window = window): Promise<Turnstile> {
  const ready = () => (win as unknown as { turnstile?: Turnstile }).turnstile;
  scriptLoad ??= new Promise<Turnstile>((resolve, reject) => {
    const have = ready();
    if (have) { resolve(have); return; }
    const script = doc.createElement('script');
    script.src = TURNSTILE_SCRIPT;
    script.async = true;
    script.onload = () => {
      const api = ready();
      if (api) resolve(api);
      else reject(new Error(CHECK_FAILED));
    };
    script.onerror = () => reject(new Error(CHECK_FAILED));
    doc.head.append(script);
  }).catch(err => {
    // (a failed load is tried again next time)
    scriptLoad = null;
    throw err;
  });
  return scriptLoad;
}

/** The browser's and the build's part of a report. */
export function clientDetails(d: Pick<TransportDeps, 'doc' | 'nav' | 'win'>) {
  const { doc, nav, win } = d;
  const standalone = win.matchMedia?.('(display-mode: standalone), (display-mode: fullscreen)').matches ?? false;
  return {
    build: doc.querySelector<HTMLMetaElement>(`meta[name="${VERSION_META}"]`)?.content || 'dev',
    path: win.location.pathname,
    userAgent: nav.userAgent,
    language: nav.language,
    screen: `${win.screen.width}x${win.screen.height}`,
    viewport: `${win.innerWidth}x${win.innerHeight}`,
    pixelRatio: win.devicePixelRatio,
    touch: (nav.maxTouchPoints ?? 0) > 0,
    online: nav.onLine,
    installed: standalone,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    sentAt: new Date().toISOString(),
  };
}

export function feedbackTransport(deps: TransportDeps = { fetch: (...a) => fetch(...a), turnstile: () => loadTurnstile(), doc: document, nav: navigator, win: window }): FeedbackTransport {
  return {
    async check(box: HTMLElement): Promise<FeedbackCheck> {
      if (!deps.nav.onLine) throw new Error(OFFLINE);
      let siteKey: unknown;
      try {
        const res = await deps.fetch(FEEDBACK_URL, { headers: { accept: 'application/json' } });
        const body = res.ok && (res.headers.get('content-type') ?? '').includes('application/json') ? ((await res.json()) as { siteKey?: unknown }) : null;
        siteKey = body?.siteKey;
      } catch {
        throw new Error(OFFLINE);
      }
      if (typeof siteKey !== 'string' || siteKey === '') throw new Error(NOT_HERE);
      const api = await deps.turnstile();
      let token: string | undefined;
      const id = api.render(box, {
        sitekey: siteKey,
        action: FEEDBACK_ACTION,
        // (shown only when Turnstile needs the player to do something; most never see it)
        appearance: 'interaction-only',
        theme: 'dark',
        size: 'flexible',
        callback: (t: string) => { token = t; },
        'expired-callback': () => { token = undefined; },
        'error-callback': () => { token = undefined; },
      });
      if (id === undefined) throw new Error(CHECK_FAILED);
      return {
        token: () => token,
        reset: () => { token = undefined; api.reset(id); },
        dispose: () => { token = undefined; api.remove(id); },
      };
    },

    async send(report: FeedbackReport, token: string, trap: string): Promise<string> {
      let res: Response;
      try {
        res = await deps.fetch(FEEDBACK_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ ...report, client: clientDetails(deps), errors: recentErrors(), token, trap }),
        });
      } catch {
        throw new Error(OFFLINE);
      }
      const body = (await res.json().catch(() => null)) as { id?: unknown; error?: unknown } | null;
      if (res.ok && typeof body?.id === 'string') return body.id;
      throw new Error(typeof body?.error === 'string' ? body.error : `The report was not sent (${res.status})`);
    },
  };
}
