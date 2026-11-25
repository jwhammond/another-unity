// SPDX-License-Identifier: GPL-3.0-or-later
// Cloudflare Pages Function: the game's feedback reports (the admin console's SETTINGS > GAME > SEND FEEDBACK). docs/deploy.md, "Feedback".
//
// GET  /api/feedback  -> { siteKey }: Turnstile's public site key, for the page to draw its check with (503 until feedback is set up).
// POST /api/feedback  -> { id }: a report, kept in the R2 bucket bound as FEEDBACK, once its Turnstile token checks out.
//
// What keeps bots out, in order: the request must come from a page of this site (its Origin); it must be JSON of a sane size and shape;
// a form field no person sees must be empty (a bot that fills it gets a 201 and its report is dropped); and its Turnstile token must
// pass Cloudflare's siteverify, for this site's hostname and the "feedback" action. Each token is good for one send.
//
// The project's settings (Workers & Pages > the project > Settings): TURNSTILE_SITE_KEY (a variable), TURNSTILE_SECRET_KEY (a secret),
// the R2 binding FEEDBACK; and optionally FEEDBACK_WEBHOOK (a secret: a Discord or Slack webhook URL told of each report).
// Without the keys or the bucket, the feature is off (503) rather than open.

/** The part of R2's bucket binding used here. */
export interface Bucket {
  put(key: string, value: string, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<unknown>;
}

export interface FeedbackEnv {
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  FEEDBACK?: Bucket;
  FEEDBACK_WEBHOOK?: string;
}

interface Ctx {
  request: Request;
  env: FeedbackEnv;
  waitUntil?: (p: Promise<unknown>) => void;
}

/** What siteverify answers (https://developers.cloudflare.com/turnstile/get-started/server-side-validation/). */
export interface Verdict {
  success: boolean;
  hostname?: string;
  action?: string;
  'error-codes'?: string[];
}

export const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const ACTION = 'feedback';
/** Turnstile's test secret that always passes (for `deploy:preview`): its answers carry no real hostname or action. */
export const TEST_SECRET = '1x0000000000000000000000000000000AA';

export const LIMITS = { body: 4_000_000, message: 4000, email: 200, save: 3_000_000, token: 2048, part: 100_000, errors: 50 };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const refuse = (error: string, status: number) => json({ error }, status);

const configured = (env: FeedbackEnv): env is Required<Pick<FeedbackEnv, 'TURNSTILE_SITE_KEY' | 'TURNSTILE_SECRET_KEY' | 'FEEDBACK'>> & FeedbackEnv =>
  !!env.TURNSTILE_SITE_KEY && !!env.TURNSTILE_SECRET_KEY && !!env.FEEDBACK;

export function onRequestGet({ env }: Ctx): Response {
  if (!configured(env)) return refuse('Feedback is not set up on this site', 503);
  return json({ siteKey: env.TURNSTILE_SITE_KEY });
}

/** Asks Cloudflare whether a token is good. */
export async function siteverify(secret: string, token: string, ip: string | null, fetchFn: typeof fetch = fetch): Promise<Verdict> {
  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  const res = await fetchFn(SITEVERIFY, { method: 'POST', body: form });
  if (!res.ok) return { success: false, 'error-codes': [`siteverify ${res.status}`] };
  return (await res.json()) as Verdict;
}

/** A report as it is kept: what the player wrote and what the game and the browser filled in. */
export interface StoredReport {
  id: string;
  receivedAt: string;
  message: string;
  email: string;
  save: string | null;
  saveNote: string | null;
  game: unknown;
  client: unknown;
  errors: unknown[];
  country: string | null;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const small = (v: unknown) => JSON.stringify(v ?? null).length <= LIMITS.part;

/** The report in a request body, or the reason it is refused. */
export function readReport(body: unknown): { ok: true; report: Omit<StoredReport, 'id' | 'receivedAt' | 'country'>; token: string; trap: string } | { ok: false; error: string } {
  if (!isObject(body)) return { ok: false, error: 'A report is a JSON object' };
  const { message, email = '', save = null, saveNote = null, game, client, errors = [], token, trap = '' } = body;
  if (typeof message !== 'string' || message.trim() === '') return { ok: false, error: 'Write what happened first' };
  if (message.length > LIMITS.message) return { ok: false, error: `The message is over ${LIMITS.message} characters` };
  if (typeof email !== 'string' || email.length > LIMITS.email || (email !== '' && !EMAIL.test(email))) return { ok: false, error: 'That email address does not look right' };
  if (save !== null && (typeof save !== 'string' || save.length > LIMITS.save)) return { ok: false, error: 'The save is too large' };
  if (saveNote !== null && typeof saveNote !== 'string') return { ok: false, error: 'A malformed report' };
  if (!isObject(game) || !isObject(client) || !small(game) || !small(client)) return { ok: false, error: 'A malformed report' };
  if (!Array.isArray(errors) || errors.length > LIMITS.errors || !small(errors)) return { ok: false, error: 'A malformed report' };
  if (typeof token !== 'string' || token === '' || token.length > LIMITS.token) return { ok: false, error: 'The check against bots did not pass: try again' };
  if (typeof trap !== 'string') return { ok: false, error: 'A malformed report' };
  return { ok: true, report: { message: message.trim(), email: email.trim(), save, saveNote: saveNote as string | null, game, client, errors }, token, trap };
}

export interface Deps {
  verify: (secret: string, token: string, ip: string | null) => Promise<Verdict>;
  now: () => Date;
  id: () => string;
  notify: (url: string, text: string) => Promise<unknown>;
}

const defaultDeps: Deps = {
  verify: (secret, token, ip) => siteverify(secret, token, ip),
  now: () => new Date(),
  id: () => crypto.randomUUID(),
  // (Discord reads `content`, Slack `text`)
  notify: (url, text) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: text, text }) }),
};

export async function handleFeedback(ctx: Ctx, deps: Deps = defaultDeps): Promise<Response> {
  const { request, env } = ctx;
  if (!configured(env)) return refuse('Feedback is not set up on this site', 503);
  const url = new URL(request.url);
  // (only a page of this site sends a report: a form elsewhere, or a script with no Origin, is refused)
  if (request.headers.get('origin') !== url.origin) return refuse('Reports are sent from the game', 403);
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return refuse('A report is sent as JSON', 415);
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > LIMITS.body) return refuse('The report is too large', 413);
  const text = await request.text();
  if (text.length > LIMITS.body) return refuse('The report is too large', 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return refuse('A report is sent as JSON', 400);
  }
  const read = readReport(body);
  if (!read.ok) return refuse(read.error, 400);

  const now = deps.now();
  const id = deps.id();
  const short = id.slice(0, 8);
  // (a filled trap: a bot. It is told it worked, and nothing is kept or checked)
  if (read.trap !== '') return json({ id: short }, 201);

  const verdict = await deps.verify(env.TURNSTILE_SECRET_KEY, read.token, request.headers.get('cf-connecting-ip')).catch(() => null);
  const testing = env.TURNSTILE_SECRET_KEY === TEST_SECRET;
  const good = verdict?.success === true && (testing || (verdict.hostname === url.hostname && verdict.action === ACTION));
  if (!good) return refuse('The check against bots did not pass: try again', 403);

  const cf = (request as Request & { cf?: { country?: string } }).cf;
  const stored: StoredReport = { id, receivedAt: now.toISOString(), ...read.report, country: cf?.country ?? null };
  const day = now.toISOString().slice(0, 10);
  const key = `reports/${day}/${now.toISOString().replace(/[:.]/g, '-')}-${short}.json`;
  await env.FEEDBACK.put(key, JSON.stringify(stored, null, 2), {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { id: short, screen: String((read.report.game as { screen?: unknown }).screen ?? '') },
  });

  if (env.FEEDBACK_WEBHOOK) {
    const line = read.report.message.replace(/\s+/g, ' ').slice(0, 300);
    const told = deps.notify(env.FEEDBACK_WEBHOOK, `New feedback ${short}: ${line}`).catch(() => undefined);
    if (ctx.waitUntil) ctx.waitUntil(told);
    else await told;
  }
  return json({ id: short }, 201);
}

export const onRequestPost = (ctx: Ctx) => handleFeedback(ctx);
