// SPDX-License-Identifier: GPL-3.0-or-later
import { NONE } from '@another-unity/engine';
import { checkRng, parseTrace } from '@another-unity/rawcheck/trace';
import type { GameMaps } from './maps';
import type { Norm, Value } from './model';

/** Response states by the trace's number (1 set, 2 enabled, 3 disabled, 4 locked). */
const RESPONSE_STATES = ['', 'set', 'enabled', 'disabled', 'locked'];
/** Startup flags 255 leaves alone (null in the sim), as StartupState names them; closeup is read apart (Plan 6 Decision 7 lists the rest). */
const STARTUP_FLAGS: Record<string, string> = { combadge: 'combadge', input_blocked: 'inputBlocked' };

export interface Normalized {
  events: Norm[];
  /** What was left out, and how often (the report's "Not compared"). */
  notCompared: Map<string, number>;
  /** Why the trace can't be compared at all; empty if it can. */
  problems: string[];
}

/** ScummVM's trace (docs/trace-format.md) in the normalized model, from the walkthrough's first step on. */
export function normalizeScummvm(text: string, maps: GameMaps): Normalized {
  const { events: raw, problems } = parseTrace(text);
  const out: Norm[] = [];
  const notCompared = new Map<string, number>();
  const skip = (what: string) => notCompared.set(what, (notCompared.get(what) ?? 0) + 1);

  if (raw.at(-1)?.ev !== 'end') {
    problems.push('the trace has no end: was ScummVM killed at the harness timeout? (its out.log then says "HARNESS: killed at the …"); rerun it with a longer timeout');
  }
  if (raw.some(e => e.ev === 'load')) {
    problems.push('the trace spans a load, which loses the changes since the last checkpoint (carry note); walkthroughs never load');
  }
  problems.push(...checkRng(raw));
  if (problems.length > 0) return { events: [], notCompared, problems };

  const set = (key: string, value: Value, tag?: 'alter') => out.push(tag ? { k: 'set', key, value, tag } : { k: 'set', key, value });
  const slug = (id: string) => maps.object(id) ?? id;
  const screens = new Map<string, string | null>();
  const pixels = new Map<string, [number | null, number | null]>();
  let world = 0;
  let started = false;
  let aboard = false;
  let lastEntry: string | null = null;

  for (const e of raw) {
    if (e.ev === 'step') started = true;
    if (!started) {
      if (e.ev !== 'begin') skip('events before the first step (the harness preamble)');
      continue;
    }
    if (aboard && e.ev === 'screen') {
      problems.push('an away screen was entered after the team was back on the ship: the normalizer stops at the return');
    }
    // (back on the ship, ScummVM plays the ship's screens, which the slice doesn't have: Decision 7)
    if (aboard && e.ev !== 'step' && e.ev !== 'error' && e.ev !== 'end') {
      skip('everything after the team is back on the ship (the ship\'s screens)');
      continue;
    }
    // (an entry's state changes follow it: remember its class until the next event that isn't one)
    if (e.ev !== 'obj' && e.ev !== 'entry') lastEntry = null;

    switch (e.ev) {
      case 'step': out.push({ k: 'step', line: e.line, text: e.text }); break;
      case 'seed': out.push({ k: 'seed', seed: e.seed }); break;
      case 'end': out.push({ k: 'end' }); break;
      case 'action':
        // (an action by nobody, ffffff, is by $none in the content: CommandBlock and startup actors)
        out.push({ k: 'action', verb: e.verb, target: e.target === null ? null : maps.object(e.target), who: e.who === 'ffffff' ? NONE : slug(e.who), other: maps.object(e.other), depth: e.depth });
        break;
      case 'actionEnd':
        out.push({ k: 'actionEnd', verb: e.verb, target: e.target === null ? null : maps.object(e.target), flags: e.flags, depth: e.depth });
        break;
      case 'group': out.push({ k: 'group', key: maps.group(e.list, e.index), passed: e.passed }); break;
      case 'entry':
        lastEntry = e.class;
        skip('entry events (one IR entry lifts to one or more effects)');
        break;
      case 'obj': {
        const s = maps.object(e.id);
        if (s === null) break;
        const k = `obj:${s}`;
        switch (e.field) {
          case 'curr_screen': {
            // (0 is nowhere; GET sets 0xff, object.cpp:1327: in the inventory, on no screen)
            const screen = e.to === 0 || e.to === 0xff ? null : maps.screen(maps.objectWorld(e.id, world), Number(e.to));
            screens.set(s, screen);
            set(`${k}.screen`, screen);
            break;
          }
          case 'state': set(`${k}.state`, e.to); break;
          case 'flags': {
            const from = Number(e.from);
            const to = Number(e.to);
            if ((from ^ to) & 0x20) set(`${k}.active`, (to & 0x20) !== 0);
            if ((from ^ to) & 0x80) set(`${k}.stunned`, (to & 0x80) !== 0);
            if ((from ^ to) & ~0xa0) skip('obj.flags verb and inventory bits (verbs pick the cursor; inventory is its own field)');
            break;
          }
          case 'inventory': set(`${k}.inventory`, Boolean(e.to)); break;
          case 'x':
          case 'y': {
            const was = pixels.get(s) ?? maps.initialPixel(s) ?? [null, null];
            const now: [number | null, number | null] = e.field === 'x' ? [Number(e.to), was[1]] : [was[0], Number(e.to)];
            pixels.set(s, now);
            // (but the coordinate is kept: once the walk ends, ScummVM logs only the one that still changes)
            if (e.walking) {
              skip('positions while walking (the sim moves between markers)');
              break;
            }
            const screen = screens.has(s) ? screens.get(s)! : maps.initialScreen(s);
            if (now[0] === null || now[1] === null) skip('positions with one coordinate still unknown');
            else if (!screen) skip('positions on no screen (in the inventory, or nowhere)');
            else set(`${k}.pos`, maps.pos(screen, now[0], now[1]), lastEntry === 'AlterBlock' ? 'alter' : undefined);
            break;
          }
          case 'timer': set(`${k}.timer`, e.to === 0xffff ? 0 : e.to); break;
          case 'name': set(`${k}.name`, e.to); break;
          case 'talk_string': set(`${k}.talk`, maps.talk(String(e.to), maps.objectWorld(e.id, world))); break;
          case 'health': set(`phaser:${s}.health`, e.to); break;
          case 'stunned': set(`phaser:${s}.stunned`, Boolean(e.to)); break;
          default: skip(`obj.${e.field}`);
        }
        break;
      }
      case 'response':
        set(`resp:${maps.ids.conversations[e.conv] ?? `?${e.conv}`}/${e.index}`, RESPONSE_STATES[e.to]);
        break;
      case 'triggerState': set(`trigger:${maps.trigger(e.id)}`, e.enabled); break;
      case 'region': set(`region:${maps.screen(e.world, e.screen) ?? '?'}/r${e.region}`, e.type === 1); break;
      case 'counter': set(`counter:${maps.counter(e.entry)}`, e.to); break;
      case 'startup': {
        const screen = maps.screen(e.world, e.screen) ?? '?';
        if (e.field === 'advice_id') set(`startup:${screen}.advice`, maps.advice(e.world, e.to));
        // (a close-up is `closeup == 1`, awayteam.cpp:284, and the lifter lifts 255 as none: false, not null)
        else if (e.field === 'closeup') set(`startup:${screen}.closeup`, e.to === 1);
        else if (STARTUP_FLAGS[e.field]) set(`startup:${screen}.${STARTUP_FLAGS[e.field]}`, e.to === 255 ? null : e.to === 1);
        else skip(`startup.${e.field}`);
        break;
      }
      case 'global': {
        const to = e.to;
        switch (e.key) {
          case 'adviceId': set('global:adviceId', maps.advice(world, Number(to))); break;
          // (ScummVM keeps the interval in milliseconds, the sim in seconds)
          case 'adviceInterval': set('global:adviceInterval', Number(to) / 1000); break;
          case 'combadge':
          case 'inputBlocked':
          case 'closeup': set(`global:${e.key}`, Boolean(to)); break;
          case 'member': set('global:member', maps.object(String(to))); break;
          case 'team': set('global:team', String(to) === '' ? '' : String(to).split(',').map(slug).join(',')); break;
          // (the gauge has four positions to a setting)
          case 'phaserIndex': set('global:phaserSetting', Math.floor(Number(to) / 4)); break;
          case 'beam': {
            const [w, s] = String(to).split(',').map(Number);
            set('global:beam', maps.screen(w, s));
            break;
          }
          // (a hail is for the starship modes: whether one is waiting is compared, not its details)
          case 'pendingHail': set('global:pendingHail', String(to).split(',')[3] === '255' ? null : 'pending'); break;
          default: skip(`global.${e.key} (the starship modes)`);
        }
        break;
      }
      case 'shipUnit': skip('shipUnit (the ship, sub-project 4)'); break;
      case 'trigger': out.push({ k: 'trigger', id: maps.trigger(e.id), target: slug(e.target) }); break;
      case 'timer': out.push({ k: 'timer', object: slug(e.object) }); break;
      case 'screen': {
        world = e.world;
        const screen = maps.screen(e.world, e.screen) ?? '?';
        out.push({ k: 'screen', screen });
        // (a start puts the team on the screen without tracing their curr_screen: until it says otherwise they are here)
        for (const member of maps.content.start.awayTeam) {
          if (screens.has(member)) continue;
          screens.set(member, screen);
          // (and on their slot of the entrance: the pixel a start leaves unchanged is never logged)
          const slot = maps.entrancePixel(screen, Number(e.entrance), member);
          if (slot) pixels.set(member, slot);
        }
        break;
      }
      case 'ship':
        out.push({ k: 'ship' });
        aboard = true;
        break;
      case 'rng': out.push({ k: 'rng', site: e.site, max: e.max, value: e.value }); break;
      case 'say':
        out.push({ k: 'say', who: slug(e.who), voice: e.voice.replace(/\.vac$/i, '').toLowerCase(), text: e.text.replace(/\s+/g, ' ').trim() });
        break;
      case 'choice': out.push({ k: 'choice', kind: e.kind, options: e.options.length, picked: e.picked }); break;
      case 'movie': out.push({ k: 'movie', file: e.file.replace(/\.[a-z0-9]+$/i, '').toLowerCase() }); break;
      case 'refused': out.push({ k: 'refused', who: slug(e.who) }); break;
      case 'error': out.push({ k: 'error', what: e.what }); break;
      case 'begin':
      case 'load':
        break;
      // (space combat's own events: `tracediff combat` compares them, docs/tracediff.md "Space combat")
      case 'combat': case 'ships': case 'roll': case 'snap': case 'hails': case 'hailsEnd': case 'standDown':
      case 'leave': case 'warp': case 'input': case 'atan2': case 'combatEnd':
        skip('space combat (tracediff combat compares it)');
        break;
      default: {
        const unhandled: never = e;
        throw new Error(`an event the normalizer doesn't know: ${JSON.stringify(unhandled)}`);
      }
    }
  }
  return { events: out, notCompared, problems: [] };
}
