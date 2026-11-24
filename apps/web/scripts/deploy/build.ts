// SPDX-License-Identifier: GPL-3.0-or-later
// `npm run deploy:build`: a production build with the local game data and art, as a self-contained directory (dist-deploy) for a direct
// upload. It is never committed (apps/web/dist-deploy is git-ignored). docs/deploy.md.
import { cpSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEPLOY_FILES, localGamePresent, OUT, REPO, run, WEB } from './common';

type Runner = (cmd: string, args: string[], opts?: { cwd?: string; env?: Record<string, string | undefined> }) => number;

/**
 * The site's pictures, from the local game data: apps/web/public/site-media, which the build copies into the output. Without the game data
 * the step still runs, pointed at no game, so it clears site-media and writes an empty manifest: a demo-only build must never ship the
 * pictures of an earlier run.
 */
export function siteMediaStep(have: { data: boolean; art: boolean }, exec: Runner = run): number {
  const env = have.data && have.art ? undefined : { GAMES_DIR: `${OUT}-no-game-data` };
  return exec('npx', ['tsx', 'apps/web/scripts/site-media.ts'], env ? { env } : {});
}

/** What build() needs from the machine; the tests stand in for each. */
export interface BuildDeps {
  exec: Runner;
  have: { data: boolean; art: boolean };
  /** Whether games/unity/gate.yaml (the gate's parameters, `npm run gate:init`) is here. */
  gateYaml: boolean;
  out: string;
}

export function build(deps: Partial<BuildDeps> = {}): boolean {
  const exec = deps.exec ?? run;
  const have = deps.have ?? localGamePresent();
  const out = deps.out ?? OUT;
  if (!have.data || !have.art) {
    const what = !have.data ? 'the lifted game data (games/unity/game.yaml)' : 'the published art (games/unity/art)';
    if (process.env.AU_DEPLOY_DEMO_ONLY !== '1') {
      console.error(`deploy:build: ${what} is not on this machine, so the build would hold only the demo.\n`
        + 'Make it first (docs/unity-local.md), or set AU_DEPLOY_DEMO_ONLY=1 to build the demo on purpose.');
      return false;
    }
    console.warn(`deploy:build: ${what} is missing: building without it (AU_DEPLOY_DEMO_ONLY=1).`);
  }
  // (the deploy ships the game only sealed: games/unity/.sealed, which `gate:seal` brings up to date. It needs the gate's parameters)
  if (have.data) {
    if (!(deps.gateYaml ?? existsSync(`${REPO}games/unity/gate.yaml`))) {
      console.error('deploy:build: the game data is here but the gate is not set up: run `npm run gate:init` first (docs/deploy.md).');
      return false;
    }
    if (exec('npm', ['run', 'gate:seal']) !== 0) return false;
  }
  rmSync(out, { recursive: true, force: true });
  // (the demo game's greybox media: made by the same step as `npm run build`)
  if (exec('npx', ['tsx', 'scripts/demo-assets.ts'], { cwd: WEB }) !== 0) return false;
  if (siteMediaStep(have, exec) !== 0) return false;
  // (VITE_AU_DEPLOY=1 removes ?dev and the test hooks from the bundle (main.ts), and takes the sealed unity in place of the plain one
  // (games/index.ts). The build never writes source maps.)
  if (exec('npx', ['vite', 'build', '--outDir', out, '--emptyOutDir'], { cwd: WEB, env: { VITE_AU_DEPLOY: '1' } }) !== 0) return false;
  for (const f of ['_headers', '404.html', '_redirects']) {
    if (existsSync(`${DEPLOY_FILES}/${f}`)) cpSync(`${DEPLOY_FILES}/${f}`, `${out}/${f}`);
  }
  console.log(`\ndeploy:build: ${out}`);
  return true;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!build()) process.exit(1);
  // (the checks follow the build, so a bare `npm run deploy:build` says at once whether the output may be uploaded)
  process.exit(run('npx', ['tsx', 'apps/web/scripts/deploy/check.ts', OUT]));
}
