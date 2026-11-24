// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn } from 'node:child_process';
import { unityBuild, type Exec } from './build';

const exec: Exec = argv =>
  new Promise(resolve => {
    // (no shell: the audio filter is a regular expression)
    const child = spawn(argv[0], argv.slice(1), { stdio: argv[0] === 'ffmpeg' ? 'ignore' : 'inherit' });
    child.on('close', code => resolve(code ?? 1));
    child.on('error', () => resolve(127));
  });

process.exitCode = await unityBuild(process.env, exec, line => console.log(line));
