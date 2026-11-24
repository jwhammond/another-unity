// SPDX-License-Identifier: GPL-3.0-or-later
import type { AnimFx, Vec2 } from '../content/types';
import { TICKS_PER_SECOND, type Clock } from './clock';
import { distance } from './geometry';
import type { StopSignal } from './stop';

/** A visual effect that the simulation waits for. */
export type Visual =
  | { kind: 'phaserShot'; from: string; to: string }
  | { kind: 'beam'; objects: string[]; out: boolean; chodak: boolean };

/** What the simulation asks of the outside world; each call resolves when the thing is done. */
/** Which conversation menu is asking: the conversation's id and the situation the options belong to. */
export interface MenuAt {
  conversation: string;
  situation: number;
}

export interface Presenter {
  say(who: string, text: string, voice?: string): Promise<void>;
  /**
   * Walks from `from` to `to`, resolving with where the actor ended up: `to`, or wherever `stop` caught them.
   * The browser's navmesh walker ends at `to` too: the sim's `to` is already where the walk ends (World.walkThenAct
   * has applied the stop distance, and on a screen with a pixel metric, the original's path finder has said where the
   * walk ends), so the browser animates its own route but ends where the sim says.
   */
  walk(actor: string, from: Vec2, to: Vec2, stop: StopSignal): Promise<Vec2>;
  /** `warpMovie` is an index of the game's warp movies (the presenter knows their files). */
  play(media: { movie?: string; sound?: string; warpMovie?: number }): Promise<void>;
  choose(question: string, options: [string, string]): Promise<0 | 1>;
  /**
   * A conversation menu; resolves with the index picked, or null if the player backed out. `at` says which situation of which
   * conversation asks (ids only: a browser test checks it answers the menu it means to).
   */
  menu(options: string[], at?: MenuAt): Promise<number | null>;
  /** Text shown on the screen itself (^n); false when there is no such text. */
  screenText(id: number): Promise<boolean>;
  /** The tricorder viewer, opened at a reading (~n). */
  tricorder(reading: number): Promise<void>;
  anim(object: string, anim: AnimFx): Promise<void>;
  show(visual: Visual): Promise<void>;
}

/** A presenter for tests: logs everything and takes simulated time from the clock. */
export class HeadlessPresenter implements Presenter {
  readonly log: string[] = [];
  private readonly answers: (0 | 1)[] = [];
  private readonly picks: (number | null)[] = [];

  constructor(
    private readonly clock: Clock,
    private readonly walkSpeed = 2,
    private readonly sayTicks = 60,
  ) {}

  answer(choice: 0 | 1): void {
    this.answers.push(choice);
  }

  /** Queues the answer to the next conversation menu (null backs out). */
  pick(index: number | null): void {
    this.picks.push(index);
  }

  async say(who: string, text: string): Promise<void> {
    this.log.push(`say ${who}: ${text}`);
    await this.clock.wait(this.sayTicks);
  }

  async walk(actor: string, from: Vec2, to: Vec2, stop: StopSignal): Promise<Vec2> {
    this.log.push(`walk ${actor} -> ${to.x},${to.z}`);
    const ticks = (distance(from, to) / this.walkSpeed) * TICKS_PER_SECOND;
    const start = this.clock.now;
    await this.clock.wait(ticks, stop);
    if (!stop.stopped) return { ...to };
    // (stopped part way: as far along as the time it walked)
    const f = Math.min(1, (this.clock.now - start) / Math.max(1, Math.ceil(ticks)));
    if (f >= 1) return { ...to };
    return { x: from.x + (to.x - from.x) * f, z: from.z + (to.z - from.z) * f };
  }

  async play(media: { movie?: string; sound?: string; warpMovie?: number }): Promise<void> {
    this.log.push(`play ${media.movie ?? media.sound ?? (media.warpMovie !== undefined ? `warp ${media.warpMovie}` : '')}`);
    await this.clock.wait(1);
  }

  async choose(question: string): Promise<0 | 1> {
    this.log.push(`choose ${question}`);
    const answer = this.answers.shift();
    if (answer === undefined) throw new Error(`no scripted answer for choice: ${question}`);
    return answer;
  }

  async menu(options: string[], _at?: MenuAt): Promise<number | null> {
    const text = options.join(' | ');
    this.log.push(`menu ${text}`);
    if (this.picks.length === 0) throw new Error(`no scripted pick for menu: ${text}`);
    return this.picks.shift() ?? null;
  }

  async screenText(id: number): Promise<boolean> {
    this.log.push(`screenText ${id}`);
    await this.clock.wait(1);
    return true;
  }

  async tricorder(reading: number): Promise<void> {
    this.log.push(`tricorder ${reading}`);
    await this.clock.wait(1);
  }

  async anim(object: string, anim: AnimFx): Promise<void> {
    const what = 'play' in anim ? `play ${anim.play}${anim.wait ? ' wait' : ''}` : 'stop' in anim ? 'stop' : `sprite ${anim.sprite}`;
    this.log.push(`anim ${object} ${what}`);
    if ('play' in anim && anim.wait) await this.clock.wait(30);
  }

  async show(visual: Visual): Promise<void> {
    this.log.push(visual.kind === 'phaserShot'
      ? `phaser ${visual.from} -> ${visual.to}`
      : `beam ${visual.out ? 'out' : 'in'} ${visual.objects.join(',')}`);
    await this.clock.wait(1);
  }
}
