// SPDX-License-Identifier: GPL-3.0-or-later
import { ALLOWANCES } from './allowances';
import type { Report } from './diff';
import { describeNorm, type Norm } from './model';

/** The diff as Markdown: the verdict, each differing step, the allowances used, and what wasn't compared. */
export function renderReport(r: Report, title: string): string {
  const out = [`# Trace diff: ${title}`, ''];
  out.push(r.clean ? '**CLEAN**: no differences beyond the allowances below.' : `**Not clean:** ${r.steps.length} step(s) differ.`, '');
  if (r.structure.length > 0) out.push('## Structure', '', ...r.structure.map(s => `- ${s}`), '');
  for (const d of r.steps) {
    out.push(`## Line ${d.line}: \`${d.text}\``, '');
    for (const x of d.onlyScummvm) out.push(`- only in ScummVM: ${x}`);
    for (const x of d.onlyTs) out.push(`- only in TypeScript: ${x}`);
    for (const x of d.rng) out.push(`- random draw ${x}`);
    for (const x of d.state) out.push(`- ${x.key}: ScummVM ${JSON.stringify(x.scummvm)}, TypeScript ${JSON.stringify(x.ts)}`);
    for (const x of d.explained) out.push(`- known cause: ${x}`);
    out.push('');
  }
  out.push('## Allowances used', '', '| allowance | times | effect | why |', '|---|---|---|---|');
  for (const a of ALLOWANCES) {
    const n = r.allowances.get(a.id);
    if (n) out.push(`| ${a.id} | ${n} | ${a.kind === 'explain' ? 'explained, still reported' : 'forgiven'} | ${a.why} |`);
  }
  out.push('', '## Not compared', '', '| what | count |', '|---|---|');
  for (const [what, n] of [...r.notCompared].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) out.push(`| ${what} | ${n} |`);
  if (r.info.length > 0) out.push('', '## Notes', '', ...r.info.map(i => `- ${i}`));
  return out.join('\n') + '\n';
}

/** One trace, step by step: what was done, said, chosen and changed (counters left out), for writing walkthroughs. */
export function summarize(events: Norm[]): string {
  const lines: string[] = [];
  for (const e of events) {
    if (e.k === 'step') lines.push(`line ${e.line}: ${e.text}`);
    else if (e.k === 'action' && e.depth === 1) lines.push(`  ${describeNorm(e)}`);
    else if (e.k === 'set' && !e.key.startsWith('counter:')) lines.push(`  ${describeNorm(e)}`);
    else if (['say', 'choice', 'screen', 'ship', 'movie', 'refused', 'error', 'trigger', 'timer'].includes(e.k)) lines.push(`  ${describeNorm(e)}`);
  }
  return lines.join('\n');
}
