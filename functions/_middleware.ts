// SPDX-License-Identifier: GPL-3.0-or-later
// Cloudflare Pages Function: an optional shared-password gate (HTTP Basic Auth) in front of every file of the site. docs/deploy.md.
//
// Off unless the project has a `SITE_PASSWORD` secret, so a site gated by Cloudflare Access instead is not affected: with no secret
// the middleware only passes the request on. (A deploy without `functions/` at all is `DEPLOY_FUNCTIONS=0`, which also saves the
// free plan's daily Functions requests.)
//
// Set the secret in the dashboard (Workers & Pages > the project > Settings > Variables and Secrets, type Secret) or with
// `npx wrangler pages secret put SITE_PASSWORD --project-name <name>`. `SITE_USER` is optional: when set, the user name must match it
// too; otherwise any user name is accepted and only the password counts.

interface Env {
  SITE_PASSWORD?: string;
  SITE_USER?: string;
}

/** Compares two strings without the time depending on where they differ: both are hashed to 32 bytes, and every byte is looked at. */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = x.length ^ y.length;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ (y[i] ?? 0);
  return diff === 0;
}

/** The user name and password of an `Authorization: Basic ...` header, or null if it isn't one (or isn't valid base64/UTF-8). */
export function parseBasic(header: string | null): { user: string; password: string } | null {
  const m = /^Basic +([A-Za-z0-9+/=_-]+)$/i.exec((header ?? '').trim());
  if (!m) return null;
  try {
    const bytes = Uint8Array.from(atob(m[1]!.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const colon = text.indexOf(':');
    return colon < 0 ? null : { user: text.slice(0, colon), password: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

/** Whether the request carries the right credentials. The user name is checked only when `env.SITE_USER` is set. */
export async function authorized(header: string | null, env: Env): Promise<boolean> {
  if (!env.SITE_PASSWORD) return true;
  const given = parseBasic(header);
  if (!given) return false;
  const passwordOk = await safeEqual(given.password, env.SITE_PASSWORD);
  const userOk = env.SITE_USER ? await safeEqual(given.user, env.SITE_USER) : true;
  return passwordOk && userOk;
}

export function challenge(): Response {
  return new Response('Sign in to continue.', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Another Unity", charset="UTF-8"',
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}

interface Ctx {
  request: Request;
  env: Env;
  next(): Promise<Response>;
}

export const onRequest = async (ctx: Ctx): Promise<Response> => {
  if (!ctx.env.SITE_PASSWORD) return ctx.next();
  if (await authorized(ctx.request.headers.get('Authorization'), ctx.env)) return ctx.next();
  return challenge();
};
