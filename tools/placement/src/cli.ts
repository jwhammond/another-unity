// SPDX-License-Identifier: GPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { GameMaps } from '../../tracediff/src/maps';
import { compareRoom, oursAt, turnedOnBy, type Finding } from './compare';
import { roomsOf } from './rooms';
import { countTable, triageFindings } from './triageRun';
import { harnessScript, parseLog } from './scummvm';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const USAGE = 'usage: placement scummvm <out.json> <world|room>…   (runs the muted harness; one ScummVM run, every object of each room dumped)\n       placement compare <scummvm.json> [report.json]   (our world on each room against that dump; RAW_DIR names the sprites)\n       placement triage <scummvm.json> <findings.json> [triage.json]   (RAW_DIR, IMAGES_DIR: sorts each no-art sprite into in-plate / static-missing / animated / invisible)';

const [cmd, out, ...wanted] = process.argv.slice(2);
if (cmd === 'scummvm' && out && wanted.length > 0) {
  const rooms = roomsOf(join(REPO, 'games', 'unity', 'ids.yaml'), wanted);
  if (rooms.length === 0) throw new Error(`no room matches ${wanted.join(' ')}`);
  const raw = process.env.RAW_DIR;
  // (the objects that have a sprite are asked after one by one; the screen's own list gives every object's flags, state and position)
  const hasSprite = (id: string): boolean => {
    if (!raw) return true;
    try {
      return (JSON.parse(readFileSync(join(raw, 'objects', `o_${id}.json`), 'utf8')) as { sprite_id: number }).sprite_id !== 0xffff;
    } catch {
      return false;
    }
  };
  const doc: Record<string, unknown> = {};
  let count = 0;
  // (one run a room: what a room's scripts set stays set in the game, so a second room in the run would not be a fresh arrival)
  for (const r of rooms) {
    const dir = join(process.env.RUNS ?? join(homedir(), 'pcode', 'unity-raw', 'runs'), `placement-${r.room}`);
    mkdirSync(dir, { recursive: true });
    if (!process.env.REPARSE) writeFileSync(join(dir, 'script.txt'), harnessScript([{ world: r.world, screen: r.screen, objects: r.objects.map(o => o.raw).filter(hasSprite) }]));
    // (REPARSE=1 reads the logs of the last runs again: the parser has changed, the game has not)
    const run = process.env.REPARSE ? { status: 0 } : spawnSync('sh', [join(REPO, 'tools', 'scummvm-harness', 'run.sh'), dir, '240'], { stdio: 'inherit' });
    if (run.status !== 0) throw new Error(`the harness run failed (${run.status}): see ${dir}/out.log`);
    const parsed = parseLog(readFileSync(join(dir, 'out.log'), 'utf8')).get(`${r.world}/${r.screen}`) ?? [];
    doc[r.room] = parsed.map(o => ({ ...o, slug: r.objects.find(x => x.raw === o.id)?.slug }));
    count += parsed.length;
  }
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(resolve(out), JSON.stringify(doc, null, 1));
  console.log(`${rooms.length} rooms, ${count} objects -> ${out}`);
} else if (cmd === 'compare' && out) {
  const dump = JSON.parse(readFileSync(resolve(out), 'utf8')) as Record<string, Parameters<typeof compareRoom>[1]>;
  const gameDir = join(REPO, 'games', 'unity');
  const maps = await GameMaps.load(gameDir);
  const presentation = parse(readFileSync(join(gameDir, 'presentation.yaml'), 'utf8')) as { art?: { rooms?: Record<string, { masks?: { object: string }[] }> } };
  const raw = process.env.RAW_DIR;
  const names = raw ? (JSON.parse(readFileSync(join(raw, 'maps', 'sprite.json'), 'utf8')) as { _spriteFilenames: string[] })._spriteFilenames : [];
  // (the prop recipes: which object each card stands in for, and the animation it shows)
  const recipes = new Map<string, { id: string; anim: number }>();
  for (const f of readdirSync(join(REPO, 'art', 'recipes')).filter(f => /^card\..*\.yaml$/.test(f))) {
    const r = parse(readFileSync(join(REPO, 'art', 'recipes', f), 'utf8')) as { id: string; prop?: { objects: string[]; anim?: number } };
    for (const o of r.prop?.objects ?? []) recipes.set(o, { id: r.id, anim: r.prop?.anim ?? 0 });
  }
  const objectsDir = join(gameDir, 'objects');
  const trees: unknown[] = [];
  const walkDir = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walkDir(join(dir, e.name));
      else if (e.name.endsWith('.yaml')) trees.push(parse(readFileSync(join(dir, e.name), 'utf8')));
    }
  };
  walkDir(objectsDir);
  const turnedOn = turnedOnBy(trees);
  const findings: Finding[] = [];
  // (ScummVM's room had 2.5 s to settle and ours has none, or three seconds: a timer, a walk or a conversation can put the two a step
  // apart either way. A difference in the world's own state counts only if it holds at both times.)
  const waits = (process.env.WAITS ?? '0,3').split(',').map(Number);
  for (const [room, objects] of Object.entries(dump)) {
    const published = presentation.art?.rooms?.[room];
    const art = published ? new Set((published.masks ?? []).map(m => m.object)) : null;
    const runs: Finding[][] = [];
    for (const w of waits) runs.push(compareRoom(room, objects, await oursAt(maps, room, w), maps, art, id => (names[id] ?? `sprite ${id}`).toLowerCase(), recipes, turnedOn));
    const same = (a: Finding, b: Finding): boolean => a.object === b.object && a.kind === b.kind;
    for (const f of runs[0]!) {
      const world = f.kind === 'active' || f.kind === 'state' || f.kind === 'position';
      if (!world || runs.every(r => r.some(g => same(f, g)))) findings.push(f);
    }
  }
  const report = process.argv[4];
  if (report) writeFileSync(resolve(report), JSON.stringify(findings, null, 1));
  const by = new Map<string, number>();
  for (const f of findings) by.set(f.kind, (by.get(f.kind) ?? 0) + 1);
  for (const f of findings) console.log(`${f.room} ${f.object} [${f.kind}] scummvm ${f.scummvm} | ours ${f.ours}`);
  console.log([...by].map(([k, n]) => `${k}: ${n}`).join(', ') || 'no findings');
} else if (cmd === 'triage' && out && wanted[0]) {
  const raw = process.env.RAW_DIR;
  const images = process.env.IMAGES_DIR;
  if (!raw || !images) throw new Error('placement triage needs RAW_DIR and IMAGES_DIR');
  const dump = JSON.parse(readFileSync(resolve(out), 'utf8')) as Parameters<typeof triageFindings>[1];
  const findings = JSON.parse(readFileSync(resolve(wanted[0]), 'utf8')) as Finding[];
  const rows = triageFindings(findings, dump, { repo: REPO, rawDir: raw, imagesDir: images });
  if (wanted[1]) writeFileSync(resolve(wanted[1]), JSON.stringify(rows, null, 1));
  for (const r of rows) console.log(`${r.room} ${r.object} [${r.kind}] ${r.sprite} anim ${r.anim} (${r.frames} frames) -> ${r.bucket}: ${r.why}`);
  console.log(countTable(rows));
} else {
  console.error(USAGE);
  process.exit(2);
}
