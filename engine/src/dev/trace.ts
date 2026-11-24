// SPDX-License-Identifier: GPL-3.0-or-later
import type { SimEvent } from '../sim/events';
import { R } from '../sim/result';
import type { World } from '../sim/world';

export type TraceKind = 'rule' | 'skipped' | 'effect' | 'error' | 'warning' | 'screen' | 'event';

export interface TraceEntry {
  /** The sim tick it happened on. */
  tick: number;
  kind: TraceKind;
  text: string;
}

/** The names of the result flags set in r (object.h's RESULT_*). */
export function flagNames(r: number): string {
  const names = Object.entries(R).filter(([, bit]) => (r & bit) !== 0).map(([name]) => name);
  return names.length > 0 ? names.join(' ') : '0';
}

/** A trace line for an event, or null for the ones too frequent to be worth one. */
export function describeEvent(e: SimEvent): { kind: TraceKind; text: string } | null {
  switch (e.type) {
    case 'ruleRan':
      return { kind: 'rule', text: `${e.verb} ${e.target ?? '-'}: ${e.group} ran` };
    case 'ruleSkipped':
      return { kind: 'skipped', text: `${e.verb} ${e.target ?? '-'}: ${e.group} skipped (${flagNames(e.result)})` };
    case 'effectRan':
      return { kind: 'effect', text: `${e.group}: ${e.effect}${e.result !== 0 ? ` -> ${flagNames(e.result)}` : ''}` };
    case 'actionFailed':
      return { kind: 'error', text: `failed: ${e.error}` };
    case 'warning':
      return { kind: 'warning', text: `warning: ${e.message}` };
    case 'screenChanged':
      return { kind: 'screen', text: `screen ${e.screen}` };
    case 'leftAwayMission':
      return { kind: 'screen', text: `back to the ship${e.gameOver === null ? '' : ` (game over ${e.gameOver})`}` };
    case 'beamedDown':
      return { kind: 'screen', text: `beamed down to world ${e.world}${e.effect ? '' : ' (no effect)'}` };
    case 'shipScreen':
      return { kind: 'screen', text: `ship screen ${e.code.toString(16)}` };
    case 'astro':
      return { kind: 'event', text: `astro ${e.what} at (${e.pos.x}, ${e.pos.y}, ${e.pos.z}) sector ${e.location.sector} speed ${e.speed}` };
    case 'viewscreen':
      return { kind: 'screen', text: e.on ? `viewscreen on ${e.target ?? 'nobody'}` : 'viewscreen off' };
    case 'bridgeViewscreen':
      return { kind: 'screen', text: `bridge viewscreen ${e.up ? 'up' : 'down'}` };
    case 'battleScenario':
      return { kind: 'event', text: `battle scenario ${e.scenario}` };
    case 'combat':
      return { kind: 'screen', text: `battle ${e.scenario} ${e.on ? 'begins' : 'ends'}` };
    case 'regionsChanged':
      return { kind: 'event', text: `regions changed on ${e.screen}` };
    case 'hail':
      return { kind: 'event', text: `hail ${e.hail.conversation ?? `scenario ${e.hail.scenario}`} situation ${e.hail.situation} (type ${e.hail.type})` };
    case 'reading':
      return { kind: 'event', text: `tricorder reading ${e.world} ${e.group}` };
    case 'collapsed':
      return { kind: 'event', text: `${e.id} is down` };
    case 'recovered':
      return { kind: 'event', text: `${e.id} is up` };
    case 'gathered':
      return { kind: 'event', text: `the team gathers on ${e.actor}` };
    case 'shipEffect':
      return { kind: 'event', text: `ship effect ${JSON.stringify(e.effect)}` };
    case 'computer':
      return { kind: 'event', text: `computer ${e.field} ${e.id} ${e.to ? 'on' : 'off'}` };
    case 'astroFlag':
      return { kind: 'event', text: `astro flag ${e.id}: ${e.from} -> ${e.to}` };
    case 'scriptedWarp':
      return { kind: 'event', text: `scripted warp ${e.code} at speed ${e.speed}` };
    case 'universeMove':
      return { kind: 'event', text: `${e.object} moves to (${e.to.x}, ${e.to.y}, ${e.to.z})` };
    case 'triggerFired':
      return { kind: 'event', text: `trigger ${e.id} fired: ${e.target}` };
    case 'timerFired':
      return { kind: 'event', text: `${e.object}'s timer fired` };
    case 'missing':
    case 'actionStarted':
    case 'actionEnded':
    case 'rng':
    case 'conditionPassed':
    case 'shipCue':
    case 'battleAudio':
    case 'battleWarp':
    case 'objectChanged':
    case 'turned':
    case 'faced':
      return null;
  }
}

/** The rule trace (spec §7.5): which groups ran or were skipped, which effects ran, and what went wrong. */
export class RuleTrace {
  readonly entries: TraceEntry[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly limit = 500) {}

  /** Follows a world's events; returns how to stop. */
  attach(world: World): () => void {
    return world.bus.on(e => {
      const line = describeEvent(e);
      if (line) this.push({ tick: world.clock.now, ...line });
    });
  }

  push(entry: TraceEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
    this.notify();
  }

  clear(): void {
    this.entries.length = 0;
    this.notify();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
