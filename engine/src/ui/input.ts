// SPDX-License-Identifier: GPL-3.0-or-later
import type { Vec2, Verb } from '../content/types';
import { callShip, COMBADGE_QUESTION } from '../sim/general';
import { setPhaserSetting } from '../sim/phaser';
import { ALL_READINGS, tricorderReading } from '../sim/talk';
import type { World } from '../sim/world';
import type { EngineSound } from '../view/package';
import type { Hit } from '../view/stage';
import { CYCLE, type UiStore, type VerbMode } from './store';

export interface InputHooks {
  /** Ends the line being said: a click while someone speaks. */
  skipLine(): void;
  /** Plays one of the engine's own sounds (presentation.yaml names its stem). */
  playSound?(sound: EngineSound): void;
  /** Opens the admin console (Plan 32): false when it is refused, as while a warp is pending. */
  admin?(): boolean;
}

// (the question lives with callShip, DOM-free, so tools/play asks the same one)
export { COMBADGE_QUESTION };
const KEYS: Record<string, VerbMode> = { w: 'walk', l: 'look', u: 'use', t: 'talk' };
/** What the gauge says of each phaser setting; off says nothing (awayteam.cpp:788-793). */
const PHASER_SETTINGS = [null, 'low', 'medium', 'high'];

/** Where a press in the room is let go: on something in the room (or nothing), or on the inventory. */
export type Drop = Hit | 'inventory' | null;

/** Turns the player's clicks and keys into the sim's actions, and only when the game can take them. */
export class Input {
  /** How many actions this controller has started: the e2e tests check a click took. */
  started = 0;
  /** The object pressed in Use mode, acted on when the button is let go (the original's _pressed_object). */
  private pressed: string | null = null;

  constructor(readonly world: World, private readonly store: UiStore, private readonly hooks: InputHooks) {}

  /**
   * Whether a click may become an action now. The original drops input while it is blocked or a dialog is up
   * (unity.cpp:1329-1370); World.act refuses inside an action, so the UI only acts when the world is
   * idle or only walking (a new command stops the walker).
   */
  get canAct(): boolean {
    const s = this.world.state;
    return this.store.state.dialog === null && !s.awayFlags.inputBlocked && s.onShip === null && this.world.interruptible;
  }

  /** Whether the verb may change: the right button and verb keys do nothing while a dialog is up or input is blocked (unity.cpp:1328-1354). */
  get canChangeMode(): boolean {
    return this.store.state.dialog === null && !this.world.state.awayFlags.inputBlocked;
  }

  get combadgeReady(): boolean {
    return this.world.state.awayFlags.combadge && this.world.content.rules.items.communicator !== undefined;
  }

  /** A press and a release on the same spot. */
  click(hit: Hit | null): boolean {
    const acted = this.press(hit);
    return this.pressed === null ? acted : this.release(hit);
  }

  /**
   * The button goes down in the room (handleAwayTeamMouseDown, awayteam.cpp:604-646). Every mode acts on the press,
   * except Use with nothing held: that waits for the release, as the press may start a drag.
   */
  press(hit: Hit | null): boolean {
    this.letGo();
    if (this.store.state.subtitle !== null) {
      this.hooks.skipLine();
      return false;
    }
    if (!this.canAct) return false;
    const { mode, held } = this.store.state;
    if (hit === null || hit.kind === 'floor') {
      // the floor is walked to only in Walk mode (awayteam.cpp:620-624)
      if (hit !== null && mode === 'walk') return this.act('walk', { to: hit.at });
      // (otherwise the click only cancels the member's queued actions, as every room click does, unless they are
      // down, when the click does nothing at all: awayteam.cpp:606-611)
      const member = this.world.state.currentActor;
      if (!this.world.isIncapacitated(member)) this.world.cancelQueuedActions(member);
      return false;
    }
    if (mode === 'use') {
      // (the item stays held after a use: the original never lets go of it then, awayteam.cpp:402-416)
      if (held !== null) return this.act('use', { target: hit.id, other: held });
      this.pressed = hit.id;
      return false;
    }
    return this.act(mode, { target: hit.id });
  }

  /** The pointer has moved far enough from the press to be a drag (kDragDistance, awayteam.cpp:543-552). */
  dragged(): void {
    if (this.pressed !== null && this.store.state.dragging !== this.pressed) this.store.set({ dragging: this.pressed });
  }

  /**
   * The button comes up (handleAwayTeamMouseUp, awayteam.cpp:655-676): an object pressed in Use mode and let go on the
   * inventory is got; on itself, used; on another object, used with it; anywhere else, nothing.
   */
  release(drop: Drop): boolean {
    const pressed = this.pressed;
    this.letGo();
    if (pressed === null || this.store.state.mode !== 'use' || this.store.state.held !== null || !this.canAct) return false;
    if (drop === 'inventory') return this.act('get', { target: pressed });
    if (drop === null || drop.kind !== 'object') return false;
    return drop.id === pressed ? this.act('use', { target: pressed }) : this.act('use', { target: pressed, other: drop.id });
  }

  /** stopDragging (awayteam.cpp:650-654). */
  private letGo(): void {
    this.pressed = null;
    if (this.store.state.dragging !== null) this.store.set({ dragging: null });
  }

  /** An inventory item: look at it, pick it up to use with something, or use the held item with it (handleInventoryClick). */
  clickItem(id: string): boolean {
    if (!this.canAct) return false;
    const { mode, held } = this.store.state;
    if (mode === 'look') {
      if (id !== this.world.content.rules.items.tricorder) return this.act('look', { target: id });
      // looking at the tricorder opens it on every reading (awayteam.cpp:771-773)
      const world = this.world;
      this.stopWalking();
      void world.enqueue(() => tricorderReading(world, ALL_READINGS));
      this.started++;
      return true;
    }
    if (held === id) {
      this.store.set({ held: null });
      return false;
    }
    // (and stays held after the use, awayteam.cpp:762-781)
    if (held !== null) return this.act('use', { target: id, other: held });
    this.store.set({ mode: 'use', held: id });
    return false;
  }

  setMode(mode: VerbMode): void {
    if (!this.canChangeMode) return;
    this.store.set({ mode, held: mode === 'use' ? this.store.state.held : null });
  }

  /** The right mouse button: Look, Use, Walk, Talk, and round again. */
  cycleMode(): void {
    this.setMode(CYCLE[(CYCLE.indexOf(this.store.state.mode) + 1) % CYCLE.length]);
  }

  /**
   * Where the original's Esc opens its admin console (phase4_rest.md §6.1): away (not while away input is blocked, unity.cpp:1335), on the
   * bridge, and on the game-over screen. The other stations' screens leave it; Tactical's Escape is its assists panel.
   */
  private get escapeOpensAdmin(): boolean {
    const s = this.world.state;
    if (s.onShip === null) return !s.awayFlags.inputBlocked;
    // (the game-failure screen: the original keeps its console up there until a load or quit, 14620's loop of 1200d(0); here Esc brings it up)
    if (s.onShip.gameOver !== null) return true;
    return s.ship.station === 'bridge' && this.world.computer === null && this.world.viewscreen === null;
  }

  /** Returns whether the key did something. */
  key(key: string): boolean {
    // the log: L aboard, where there are no verbs; away L is Look (metaengine.cpp:104), and Shift+L the log
    if (key === 'L' || (key === 'l' && this.world.state.onShip !== null)) {
      this.store.set({ panel: this.store.state.panel === 'transcript' ? 'none' : 'transcript' });
      return true;
    }
    const verb = KEYS[key.toLowerCase()];
    if (verb) {
      if (!this.canChangeMode) return false;
      this.setMode(verb);
      return true;
    }
    if (key === ' ' && this.store.state.subtitle !== null) {
      this.hooks.skipLine();
      return true;
    }
    if (key === 'Escape') {
      // (a dialog up answers Escape itself: one press must not also drop the item or close the panel)
      if (this.store.state.dialog !== null) return false;
      if (this.store.state.held !== null) {
        this.store.set({ held: null });
        return true;
      }
      if (this.store.state.panel !== 'none') {
        this.store.set({ panel: 'none' });
        return true;
      }
      // (a line being said, shown or not: Esc skips it instead, as a click or Space does; the console never opens over it)
      if (this.store.state.subtitle !== null) {
        this.hooks.skipLine();
        return true;
      }
      // (nothing else took it: the original's Esc opens the admin console, unless the session refuses it now: its canOpenAdmin)
      if (this.escapeOpensAdmin && this.hooks.admin) return this.hooks.admin();
    }
    return false;
  }

  /** The away-team selector. */
  selectMember(id: string): boolean {
    if (!this.canAct || !this.world.selectMember(id)) return false;
    this.store.bump();
    return true;
  }

  /** The panel's portrait: the next member, in team order, who can act here (selectNextAwayTeamMember, awayteam.cpp:742-760). */
  selectNextMember(): boolean {
    if (!this.canAct) return false;
    const before = this.world.state.currentActor;
    this.world.selectNextMember();
    this.store.bump();
    return this.world.state.currentActor !== before;
  }

  /** The phaser's setting, 0 (off) to 3; the gauge says the new setting when it changes (awayteam.cpp:788-793). */
  setPhaser(setting: number): boolean {
    if (!this.canAct) return false;
    const before = this.world.state.phaserSetting;
    try {
      if (!setPhaserSetting(this.world, setting)) return false;
    } catch (err) {
      // (a setting off the gauge)
      if (err instanceof RangeError) return false;
      throw err;
    }
    const name = PHASER_SETTINGS[setting];
    if (setting !== before && name) this.store.set({ message: `Phaser on ${name} setting` });
    this.store.bump();
    return true;
  }

  /** The combadge: the original asks first, then uses the communicator (awayteam.cpp:824-832). */
  async combadge(): Promise<boolean> {
    if (!this.canAct || !this.combadgeReady) return false;
    this.hooks.playSound?.('combadge');
    const choice = await this.store.ask<number>({ kind: 'prompt', text: COMBADGE_QUESTION, buttons: ['Hail', 'Ignore'] });
    // (the world may have moved on while the question was up)
    if (choice !== 0 || !this.canAct || !this.combadgeReady) return false;
    this.stopWalking();
    const called = callShip(this.world);
    if (called) {
      this.started++;
      this.store.bump();
    }
    return called;
  }

  /** A new command stops the current member's walk first, as act() does (Decision 4), so it needn't wait for it. */
  private stopWalking(): void {
    const member = this.world.state.currentActor;
    if (this.world.isWalking(member)) this.world.halt(member);
  }

  private act(verb: Verb, opts: { target?: string; other?: string; to?: Vec2 }): boolean {
    try {
      void this.world.act(verb, opts);
      this.started++;
      return true;
    } catch (err) {
      // (canAct should have stopped this: say so rather than lose the click silently)
      this.store.set({ message: `That didn't work: ${err instanceof Error ? err.message : String(err)}` });
      return false;
    }
  }
}
