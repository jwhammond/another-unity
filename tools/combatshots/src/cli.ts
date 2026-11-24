// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { PNG } from 'pngjs';
import { compareConsole, compareShots, contactSheet } from './compare';
import { addShots, readShots, shownStep, viewInputs } from './shots';

const USAGE = [
  'usage: combatshots inputs                          the views\' inputs file, for tracediff combat-script --inputs',
  '       combatshots script --in <script> --out <script>   the harness script with the shots added',
  '       combatshots shots --dir <run dir>           the shots its out.log says it took: shots.json, and the steps they show (for tracediff combat-states)',
  '       combatshots compare --dir <run dir> [--art]  each shot\'s view rectangle and console against the port\'s: report.md and sheet.png; exit 1 if one differs (--art: the port\'s console repainted, lined up only: Plan 30 R17)',
].join('\n');

/** The screenshot check (M8 spec §9.3): `tools/combatshots/shots.sh` runs these in turn, around ScummVM and the port. */
export async function runCombatshots(argv: string[], log: (line: string) => void): Promise<number> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({ args: rest, options: { in: { type: 'string' }, out: { type: 'string' }, dir: { type: 'string' }, art: { type: 'boolean' } } });
  if (command === 'inputs') {
    log(viewInputs().trimEnd());
    return 0;
  }
  if (command === 'script' && values.in && values.out) {
    await writeFile(values.out, addShots(await readFile(values.in, 'utf8')));
    return 0;
  }
  if (command === 'shots' && values.dir) {
    const shots = readShots(await readFile(join(values.dir, 'out.log'), 'utf8'));
    await writeFile(join(values.dir, 'shots.json'), JSON.stringify(shots.map(s => ({ ...s, state: `state-${shownStep(s)}.json` })), null, 1));
    log(shots.map(shownStep).join(','));
    return shots.length > 0 ? 0 : 1;
  }
  if (command === 'compare' && values.dir) {
    const shots = JSON.parse(await readFile(join(values.dir, 'shots.json'), 'utf8')) as { name: string; file: string; step: number; state: string }[];
    const lines = ['| shot | step | view shown | IoU (1 px tolerance) | strict IoU | box shift | centroid | areas (ScummVM, port) | console (2 px, measured/total points; same pixels) | verdict |', '|---|---|---|---|---|---|---|---|---|---|'];
    const rows: [PNG, PNG][] = [];
    let failed = 0, empty = 0;
    for (const s of shots) {
      const port = join(values.dir, `port-${s.name}.png`);
      if (!existsSync(s.file) || !existsSync(port)) {
        lines.push(`| ${s.name} | ${s.step} | - | - | - | - | - | - | - | MISSING ${existsSync(s.file) ? 'the port\'s' : 'ScummVM\'s'} |`);
        failed++;
        continue;
      }
      // (the view the state shows: a battle's start can hold an input back, so a shot shows the view of its step)
      const state = existsSync(join(values.dir, s.state)) ? JSON.parse(await readFile(join(values.dir, s.state), 'utf8')) as { view: { view: number } } : null;
      const a = PNG.sync.read(await readFile(s.file)), b = PNG.sync.read(await readFile(port));
      const c = compareShots(a, b);
      // (the console about the view: Plan 27 R17)
      const k = compareConsole(a, b, { art: values.art === true });
      if (!c.pass || !k.pass) failed++;
      // (nothing in view on either side passes, but compares nothing: said apart, so the tally's real matches show)
      const bothEmpty = c.pass && k.pass && c.areas[0] === 0 && c.areas[1] === 0;
      if (bothEmpty) empty++;
      rows.push([a, b]);
      const console = `${k.pass ? 'lines up' : `DIFFERS: ${k.why ?? ''};`} ${k.measured}/${k.total} points; ${(k.same * 100).toFixed(1)}% the same`;
      lines.push(`| ${s.name} | ${s.step} | ${state ? `0x${state.view.view.toString(16)}` : '-'} | ${c.iou.toFixed(3)} | ${c.strictIou.toFixed(3)} | ${c.shift} | ${c.centroid.toFixed(2)} | ${c.areas.join(', ')} | ${console} | ${bothEmpty ? 'SAME (empty)' : c.pass && k.pass ? 'SAME' : 'DIFFERS'} |`);
    }
    const tally = `${shots.length - failed} of ${shots.length} SAME (${empty} empty on both sides)`;
    await writeFile(join(values.dir, 'report.md'), `# Combat screenshots: ${values.dir}\n\n${lines.join('\n')}\n\n${tally}\n`);
    await writeFile(join(values.dir, 'sheet.png'), PNG.sync.write(contactSheet(rows)));
    for (const l of lines.slice(2)) log(`combatshots: ${l}`);
    log(`combatshots: ${tally}`);
    return failed > 0 ? 1 : 0;
  }
  log(USAGE);
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCombatshots(process.argv.slice(2), line => console.log(line)).then(
    code => { process.exitCode = code; },
    (e: unknown) => { console.log(`combatshots: ${(e as Error).message}`); process.exitCode = 1; },
  );
}
