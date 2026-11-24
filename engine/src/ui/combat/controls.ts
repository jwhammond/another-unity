// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef } from 'preact/hooks';
import type { CombatCommand } from '../../sim/combat/commands';
import { NO_AXES, TACTICAL_ACTIONS, type Axes, type TacticalAction, type TacticalKeys } from '../../view/combat/consoleInput';
import { DEFAULT_KEYS } from '../../view/combat/bindings';
import { keyAction, keyMapFor, keyFor, nextSpeed, padAxes, padPresses, repeats, type BattleAction, type PadState } from '../../view/combat/controls';
import type { BattlePort, BattleView } from '../../web/battlePort';

/** What the battle's keys and pads need from the console (console.tsx). */
export interface BattleControls {
  port: BattlePort;
  /** The console's TacticalKeys: the keys held and their times, the drag's and the pad's. */
  keys: TacticalKeys;
  /** The wall clock, ms. */
  now: () => number;
  /** Escape: the assists panel opened or closed. */
  assists(): void;
  /** F1: Tactical's Combat Options opened (Plan 32 Task 11; the screen closes itself, as it takes the keys while it is up). */
  options?(): void;
  /** The pad's d-pad: the page before or after, as a tab's click (not while a button is down). */
  turnPage(step: 1 | -1): void;
  /** F6: the keyboard's focus onto the console's first control (the port's way into its controls, Plan 29 R2). */
  focusConsole(): void;
  /** The pads, as navigator.getGamepads gives them: for the tests. */
  pads?: () => readonly (PadState & { mapping?: string } | null)[];
  /** Whether an element has the keyboard's focus (:focus-visible): for the tests. */
  keyboardFocus?: (el: Element) => boolean;
}

/** Whether the keyboard focused `el` (:focus-visible), false where a browser can't say. */
function focusVisible(el: Element): boolean {
  try {
    return el.matches(':focus-visible');
  } catch {
    return false;
  }
}

/** keyMapFor's last answer, kept while the bindings are the same record (the settings hand one back until they change). */
let lastKeys: Readonly<Record<string, string>> | null = null;
let lastMap: ReturnType<typeof keyMapFor> | null = null;
function mapFor(keys: Parameters<typeof keyMapFor>[0]): ReturnType<typeof keyMapFor> {
  if (lastKeys !== keys || !lastMap) {
    lastKeys = keys;
    lastMap = keyMapFor(keys);
  }
  return lastMap;
}

/** The page's pads, copied (a browser may hand back the same live objects each call). */
function gamepads(): (PadState & { mapping?: string } | null)[] {
  return [...(globalThis.navigator?.getGamepads?.() ?? [])].map(g => (g ? { mapping: g.mapping, axes: [...g.axes], buttons: g.buttons.map(b => ({ pressed: b.pressed, value: b.value })) } : null));
}

/**
 * The battle's keys and pads (M8 spec §6.1, Decision 18; Plan 29 R2, R4, R8): each key's action (keyAction), taken on the window
 * before the game's own keys, unless it is the page's (keyFor) or a dialog is up over tactical; a flight key let go as its key
 * comes up; the first standard pad read each animation frame, its buttons acting as they are pressed and its sticks held. Every
 * key, the drag and the pad let go as the warp overlay comes up (showWarp's releaseKeys, tactical.cpp:843-846) and as a dialog does
 * (start()'s `_held = 0` as tactical comes back, :284), and as the page loses the keyboard: the orders that zero a held steer or
 * orbit are given too (TacticalKeys.letGo), kept until the overlay is gone when it drops orders, and before any new steering. A key
 * or pad button held across a let-go counts only when pressed again, and a stick or trigger held across one only once it has come
 * back within the dead zone. No key is taken while auto-resolve runs or its result waits (the zeros go out as it starts: a zero steer
 * changes nothing in the battle it fights). Under the warp overlay pause is still live, P's and the pad's Start (R11). F1 is never
 * the browser's while a battle shows.
 */
export function useBattleControls(c: BattleControls): () => void {
  const ref = useRef(c);
  ref.current = c;
  /** Sends the zero orders waiting, before any new steering (set by the effect below). */
  const flushRef = useRef<() => void>(() => {});
  useEffect(() => {
    /** What each key down started, by its code: its key coming up lets go of it whatever Shift did meanwhile. */
    const down = new Map<string, BattleAction>();
    /** The zero orders for what was let go, waiting for the battle to take orders (not under the warp overlay). */
    const pending: CombatCommand[] = [];
    /** The codes of the keys down at a let-go: their auto-repeats count for nothing until they come up and go down again. */
    const lifted = new Set<string>();
    let pad: PadState | null = null;
    /** The pad's axes held at a let-go or while closed: each counts for nothing until it comes back within the dead zone (R4). */
    const stuck = new Set<keyof Axes>();
    let off = false;
    /** The first standard pad now. */
    const readPad = () => (ref.current.pads ?? gamepads)().find(p => p !== null && (p.mapping === undefined || p.mapping === 'standard')) ?? null;
    const holdStuck = (p: PadState | null) => {
      if (!p) return;
      for (const [axis, way] of Object.entries(padAxes(p))) if (way !== 0) stuck.add(axis as keyof Axes);
    };
    const live = () => {
      const v = ref.current.port.battle();
      return v && !v.warp ? v : null;
    };
    const send = (cmds: readonly CombatCommand[]) => {
      for (const cmd of cmds) if (live()) ref.current.port.command(cmd);
    };
    const flush = () => {
      if (live()) send(pending.splice(0));
    };
    flushRef.current = flush;
    const letGo = () => {
      for (const code of down.keys()) lifted.add(code);
      down.clear();
      // (a button held now is not a press when the battle comes back: it must be let go and pressed again; a stick must come back first)
      pad = readPad();
      holdStuck(pad);
      pending.push(...ref.current.keys.letGo());
      flush();
    };
    const act = (action: BattleAction, view: BattleView) => {
      const { port, keys, now } = ref.current;
      const o = { warp: view.warp, queued: view.queued };
      if ((TACTICAL_ACTIONS as readonly string[]).includes(action)) return send(keys.start(action as TacticalAction, now(), view.b, o));
      switch (action) {
        case 'fireBoth': return send(keys.fireBoth(now(), view.b, o));
        case 'pause': return port.pause(!view.paused);
        case 'cycleSpeed': return port.setAssists({ ...port.assists(), speed: nextSpeed(port.assists().speed) });
        case 'assists': return ref.current.assists();
        // (F1: the Combat Options; its preventDefault is onDown's)
        case 'options': return ref.current.options?.();
        case 'pagePrevious': return ref.current.turnPage(-1);
        case 'pageNext': return ref.current.turnPage(1);
      }
    };
    /** No keys or pad now: no battle, a dialog over it, or auto-resolve's. */
    const closed = (view: BattleView | null) => !view || view.overlay === 'dialog' || view.resolving || view.resolved !== null;
    const onDown = (e: KeyboardEvent) => {
      const view = ref.current.port.battle();
      if (e.defaultPrevented || !view) return;
      // (F1 has no meaning on the page: not the browser's help with a game panel open, in the assists panel or under a dialog)
      if (e.key === 'F1' && !e.ctrlKey && !e.altKey && !e.metaKey) e.preventDefault();
      if (closed(view)) return;
      if (e.repeat && lifted.has(e.code || e.key)) {
        e.preventDefault();
        return;
      }
      lifted.delete(e.code || e.key);
      flush();
      const target = e.target instanceof Element ? e.target : null;
      if (e.key === 'F6' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        ref.current.focusConsole();
        return;
      }
      const action = keyAction(e, mapFor(ref.current.port.keys?.() ?? DEFAULT_KEYS));
      // (Escape with a panel of the game's open is the game's: it closes it)
      if (!action || (action === 'assists' && view.overlay === 'panel')) return;
      if (keyFor(target, e.key, target ? (ref.current.keyboardFocus ?? focusVisible)(target) : false) === 'page') return;
      e.preventDefault();
      if (e.repeat && !repeats(action)) return;
      if (!e.repeat) down.set(e.code || e.key, action);
      act(action, view);
    };
    const onUp = (e: KeyboardEvent) => {
      lifted.delete(e.code || e.key);
      const action = down.get(e.code || e.key);
      if (!action) return;
      down.delete(e.code || e.key);
      if ((TACTICAL_ACTIONS as readonly string[]).includes(action)) send(ref.current.keys.end(action as TacticalAction));
    };
    let id = 0;
    const frame = () => {
      const { keys } = ref.current;
      const view = ref.current.port.battle();
      // (the warp overlay or a dialog came up: every key, the drag and the pad let go, the sim's held steer zeroed with them)
      const now = !view || view.warp || closed(view);
      if (now && !off) letGo();
      off = now;
      flush();
      if (now) {
        // (while closed the pad is only remembered, but for Start under the warp overlay alone, which pauses as P does: R11)
        const found = readPad();
        if (found && view && view.warp && !closed(view)) for (const action of padPresses(pad, found)) if (action === 'pause') act(action, view);
        pad = found;
        holdStuck(found);
      } else if (view) {
        const found = readPad();
        if (found) for (const action of padPresses(pad, found)) act(action, view);
        pad = found;
        const axes = found ? padAxes(found) : { ...NO_AXES };
        for (const axis of [...stuck]) {
          if (axes[axis] === 0) stuck.delete(axis);
          else axes[axis] = 0;
        }
        send(keys.hold('pad', axes));
      }
      id = requestAnimationFrame(frame);
    };
    window.addEventListener('keydown', onDown, true);
    window.addEventListener('keyup', onUp, true);
    window.addEventListener('blur', letGo);
    id = requestAnimationFrame(frame);
    return () => {
      window.removeEventListener('keydown', onDown, true);
      window.removeEventListener('keyup', onUp, true);
      window.removeEventListener('blur', letGo);
      cancelAnimationFrame(id);
      // (a steer held as the console goes is zeroed in the sim, if the battle still takes orders)
      pending.push(...ref.current.keys.letGo());
      flush();
    };
  }, []);
  return () => flushRef.current();
}
