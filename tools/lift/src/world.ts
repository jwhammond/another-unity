// SPDX-License-Identifier: GPL-3.0-or-later
import type { AdviceDef, TriggerDef } from '@another-unity/engine';
import type { LiftCtx } from './context';
import { triggerSlug } from './ids';
import type { TriggerT, WorldFileT } from './raw';
import { convertTalk } from './talk';

export function liftTriggers(ctx: LiftCtx, include: (t: TriggerT) => boolean): TriggerDef[] {
  const out: TriggerDef[] = [];
  const seen = new Map<number, number>();
  ctx.raw.triggers.forEach((t, i) => {
    // (count every trigger with the id, lifted or not, so a repeat's suffix doesn't depend on what's asked for)
    const n = (seen.get(t.id) ?? 0) + 1;
    seen.set(t.id, n);
    if (!include(t)) return;
    const { id, type, target, enabled, context, timer_start, dist, from, to, reversed, instant } = t;
    const where = `triggers.json#/${i}`;
    if (type === 3) {
      ctx.problems.warn(where, `trigger ${id} is unused (type 3): it never fires, so it isn't lifted`);
      return;
    }
    if (n > 1) ctx.problems.warn(where, `a second trigger ${id}, which TriggerBlocks never reach (getTrigger finds the first)`);
    const kind = type === 2 ? ('proximity' as const) : type === 1 ? ('timer' as const) : ('normal' as const);
    const base = {
      id: n === 1 ? ctx.ids.trigger(id, where) : `${triggerSlug(id)}.${n}`,
      type: kind,
      context: context === 1 ? ('away' as const) : ('ship' as const),
      target: ctx.ids.object(target, where),
      enabled,
    };
    if (type === 2) {
      // the ship's distance to a place in space (trigger.cpp proximityTick): the ship tick runs it
      if (dist === null || from === null || to === null || reversed === null || instant === null) {
        ctx.problems.error(where, `proximity trigger ${id} has no test (dist, from, to, reversed, instant)`);
        return;
      }
      out.push({ ...base, type: 'proximity' as const, proximity: { dist, from: ctx.ids.object(from, where), to: ctx.ids.object(to, where), reversed, instant } });
      return;
    }
    out.push({ ...base, ...(type === 1 ? { seconds: timer_start } : {}) });
  });
  return out;
}

/** wWWWa000.dat: for each crew member, the first line under their advice name (getAdvice, data.cpp:1147-1161). */
export function liftAdvice(ctx: LiftCtx, w: WorldFileT): Record<string, AdviceDef> {
  const names = new Map<string, string>();
  for (const [key, name] of Object.entries(ctx.raw.executable._adviceNames)) {
    const n = Number(key);
    // (anyone who isn't crew asks as 0xf)
    const slug = n === 0xf ? '$anyone' : ctx.crew.get(n);
    if (slug) names.set(name.toLowerCase(), slug);
  }
  const out: Record<string, AdviceDef> = {};
  for (const [num, entry] of Object.entries(w.advice ?? {})) {
    const def: AdviceDef = {};
    for (const level of ['easy', 'hard'] as const) {
      const lines: Record<string, string> = {};
      entry[level].forEach((line, i) => {
        const { name, text } = line;
        const where = `${w.id}#/advice/${num}/${level}/${i}`;
        const who = names.get(name.toLowerCase());
        if (!who) ctx.problems.warn(where, `advice for "${name}", which no advice name in the executable matches`);
        else if (lines[who] === undefined) lines[who] = convertTalk(text, w.world, ctx.ids, ctx.problems, where);
      });
      if (Object.keys(lines).length > 0) def[level] = lines;
    }
    out[ctx.ids.advice(w.world, Number(num), `${w.id}#/advice/${num}`)] = def;
  }
  return out;
}
