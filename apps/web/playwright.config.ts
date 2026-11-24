// SPDX-License-Identifier: GPL-3.0-or-later
import { defineConfig, devices } from '@playwright/test';

// (a worktree running beside others sets E2E_PORT so the servers don't collide: dev on it, preview on the next port)
const PORT = Number(process.env.E2E_PORT ?? 5174);
const PREVIEW = PORT + 1;

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  fullyParallel: false,
  // (each page renders WebGL on the CPU, SwiftShader, and one browser alone uses about six cores: seven workers on a 15-core machine slow every
  // test past its timeouts. E2E_WORKERS overrides it)
  workers: Number(process.env.E2E_WORKERS ?? 3),
  // (one retry for what only load can break: a page that takes over 30 s to boot beside two others, a pace measured on the clock. A test that passes on
  // its retry is reported as flaky, by name, in the run's summary and its JSON: it is not hidden. E2E_RETRIES=0 turns it off)
  retries: Number(process.env.E2E_RETRIES ?? 1),
  use: { baseURL: `http://localhost:${PORT}` },
  projects: [{
    name: 'chromium',
    use: {
      ...devices['Desktop Chrome'],
      headless: true,
      // (WebGL without a GPU: SwiftShader. Audio to Chromium's fake output, whose clock runs on a timer: through the machine's own
      // device a headless page's AudioContext can sit at currentTime 0 while 'running', so no sound ever ends and the sound checks
      // wait on channels that never free; the tests are muted, so nothing is lost)
      launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--disable-audio-output'] },
    },
  }],
  // (started in order: the dev server writes the demo's assets, then the production build uses them)
  webServer: [
    {
      command: `npm run dev -- --port ${PORT} --strictPort`,
      url: `http://localhost:${PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      // (what players get: production.spec.ts checks the dev tools stay out of it)
      command: `npx vite build && npx vite preview --port ${PREVIEW} --strictPort`,
      url: `http://localhost:${PREVIEW}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
