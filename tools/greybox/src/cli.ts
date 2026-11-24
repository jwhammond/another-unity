// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { RoomFile } from '@another-unity/lift/room';
import { writeRoom } from './build';

const USAGE = 'usage: greybox --rooms <dir> [--images <dir>] [--out games/unity/models/rooms]';

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    options: { rooms: { type: 'string' }, images: { type: 'string' }, out: { type: 'string', default: 'games/unity/models/rooms' } },
  }).values;
}

/** Every file under `dir` whose name ends with `ext`, as sorted `/`-separated paths relative to it; a missing `dir` is an error unless `missingOk`. */
async function listFiles(dir: string, ext: string, missingOk = false): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch((e: NodeJS.ErrnoException) => {
    if (missingOk && e.code === 'ENOENT') return [];
    throw e;
  });
  return entries
    .filter(e => e.isFile() && e.name.endsWith(ext))
    .map(e => relative(dir, join(e.parentPath, e.name)).split(sep).join('/'))
    .sort();
}

export async function runGreybox(argv: string[], log: (line: string) => void): Promise<number> {
  let values: ReturnType<typeof parse>;
  try {
    values = parse(argv);
  } catch {
    log(USAGE);
    return 2;
  }
  if (!values.rooms) {
    log(USAGE);
    return 2;
  }
  const rooms = values.rooms;
  const out = values.out ?? 'games/unity/models/rooms';
  const files = await listFiles(rooms, '.json');
  let backgrounds = 0;
  for (const rel of files) {
    const room = JSON.parse(await readFile(join(rooms, rel), 'utf8')) as RoomFile;
    const png = values.images && room.background
      ? await readFile(join(values.images, room.background.png)).catch(() => undefined)
      : undefined;
    if (png) backgrounds++;
    const target = join(out, rel.replace(/\.json$/, '.glb'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await writeRoom(room, png ? new Uint8Array(png) : undefined));
  }
  // a .glb whose room file is gone (a room the lifter no longer writes) is removed, so the models match the rooms
  const wanted = new Set(files.map(rel => rel.replace(/\.json$/, '.glb')));
  for (const rel of await listFiles(out, '.glb', true)) {
    if (wanted.has(rel)) continue;
    await rm(join(out, rel));
    log(`removed ${rel}`);
  }
  log(`wrote ${files.length} rooms (${backgrounds} with a background)`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runGreybox(process.argv.slice(2), line => console.log(line)).then(
    code => process.exit(code),
    (e: unknown) => {
      console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
