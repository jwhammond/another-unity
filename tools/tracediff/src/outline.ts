// SPDX-License-Identifier: GPL-3.0-or-later
import { SHIP, type Condition, type Effect, type GameContent, type RuleGroup } from '@another-unity/engine';

/**
 * Ship scripts that write away-world objects (Plan 8 R6; Plan 9 R2), by original id, from the raw IR's AlterBlock and
 * CommandBlock targets. Neither engine runs them before M4, so a route must not need what they write.
 */
export const SHIP_WRITES: Record<string, string[]> = {
  '5f0372': ['050100', '050801', '050800'],
  '5f0374': ['050100', '050106', '050109', '050126', '050127', '050200', '050202', '050205', '05020f'],
  '5f0383': ['040701', '040704', '040705', '040708', '040709', '04070a'],
  '5f0384': ['040701', '040704', '040705', '040708', '040709', '04070a'],
  '5f0385': ['040701', '040704', '040705', '040708', '040709', '04070a'],
  w05fc005: ['050502', '05050b'],
  w05fc007: ['04090b', '040903'],
};

/** Every group of a rule list, then the groups inside its choices (`<group>/choice<n>/<k>`, as the sim names them). */
export function groupsIn(groups: RuleGroup[] | undefined, path: string): Array<[string, RuleGroup]> {
  const out: Array<[string, RuleGroup]> = [];
  (groups ?? []).forEach((g, i) => {
    out.push([`${path}/${i}`, g]);
    for (const fx of g.do) {
      if ('choose' in fx) fx.choose.options.forEach((o, n) => out.push(...groupsIn(o.do, `${path}/${i}/choice${n}`)));
    }
  });
  return out;
}

export function needs(when: Condition | undefined, label: (slug: string) => string): string[] {
  if (!when) return [];
  const out: string[] = [];
  for (const c of when.checks ?? []) {
    if ('emptyAt' in c) {
      out.push(`nobody at ${c.emptyAt}`);
      continue;
    }
    let s = label(c.object);
    if (c.state !== undefined) s += `=${c.state}`;
    if (c.status) s += ` ${c.status}`;
    if (c.screen) s += ` on ${c.screen}`;
    if (c.at) s += ` at ${c.at}`;
    out.push(s);
  }
  if (when.other) out.push(`with ${label(when.other)}`);
  if (when.who) out.push(`by ${label(when.who)}`);
  if (when.skill !== undefined) out.push(`skill ${when.skill}`);
  if (when.near) out.push(`near ${when.near.dist}`);
  if (when.counter) out.push(`counter ${when.counter.mode} ${when.counter.value}`);
  return out;
}

function sets(effects: Effect[]): string[] {
  const out: string[] = [];
  for (const fx of effects) {
    if ('alter' in fx) {
      const a = fx.alter;
      if (a.state !== undefined) out.push(`${a.object}=${a.state}`);
      if (a.get) out.push(`get ${a.object}`);
      if (a.active !== undefined) out.push(`${a.object} ${a.active ? 'on' : 'off'}`);
      if (a.timer !== undefined) out.push(`${a.object} timer ${a.timer}`);
    } else if ('screen' in fx) out.push(`-> ${fx.screen.to}${fx.screen.gameOver !== undefined ? ` gameOver ${fx.screen.gameOver}` : ''}`);
    else if ('trigger' in fx) out.push(`trigger ${fx.trigger.id} ${fx.trigger.enabled ? 'on' : 'off'}`);
    else if ('missing' in fx) out.push(`MISSING ${fx.missing.kind} ${fx.missing.id}`);
    else if ('converse' in fx) out.push(`${fx.converse.conversation} ${fx.converse.situation}/${fx.converse.key} ${fx.converse.to}`);
    else if ('beam' in fx) out.push(`beam ${fx.beam.to ?? 'none'}`);
    else if ('communicate' in fx) out.push(`hail ${fx.communicate.conversation ?? fx.communicate.from ?? '?'} ${fx.communicate.situation ?? ''}`.trim());
    else if ('react' in fx && typeof fx.react.do === 'object' && 'beamTo' in fx.react.do) out.push(`beamTo ${fx.react.do.beamTo.screen ?? 'here'}`);
  }
  return out;
}

/**
 * A world's puzzle-gate graph from the lifted content, for writing its walkthrough (Plan 9 W1): its screens with their
 * timers, then every group that is gated or changes something, with flags for goals, the watch list (R2, R3), content
 * the export lacks (R1) and random draws. It prints lifted slugs: keep its output local (it is generated from the game).
 */
export function outline(content: GameContent, world: string, hexOf: Record<string, string> = {}): string[] {
  const mine = (id: string) => id.startsWith(`${world}.`);
  const label = (slug: string) => (hexOf[slug] ? `${hexOf[slug]} ${slug}` : slug);
  const watched = new Set(Object.values(SHIP_WRITES).flat());
  const triggers = new Map(content.triggers.map(t => [t.id, t]));
  const hasRules = (slug: string) => Object.values(content.objects[slug]?.on ?? {}).some(g => (g?.length ?? 0) > 0);
  const objects = Object.values(content.objects).filter(o => mine(o.id)).sort((a, b) => a.id.localeCompare(b.id));
  const out: string[] = [];

  for (const id of Object.keys(content.screens).filter(mine).sort()) {
    const timers = objects
      .filter(o => o.screen === id && (o.timer ?? 0) > 0)
      .map(o => `${label(o.id)} ${o.timer}s${o.active === false ? ' (inactive)' : ''}`);
    out.push(`screen ${id}${content.screens[id].startup?.closeup ? ' (close-up)' : ''}: timers [${timers.join(', ')}]`);
  }

  const groups: Array<[string, RuleGroup]> = [];
  for (const o of objects) {
    for (const [verb, list] of Object.entries(o.on ?? {})) groups.push(...groupsIn(list, `${label(o.id)} ${verb}`));
  }
  for (const id of Object.keys(content.conversations).filter(mine).sort()) {
    content.conversations[id].responses.forEach(r =>
      (r.results ?? []).forEach((list, n) => groups.push(...groupsIn(list, `${id} ${r.situation}/${r.key} results${n}`))));
  }

  for (const [path, g] of groups) {
    const n = needs(g.when, label);
    const s = sets(g.do);
    const flags: string[] = [];
    const goal = g.do.some(fx => ('screen' in fx && fx.screen.to === SHIP)
      || ('trigger' in fx && fx.trigger.enabled && triggers.get(fx.trigger.id)?.context === 'ship'));
    if (goal) flags.push('GOAL');
    if ((g.when?.checks ?? []).some(c => 'object' in c && watched.has(hexOf[c.object] ?? ''))) flags.push('WATCH ship-written');
    for (const fx of g.do) {
      if (!('trigger' in fx) || !fx.trigger.enabled) continue;
      const t = triggers.get(fx.trigger.id);
      if (t && !hasRules(t.target)) flags.push(`WATCH ${t.id} -> ${t.target} (${t.context}${t.seconds !== undefined ? `, ${t.seconds}s` : ''}) has no lifted rules`);
    }
    if (g.when?.skill !== undefined || g.do.some(fx => 'choose' in fx)) flags.push('RANDOM/CHOICE');
    if (n.length || s.length || flags.length) out.push(`${path}: needs [${n.join(', ')}] -> ${s.join('; ')}${flags.length ? `  ${flags.join('; ')}` : ''}`);
  }
  return out;
}
