// SPDX-License-Identifier: GPL-3.0-or-later
import { ANYONE, CURRENT, SHIP, type AdviceFx, type AwayFlagsFx, type ScreenFx, type StartupFx, type Vec2 } from '../content/types';
import { perform } from './actions';
import { setAdvice } from './advice';
import { TICKS_PER_SECOND } from './clock';
import { fullScalePixels, pixelAt, screenFloor, screenPixels } from './pixels';
import { GAME_END, returnAwayTeam, STATION_CODE } from './ship';
import { gotoShipScreen } from './stations';
import { entranceSlotName, type PendingScreen } from './state';
import { startScreenTimers } from './timers';
import type { ActionContext, World } from './world';

/** How long the team takes to gather before leaving (awayteam.cpp:360). */
export const GATHER_TICKS = Math.round(TICKS_PER_SECOND / 3);

/** setAwayTeamFlags (unity.cpp:975-980): null or undefined leaves a flag as it is. */
export function setAwayFlags(world: World, inputBlocked?: boolean | null, combadge?: boolean | null): void {
  if (inputBlocked !== undefined && inputBlocked !== null) world.state.awayFlags.inputBlocked = inputBlocked;
  if (combadge !== undefined && combadge !== null) world.state.awayFlags.combadge = combadge;
}

/**
 * requestScreenChange with screen 0xff: the screen already asked for, else the one the team is on (M3 Plan 8 R1).
 * An entrance the screen lacks is entrance 0, as placeAwayTeam makes it.
 */
async function requestCurrent(world: World, s: ScreenFx): Promise<number> {
  const warn = (message: string) => world.bus.emit({ type: 'warning', message });
  if (world.state.onShip !== null) {
    warn(`a change to the current screen (${CURRENT}) from the ship does nothing`);
    return 0;
  }
  const pending = world.state.pendingScreen;
  // (ScummVM keeps _pendingScreen but resets _pendingWorld to the away world, which would send the team to the ship's
  // screen number on an away world: ill-defined. Keeping the change to the ship is the sane reading.)
  if (pending?.to === SHIP) {
    warn(`a change to the current screen (${CURRENT}) while a change to the ship is pending does nothing`);
    return 0;
  }
  const to = pending !== null ? pending.to : world.state.screen;
  const markers = world.content.screens[to]?.markers ?? {};
  let entrance = s.entrance ?? 'entrance_0';
  if (!Object.hasOwn(markers, entrance)) {
    if (!Object.hasOwn(markers, 'entrance_0')) {
      warn(`${to} has neither ${entrance} nor entrance_0: the change to the current screen does nothing`);
      return 0;
    }
    warn(`${entrance} isn't on ${to}: entrance_0 instead (placeAwayTeam)`);
    entrance = 'entrance_0';
  }
  return requestScreen(world, { ...s, to, entrance });
}

/** ScreenBlock's screen change (object.cpp:1660-1678); applied once the outermost action is done. */
export async function requestScreen(world: World, s: ScreenFx): Promise<number> {
  if (s.to === CURRENT) return requestCurrent(world, s);
  if (s.to === SHIP) {
    world.state.pendingScreen = { to: SHIP, entrance: '', ...(s.gameOver !== undefined ? { gameOver: s.gameOver } : {}) };
    return 0;
  }
  if (s.entrance === undefined) throw new Error(`a change to screen "${s.to}" needs an entrance`);
  if (s.gather) await gather(world);
  world.state.pendingScreen = { to: s.to, entrance: s.entrance, ...(s.stepIn ? { stepIn: true } : {}), ...(s.stay ? { stay: true } : {}) };
  return 0;
}

/** Where arriving member `i` stands: entrance slot `i % 4` (placeAwayTeam, awayteam.cpp:375-378). */
export function entranceSlot(world: World, screen: string, entrance: string, i: number): Vec2 {
  return world.marker(screen, entranceSlotName(world.content.screens[screen]?.markers ?? {}, entrance, i));
}

/** gatherAwayTeam (awayteam.cpp:350-363): everyone joins whoever is acting, before they leave together. */
async function gather(world: World): Promise<void> {
  // (getWalker(_actionWho): $none and $anyone mean the current member)
  const actor = world.actionWho === null ? undefined : world.walkerIdFor(world.actionWho);
  if (actor === undefined || world.state.onCloseup) return;
  world.bus.emit({ type: 'gathered', actor });
  // (where they get to doesn't matter: everyone arrives at the entrance)
  await world.clock.wait(GATHER_TICKS);
}

function endAwayTeam(world: World): void {
  returnAwayTeam(world.state, world.content, world.clock.now);
}

/** applyScreenChange (unity.cpp:1878-1895). World.applyScreenChange also drops the queued walks. */
export function applyScreenChange(world: World): void {
  const pending = world.state.pendingScreen;
  if (!pending) return;
  world.state.pendingScreen = null;
  world.screenChanges++;

  if (pending.to === SHIP) {
    const gameOver = pending.gameOver ?? null;
    const aboard = world.content.ship !== undefined;
    world.state.onShip = { gameOver };
    setAwayFlags(world, false, true);
    world.bus.emit({ type: 'leftAwayMission', gameOver });
    // (the team's last state, then the ship's: gotoShipScreen's endAwayTeam comes after the mission is left)
    if (aboard) endAwayTeam(world);
    // going back to the ship always means the bridge, unless the game is over (unity.cpp:1888-1893)
    if (aboard) void gotoShipScreen(world, gameOver === null ? STATION_CODE.bridge : GAME_END | (gameOver << 8));
    return;
  }
  enterScreen(world, pending);
}

/**
 * Where a member steps in to from their slot. On a screen with a pixel metric, as placeAwayTeam does it: the step is
 * scaleAt(slot) * stepIn / 256 whole pixels (stepIn as pixels at full scale), in rows as in columns, kept on the screen,
 * and the walk there ends at the nearest walkable point (walk.cpp findPath).
 */
function stepInTo(world: World, pos: Vec2, step: number, dx: number, dz: number): Vec2 {
  const p = screenPixels(world);
  const floor = screenFloor(world);
  if (!p || !floor) return { x: pos.x + step * dx, z: pos.z + step * dz };
  const slot = pixelAt(p, pos);
  // (the scale is the floor's at the slot, from its polygons' corners: walk.cpp Screen::scaleAt)
  const px = Math.trunc((floor.scaleAt(slot) * fullScalePixels(p, step)) / 256);
  const clip = (v: number, max: number) => Math.min(max, Math.max(0, v));
  const dest = { x: clip(slot.x + px * dx, 639), y: clip(slot.y + px * dz, 399) };
  // (where walkTo ends, worked out here in pixels: a point off the floor may be on a row the metres can't hold)
  const end = floor.findPath(slot, dest)?.at(-1) ?? slot;
  return p.toWorld(end.x, end.y);
}

/** startAwayTeam (awayteam.cpp:241-342), for a team already on an away mission. */
function enterScreen(world: World, pending: PendingScreen): void {
  const c = world.content;
  const s = world.state;
  const screen = pending.to;
  const old = s.screen;
  // the team moves together, but anyone left on another screen stays there
  const sameWorld = s.onShip === null && (c.screens[old]?.world ?? c.id) === (c.screens[screen].world ?? c.id);
  const wasCloseup = s.onShip === null && s.onCloseup;

  s.screen = screen;
  s.onShip = null;
  // (openLocation loads the sprite of everything the screen lists)
  for (const d of Object.values(c.objects)) {
    if (d.screen === screen && !s.spritesLoaded.includes(d.id)) s.spritesLoaded.push(d.id);
  }
  // a close-up screen doesn't show the away team
  s.onCloseup = s.startups[screen].closeup;

  // The crew in object-id order (awayteam.cpp:285-305); the converter must emit crew in the original's order.
  const arriving: string[] = [];
  for (const def of Object.values(c.objects)) {
    if (!def.crew) continue;
    const id = def.id;
    const o = world.obj(id);
    if (!s.awayTeam.includes(id)) {
      // (the crew who aren't on the away team are nowhere)
      if (o.screen !== null) {
        o.screen = null;
        world.bus.emit({ type: 'objectChanged', id });
      }
      continue;
    }
    // (anyone who is down stays where they fell)
    if (!sameWorld || (o.screen === old && !world.isIncapacitated(id))) {
      o.screen = screen;
      arriving.push(id);
    }
  }

  // (coming back from a close-up with entrance 0xff, the team stays where it was: awayteam.cpp:309)
  // (the step-in walks are started after the startup action is queued: ScummVM runs that on the first frame, long before
  // anyone has stepped in, and a walk's arrival can now run an action square)
  const stepIns: { id: string; to: Vec2 }[] = [];
  if (!s.onCloseup && !(wasCloseup && pending.stay === true)) {
    const step = c.rules.stepIn ?? 0;
    arriving.forEach((id, i) => {
      const pos = entranceSlot(world, screen, pending.entrance, i);
      world.obj(id).pos = { ...pos };
      world.bus.emit({ type: 'objectChanged', id });
      if (pending.stepIn === true) {
        // step in from the slot, a little way in a random direction (awayteam.cpp:384-392)
        const dx = world.rng.next(2, 'stepInX') - 1;
        const dz = world.rng.next(2, 'stepInY') - 1;
        stepIns.push({ id, to: stepInTo(world, pos, step, dx, dz) });
      }
    });
  } else {
    // (they still arrive: unseen on a close-up, or where they were)
    for (const id of arriving) world.bus.emit({ type: 'objectChanged', id });
  }

  if (world.obj(s.currentActor).screen !== screen) world.selectNextMember();
  startScreenTimers(world);
  applyStartup(world, wasCloseup);
  for (const w of stepIns) world.walkTo(w.id, w.to);
  world.bus.emit({ type: 'screenChanged', screen });
}

/** The screen startup (awayteam.cpp:315-340): flags, advice, and an action that runs next. */
export function applyStartup(world: World, wasCloseup: boolean): void {
  const st = world.state.startups[world.state.screen];
  setAwayFlags(world, st.inputBlocked, st.combadge);
  if (st.advice.off || st.advice.id !== undefined) setAdvice(world, st.advice);

  const a = st.action;
  if (!a || wasCloseup) return;
  const who = a.who === undefined || a.who === ANYONE ? world.state.currentActor : a.who;
  const ctx: ActionContext = {
    verb: a.verb,
    target: a.target,
    who,
    other: a.other ?? null,
    walked: false,
    to: a.at !== undefined ? world.marker(world.state.screen, a.at) : undefined,
  };
  const screenChanges = world.screenChanges;
  void world.enqueue(async () => {
    // (another screen change clears the delayed actions, unity.cpp:940-943, 966-973)
    if (world.screenChanges !== screenChanges) return;
    await perform(world, ctx);
  });
}

/** ScreenBlock's advice (object.cpp:1680-1692). */
export function adviceEffect(world: World, a: AdviceFx): number {
  if (a.screen === undefined) {
    // (an interval without an advice id does nothing)
    if (a.off) setAdvice(world, { off: true });
    else if (a.id !== undefined) setAdvice(world, { id: a.id, every: a.every });
    return 0;
  }
  // for the next time the screen is entered: the id always, the interval only if given
  const st = world.state.startups[a.screen];
  const every = a.every ?? st.advice.every;
  st.advice = {
    ...(a.off ? { off: true as const } : a.id !== undefined ? { id: a.id } : {}),
    ...(every !== undefined ? { every } : {}),
  };
  return 0;
}

/** ScreenBlock's startup override (object.cpp:1694-1706). */
export function startupEffect(world: World, s: StartupFx): number {
  world.state.startups[s.screen].action = s.action ? { ...s.action } : null;
  return 0;
}

/** ScreenBlock's flags (object.cpp:1708-1718). */
export function awayFlagsEffect(world: World, a: AwayFlagsFx): number {
  if (a.screen === undefined) {
    setAwayFlags(world, a.inputBlocked, a.combadge);
    return 0;
  }
  const st = world.state.startups[a.screen];
  if (a.closeup !== undefined) st.closeup = a.closeup;
  if (a.combadge !== undefined) st.combadge = a.combadge;
  if (a.inputBlocked !== undefined) st.inputBlocked = a.inputBlocked;
  return 0;
}
