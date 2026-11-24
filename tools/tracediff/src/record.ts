// SPDX-License-Identifier: GPL-3.0-or-later
import type { Clock, SimEvent, World } from '@another-unity/engine';
import { WalkPresenter, type WalkEvent } from '@another-unity/play';
import { posString, type GameMaps } from './maps';
import type { Norm, Value } from './model';

/** The world's state as the normalized keys (Task 7's list), for snapshots at step boundaries. */
export function snapshot(world: World): Map<string, Value> {
  const s = world.state;
  const out = new Map<string, Value>();
  for (const [id, o] of Object.entries(s.objects)) {
    const k = `obj:${id}`;
    out.set(`${k}.screen`, o.screen);
    out.set(`${k}.state`, o.state);
    out.set(`${k}.active`, o.active);
    out.set(`${k}.inventory`, o.inventory);
    out.set(`${k}.stunned`, o.stunned);
    if (o.screen !== null) out.set(`${k}.pos`, posString(o.pos));
    out.set(`${k}.timer`, o.timer);
    out.set(`${k}.name`, o.name);
    out.set(`${k}.talk`, o.talk);
  }
  for (const [id, p] of Object.entries(s.phaser)) {
    out.set(`phaser:${id}.health`, p.health);
    out.set(`phaser:${id}.stunned`, p.stunned);
  }
  for (const [conversation, states] of Object.entries(s.conversations)) states.forEach((st, i) => out.set(`resp:${conversation}/${i}`, st));
  for (const [id, t] of Object.entries(s.triggers)) out.set(`trigger:${id}`, t.enabled);
  for (const [screen, regions] of Object.entries(s.regions)) {
    for (const [region, open] of Object.entries(regions)) out.set(`region:${screen}/${region}`, open);
  }
  for (const [key, value] of Object.entries(s.counters)) out.set(`counter:${key}`, value);
  for (const [screen, st] of Object.entries(s.startups)) {
    out.set(`startup:${screen}.closeup`, st.closeup);
    out.set(`startup:${screen}.combadge`, st.combadge);
    out.set(`startup:${screen}.inputBlocked`, st.inputBlocked);
    out.set(`startup:${screen}.advice`, st.advice.off ? 'off' : st.advice.id ?? null);
  }
  out.set('global:adviceId', s.advice.id);
  out.set('global:adviceInterval', s.advice.every);
  out.set('global:combadge', s.awayFlags.combadge);
  out.set('global:inputBlocked', s.awayFlags.inputBlocked);
  out.set('global:closeup', s.onCloseup);
  out.set('global:member', s.currentActor);
  out.set('global:team', s.awayTeam.join(','));
  out.set('global:phaserSetting', s.phaserSetting);
  out.set('global:beam', s.beamTarget);
  out.set('global:pendingHail', s.pendingHail ? 'pending' : null);
  return out;
}

/** Records a TypeScript run in the normalized model: the sim's events, the presenter's, and state per step. */
export class TraceRecorder {
  readonly events: Norm[] = [];
  private world: World | null = null;
  private last = new Map<string, Value>();
  private screen: string | null = null;
  /** The team is back on the ship: the ship's screens aren't compared, as the ScummVM side's normalizer skips them. */
  private aboard = false;

  constructor(private readonly maps: GameMaps) {}

  /** Follows a new world, before it starts: its baseline, its start screen, then its events. */
  attach(world: World): void {
    this.world = world;
    this.last = snapshot(world);
    this.push({ k: 'baseline', values: Object.fromEntries(this.last) });
    // (ScummVM's start logs the screen; a new TypeScript world is simply on its start screen)
    this.screen = world.state.screen;
    this.push({ k: 'screen', screen: this.screen });
    world.bus.on(e => this.onEvent(e));
  }

  push(e: Norm): void {
    // (back on the ship the ship's own triggers and hails run: ScummVM's side skips everything but the walk's own lines there)
    if (this.aboard && e.k !== 'step' && e.k !== 'error' && e.k !== 'end') return;
    this.events.push(e);
  }

  say(who: string, text: string, voice: string | undefined): void {
    this.push({ k: 'say', who, voice: this.maps.voice(voice, who), text: text.replace(/\s+/g, ' ').trim() });
  }

  walkEvent(e: WalkEvent): void {
    switch (e.kind) {
      case 'step':
        // (ScummVM checkpoints before each step: what the last step changed belongs to it)
        this.checkpoint();
        this.push({ k: 'step', line: e.line, text: e.text });
        break;
      case 'seed':
        this.push({ k: 'seed', seed: e.seed });
        break;
      case 'refused':
        this.push({ k: 'refused', who: e.who });
        break;
      case 'error':
        // (ScummVM logs the error, then quits: the step's changes come with the end, in finish)
        this.push({ k: 'error', what: e.what });
        break;
      case 'end':
        this.checkpoint();
        this.push({ k: 'end' });
        break;
    }
  }

  /**
   * The state keys that changed since the last checkpoint. A key the snapshot no longer has (the position of an
   * object on no screen) keeps its last value, unwritten, as ScummVM's trace logs no position there.
   */
  checkpoint(): void {
    if (!this.world) return;
    const now = snapshot(this.world);
    for (const [key, value] of now) if (!this.last.has(key) || this.last.get(key) !== value) this.push({ k: 'set', key, value });
    for (const [key, value] of this.last) if (!now.has(key)) now.set(key, value);
    this.last = now;
  }

  /** Ends the record as ScummVM's ends: an `end`, even after an error (its runner quits, and the tracer writes one). */
  finish(): void {
    this.checkpoint();
    if (this.events.at(-1)?.k !== 'end') this.push({ k: 'end' });
  }

  /**
   * ScummVM logs the screen as the team starts to arrive (traceScreen opens startAwayTeam, awayteam.cpp:243),
   * before placeAwayTeam's step-in draws; the sim says so once the team is placed. So the screen goes before them.
   */
  private pushScreen(screen: string): void {
    let at = this.events.length;
    while (at > 0) {
      const e = this.events[at - 1];
      if (e.k !== 'rng' || (e.site !== 'stepInX' && e.site !== 'stepInY')) break;
      at--;
    }
    this.events.splice(at, 0, { k: 'screen', screen });
  }

  private onEvent(e: SimEvent): void {
    switch (e.type) {
      case 'missing':
        this.push({ k: 'missing', kind: e.kind, id: e.id });
        break;
      case 'actionStarted':
        this.push({ k: 'action', verb: e.verb, target: e.target, who: e.who, other: e.other, depth: e.depth });
        break;
      case 'actionEnded':
        this.push({ k: 'actionEnd', verb: e.verb, target: e.target, flags: e.result, depth: e.depth });
        break;
      case 'ruleRan':
        this.push({ k: 'group', key: e.group, passed: true });
        break;
      case 'ruleSkipped':
        this.push({ k: 'group', key: e.group, passed: false });
        break;
      case 'rng':
        this.push({ k: 'rng', site: e.site, max: e.max, value: e.value });
        break;
      case 'triggerFired':
        this.push({ k: 'trigger', id: e.id, target: e.target });
        break;
      case 'timerFired':
        this.push({ k: 'timer', object: e.object });
        break;
      case 'screenChanged':
        // (a mission entered again once aboard: everything after the return is dropped, so say so rather than lose it silently)
        if (this.aboard) {
          this.push({ k: 'error', what: `away screen ${e.screen} entered after the team was back on the ship: the recorder stops at the return` });
          break;
        }
        // (the start screen, announced again by the world's start, is already recorded)
        if (e.screen === this.screen && this.events.at(-1)?.k === 'screen') break;
        this.screen = e.screen;
        this.pushScreen(e.screen);
        break;
      case 'leftAwayMission':
        // (the mission's last state counts: a trigger the ship fires next may turn off what the mission turned on)
        this.checkpoint();
        this.push({ k: 'ship' });
        this.aboard = true;
        break;
      default:
        break;
    }
  }
}

/** The walkthrough's presenter, recording lines, choices and movies as ScummVM's trace logs them. */
export class TracingPresenter extends WalkPresenter {
  constructor(clock: Clock, private readonly rec: TraceRecorder) {
    super(clock);
  }

  override async say(who: string, text: string, voice?: string): Promise<void> {
    this.rec.say(who, text, voice);
    await super.say(who, text);
  }

  // (options is optional, as in HeadlessPresenter.choose(question): an override can't require more)
  override async choose(question: string, options?: [string, string]): Promise<0 | 1> {
    const picked = await super.choose(question);
    this.rec.push({ k: 'choice', kind: 'box', options: options?.length ?? 2, picked });
    return picked;
  }

  override async menu(options: string[]): Promise<number | null> {
    const picked = await super.menu(options);
    this.rec.push({ k: 'choice', kind: 'menu', options: options.length, picked: picked ?? -1 });
    return picked;
  }

  override async play(media: { movie?: string; sound?: string }): Promise<void> {
    if (media.movie) this.rec.push({ k: 'movie', file: media.movie.toLowerCase() });
    await super.play(media);
  }
}
