// SPDX-License-Identifier: GPL-3.0-or-later
import { combatSim, createInitialState } from '@another-unity/engine';
import { readRaw } from '@another-unity/lift/raw';
import { writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { diffTraces } from './diff';
import { GameMaps } from './maps';
import { fromJsonl, toJsonl } from './model';
import { renderReport, summarize } from './report';
import { combatCensus, renderCensus } from './census';
import { routeCensus, routeChainTo, routeReach } from './route';
import { outline } from './outline';
import { loadGameHooks, runTs } from './run';
import { normalizeScummvm } from './scummvm';
import { readBattles, replayBattle } from './combat';
import { diffBattle, parityExit, parityLines, renderParityReport, traceLine, type ParityRow } from './combatDiff';
import { harnessScript } from './combatParity';

const USAGE = [
  'usage: tracediff run --game <dir> --walk <file> [--seed <n>] [--raw <dir>] --out <ts.jsonl>',
  '       tracediff diff --game <dir> --scummvm <trace.jsonl> --ts <ts.jsonl> [--raw <dir>] [--out <report.md>]',
  '       tracediff summary --game <dir> (--scummvm <trace.jsonl> | --ts <ts.jsonl>) [--raw <dir>]',
  '       tracediff outline --game <dir> --world <slug> [--raw <dir>]',
  '       tracediff census --game <dir> [--raw <dir>]',
  '       tracediff route --game <dir> [--missions] [--to <object or conversation@situation>]',
  '       tracediff combat --game <dir> --scummvm <trace.jsonl> [--out <port.jsonl>] [--report <report.md>]',
  '       tracediff combat-battles --game <dir>',
  '       tracediff combat-script --game <dir> --battle <n> --difficulty <0-2> --seed <n> --cap <steps> [--inputs <file>] --out <script.txt>',
  '       tracediff combat-states --game <dir> --scummvm <trace.jsonl> --steps <n,n,...> --out <dir>',
  '       (--raw defaults to RAW_DIR)',
];

const OPTIONS = new Set(['to', 'game', 'world', 'walk', 'seed', 'raw', 'out', 'scummvm', 'ts', 'report', 'battle', 'difficulty', 'cap', 'inputs', 'steps']);

/** The options as `--name value` pairs, or null if any is unknown, repeated or has no value. */
function parseOptions(argv: string[]): Map<string, string> | null {
  const opts = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i].startsWith('--') ? argv[i].slice(2) : '';
    const value = argv[i + 1];
    if (!OPTIONS.has(name) || opts.has(name) || value === undefined || value.startsWith('--')) return null;
    opts.set(name, value);
  }
  return opts;
}

/**
 * The tracediff command (docs/tracediff.md). Returns its exit code: a bad command line, or a file that
 * can't be read or written, is 2 (not comparable), with its reason.
 */
export async function runTracediff(argv: string[], log: (line: string) => void): Promise<number> {
  try {
    return await tracediff(argv, log);
  } catch (e) {
    log(`tracediff: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
}

async function tracediff(argv: string[], log: (line: string) => void): Promise<number> {
  const [command, ...rest] = argv;
  const usage = () => {
    for (const line of USAGE) log(line);
    return 2;
  };
  // (`route --missions` is the one bare flag)
  const missions = command === 'route' && rest.includes('--missions');
  const opts = parseOptions(missions ? rest.filter(x => x !== '--missions') : rest);
  if (!opts) return usage();
  const option = (name: string) => opts.get(name);
  const game = option('game');
  if (!game) return usage();
  // (Plan 3's export, for triggers.json: what unlifted-triggers may forgive)
  const rawDir = option('raw') ?? process.env.RAW_DIR;

  if (command === 'run') {
    const walk = option('walk');
    const out = option('out');
    const seed = Number(option('seed') ?? 42);
    if (!walk || !out || !Number.isInteger(seed)) return usage();
    const { events, error } = await runTs(game, await readFile(walk, 'utf8'), {
      seed,
      registerHooks: await loadGameHooks(game),
      rawDir,
    });
    await writeFile(out, toJsonl(events));
    log(error ? `tracediff run: ${basename(walk)} stopped: ${error}` : `tracediff run: ${basename(walk)} played to its end (${events.length} events)`);
    return error ? 1 : 0;
  }

  const scummvm = option('scummvm');
  const ts = option('ts');
  const maps = async () => GameMaps.load(game, rawDir);
  if (command === 'combat-battles') {
    // (the battles a parity run can fight: those with an Enterprise, in order)
    const battles = (await maps()).content.ship?.combat?.battles ?? {};
    log(Object.entries(battles).filter(([, b]) => b.ships.some(s => s.type === combatSim.KIND.enterprise)).map(([n]) => n).join(' '));
    return 0;
  }
  if (command === 'combat-script') {
    const [battle, difficulty, seed, cap] = ['battle', 'difficulty', 'seed', 'cap'].map(k => Number(option(k)));
    const out = option('out');
    const inputsFile = option('inputs');
    if (!out || ![battle, difficulty, seed, cap].every(Number.isInteger) || !(difficulty! >= 0 && difficulty! <= 2)) return usage();
    const inputs = inputsFile ? await readFile(inputsFile, 'utf8') : '';
    const read = combatSim.parseInputScript(inputs);
    for (const e of read.errors) log(`tracediff combat-script: ${inputsFile}: ${e}`);
    if (read.errors.length > 0) return 2;
    // (the grammar has `engineering`, but the harness can't play it: ScummVM's battle waits on the engineering
    // screen (unity.cpp:285-286), which no input leaves, so the fight would stall to its cap: docs/trace-format.md)
    const unplayable = read.inputs.filter(x => x.command.type === 'engineering');
    for (const x of unplayable) log(`tracediff combat-script: ${inputsFile}: at ${x.step} engineering: the harness can't play it (the battle would wait on the engineering screen to its cap)`);
    if (unplayable.length > 0) return 2;
    const m = await maps();
    const combat = m.content.ship?.combat;
    const hex = new Map(Object.entries(m.ids.objects).map(([h, slug]) => [slug, h]));
    const state = createInitialState(m.content);
    const script = combat ? harnessScript(combat, slug => hex.get(slug), slug => state.objects[slug]?.active ?? false, { battle: battle!, difficulty: difficulty as 0 | 1 | 2, seed: seed!, cap: cap!, inputs }) : null;
    if (!script) {
      log(`tracediff combat-script: battle ${battle} isn't in the lifted game, or has no Enterprise`);
      return 2;
    }
    await writeFile(out, script);
    return 0;
  }
  if (command === 'combat-states') {
    // (tools/combatshots: the battle as the screen drew it after each of these steps, replayed from ScummVM's trace)
    const steps = (option('steps') ?? '').split(',').filter(x => x !== '').map(Number);
    const out = option('out');
    if (!scummvm || !out || steps.length === 0 || !steps.every(Number.isInteger)) return usage();
    // (the trace first, as `combat` reads it: its notes and problems said, and a bad trace refused before the game is read)
    const { battles, problems, notes } = readBattles(await readFile(scummvm, 'utf8'));
    for (const n of notes) log(`tracediff combat-states: ${scummvm}: ${n}`);
    for (const p of problems) log(`tracediff combat-states: ${scummvm}: ${p}`);
    const t = battles[0];
    if (problems.length > 0 || !t) {
      if (!t) log(`tracediff combat-states: ${scummvm} has no battle`);
      return 2;
    }
    const m = await maps();
    const hex = new Map(Object.entries(m.ids.objects).map(([h, slug]) => [slug, h]));
    const want = new Set(steps);
    const written: number[] = [];
    replayBattle(m.content, slug => hex.get(slug), t, undefined, {
      atStep: b => {
        if (!want.has(b.steps) || written.includes(b.steps)) return;
        written.push(b.steps);
        // (the Enterprise's systems are the world's own object in the game: here a copy, as JSON)
        writeFileSync(`${out}/state-${b.steps}.json`, JSON.stringify(b));
      },
    });
    for (const n of steps.filter(x => !written.includes(x))) log(`tracediff combat-states: the replay never reached step ${n}`);
    return written.length === steps.length ? 0 : 1;
  }
  if (command === 'combat') {
    if (!scummvm) return usage();
    const m = await maps();
    const { battles, problems, notes } = readBattles(await readFile(scummvm, 'utf8'));
    for (const n of notes) log(`tracediff combat: ${scummvm}: ${n}`);
    for (const p of problems) log(`tracediff combat: ${scummvm}: ${p}`);
    if (problems.length > 0 || battles.length === 0) {
      if (battles.length === 0) log(`tracediff combat: ${scummvm} has no battle`);
      return 2;
    }
    const hex = new Map(Object.entries(m.ids.objects).map(([h, slug]) => [slug, h]));
    const rows: ParityRow[] = [];
    const port: string[] = [];
    // (a trace of several battles, a route's, is one session: each battle goes on from the last's Combat, Plan 23)
    let previous: combatSim.BattleState | undefined;
    for (const t of battles) {
      const r = replayBattle(m.content, slug => hex.get(slug), t, previous);
      previous = r.battle ?? previous;
      port.push(...r.events.map(traceLine));
      const diff = diffBattle(t.events, r.events);
      const row: ParityRow = { battle: t.start.scenario, label: basename(scummvm), diff, problems: r.problems, finished: r.finished };
      rows.push(row);
      for (const line of parityLines(row)) log(`tracediff combat: ${line}`);
    }
    const out = option('out');
    if (out) await writeFile(out, port.join('\n') + '\n');
    const report = option('report');
    if (report) await writeFile(report, renderParityReport(rows, basename(scummvm)));
    return parityExit(rows);
  }
  if (command === 'outline') {
    const world = option('world');
    if (!world) return usage();
    const m = await maps();
    const hexOf = Object.fromEntries(Object.entries(m.ids.objects).map(([hex, slug]) => [slug, hex]));
    for (const line of outline(m.content, world, hexOf)) log(line);
    return 0;
  }
  if (command === 'route') {
    const m = await maps();
    // (local output: ids only, as the original's hex ids where ids.yaml has them)
    const hex: Record<string, string> = {};
    for (const table of [m.ids.objects, m.ids.screens, m.ids.conversations, m.ids.triggers]) {
      for (const [h, slug] of Object.entries(table ?? {})) hex[slug as string] = h;
    }
    const name = (slug: string) => hex[slug] ?? slug;
    const worlds = Object.fromEntries(Object.entries(m.ids.worlds ?? {}).map(([h, slug]) => [slug as string, parseInt(h, 16)]));
    // (the battles the story needs: Plan 10's census, which reads the raw scripts when RAW_DIR is set)
    const mandatory = new Set<number>();
    if (rawDir) {
      const hexOf = Object.fromEntries(Object.entries(m.ids.objects).map(([h, slug]) => [slug, h]));
      for (const r of combatCensus(m.content, await readRaw(rawDir), hexOf)) if (r.mandatory) mandatory.add(r.scenario);
    }
    const ropts = { mandatory, worlds };
    const rows = routeCensus(m.content, ropts);
    const reach = routeReach(m.content, ropts);
    const show = (r: (typeof rows)[number]) => {
      log(`beam ${name(r.beam)} (mission ${r.mission})${r.gaps.length > 0 ? ` GAP ${r.gaps.map(name).join(',')}` : ''}`);
      log(`  ${r.chain.map(s => `${name(s.node)}[${s.via}]`).join(' > ')}`);
      log(`  hails ${r.hails.join(',') || '-'}; battles ${r.battles.map(b => `${b.scenario}${b.mandatory ? '!' : ''}:${b.via}`).join(',') || '-'}; ship fx ${r.shipFx.join(',') || '-'}`);
    };
    const to = option('to');
    if (to !== undefined) {
      // (an original id, or a slug: the chain of nodes the scan finds to it)
      const slug = m.ids.objects[to] ?? to;
      const chain = routeChainTo(m.content, slug, ropts);
      log(chain ? `${name(slug)}: ${chain.map(s => `${name(s.node)}[${s.via}]`).join(' > ')}` : `${name(slug)}: not reached`);
      return 0;
    }
    if (missions) {
      // One row per mission, in the story's order (Mertens, the zoo, Frigis, Frigis again, Horst III, Allanor, the Unity Device), the best chain of each.
      for (const mission of [4, 3, 5, 8, 7, 2, 6]) {
        const best = rows.filter(r => r.mission === mission).sort((a, b) => a.gaps.length - b.gaps.length || a.chain.length - b.chain.length)[0];
        if (best) show(best);
        else log(`mission ${mission}: no beam found`);
      }
      return 0;
    }
    log(`reachable from a new game: ${reach.nodes} nodes; hail types ${reach.hails.join(',') || '-'}; battles ${reach.battles.join(',') || '-'}; ship fx ${reach.shipFx.join(',') || '-'}`);
    for (const b of reach.battleChains) log(`battle ${b.scenario} (hail ${b.type}) from ${b.chain.map(name).join(' > ')}`);
    for (const r of rows) show(r);
    return 0;
  }
  if (command === 'census') {
    if (!rawDir) return usage();
    const m = await maps();
    const hexOf = Object.fromEntries(Object.entries(m.ids.objects).map(([hex, slug]) => [slug, hex]));
    for (const line of renderCensus(combatCensus(m.content, await readRaw(rawDir), hexOf))) log(line);
    return 0;
  }
  const normalized = async (m: GameMaps) => {
    const n = normalizeScummvm(await readFile(scummvm!, 'utf8'), m);
    for (const p of n.problems) log(`tracediff: ${scummvm}: ${p}`);
    return n;
  };

  if (command === 'diff') {
    if (!scummvm || !ts) return usage();
    const m = await maps();
    const s = await normalized(m);
    if (s.problems.length > 0) return 2;
    const report = diffTraces(s.events, fromJsonl(await readFile(ts, 'utf8')), m, s.notCompared);
    const out = option('out');
    if (out) await writeFile(out, renderReport(report, basename(scummvm)));
    log(report.clean
      ? 'tracediff diff: CLEAN'
      : `tracediff diff: ${report.steps.length} step(s) differ${report.structure.length > 0 ? `; ${report.structure.join('; ')}` : ''}${out ? ` (see ${out})` : ''}`);
    return report.clean ? 0 : 1;
  }

  if (command === 'summary') {
    if (!scummvm === !ts) return usage();
    if (scummvm) {
      const s = await normalized(await maps());
      if (s.problems.length > 0) return 2;
      log(summarize(s.events));
    } else {
      log(summarize(fromJsonl(await readFile(ts!, 'utf8'))));
    }
    return 0;
  }
  return usage();
}
