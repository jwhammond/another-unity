// SPDX-License-Identifier: GPL-3.0-or-later
import { defineConfig, devices } from '@playwright/test';

// The deploy output's e2e (docs/deploy.md): `npm run deploy:e2e` runs both parts, one after the other, on E2E_PORT (default 5292):
//   AU_DEPLOY_E2E=preview  the output served by `wrangler pages dev` (the real _headers, CSP and Functions, offline): deploy-smoke.spec.ts,
//                          then deploy-gate.spec.ts (the CD gate: the import screen with GAMEDATA_DIR)
//   AU_DEPLOY_E2E=auth     the same files behind a fixture server that can answer 401 or a redirect to a sign-in page: sw-auth.spec.ts;
//                          and the next deploy laid over them, for a returning player's update (sw-update.spec.ts, with GAMEDATA_DIR)
const PORT = Number(process.env.E2E_PORT ?? 5292);
const part = process.env.AU_DEPLOY_E2E === 'auth' ? 'auth' : 'preview';

export default defineConfig({
  testDir: 'e2e-deploy',
  testMatch: part === 'auth' ? ['sw-auth.spec.ts', 'sw-update.spec.ts'] : ['deploy-smoke.spec.ts', 'deploy-gate.spec.ts'],
  timeout: 180_000,
  fullyParallel: false,
  workers: 1,
  use: { baseURL: `http://localhost:${PORT}` },
  projects: [{
    name: 'chromium',
    use: {
      ...devices['Desktop Chrome'],
      headless: true,
      launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] },
    },
  }],
  webServer: {
    command: part === 'auth' ? 'npx tsx apps/web/scripts/deploy/authsim.ts' : 'npm run deploy:preview -- --rebuild',
    cwd: '../..',
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: { E2E_PORT: String(PORT) },
  },
});
