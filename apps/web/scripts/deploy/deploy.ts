// SPDX-License-Identifier: GPL-3.0-or-later
// `npm run deploy`: build, check, then (after a y/N) a direct upload with `wrangler pages deploy`. docs/deploy.md.
//   --dry-run   builds and checks, prints the command, uploads nothing.
// Needs CF_PAGES_PROJECT (the Pages project's name; never written in the repo). CF_PAGES_BRANCH is the project's production branch
// (default main): any other branch name makes Pages publish a preview deployment instead.
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { build } from './build';
import { checkDir, printReport } from './check';
import { OUT, REPO, run, validProjectName } from './common';

/** The wrangler arguments of an upload (no network here: this only builds the list). */
export function wranglerArgs(dir: string, project: string, branch: string): string[] {
  return ['wrangler', 'pages', 'deploy', dir, '--project-name', project, '--branch', branch];
}

async function main(): Promise<number> {
  const dry = process.argv.includes('--dry-run');
  const project = process.env.CF_PAGES_PROJECT;
  const branch = process.env.CF_PAGES_BRANCH || 'main';
  if (!validProjectName(project) && !dry) {
    console.error('deploy: set CF_PAGES_PROJECT to your Pages project name (lowercase letters, digits, hyphens), e.g.\n  CF_PAGES_PROJECT=my-project npm run deploy');
    return 1;
  }
  if (project !== undefined && !validProjectName(project)) {
    console.error(`deploy: CF_PAGES_PROJECT "${project}" is not a valid Pages project name.`);
    return 1;
  }
  if (!build()) return 1;
  const { findings, report } = await checkDir(OUT);
  printReport(report, findings);
  if (findings.some(f => f.level === 'fail')) {
    console.error('\ndeploy: the checks failed: not uploading.');
    return 1;
  }
  // (with DEPLOY_FUNCTIONS=0 wrangler is run where there is no functions/ folder, so the Basic Auth middleware is not uploaded.
  // That is the system temp dir, with the repo's wrangler: run from inside the output dir, wrangler 4.148 refused the upload as
  // "over 20,000 files" with 11,646 in it)
  const withFunctions = process.env.DEPLOY_FUNCTIONS !== '0';
  const args = [...(withFunctions ? [] : ['--prefix', REPO]), ...wranglerArgs(OUT, project ?? '<CF_PAGES_PROJECT>', branch)];
  const cwd = withFunctions ? REPO : tmpdir();
  const shown = `npx ${args.join(' ')}${withFunctions ? '' : '   (from the temp dir: no functions/)'}`;
  console.log(`\nsummary: ${report.count} files, ${(report.total / 1024 / 1024).toFixed(1)} MiB`);
  console.log(`functions (the SITE_PASSWORD gate, /api/feedback): ${withFunctions ? 'included (the gate is a no-op unless the project has SITE_PASSWORD; feedback is off until its keys and bucket are set)' : 'not included (DEPLOY_FUNCTIONS=0: no feedback)'}`);
  console.log(`command: ${shown}`);
  if (dry) {
    console.log('\ndeploy: --dry-run: nothing uploaded.');
    return 0;
  }
  if (!process.stdin.isTTY) {
    console.error('deploy: no terminal to confirm on: run it in a terminal.');
    return 1;
  }
  console.log(`\nThis uploads the game's data and art to project "${project}" (branch ${branch}). Keep that site behind its login.`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('Upload now? [y/N] ')).trim().toLowerCase();
  rl.close();
  if (answer !== 'y' && answer !== 'yes') {
    console.log('deploy: cancelled.');
    return 1;
  }
  return run('npx', args, { cwd });
}

process.exit(await main());
