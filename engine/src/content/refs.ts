// SPDX-License-Identifier: GPL-3.0-or-later
import { parseConversationString } from './talkString';
import { ACTOR, ANYONE, CURRENT, NONE, SHIP, type CombatData, type GameContent, type ObjectDef, type RuleGroup, type StartupActionDef } from './types';

type Report = (path: string, message: string) => void;

/** Every reference between content files must resolve; returns one line per problem. */
export function checkRefs(c: GameContent, where: Map<string, string> = new Map()): string[] {
  const out: string[] = [];
  const s = c.start;
  if (!c.screens[s.screen]) out.push(`game.yaml: start.screen: unknown screen "${s.screen}"`);
  else if (!c.screens[s.screen].markers[s.entrance]) {
    out.push(`game.yaml: start.entrance: unknown marker "${s.entrance}" on screen "${s.screen}"`);
  }
  (c.missions ?? []).forEach((m, i) => {
    if (!c.screens[m.screen]) out.push(`game.yaml: missions[${i}].screen: unknown screen "${m.screen}"`);
    else if (!c.screens[m.screen].markers[m.entrance]) out.push(`game.yaml: missions[${i}].entrance: unknown marker "${m.entrance}" on screen "${m.screen}"`);
  });
  for (const member of new Set([...s.awayTeam, s.leader])) {
    if (!c.objects[member]?.crew) out.push(`game.yaml: start: "${member}" is not a crew object`);
  }

  for (const def of Object.values(c.objects)) {
    const file = where.get(def.id) ?? `objects/${def.id}`;
    const report: Report = (path, message) => out.push(`${file}: ${path}: ${message}`);
    if (def.screen !== null && !c.screens[def.screen]) report('screen', `unknown screen "${def.screen}"`);
    if (def.at && !hasMarker(c, def.screen, def.at)) report('at', `unknown marker "${def.at}" on screen "${def.screen}"`);
    if (def.transition && !c.objects[def.transition]) report('transition', `unknown object "${def.transition}"`);
    if (def.talk !== undefined) checkTalkString(c, def.talk, 'talk', report);
    for (const who of Object.keys(def.descriptions ?? {})) {
      if (!c.objects[who]?.crew) report('descriptions', `"${who}" is not a crew object`);
    }
    for (const [list, groups] of Object.entries(def.phaser?.on ?? {})) {
      checkGroups(c, def, groups ?? [], `phaser.on.${list}`, report);
    }
    for (const [verb, groups] of Object.entries(def.on ?? {})) {
      checkGroups(c, def, groups ?? [], `on.${verb}`, report);
    }
  }

  const triggerIds = new Set<string>();
  c.triggers.forEach((t, i) => {
    if (triggerIds.has(t.id)) out.push(`triggers.yaml: [${i}].id: duplicate trigger id "${t.id}"`);
    triggerIds.add(t.id);
    if (!c.objects[t.target]) out.push(`triggers.yaml: [${i}].target: unknown object "${t.target}"`);
    if (t.type === 'timer' && t.seconds === undefined) out.push(`triggers.yaml: [${i}].seconds: a timer trigger needs seconds`);
  });
  checkRules(c, out);
  checkScreenStartups(c, where, out);
  checkFloors(c, where, out);
  checkConversations(c, where, out);
  checkAdvice(c, out);
  checkShip(c, out);
  checkCombat(c, out);
  return out;
}

function hasMarker(c: GameContent, screen: string | null, marker: string): boolean {
  // (objects off-screen, like inventory items, have no markers to check)
  return screen === null || c.screens[screen]?.markers[marker] !== undefined;
}

function checkGroups(c: GameContent, def: ObjectDef, groups: RuleGroup[], path: string, report: Report): void {
  const isObject = (id: string) => c.objects[id] !== undefined;
  const isScreen = (id: string) => c.screens[id] !== undefined;

  groups.forEach((group, i) => {
    const p = `${path}[${i}]`;
    const w = group.when;
    if (w) {
      if (w.other && w.other !== NONE && !isObject(w.other)) report(`${p}.when.other`, `unknown object "${w.other}"`);
      if (w.who && !isObject(w.who)) report(`${p}.when.who`, `unknown object "${w.who}"`);
      if (w.near?.at && !hasMarker(c, def.screen, w.near.at)) {
        report(`${p}.when.near.at`, `unknown marker "${w.near.at}" on screen "${def.screen}"`);
      }
      (w.checks ?? []).forEach((ch, j) => {
        const cp = `${p}.when.checks[${j}]`;
        if ('emptyAt' in ch) {
          if (!hasMarker(c, def.screen, ch.emptyAt)) report(`${cp}.emptyAt`, `unknown marker "${ch.emptyAt}" on screen "${def.screen}"`);
          return;
        }
        if (ch.object !== ANYONE && !isObject(ch.object)) report(`${cp}.object`, `unknown object "${ch.object}"`);
        else if (ch.status === 'inTeam' && ch.object !== ANYONE && !c.objects[ch.object].crew) {
          report(`${cp}.status`, 'status inTeam needs a crew object');
        }
        if (ch.screen && !isScreen(ch.screen)) report(`${cp}.screen`, `unknown screen "${ch.screen}"`);
        else if (ch.at) {
          // the marker is on the screen the check asks for, else the object's own, else this object's
          const screen = ch.screen ?? (ch.object === ANYONE ? null : c.objects[ch.object]?.screen) ?? def.screen;
          if (!hasMarker(c, screen, ch.at)) report(`${cp}.at`, `unknown marker "${ch.at}" on screen "${screen}"`);
        }
      });
    }

    group.do.forEach((fx, j) => {
      const ep = `${p}.do[${j}]`;
      if ('alter' in fx) {
        const a = fx.alter;
        if (a.object !== ANYONE && !isObject(a.object)) {
          report(`${ep}.alter.object`, `unknown object "${a.object}"`);
          return;
        }
        // (whoever is acting, or an object off-screen, finds its marker on the current screen at run time)
        const screen = a.object === ANYONE ? null : c.objects[a.object].screen;
        if (a.at && !hasMarker(c, screen, a.at)) report(`${ep}.alter.at`, `unknown marker "${a.at}" on screen "${screen}"`);
        if (a.talk !== undefined) checkTalkString(c, a.talk, `${ep}.alter.talk`, report);
        if (a.converseNow !== undefined) checkTalkString(c, a.converseNow, `${ep}.alter.converseNow`, report);
      } else if ('path' in fx) {
        for (const region of [...(fx.path.enable ?? []), ...(fx.path.disable ?? [])]) {
          if (def.screen !== null && c.screens[def.screen]?.regions?.[region] === undefined) {
            report(`${ep}.path`, `unknown region "${region}" on screen "${def.screen}"`);
          }
        }
      } else if ('trigger' in fx) {
        if (!c.triggers.some(t => t.id === fx.trigger.id)) report(`${ep}.trigger.id`, `unknown trigger "${fx.trigger.id}"`);
      } else if ('screen' in fx) {
        const s = fx.screen;
        // ($current's entrance is looked up on whichever screen the team is on, when it runs)
        if (s.to !== SHIP && s.to !== CURRENT) {
          if (!isScreen(s.to)) report(`${ep}.screen.to`, `unknown screen "${s.to}"`);
          else if (s.entrance !== undefined && !hasMarker(c, s.to, s.entrance)) {
            report(`${ep}.screen.entrance`, `unknown marker "${s.entrance}" on screen "${s.to}"`);
          }
        }
      } else if ('say' in fx) {
        if (!isObject(fx.say.who)) report(`${ep}.say.who`, `unknown object "${fx.say.who}"`);
      } else if ('describe' in fx) {
        if (!isObject(fx.describe.object)) report(`${ep}.describe.object`, `unknown object "${fx.describe.object}"`);
      } else if ('converse' in fx) {
        if (!c.conversations[fx.converse.conversation]) {
          report(`${ep}.converse.conversation`, `unknown conversation "${fx.converse.conversation}"`);
        }
      } else if ('act' in fx) {
        const a = fx.act;
        if (a.object !== undefined && a.object !== ANYONE && !isObject(a.object)) report(`${ep}.act.object`, `unknown object "${a.object}"`);
        if (a.other !== undefined && !isObject(a.other)) report(`${ep}.act.other`, `unknown object "${a.other}"`);
        // (any object may act for a script, as getWalker allows: unity.cpp:876-886)
        if (a.who !== undefined && a.who !== ANYONE && a.who !== ACTOR && a.who !== NONE && !isObject(a.who)) report(`${ep}.act.who`, `unknown object "${a.who}"`);
        if (a.at !== undefined && !hasMarker(c, def.screen, a.at)) report(`${ep}.act.at`, `unknown marker "${a.at}" on screen "${def.screen}"`);
      } else if ('react' in fx) {
        const r = fx.react;
        if (typeof r.who === 'object' && !isObject(r.who.object)) report(`${ep}.react.who.object`, `unknown object "${r.who.object}"`);
        const d = r.do;
        if (typeof d === 'object' && 'beamIn' in d && !hasMarker(c, def.screen, d.beamIn)) {
          report(`${ep}.react.do.beamIn`, `unknown marker "${d.beamIn}" on screen "${def.screen}"`);
        }
        if (typeof d === 'object' && 'beamTo' in d) {
          const screen = d.beamTo.screen ?? def.screen;
          if (d.beamTo.screen !== undefined && !isScreen(d.beamTo.screen)) report(`${ep}.react.do.beamTo.screen`, `unknown screen "${d.beamTo.screen}"`);
          else if (!hasMarker(c, screen, d.beamTo.entrance)) {
            report(`${ep}.react.do.beamTo.entrance`, `unknown marker "${d.beamTo.entrance}" on screen "${screen}"`);
          }
        }
      } else if ('beam' in fx) {
        if (fx.beam.to !== null && !isScreen(fx.beam.to)) report(`${ep}.beam.to`, `unknown screen "${fx.beam.to}"`);
      } else if ('advice' in fx) {
        const a = fx.advice;
        if (a.id !== undefined && !c.advice[a.id]) report(`${ep}.advice.id`, `unknown advice "${a.id}"`);
        if (a.screen !== undefined && !isScreen(a.screen)) report(`${ep}.advice.screen`, `unknown screen "${a.screen}"`);
      } else if ('startup' in fx) {
        const st = fx.startup;
        if (!isScreen(st.screen)) report(`${ep}.startup.screen`, `unknown screen "${st.screen}"`);
        else if (st.action) checkStartupAction(c, st.screen, st.action, `${ep}.startup.action`, report);
      } else if ('awayFlags' in fx) {
        const s = fx.awayFlags.screen;
        if (s !== undefined && !isScreen(s)) report(`${ep}.awayFlags.screen`, `unknown screen "${s}"`);
      } else if ('communicate' in fx) {
        const h = fx.communicate;
        if (h.from !== undefined && !isObject(h.from)) report(`${ep}.communicate.from`, `unknown object "${h.from}"`);
        if (h.conversation !== undefined && !c.conversations[h.conversation]) {
          report(`${ep}.communicate.conversation`, `unknown conversation "${h.conversation}"`);
        } else if (h.conversation !== undefined && !c.conversations[h.conversation].ship) {
          // (every hail is a conversation on the ship, object.cpp:1874-1877)
          report(`${ep}.communicate.conversation`, `"${h.conversation}" is not a ship conversation`);
        }
      } else if ('ship' in fx) {
        const u = 'universe' in fx.ship ? fx.ship.universe : undefined;
        if (u && !isObject(u.object)) report(`${ep}.ship.universe.object`, `unknown object "${u.object}"`);
      } else if ('choose' in fx) {
        fx.choose.options.forEach((option, k) => checkGroups(c, def, option.do, `${ep}.choose.options[${k}].do`, report));
      }
    });
  });
}

/** A talk string that starts a conversation ("@…", or "1@…" in an alter) must name one that exists. */
export function checkTalkString(c: GameContent, s: string, path: string, report: Report): void {
  const body = s.startsWith('1') ? s.slice(1) : s;
  if (!body.startsWith('@')) return;
  const ref = parseConversationString(body);
  if (!ref) report(path, `bad conversation string "${s}"`);
  else if (!c.conversations[ref.conversation]) report(path, `unknown conversation "${ref.conversation}"`);
}

export function checkStartupAction(c: GameContent, screen: string, a: StartupActionDef, path: string, report: Report): void {
  if (!c.objects[a.target]) report(`${path}.target`, `unknown object "${a.target}"`);
  if (a.who !== undefined && a.who !== ANYONE && a.who !== NONE && !c.objects[a.who]) report(`${path}.who`, `unknown object "${a.who}"`);
  if (a.other !== undefined && !c.objects[a.other]) report(`${path}.other`, `unknown object "${a.other}"`);
  if (a.at !== undefined && !hasMarker(c, screen, a.at)) report(`${path}.at`, `unknown marker "${a.at}" on screen "${screen}"`);
}

function checkRules(c: GameContent, out: string[]): void {
  const r = c.rules;
  for (const [role, id] of Object.entries(r.items)) {
    if (id !== undefined && !c.objects[id]) out.push(`game.yaml: rules.items.${role}: unknown object "${id}"`);
  }
  if (r.doctor !== undefined && !c.objects[r.doctor]?.crew) out.push(`game.yaml: rules.doctor: "${r.doctor}" is not a crew object`);
  for (const [name, line] of Object.entries(r.lines)) {
    if (line && !c.conversations[line.conversation]) {
      out.push(`game.yaml: rules.lines.${name}.conversation: unknown conversation "${line.conversation}"`);
    }
  }
  r.lines.medical?.order.forEach((id, i) => {
    if (!c.objects[id]?.crew) out.push(`game.yaml: rules.lines.medical.order[${i}]: "${id}" is not a crew object`);
  });
  if (r.items.medicalTricorder !== undefined || r.items.medkit !== undefined) {
    const medical = r.lines.medical;
    if (!medical) out.push('game.yaml: rules.lines.medical: needed for the medical tricorder and medkit');
    else {
      for (const d of Object.values(c.objects)) {
        if (d.crew && d.phaser && !medical.order.includes(d.id)) out.push(`game.yaml: rules.lines.medical.order: missing crew member "${d.id}"`);
      }
    }
  }
}

/** A floor polygon is walked on while its region is open, so its region must be one of the screen's. */
function checkFloors(c: GameContent, where: Map<string, string>, out: string[]): void {
  for (const s of Object.values(c.screens)) {
    const file = where.get(`screen:${s.id}`) ?? `screens/${s.id}`;
    s.pixelMetric?.floor.forEach((poly, i) => {
      if (s.regions?.[poly.region] === undefined) out.push(`${file}: pixelMetric.floor.${i}.region: unknown region "${poly.region}"`);
    });
  }
}

function checkScreenStartups(c: GameContent, where: Map<string, string>, out: string[]): void {
  for (const s of Object.values(c.screens)) {
    const st = s.startup;
    if (!st) continue;
    const file = where.get(`screen:${s.id}`) ?? `screens/${s.id}`;
    const report: Report = (path, message) => out.push(`${file}: ${path}: ${message}`);
    if (st.advice?.id !== undefined && !c.advice[st.advice.id]) report('startup.advice.id', `unknown advice "${st.advice.id}"`);
    if (st.action) checkStartupAction(c, s.id, st.action, 'startup.action', report);
  }
}

function checkConversations(c: GameContent, where: Map<string, string>, out: string[]): void {
  const shipNumbers = new Map<number, string>();
  for (const conv of Object.values(c.conversations)) {
    const file = where.get(`conversation:${conv.id}`) ?? `conversations/${conv.id}`;
    const report: Report = (path, message) => out.push(`${file}: ${path}: ${message}`);
    // (a hail finds a ship conversation by its number)
    if (conv.ship && conv.number !== undefined) {
      const other = shipNumbers.get(conv.number);
      if (other !== undefined) report('number', `ship conversation ${conv.number} is also "${other}"`);
      else shipNumbers.set(conv.number, conv.id);
    }
    // (a conversation has no screen, so its markers and regions are checked when it runs)
    const owner: ObjectDef = { id: conv.id, name: conv.id, screen: null };
    conv.responses.forEach((r, i) => {
      const p = `responses[${i}]`;
      r.who.forEach((who, j) => {
        if (who !== ANYONE && !c.objects[who]?.crew) report(`${p}.who[${j}]`, `"${who}" is not a crew object`);
      });
      if (r.replier) {
        const kind = 'object' in r.replier ? 'object' : 'crew' in r.replier ? 'crew' : 'teamCrew';
        const id = 'object' in r.replier ? r.replier.object : 'crew' in r.replier ? r.replier.crew : r.replier.teamCrew;
        if (!c.objects[id]) report(`${p}.replier.${kind}`, `unknown object "${id}"`);
        else if (kind !== 'object' && !c.objects[id].crew) report(`${p}.replier.${kind}`, `"${id}" is not a crew object`);
      }
      for (const who of Object.keys(r.voices ?? {})) {
        if (!c.objects[who]?.crew) report(`${p}.voices`, `"${who}" is not a crew object`);
      }
      (r.results ?? []).forEach((list, k) => checkGroups(c, owner, list, `${p}.results[${k}]`, report));
    });
  }
}

function checkAdvice(c: GameContent, out: string[]): void {
  for (const [id, a] of Object.entries(c.advice)) {
    for (const level of ['easy', 'hard'] as const) {
      for (const [who, text] of Object.entries(a[level] ?? {})) {
        if (who !== ANYONE && !c.objects[who]?.crew) out.push(`advice.yaml: ${id}.${level}: "${who}" is not a crew object`);
        // (advice is said as a talk string, so it can start a conversation)
        checkTalkString(c, text, `${id}.${level}.${who}`, (path, message) => out.push(`advice.yaml: ${path}: ${message}`));
      }
    }
  }
}

/** ship.yaml's slugs must name objects and triggers (the engine never builds an id from a number: R7). */
function checkShip(c: GameContent, out: string[]): void {
  const ship = c.ship;
  if (!ship) return;
  const d = ship.data;
  const object = (path: string, slug: string) => {
    if (!c.objects[slug]) out.push(`ship.yaml: ${path}: unknown object "${slug}"`);
  };
  const triggers = new Set(c.triggers.map(t => t.id));
  object('astro.enterprise', d.astro.enterprise);
  for (const [name, slug] of Object.entries(d.astro.triggers)) {
    if (!triggers.has(slug)) out.push(`ship.yaml: astro.triggers.${name}: unknown trigger "${slug}"`);
  }
  d.equipment.forEach((slug, i) => object(`equipment[${i}]`, slug));
  d.transporter.teams.forEach((t, i) => {
    t.members.forEach((slug, j) => object(`transporter.teams[${i}].members[${j}]`, slug));
    t.items.forEach((slug, j) => object(`transporter.teams[${i}].items[${j}]`, slug));
  });
  d.bridge.items.forEach((it, i) => object(`bridge.items[${i}].object`, it.object));
  d.bridge.objects.forEach((o, i) => object(`bridge.objects[${i}].object`, o.object));
  d.crew.leaderOrder.forEach((slug, i) => object(`crew.leaderOrder[${i}]`, slug));
  d.contacts.comms.forEach((o, i) => object(`contacts.comms[${i}].object`, o.object));
  d.contacts.lounge.forEach((slug, i) => object(`contacts.lounge[${i}]`, slug));
  ship.computer.readings.forEach((r, i) => {
    if (r.entry >= ship.computer.entries.length) out.push(`computer.yaml: readings[${i}].entry: no entry ${r.entry}`);
    if (r.parent >= ship.computer.entries.length) out.push(`computer.yaml: readings[${i}].parent: no entry ${r.parent}`);
  });
  for (const e of ship.computer.hidden) {
    if (e >= ship.computer.entries.length) out.push(`computer.yaml: hidden: no entry ${e}`);
  }
}

/** combat.yaml's names against the rest of the game, for a combat.yaml read after the game was (the web app's, M8 spec §8): checkRefs' combat checks. */
export function combatRefProblems(c: GameContent, combat: CombatData): string[] {
  const out: string[] = [];
  if (c.ship) checkCombat({ ...c, ship: { ...c.ship, combat } }, out);
  return out;
}

/** combat.yaml's names must resolve: battles' screens and objects, and every tactics file and model a kind, an effect or a ship names. */
function checkCombat(c: GameContent, out: string[]): void {
  const combat = c.ship?.combat;
  if (!combat) return;
  const object = (path: string, slug: string | null) => {
    if (slug !== null && !c.objects[slug]) out.push(`combat.yaml: ${path}: unknown object "${slug}"`);
  };
  const tactics = (path: string, name: string | null) => {
    if (name !== null && !combat.tactics[name]) out.push(`combat.yaml: ${path}: unknown tactics "${name}"`);
  };
  const model = (path: string, key: string | null) => {
    if (key !== null && !combat.models[key]) out.push(`combat.yaml: ${path}: unknown model "${key}"`);
  };
  combat.kinds.forEach((k, i) => {
    tactics(`kinds[${i}].tactics`, k.tactics);
    model(`kinds[${i}].models.detail`, k.models.detail);
    model(`kinds[${i}].models.reduced`, k.models.reduced);
    model(`kinds[${i}].models.damaged`, k.models.damaged);
    k.models.debris.forEach((d, j) => model(`kinds[${i}].models.debris[${j}]`, d));
  });
  const e = combat.effects;
  model('effects.phaser', e.phaser);
  model('effects.photon', e.photon);
  model('effects.billboard', e.billboard);
  e.shields.forEach((s, i) => model(`effects.shields[${i}]`, s));
  e.genericDebris.forEach((d, i) => model(`effects.genericDebris[${i}]`, d));
  for (const [scenario, b] of Object.entries(combat.battles)) {
    if (!c.screens[b.screen]) out.push(`combat.yaml: battles.${scenario}.screen: unknown screen "${b.screen}"`);
    object(`battles.${scenario}.enter`, b.enter);
    object(`battles.${scenario}.exit`, b.exit);
    object(`battles.${scenario}.warp`, b.warp);
    b.ships.forEach((s, i) => {
      object(`battles.${scenario}.ships[${i}].object`, s.object);
      if (!combat.kinds[s.type]) out.push(`combat.yaml: battles.${scenario}.ships[${i}].type: no kind ${s.type}`);
      tactics(`battles.${scenario}.ships[${i}].tactics`, s.tactics);
    });
  }
}
