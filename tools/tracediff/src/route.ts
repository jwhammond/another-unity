// SPDX-License-Identifier: GPL-3.0-or-later
import { parseConversationString, SHIP_FLAGS, type Effect, type GameContent, type RuleGroup } from '@another-unity/engine';

/** One beam-down the ship's scripts can reach, with the chain of triggers, hails and talk strings that leads to it. */
export interface RouteRow {
  /** The screen the BeamBlock names. */
  beam: string;
  /** From a trigger enabled at the start to the beam: `node` is an object or conversation slug (the screen for `beam`). */
  chain: { node: string; via: string }[];
  /** The hail types on the chain, in order. */
  hails: number[];
  /** Every ship effect on the chain (`reveal:3`, `universe:<object>`, ...). */
  shipFx: string[];
  /** The battle scenarios on the chain (hail types 0xa, 0xb, 0x10, 0x11): `via` says whether a script's hail or a battle's own hook raised it. */
  battles: { scenario: number; mandatory: boolean; via: 'hail' | 'hook' }[];
  /** The original's world number of the beam's mission (the beam's own world, else the screen's world). */
  mission: number;
  /** The nodes whose starter the scan couldn't find: the chain starts at the first of them. */
  gaps: string[];
}

export interface RouteOptions {
  /** The scenarios Plan 10's combat census says the story needs (`combatCensus`). */
  mandatory?: ReadonlySet<number>;
  /** A world's slug to its number, for a beam to one of its screens. */
  worlds?: Readonly<Record<string, number>>;
}

const BATTLE_TYPES = [0xa, 0xb, 0x10, 0x11];

interface Edge { to: string; via: string; hail?: number; battle?: number }
interface Node { awayRoots?: { world: string; to: string; via: string }[]; edges: Edge[]; shipFx: string[]; beams: { to: string; world?: number }[] }

/** The states each object can take: where it starts, and every state an alter anywhere sets it to. */
function reachableStates(c: GameContent): Map<string, Set<number>> {
  const states = new Map<string, Set<number>>();
  const add = (id: string, v: number) => {
    if (!states.has(id)) states.set(id, new Set());
    states.get(id)!.add(v);
  };
  for (const o of Object.values(c.objects)) add(o.id, o.state ?? 0);
  const visit = (x: unknown): void => {
    if (Array.isArray(x)) x.forEach(visit);
    else if (typeof x === 'object' && x !== null) {
      for (const [k, v] of Object.entries(x)) {
        if (k === 'alter' && typeof v === 'object' && v !== null) {
          const a = v as { object?: unknown; state?: unknown };
          if (typeof a.object === 'string' && typeof a.state === 'number') add(a.object, a.state);
        } else visit(v);
      }
    }
  };
  for (const o of Object.values(c.objects)) visit(o.on), visit(o.phaser);
  for (const cv of Object.values(c.conversations)) visit(cv.responses);
  return states;
}

/** A group whose state checks name a state that its object starts without and nothing sets can never run. */
function possible(g: RuleGroup, states: Map<string, Set<number>>): boolean {
  return (g.when?.checks ?? []).every(ch => !('object' in ch) || ch.state === undefined || states.get(ch.object)?.has(ch.state) !== false);
}

function walkEffects(c: GameContent, groups: RuleGroup[], node: Node, states: Map<string, Set<number>>, away: string | null = null): void {
  for (const g of groups) if (possible(g, states)) for (const e of g.do) walkEffect(c, e, node, states, away);
}

/** The conversation nodes a talk string names (`conv@situation`; "?n" is any situation up to n). */
function conversationsOf(c: GameContent, talk: string | undefined): string[] {
  const ref = talk === undefined ? undefined : parseConversationString(talk);
  if (!ref || !c.conversations[ref.conversation]) return [];
  return situations(ref.situation).map(n => convKey(ref.conversation, n));
}
const situations = (s: string): number[] => (s.startsWith('?') ? Array.from({ length: Number(s.slice(1)) + 1 }, (_, i) => i) : [Number(s)]);
const convKey = (conv: string, situation: number) => `${conv}@${situation}`;

const contactCache = new WeakMap<GameContent, Set<string>>();
/** The objects the bridge's Comms and lounge can list (ship.yaml `contacts`). */
function contactSlugs(c: GameContent): Set<string> {
  let set = contactCache.get(c);
  if (!set) {
    set = new Set([...(c.ship?.data.contacts.comms.map(x => x.object) ?? []), ...(c.ship?.data.contacts.lounge ?? [])]);
    contactCache.set(c, set);
  }
  return set;
}

function walkEffect(c: GameContent, e: Effect, node: Node, states: Map<string, Set<number>>, away: string | null): void {
  if ('trigger' in e) {
    const t = c.triggers.find(x => x.id === e.trigger.id);
    if (e.trigger.enabled && t) {
      node.edges.push({ to: t.target, via: `${t.id}/${t.type}` });
      // (an away world's script that enables a ship trigger is a root of its own: the mission has to be played first)
      if (away !== null && t.context === 'ship') node.awayRoots = [...(node.awayRoots ?? []), { world: away, to: t.target, via: `${t.id}/${t.type}` }];
    }
  } else if ('communicate' in e) {
    const h = e.communicate;
    if (BATTLE_TYPES.includes(h.type)) {
      node.edges.push({ to: `scenario${h.scenario ?? '?'}`, via: `hail${h.type}`, hail: h.type, battle: h.scenario ?? -1 });
      return;
    }
    const targets = h.conversation !== undefined && c.conversations[h.conversation]
      ? [convKey(h.conversation, h.situation ?? 0)]
      : conversationsOf(c, h.from ? c.objects[h.from]?.talk : undefined);
    for (const to of targets) node.edges.push({ to, via: `hail${h.type}`, hail: h.type });
  } else if ('alter' in e) {
    const a = e.alter;
    for (const to of conversationsOf(c, a.converseNow)) node.edges.push({ to, via: 'alterHail' });
    // (a contact the bridge's Comms or the lounge lists starts its talk string when the player hails it)
    if (a.active === true && contactSlugs(c).has(a.object)) for (const to of conversationsOf(c, c.objects[a.object]?.talk)) node.edges.push({ to, via: 'comms' });
    for (const to of conversationsOf(c, a.talk)) node.edges.push({ to, via: 'talk' });
  } else if ('act' in e) {
    const target = e.act.object;
    if (target && c.objects[target]) node.edges.push({ to: target, via: 'act' });
  } else if ('beam' in e) {
    if (e.beam.to) node.beams.push({ to: e.beam.to, ...(e.beam.world === undefined ? {} : { world: e.beam.world }) });
  } else if ('ship' in e) {
    const f = e.ship;
    node.shipFx.push(
      'reveal' in f ? `reveal:${f.reveal}` : 'universe' in f ? `universe:${f.universe.object}` : 'computer' in f ? `computer:${f.computer}:${f.entry}`
        : 'newWarpMovie' in f ? 'newWarpMovie' : 'repair',
    );
  } else if ('choose' in e) {
    for (const o of e.choose.options) walkEffects(c, o.do, node, states, away);
  }
}

/**
 * Which beam-downs the ship's scripts reach, and how: a walk over the lifted content from every ship trigger enabled at the start
 * (R8). It follows a trigger effect that enables a trigger to its object, a hail to its conversation and situation (types 7 and 8 name
 * it, the others read the hailing object's talk string), an alter's `converseNow` and new talk string, and a response's `next` situation.
 * A rule group is skipped if a state check names a state its object never has. Other conditions are ignored, so a chain is a possible
 * route, not a proved one: it over-approximates.
 */
/** What a new game's own scripts reach, beam or not (the CLI's summary). */
export interface RouteReach {
  nodes: number;
  hails: number[];
  battles: number[];
  shipFx: string[];
  /** Each battle hail with the chain of nodes from a start that raises it. */
  battleChains: { scenario: number; type: number; chain: string[] }[];
}

export function routeCensus(c: GameContent, opts: RouteOptions = {}): RouteRow[] {
  return analyze(c, opts).rows;
}

export function routeReach(c: GameContent, opts: RouteOptions = {}): RouteReach {
  return analyze(c, opts).reach;
}

const SCENARIO = 'scenario';
const NO_SCENARIO = 0xffff;

/** The chain of nodes (with the edge into each) from a start, or an away root, to a node; null if the scan doesn't reach it. */
export function routeChainTo(c: GameContent, target: string, opts: RouteOptions = {}): { node: string; via: string }[] | null {
  return analyze(c, opts).chainTo(target);
}

function analyze(c: GameContent, opts: RouteOptions): { rows: RouteRow[]; reach: RouteReach; chainTo: (node: string) => { node: string; via: string }[] | null } {
  const states = reachableStates(c);
  const battles = c.ship?.combat?.battles ?? {};
  const friendly = (type: number) => ((c.ship?.combat?.kinds[type]?.flags ?? 0) & SHIP_FLAGS.friendly) !== 0;
  // (the objects a battle's own scripts run: Enter, Exit, Warp and its ships' kill lists; the hooks)
  const hookObjects = new Set<string>();
  for (const b of Object.values(battles)) for (const o of [b.enter, b.exit, b.warp, ...b.ships.filter(x => !friendly(x.type)).map(x => x.object)]) if (o) hookObjects.add(o);
  const awayWorld = (key: string): string | null => {
    const slug = key.slice(0, key.indexOf('.'));
    return slug !== '' && slug !== 'ship' && slug !== 'space' && c.screens[`${slug}.s01`] !== undefined ? slug : null;
  };
  const nodes = new Map<string, Node>();
  const nodeOf = (key: string): Node => {
    let n = nodes.get(key);
    if (n) return n;
    n = { edges: [], shipFx: [], beams: [] };
    nodes.set(key, n);
    const obj = c.objects[key];
    const at = key.lastIndexOf('@');
    const cv = !obj && at > 0 ? c.conversations[key.slice(0, at)] : undefined;
    const away = awayWorld(key);
    if (obj) {
      for (const groups of Object.values(obj.on ?? {})) walkEffects(c, groups ?? [], n, states, away);
      for (const groups of Object.values(obj.phaser?.on ?? {})) walkEffects(c, groups ?? [], n, states, away);
    } else if (cv) {
      // (the situation's responses; each can send the talk on to its `next` situation)
      for (const r of cv.responses) {
        if (r.situation !== Number(key.slice(at + 1))) continue;
        for (const groups of r.results ?? []) walkEffects(c, groups, n, states, awayWorld(cv.id));
        if (r.next !== undefined) n.edges.push({ to: convKey(cv.id, r.next), via: 'next' });
      }
    } else if (key.startsWith(SCENARIO)) {
      const b = battles[Number(key.slice(SCENARIO.length))];
      if (b) {
        for (const [via, o] of [['enter', b.enter], ['exit', b.exit], ['warp', b.warp]] as const) if (o && c.objects[o]) n.edges.push({ to: o, via });
        for (const s of b.ships) if (!friendly(s.type) && c.objects[s.object]) n.edges.push({ to: s.object, via: 'kill' });
      }
    }
    return n;
  };

  // Every object, and every situation of every conversation, so a beam whose starter is missing is still found.
  for (const o of Object.values(c.objects)) nodeOf(o.id);
  for (const cv of Object.values(c.conversations)) for (const r of cv.responses) nodeOf(convKey(cv.id, r.situation));
  for (let pending = [...nodes.keys()]; pending.length > 0;) {
    const next: string[] = [];
    for (const key of pending) for (const e of nodeOf(key).edges) if (!nodes.has(e.to)) { nodeOf(e.to); next.push(e.to); }
    pending = next;
  }

  const starts = [...new Set(c.triggers.filter(t => t.context === 'ship' && t.enabled).map(t => t.target))];
  // (the contacts a new game's bridge lists are hailed from the start)
  for (const o of contactSlugs(c)) if (c.objects[o]?.active !== false) for (const to of conversationsOf(c, c.objects[o]?.talk)) if (!starts.includes(to)) starts.push(to);
  type Step = { from: string | null; edge: Edge | null };
  const seen = new Map<string, Step>();
  const search = (roots: string[]): void => {
    for (const r of roots) if (!seen.has(r)) seen.set(r, { from: null, edge: null });
    for (let queue = roots.filter(r => seen.get(r)!.from === null); queue.length > 0;) {
      const next: string[] = [];
      for (const key of queue) {
        for (const e of nodes.get(key)!.edges) {
          if (seen.has(e.to)) continue;
          seen.set(e.to, { from: key, edge: e });
          next.push(e.to);
        }
      }
      queue = next;
    }
  };
  search(starts);
  const fromStart = new Set(seen.keys());
  // Then each away world's scripts that enable a ship trigger, as roots `away:<world>` for what the starts don't reach.
  const awayRoots = new Map<string, { to: string; via: string }[]>();
  for (const n of nodes.values()) for (const r of n.awayRoots ?? []) awayRoots.set(r.world, [...(awayRoots.get(r.world) ?? []), { to: r.to, via: r.via }]);
  const worldNumber = (slug: string) => opts.worlds?.[slug] ?? 999;
  for (const w of [...awayRoots.keys()].sort((a, b) => worldNumber(a) - worldNumber(b) || (a < b ? -1 : 1))) {
    const root = `away:${w}`;
    nodes.set(root, { edges: awayRoots.get(w)!.map(r => ({ to: r.to, via: r.via })), shipFx: [], beams: [] });
    seen.set(root, { from: null, edge: null });
    search([root]);
  }
  const reached = seen;

  // Who feeds each node, for the beams nobody reaches.
  const parents = new Map<string, string[]>();
  for (const [key, n] of nodes) for (const e of n.edges) parents.set(e.to, [...(parents.get(e.to) ?? []), key]);

  const chainTo = (k: string): string[] => {
    const chain: string[] = [];
    for (let x: string | null = k; x !== null; x = reached.get(x)!.from) chain.unshift(x);
    return chain;
  };
  // What the new game's own scripts reach, beam or not.
  const startReached = [...fromStart];
  const reach: RouteReach = {
    battleChains: startReached.flatMap(k => nodes.get(k)!.edges.filter(e => e.battle !== undefined).map(e => ({ scenario: e.battle!, type: e.hail!, chain: chainTo(k) }))),
    nodes: startReached.length,
    hails: [...new Set(startReached.flatMap(k => nodes.get(k)!.edges.flatMap(e => (e.hail !== undefined ? [e.hail] : []))))].sort((a, b) => a - b),
    battles: [...new Set(startReached.flatMap(k => nodes.get(k)!.edges.flatMap(e => (e.battle !== undefined ? [e.battle] : []))))].sort((a, b) => a - b),
    shipFx: [...new Set(startReached.flatMap(k => nodes.get(k)!.shipFx))],
  };

  const slugOf = (screen: string) => screen.slice(0, screen.indexOf('.'));
  const rows: RouteRow[] = [];
  for (const [key, n] of nodes) {
    if (n.beams.length === 0) continue;
    let path: Step[] = [];
    const keys: string[] = [];
    const gaps: string[] = [];
    if (reached.has(key)) {
      for (let k: string | null = key; k !== null; k = reached.get(k)!.from) { keys.unshift(k); path.unshift(reached.get(k)!); }
    } else {
      // Back up through whoever feeds it, to the node nothing feeds.
      const seenUp = new Set<string>([key]);
      let k = key;
      keys.unshift(k);
      for (;;) {
        const p = (parents.get(k) ?? []).find(x => !seenUp.has(x));
        if (p === undefined) break;
        seenUp.add(p);
        path = [];
        k = p;
        keys.unshift(k);
      }
      gaps.push(k);
      path = keys.map((x, i) => ({ from: i === 0 ? null : keys[i - 1], edge: i === 0 ? null : nodes.get(keys[i - 1])!.edges.find(e => e.to === x) ?? null }));
    }
    const chain = keys.map((node, i) => ({ node, via: i === 0 ? (node.startsWith('away:') ? 'away' : 'start') : path[i].edge!.via }));
    const hails = path.flatMap(s => (s.edge?.hail !== undefined ? [s.edge.hail] : []));
    // (a battle hail a chain node raises is on the chain whether or not the walk goes through it; it is a hook's if the node is a battle's own script)
    const raised = keys.flatMap(k => nodes.get(k)!.edges.flatMap(e => (e.battle !== undefined && e.battle !== NO_SCENARIO ? [{ scenario: e.battle, via: hookObjects.has(k) ? 'hook' as const : 'hail' as const }] : [])));
    const battleRows = raised.filter((b, i) => raised.findIndex(x => x.scenario === b.scenario && x.via === b.via) === i)
      .map(b => ({ ...b, mandatory: opts.mandatory?.has(b.scenario) ?? false }));
    const shipFx = keys.flatMap(k => nodes.get(k)!.shipFx);
    const seenBeams = new Set<string>();
    for (const beam of n.beams) {
      const id = `${beam.to}/${beam.world ?? ''}`;
      if (seenBeams.has(id)) continue;
      seenBeams.add(id);
      rows.push({
        beam: beam.to, chain: [...chain, { node: beam.to, via: 'beam' }], hails, shipFx, battles: battleRows,
        mission: beam.world ?? opts.worlds?.[slugOf(beam.to)] ?? 0, gaps,
      });
    }
  }
  const chainFor = (node: string) => {
    if (!reached.has(node)) return null;
    const keys = chainTo(node);
    return keys.map((k, i) => ({ node: k, via: i === 0 ? (k.startsWith('away:') ? 'away' : 'start') : reached.get(k)!.edge!.via }));
  };
  return { reach, chainTo: chainFor, rows: rows.sort((a, b) => a.gaps.length - b.gaps.length || a.chain.length - b.chain.length || (a.beam < b.beam ? -1 : a.beam > b.beam ? 1 : 0)) };
}
