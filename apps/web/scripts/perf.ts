// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The combat frame-rate run (Plan 31 R4): `npm run perf [-- --battles 82,8]`. It starts the dev server (`npm run dev`, port 5293) and drives a HEADED Chromium on the GPU
 * through each profile and battle, then prints one line each and exits 1 if a profile is under its fps target. It is not part of CI or an
 * e2e spec: a headless run's software GL would say nothing about a player's frame rate.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, devices, type BrowserContextOptions } from '@playwright/test';
import type { PerfReport } from '@another-unity/engine/web';

const PORT = 5293;
// (a run is up to 60 s of waiting for the opening, 60 s for the battle to draw, and its 61 s of frames: the page's own watchdogs report short before this)
const TIMEOUT_MS = 240_000;

export interface Profile { name: string; target: number; context: BrowserContextOptions }

export const PROFILES: Profile[] = [
  { name: 'desktop', target: 60, context: { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 } },
  // (a Pixel 7's own device pixel ratio, 2.625: Playwright's descriptor has 2.625 too, but said here, as the run's claim rests on it (Plan 34 Task 8))
  { name: 'Pixel 7 landscape', target: 30, context: { ...(({ defaultBrowserType: _ignored, ...rest }) => rest)(devices['Pixel 7 landscape']!), deviceScaleFactor: 2.625 } },
];

/** `--battles 82,8`: the scenarios to time (default 82 and 8). */
function battlesFrom(argv: string[]): number[] {
  const at = argv.indexOf('--battles');
  const list = at >= 0 ? argv[at + 1] ?? '' : '82,8';
  const battles = list.split(',').map(Number);
  if (battles.length === 0 || battles.some(n => !Number.isInteger(n) || n <= 0)) throw new Error(`--battles wants scenario numbers, like 82,8 (got "${list}")`);
  return battles;
}

/** The line a profile and battle print. */
export function line(profile: string, battle: number, r: PerfReport): string {
  return `perf ${profile} battle ${battle}: ${r.fps.toFixed(1)} fps, p95 ${r.p95Ms.toFixed(1)} ms, worst ${r.worstMs.toFixed(1)} ms, ${r.maxCalls} calls, ${r.maxTriangles} triangles${r.short ? ' (short: the battle ended early)' : ''}`;
}

async function waitForServer(url: string, server: ChildProcess): Promise<void> {
  const end = Date.now() + 120_000;
  while (Date.now() < end) {
    if (server.exitCode !== null) throw new Error(`vite exited with ${server.exitCode}`);
    if (await fetch(url).then(r => r.ok, () => false)) return;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`${url} never came up`);
}

async function main(): Promise<number> {
  const battles = battlesFrom(process.argv.slice(2));
  const web = fileURLToPath(new URL('..', import.meta.url));
  const server = spawn('npm', ['run', 'dev', '--', '--port', String(PORT), '--strictPort'], { cwd: web, stdio: 'ignore', detached: true });
  let failed = false;
  try {
    await waitForServer(`http://localhost:${PORT}/`, server);
    const browser = await chromium.launch({ headless: false, args: ['--enable-gpu-rasterization', '--ignore-gpu-blocklist'] });
    try {
      for (const profile of PROFILES) {
        const worst: number[] = [];
        for (const battle of battles) {
          const context = await browser.newContext(profile.context);
          const page = await context.newPage();
          try {
            await page.goto(`http://localhost:${PORT}/play/afu/?game=unity&dev&mute&perf=${battle}`);
            const handle = await page.waitForFunction(() => window.__au?.perf() ?? null, undefined, { timeout: TIMEOUT_MS, polling: 500 });
            const report = await handle.jsonValue() as PerfReport;
            console.log(line(profile.name, battle, report));
            worst.push(report.fps);
          } finally {
            await context.close();
          }
        }
        if (worst.some(fps => fps < profile.target)) {
          console.log(`perf ${profile.name}: under ${profile.target} fps`);
          failed = true;
        }
      }
    } finally {
      await browser.close();
    }
  } finally {
    // (npm's child, vite, goes with the group)
    if (server.pid !== undefined) process.kill(-server.pid);
  }
  return failed ? 1 : 0;
}

// (run as `npm run perf`; imported by its test, it runs nothing)
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => process.exit(code), (err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
