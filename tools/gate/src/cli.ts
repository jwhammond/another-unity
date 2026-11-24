// SPDX-License-Identifier: GPL-3.0-or-later
// gate:init and gate:seal. Neither ever prints a range or the salt.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { GateError } from '../../../apps/web/src/gate/crypto';
import { parseGateParams } from '../../../apps/web/src/gate/params';
import { chooseRanges, gateYaml, newSalt } from './init';
import { listFolder, nodeFolderSource } from './nodeSource';
import { sealGame } from './seal';

const gameDir = resolve(process.env.GATE_GAME_DIR || 'games/unity');
const cdDir = process.env.GAMEDATA_DIR;
const paramsPath = join(gameDir, 'gate.yaml');

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const cmd = process.argv[2];
if (cmd !== 'init' && cmd !== 'seal') fail('usage: gate:init | gate:seal');
if (!cdDir) fail(`gate:${cmd} needs GAMEDATA_DIR (the folder holding the game's CD files)`);

// (a GateError's detail names a range's file, and a range is a gate parameter: nothing it says may reach the terminal)
try {
  if (cmd === 'init') {
    if (existsSync(paramsPath)) fail('gate.yaml exists already; keep it (a new one would orphan the sealed files)');
    const ranges = chooseRanges(listFolder(cdDir), Math.random);
    writeFileSync(paramsPath, gateYaml({ version: 1, salt: newSalt(), ranges }), { flag: 'wx', mode: 0o600 });
    console.log('wrote gate.yaml (4 ranges)');
  } else {
    if (!existsSync(paramsPath)) fail('no gate.yaml: run gate:init first');
    const params = parseGateParams(readFileSync(paramsPath, 'utf8'));
    const { sealed, skipped } = await sealGame({ gameDir, outDir: join(gameDir, '.sealed'), params, cd: nodeFolderSource(cdDir) });
    console.log(`sealed ${sealed} files, ${skipped} up to date`);
  }
} catch (e) {
  if (e instanceof GateError && (e.code === 'missing-file' || e.code === 'unreadable')) fail(`gate:${cmd}: a file gate.yaml names is missing from GAMEDATA_DIR`);
  if (e instanceof GateError) fail(`gate:${cmd}: the CD in GAMEDATA_DIR doesn't match gate.yaml`);
  fail(`gate:${cmd}: failed`);
}
