// SPDX-License-Identifier: GPL-3.0-or-later
import { GAME_END, NO_SCENARIO, STATION_CODE, type Station } from './ship';
import { computerPercent } from './shipSystems';
import { enterAstrogation } from './astro';
import { computerVoices, openComputer } from './computer';
import { canEnergize, energize, openTransporter } from './transporter';
import { runConversation } from './conversation';
import { perform } from './actions';
import { say } from './talk';
import { endCombat, startCombat } from './combat';
import type { PendingHail } from './state';
import type { World } from './world';

/** The stations that keep the clock running (unity.cpp:288-292): the bridge, astrogation, the viewscreen and the transporter. */
export function clockRunsAt(station: Station): boolean {
  return station === 'bridge' || station === 'astrogation' || station === 'viewscreen' || station === 'transporter';
}

/** Astrogation::stopClock (astrogation.cpp:488): remembers when, once. Tick 0 reads as 1, as 0 means "running". */
export function stopClock(world: World): void {
  const ship = world.state.ship;
  if (!ship.clockStopped) ship.clockStopped = world.state.tick || 1;
}

/** Astrogation::startClock (astrogation.cpp:494): a journey under way is pushed back by the time stopped. */
export function startClock(world: World): void {
  const ship = world.state.ship;
  if (!ship.clockStopped) return;
  if (ship.transit) ship.transit.startTick += world.state.tick - ship.clockStopped;
  ship.clockStopped = 0;
}

/** kHolodeckComputerPercent (unity.h:358): the holodeck needs the computer at least this well. */
export const HOLODECK_COMPUTER_PERCENT = 80;

/** The movies the holodeck can show again, by stem: those seen (a warp movie is seen by its index, `warp:<n>`, which `warpMovies` names). */
export function seenMovieStems(world: World, warpMovies: readonly (string | null)[] = []): Set<string> {
  const out = new Set<string>();
  for (const key of world.state.ship.seenMovies) {
    if (!key.startsWith('warp:')) out.add(key);
    else {
      const stem = warpMovies[Number(key.slice(5))];
      if (stem) out.add(stem.toLowerCase());
    }
  }
  return out;
}

/**
 * The holodeck's choice (runHolodeck's loop, unity.cpp:399-421): a movie seen before plays again, between the pick's and the projector's
 * sounds. One not seen yet is refused.
 */
export async function holodeckPlay(world: World, stem: string, warpMovies: readonly (string | null)[] = []): Promise<void> {
  if (world.state.ship.station !== 'holodeck') throw new Error('The ship is not at the holodeck.');
  const key = stem.toLowerCase();
  if (!seenMovieStems(world, warpMovies).has(key)) throw new Error(`${stem} has not been seen yet.`);
  world.bus.emit({ type: 'shipCue', cue: 'holodeckPick' });
  await world.presenter.play({ movie: stem });
  world.bus.emit({ type: 'shipCue', cue: 'holodeckOff' });
}

/** The holodeck's Bridge button (runHolodeck's end, unity.cpp:424-425): the door sounds, and the bridge. */
export async function leaveHolodeck(world: World): Promise<void> {
  if (world.state.ship.station !== 'holodeck') throw new Error('The ship is not at the holodeck.');
  world.bus.emit({ type: 'shipCue', cue: 'holodeckDoor' });
  await gotoShipScreen(world, STATION_CODE.bridge);
}

/** The station a screen code names, if it is one the sim has a station for. */
export function stationOf(code: number): Station | undefined {
  const screen = code & 0xff;
  return (Object.keys(STATION_CODE) as Station[]).find(s => STATION_CODE[s] === screen && s !== 'viewscreen');
}

/**
 * gotoShipScreen (unity.cpp:278-345): code = screen | param << 8. Any screen but tactical and engineering ends a battle
 * (unity.cpp:284-286). Emits `shipScreen` with the code.
 */
export async function gotoShipScreen(world: World, code: number): Promise<void> {
  if (world.state.onShip === null) throw new Error('the team is away: there is no ship screen to go to');
  const screen = code & 0xff;
  const param = code >> 8;
  const ship = world.state.ship;
  const warn = (message: string) => world.bus.emit({ type: 'warning', message });
  const station = stationOf(code);
  // (any other screen closes the computer)
  world.computer = null;
  // a battle waits while engineering is open, but otherwise it's over (unity.cpp:284-286)
  if (screen !== STATION_CODE.tactical && screen !== STATION_CODE.engineering && ship.combat !== null) {
    await endCombat(world, screen === STATION_CODE.bridge);
  }

  if (screen === STATION_CODE.viewscreen) {
    // a hail (or Comms), on the viewscreen, then back to where we were (unity.cpp:304-309)
    startClock(world);
    const next = await runViewscreen(world, param !== 0, ship.viewscreenTarget);
    world.bus.emit({ type: 'shipScreen', code });
    await gotoShipScreen(world, next !== 0 ? next : STATION_CODE[ship.station]);
    return;
  } else if (screen === STATION_CODE.computer) {
    // the computer leaves _shipStation as it was (M5), so a hail from in here comes back to where we were; it stops the
    // clock, and opens the entry a script asked for (unity.cpp:323-326)
    stopClock(world);
    world.computer = openComputer(world, param ? param - 1 : 0);
    // (it says how it is, then the music starts: computer.cpp:306-318)
    for (const cue of computerVoices(world.computer.level)) world.bus.emit({ type: 'shipCue', cue });
  } else if (screen === STATION_CODE.tactical) {
    // (the stations other than the bridge and astrogation stop the clock, unity.cpp:288-292)
    stopClock(world);
    ship.station = 'tactical';
    // (TacticalScreen::start and its first update, unity.cpp:322-325: a failed setup went to the bridge already)
    await startCombat(world);
    if (ship.station !== 'tactical') return;
  } else if (screen === STATION_CODE.holodeck) {
    // runHolodeck (unity.cpp:379-398): it needs the computer; without, the computer says so and the bridge comes back
    if ((world.content.ship ? computerPercent(world.content.ship, ship.systems) : 0) < HOLODECK_COMPUTER_PERCENT) {
      world.bus.emit({ type: 'shipCue', cue: 'computerOffline' });
      // (the refusal is said to its end before the bridge comes back, as the bridge's own music and sounds start with it: unity.cpp:382-384)
      await world.waitForSpeech();
      await gotoShipScreen(world, STATION_CODE.bridge);
      return;
    }
    stopClock(world);
    ship.station = 'holodeck';
    world.transporter = null;
    world.bus.emit({ type: 'shipCue', cue: 'holodeckDoor' });
    world.bus.emit({ type: 'shipCue', cue: 'holodeckOn' });
  } else if (station !== undefined) {
    if (clockRunsAt(station)) startClock(world);
    else stopClock(world);
    ship.station = station;
    // (astrogation's screen starts with Astrogation::enter, astrogation.cpp:1098)
    if (station === 'astrogation') enterAstrogation(world);
    // (the transporter room starts afresh; world 6 has nothing to choose and energizes at once: transporter.cpp:166-206)
    world.transporter = null;
    if (station === 'transporter') {
      const room = (world.transporter = openTransporter(world));
      if (room.world === 6 && canEnergize(room)) energize(world, room);
    }
  } else if (screen === GAME_END) {
    startClock(world);
    world.state.onShip = { gameOver: param };
  } else {
    startClock(world);
    warn(`unknown ship screen ${screen.toString(16)} (${param.toString(16)})`);
    ship.station = 'bridge';
  }
  world.bus.emit({ type: 'shipScreen', code });
}

/** The hail types dispatchHail acts on (unity.cpp:642-695): the rest wait for the battle (types 0-3 and 0xc-0xf). */
export const HAIL_DISPATCHED: readonly number[] = [4, 5, 7, 8, 9, 0xa, 0xb, 0x10, 0x11];

/**
 * dispatchPendingHail (unity.cpp:642-695) for the hails this plan has (R9): the next ship screen code, or null for
 * "stay" (0xffff). Types 4, 5 and 8 are the ship conversation (4 on the bridge, 5 over its viewscreen: the greybox
 * shows no difference); 7 the viewscreen; 9 the transporter; 0xb and 0x11 set the scenario only. A battle hail (0xa,
 * 0x10) go to tactical with their scenario (not their conversation, which a battle hail hasn't).
 */
export async function dispatchHail(world: World): Promise<number | null> {
  const hail = world.state.pendingHail;
  if (hail === null) return null;
  const ship = world.state.ship;
  const clear = () => { world.state.pendingHail = null; };
  switch (hail.type) {
    case 4:
    case 5:
    case 8:
      // (4 puts the viewscreen down and 5 up, setViewscreen: unity.cpp:650 and 656)
      if (hail.type !== 8) world.bus.emit({ type: 'bridgeViewscreen', up: hail.type === 5 });
      clear();
      // (who is object 0, the captain: the original's `say(0x5f, target, objectID(0, 0, 0), "@95,conv,situation")`)
      if (hail.conversation !== null) await runConversation(world, hail.conversation, hail.situation, world.content.start.leader);
      return null;
    case 7:
      // on the viewscreen screen; 99 (no conversation here) means the target's own talk string
      if (hail.conversation === null) {
        clear();
        ship.viewscreenTarget = hail.from;
        return STATION_CODE.viewscreen;
      }
      return STATION_CODE.viewscreen | 0x100;
    case 9:
      clear();
      return STATION_CODE.transporter;
    case 0xb:
    case 0x11:
      setScenario(world, hail);
      clear();
      return null;
    case 0xa:
    case 0x10:
      // (unity.cpp:676-680: the scenario is the hail's `conversation` there)
      setScenario(world, hail);
      clear();
      return STATION_CODE.tactical;
    default:
      // (types 0-3 and 0xc-0xf are for space combat: they stay pending, unity.cpp:690-692)
      return null;
  }
}

function setScenario(world: World, hail: PendingHail): void {
  world.state.ship.battleScenario = hail.scenario ?? NO_SCENARIO;
  world.bus.emit({ type: 'battleScenario', scenario: world.state.ship.battleScenario });
}

/**
 * runViewscreen (unity.cpp:697-724): a hail's conversation, or the target's own talk string, on the viewscreen. Returns
 * the next ship screen code: the transporter if a hail during the conversation asked for it, otherwise 0 (the bridge,
 * which gotoShipScreen reads as "back where we were"), or tactical if a battle hail came during it.
 */
export async function runViewscreen(world: World, hail: boolean, target: string | null): Promise<number> {
  const pending = world.state.pendingHail;
  const who = world.content.start.leader;
  if (hail) {
    target = pending?.from ?? null;
    world.state.pendingHail = null;
  }
  world.viewscreen = { target };
  world.bus.emit({ type: 'viewscreen', on: true, target });
  try {
    if (hail && pending !== null && pending.conversation !== null) {
      await runConversation(world, pending.conversation, pending.situation, who);
    } else if (target === null || !world.state.objects[target]) {
      // (the original has the helm say the signal is lost)
      world.bus.emit({ type: 'warning', message: 'viewscreen: no signal' });
    } else {
      const obj = world.obj(target);
      await say(world, target, who, obj.talk, obj.talkVoice ?? undefined);
    }
  } finally {
    world.viewscreen = null;
    world.bus.emit({ type: 'viewscreen', on: false, target });
  }

  // a hail during the conversation can go elsewhere
  const next = world.state.pendingHail;
  if (next !== null && next.type === 9) {
    world.state.pendingHail = null;
    return STATION_CODE.transporter;
  }
  // a battle hail goes to tactical (unity.cpp:718-722)
  if (next !== null && (next.type === 0xa || next.type === 0x10)) {
    setScenario(world, next);
    world.state.pendingHail = null;
    return STATION_CODE.tactical;
  }
  return 0;
}

/** The helm, who speaks the bridge's own lines: objectID(4, 0, 0) (bridge.cpp:376, unity.cpp:719). */
export const HELM = 'worf';
/**
 * What the helm says when nobody answers a hail (bridge.cpp:419) and when the lounge is empty (bridge.cpp:387).
 * Provenance: ScummVM's bridge.cpp strings, the engine's own words; neither is in the CD data files (a grep of the game's data finds
 * neither). They are short UI lines of the same class as COMBADGE_QUESTION, kept under the short-UI-strings allowance (Plan 12 ledger).
 */
export const NO_RESPONSE = 'There is no response to our hail';
export const LOUNGE_EMPTY = 'The room is empty.';
/** BridgeScreen::chooseObject lists at most this many (bridge.cpp:356). */
const MAX_CONTACTS = 10;

/**
 * BridgeScreen::chooseObject (bridge.cpp:351-378): the active objects on one of the ship's screens, up to ten. Comms
 * (ship screen 1) needs a sprite; the lounge (screen 4) doesn't. Starfleet goes first (the lifter orders the lounge so).
 */
export function contacts(world: World, which: 'comms' | 'lounge'): string[] {
  const lists = world.content.ship?.data.contacts;
  if (!lists) return [];
  const out: string[] = [];
  const entries = which === 'comms' ? lists.comms : lists.lounge.map(object => ({ object, sprite: true }));
  for (const c of entries) {
    if (out.length >= MAX_CONTACTS) break;
    if (!world.state.objects[c.object]?.active || !c.sprite) continue;
    out.push(c.object);
  }
  return out;
}

/** The helm (or whoever is nearest) says a line of the engine's own (say(0x5f, nullptr, objectID(4, 0, 0), text)). */
async function helmSays(world: World, text: string): Promise<void> {
  await say(world, null, world.state.objects[HELM] ? HELM : world.content.start.leader, text);
}

/** kActionComms (bridge.cpp:417-425): the target goes on the viewscreen (code 2); with nobody, the helm says so. */
export async function hailObject(world: World, object: string | null): Promise<void> {
  if (object === null || !contacts(world, 'comms').includes(object)) {
    await helmSays(world, NO_RESPONSE);
    return;
  }
  world.state.ship.viewscreenTarget = object;
  await gotoShipScreen(world, STATION_CODE.viewscreen);
}

/** kActionLounge (bridge.cpp:385-398): Picard talks to whoever is in the lounge; with nobody, it is said to be empty. */
export async function loungeTalk(world: World, object: string | null): Promise<void> {
  if (object === null || !contacts(world, 'lounge').includes(object)) {
    await helmSays(world, LOUNGE_EMPTY);
    return;
  }
  await perform(world, { verb: 'talk', target: object, who: world.content.start.leader, other: null, walked: false });
}
