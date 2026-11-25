// SPDX-License-Identifier: GPL-3.0-or-later
// `npm run deploy:preview`: serves the deploy output locally with `wrangler pages dev` (offline: no Cloudflare calls), on E2E_PORT
// (default 8788). It builds first unless the output is there; `--rebuild` forces a build. With SITE_PASSWORD set, the Basic Auth
// middleware is active (for a throwaway password: it is passed on the command line); with TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY,
// feedback is (into a local bucket). docs/deploy.md.
import { existsSync } from 'node:fs';
import { build } from './build';
import { OUT, REPO, run } from './common';

if (process.argv.includes('--rebuild') || !existsSync(`${OUT}/index.html`)) {
  if (!build()) process.exit(1);
}
const port = process.env.E2E_PORT ?? '8788';
const args = ['wrangler', 'pages', 'dev', OUT, '--port', port, '--ip', '127.0.0.1', '--compatibility-date', '2026-10-06', '--show-interactive-dev-session=false'];
if (process.env.SITE_PASSWORD) args.push('--binding', `SITE_PASSWORD=${process.env.SITE_PASSWORD}`);
if (process.env.SITE_USER) args.push('--binding', `SITE_USER=${process.env.SITE_USER}`);
// (feedback, functions/api/feedback.ts: with the Turnstile keys set, a local R2 bucket stands in for the project's. For a test, Turnstile's
// test keys: site 1x00000000000000000000AA, secret 1x0000000000000000000000000000000AA, which always pass)
if (process.env.TURNSTILE_SITE_KEY && process.env.TURNSTILE_SECRET_KEY) {
  args.push('--binding', `TURNSTILE_SITE_KEY=${process.env.TURNSTILE_SITE_KEY}`, '--binding', `TURNSTILE_SECRET_KEY=${process.env.TURNSTILE_SECRET_KEY}`, '--r2', 'FEEDBACK');
}
console.log(`deploy:preview: http://127.0.0.1:${port}/?game=unity`);
process.exit(run('npx', args, { cwd: REPO, env: { WRANGLER_SEND_METRICS: 'false', CI: '1' } }));
