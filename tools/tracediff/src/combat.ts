// SPDX-License-Identifier: GPL-3.0-or-later
import { combatSim, newSystems, type GameContent, type SystemsState } from '@another-unity/engine';

type CombatEvent = combatSim.CombatEvent;
type BattleState = combatSim.BattleState;
type BattleContext = combatSim.BattleContext;

/**
 * Space combat's parity (Plan 22): a battle as ScummVM's trace has it (docs/trace-format.md, "Space combat"), and
 * the port's replay of the same battle from the same start and the same inputs, written as the same events.
 */

/** The `combat` event: what TacticalScreen::start began the battle from. */
export interface CombatStart {
  scenario: number; difficulty: 0 | 1 | 2; delegate: boolean; lastDifficulty: number; astrogation: [number, number, number];
  enterprise: { units: number[][]; pool: number; torpedoes: number; matterAntimatterOutput: number; fusionOutput: number; lastReactorTick: number; lastTick: number };
  objects: { id: string; active: boolean; state: number }[];
}

/** One battle of a trace: its start, its seed (the `combatSeed` draw), its setup clock and ships, and its events in order. */
export interface TraceBattle {
  start: CombatStart;
  seed: number;
  now: number;
  ships: { index: number; type: number; id: string }[];
  events: CombatEvent[];
}

const COMBAT_EVENTS = new Set(['roll', 'snap', 'hails', 'hailsEnd', 'standDown', 'leave', 'warp', 'input', 'atan2', 'combatEnd']);

/** The battles in a trace (JSON lines): each from its `combat` event to its `combatEnd` (or the trace's end). */
export function readBattles(text: string): { battles: TraceBattle[]; problems: string[]; notes: string[] } {
  const battles: TraceBattle[] = [];
  const problems: string[] = [];
  const notes: string[] = [];
  const lines = text.split('\n');
  const lastLine = lines.reduce((m, l, i) => (l.trim() === '' ? m : i), -1);
  let current: (Partial<TraceBattle> & { events: CombatEvent[] }) | null = null;
  const close = () => {
    if (!current) return;
    if (current.start && current.seed !== undefined && current.now !== undefined && current.ships) battles.push(current as TraceBattle);
    else problems.push(`battle ${current.start?.scenario ?? '?'}: its trace has no seed, setup clock or ships`);
    current = null;
  };
  lines.forEach((line, i) => {
    if (line.trim() === '') return;
    let e: { ev: string } & Record<string, unknown>;
    try {
      e = JSON.parse(line) as typeof e;
    } catch {
      // (a run killed part way through a battle can leave its last line half-written: that battle didn't finish)
      if (i === lastLine && current) notes.push(`line ${i + 1}: half-written, dropped: the run stopped part way through its battle`);
      else problems.push(`line ${i + 1}: not JSON`);
      return;
    }
    if (e.ev === 'combat') {
      close();
      const { seq: _seq, ev: _ev, ...start } = e;
      current = { start: start as unknown as CombatStart, events: [] };
    } else if (!current) {
      return;
    } else if (e.ev === 'rng' && e.site === 'combatSeed' && current.seed === undefined) {
      current.seed = e.value as number;
    } else if (e.ev === 'ships') {
      current.now = e.now as number;
      current.ships = e.ships as TraceBattle['ships'];
    } else if (COMBAT_EVENTS.has(e.ev)) {
      const { seq: _seq, ...rest } = e;
      current.events.push(rest as unknown as CombatEvent);
      if (e.ev === 'combatEnd') close();
    }
  });
  close();
  return { battles, problems, notes };
}

/** A processHails call in ScummVM's trace: from its `hails` to its `hailsEnd`, with what it logged between (a nested call's, its stand-downs), rolls aside. */
export interface HailBlock { step: number; site: string; events: CombatEvent[]; end: Extract<CombatEvent, { ev: 'hailsEnd' }> | null }

/** The outermost processHails calls of a battle's events, in order. */
export function hailBlocks(events: readonly CombatEvent[]): HailBlock[] {
  const out: HailBlock[] = [];
  let open: HailBlock | null = null;
  let depth = 0;
  for (const e of events) {
    if (e.ev === 'hails') {
      if (depth++ === 0) open = { step: e.step, site: e.site, events: [], end: null };
    }
    if (open && e.ev !== 'roll' && e.ev !== 'snap' && e.ev !== 'atan2') open.events.push(e);
    if (e.ev === 'hailsEnd' && depth > 0 && --depth === 0 && open) {
      open.end = e;
      out.push(open);
      open = null;
    }
  }
  if (open) out.push(open);
  return out;
}

/**
 * The `libm-atan2f` allowance (docs/tracediff.md): ScummVM's angle where its trace logged atan2f apart from atan2
 * rounded, for exactly those inputs (as float32 values) at that step, and only where the port's angle is the rounded
 * one; each taken is passed to `taken` (the replay echoes it, and the report counts it by site). Each logged call is
 * taken once: two calls with the same inputs at the same step are two takes, in the order ScummVM logged them.
 */
export function atan2Oracle(events: readonly CombatEvent[], step: () => number, taken: (e: Extract<CombatEvent, { ev: 'atan2' }>) => void): combatSim.AngleOracle {
  const logged = new Map<string, Extract<CombatEvent, { ev: 'atan2' }>[]>();
  for (const e of events) {
    if (e.ev !== 'atan2') continue;
    const key = `${e.step}|${Math.fround(e.s)}|${Math.fround(e.c)}`;
    logged.set(key, [...(logged.get(key) ?? []), e]);
  }
  return (s, c, angle) => {
    const queue = logged.get(`${step()}|${s}|${c}`);
    const e = queue?.[0];
    if (!e || e.rounded !== angle) return angle;
    queue.shift();
    taken(e);
    return e.angle;
  };
}

/**
 * What else a replay does: `atStep` hears the battle as each step leaves it (after the frame's update, before the next
 * frame's inputs), as the screen draws it after that step: tools/combatshots takes the battle a shot shows from it.
 */
export interface ReplayOptions { atStep?: (b: BattleState) => void }

/** The ScummVM ids (`wwssii`) of the lifted objects, by slug: ids.yaml's objects turned round. */
export type HexOf = (slug: string) => string | undefined;

/** The port's run of a battle: its events, and what kept it from running as the trace asks. */
export interface Replay {
  events: CombatEvent[];
  problems: string[];
  /** False when ScummVM's trace has no combatEnd: its run didn't finish, and the replay went only as far as it did (a status, not a difference). */
  finished: boolean;
  /** The port's battle as the replay left it (null when none was set up): for what the trace doesn't carry, as the held keys. */
  battle: BattleState | null;
}

/** combatTicks(0x369): showWarp's wait (tactical.cpp:841), which a trace's clock skips (the `warp` event). */
const WARP_WAIT = combatSim.combatTicks(0x369);
/**
 * Where each world-script hook calls TacticalScreen::processHails, in the export's damage.cpp (which adds no lines
 * there, R11): Combat::runEventHook (:672), the hail script (:693), the hull-low hook (:713), runDestroyedHook (:731).
 * Each seam takes only its own hook's call.
 */
export const HOOK_SITES = {
  eventScript: 'damage.cpp:672', hailScript: 'damage.cpp:693', hullLowScript: 'damage.cpp:713', destroyedScript: 'damage.cpp:731',
} as const;
const isHookSite = (site: string) => (Object.values(HOOK_SITES) as string[]).includes(site);

/** The world-script seams, each taking ScummVM's processHails from its own hook's line (HOOK_SITES) through `take`. */
export function hookSeams(take: (bs: BattleState, site: string) => combatSim.HookResult): Pick<combatSim.CombatSeams, keyof typeof HOOK_SITES> {
  return {
    eventScript: (_c, bs) => take(bs, HOOK_SITES.eventScript),
    hailScript: (_c, bs) => take(bs, HOOK_SITES.hailScript),
    hullLowScript: (_c, bs) => take(bs, HOOK_SITES.hullLowScript),
    destroyedScript: (_c, bs) => take(bs, HOOK_SITES.destroyedScript),
  };
}

/**
 * Replays a traced battle in the port, as the export's harness played it (tools/scummvm-harness/harness.inc `fight`):
 * a frame at a time, each frame the harness's checks (left, won, the cap) and the inputs due at this step, then
 * TacticalScreen::update (the radar's draw, checkSensors, comes first in the step: unless the view is wide or the
 * Enterprise is lost, tactical.cpp:1315-1316, 1062-1063; Plan 23 R10) (the Enter object's hails on the first; the battle's update to one step on; leave and
 * stand down). The world's scripts aren't run: where ScummVM's trace has TacticalScreen::processHails at the step a
 * hook runs, the replay takes what it left (the exit code, the red alert, the ships' remove times). ScummVM's
 * atan2f angles are taken where its trace logs them (the `libm-atan2f` allowance).
 */
export function replayBattle(content: GameContent, hexOf: HexOf, t: TraceBattle, previous?: BattleState, o: ReplayOptions = {}): Replay {
  const ship = content.ship;
  const combat = ship?.combat;
  if (!ship || !combat) return { events: [], problems: ['the lifted game has no combat.yaml'], finished: true, battle: null };
  const events: CombatEvent[] = [];
  const problems: string[] = [];
  const traced = t.events;
  const hails = hailBlocks(traced);
  const inputs = traced.filter((e): e is Extract<CombatEvent, { ev: 'input' }> => e.ev === 'input');
  const end = traced.find((e): e is Extract<CombatEvent, { ev: 'combatEnd' }> => e.ev === 'combatEnd');
  let b: BattleState | null = null;
  let pendingSkip = 0;
  let left: number | null = null;

  /**
   * The next processHails ScummVM ran, if it was at this step and from `site`: consumed, its events echoed, and its
   * effect applied (R8). Only what processHails can change is taken (tactical.cpp:377-436, unity-engine's lines), by
   * the hail types the call ran (its own `hails` and a nested call's):
   * - the red alert: off where it stood down (0xd :402, 0xb and 0xc :412, 0x10 :423, each logged as a `standDown`),
   *   on for 0xf (:418);
   * - the exit: kShipBridge for 0xd (:403), which a type 7's conversation reaches by the fall-through (:381-399);
   * - a ship's remove time for 0x10 only, and only where the port's is still 0 (:425-427).
   * Any other value of ScummVM's hailsEnd that differs from the port's isn't taken: it is a problem.
   */
  const takeHails = (bs: BattleState, match: (site: string) => boolean): combatSim.HookResult | null => {
    const block = hails[0];
    if (!block || block.step !== bs.steps || !match(block.site)) return null;
    hails.shift();
    events.push(...block.events);
    const done = block.end;
    if (!done) return combatSim.NO_HOOK;
    const types = new Set(block.events.flatMap(e => (e.ev === 'hails' ? [e.type] : [])));
    const stoodDown = block.events.some(e => e.ev === 'standDown');
    const odd = (what: string, scummvm: unknown, port: unknown) =>
      problems.push(`step ${bs.steps}: ScummVM's processHails from ${block.site} left ${what} ${String(scummvm)}, which its hails can't set; the port has ${String(port)}`);
    if (types.has(0xd) || types.has(7)) bs.exitCode = done.exit;
    else if (done.exit !== bs.exitCode) odd('the exit', done.exit, bs.exitCode);
    if (stoodDown || types.has(0xf)) bs.console.redAlert = done.redAlert;
    else if (done.redAlert !== bs.console.redAlert) odd('the red alert', done.redAlert, bs.console.redAlert);
    done.removeTimes.forEach((r, i) => {
      const ship = bs.ships[i];
      if (!ship) return;
      if (types.has(0x10) && ship.removeTime === 0) ship.removeTime = r;
      else if (r !== ship.removeTime) odd(`ship ${i}'s remove time`, r, ship.removeTime);
    });
    return { hailPending: done.type === 7, answered: done.result };
  };
  const hook = (bs: BattleState, at: string): combatSim.HookResult => takeHails(bs, site => site === at) ?? combatSim.NO_HOOK;
  const ctx: BattleContext = {
    combat,
    enterpriseUnits: ship.data.units,
    seams: {
      ...combatSim.NO_SEAMS, ...combatSim.SIM_SEAMS,
      ...hookSeams(hook),
      showWarp: (_c, bs) => {
        // (the overlay's wait, which the trace's clock skips; the keys let go: tactical.cpp:841-846)
        events.push({ ev: 'warp', step: bs.steps, wait: WARP_WAIT });
        pendingSkip += WARP_WAIT;
        bs.input.held = 0;
      },
      astrogationPosition: () => t.start.astrogation,
      hail: (_c, bs) => { takeHails(bs, () => true); },
      bridge: (_c, bs) => {
        // (TacticalScreen::buttonAction's Bridge: the hail at a red alert, else leave for the bridge: tactical.cpp:503-510)
        if (bs.console.redAlert) takeHails(bs, () => true);
        else {
          left = combatSim.leaveCode(bs, 0);
          events.push({ ev: 'leave', step: bs.steps, code: left });
          events.push(combatSim.snapshot(bs));
        }
      },
    },
    onDraw: (site, n, value) => { if (b) events.push({ ev: 'roll', step: b.steps, site, n, value }); },
    angleOracle: atan2Oracle(traced, () => b?.steps ?? 0, e => events.push(e)),
    onStep: bs => { if (bs.steps % combatSim.SNAPSHOT_STEPS === 0) events.push(combatSim.snapshot(bs)); },
  };

  // the start: the Enterprise's systems as ScummVM had them, the objects' active flags and states
  const systems: SystemsState = newSystems(ship);
  const e = t.start.enterprise;
  systems.units.forEach((u, i) => {
    const [current, target, max, damage, repair, nextStep, nextRepair] = e.units[i] ?? [];
    Object.assign(u, { current, target, max, damage, repair, nextStep, nextRepair });
  });
  Object.assign(systems, { pool: e.pool, torpedoes: e.torpedoes, matterAntimatterOutput: e.matterAntimatterOutput, fusionOutput: e.fusionOutput, lastReactorTick: e.lastReactorTick, lastTick: e.lastTick });
  const objects = new Map(t.start.objects.map(o => [o.id, o]));
  const result = combatSim.startBattle(ctx, {
    scenario: t.start.scenario, seed: t.seed, now: t.now, difficulty: t.start.difficulty, enterprise: systems,
    active: slug => objects.get(hexOf(slug) ?? '')?.active ?? false,
    lastDifficulty: t.start.lastDifficulty,
    objectState: slug => objects.get(hexOf(slug) ?? '')?.state ?? 0,
    // (the trace's battle before this one, as the session's one Combat carries it into the next: setup's carryOver)
    ...(previous ? { previous } : {}),
  });
  for (const w of result.warnings) problems.push(`setup: ${w}`);
  b = result.battle;
  if (!b) return { events, problems: [...problems, 'the port set up no battle'], finished: end !== undefined, battle: null };
  const bs = b;
  // (the `ships` event: each index's ship type and object, as setup built them, ScummVM's against the port's)
  const ships = (list: { index: number; type: number; id: string }[]) => list.map(s => `${s.index}:${s.type}:${s.id}`).join(' ');
  const [theirs, ours] = [ships(t.ships), ships(bs.ships.map(s => ({ index: s.index, type: s.type, id: hexOf(s.object) ?? s.object })))];
  if (theirs !== ours) problems.push(`setup: the ships (index:type:object) are ${theirs} in ScummVM, ${ours} in the port`);
  events.push(combatSim.snapshot(bs));

  // (a trace without its end didn't finish: the replay goes as far as it went, the last step ScummVM logged, the
  // inputs it logged there and the radar's draw (the sensor check the next step would start with), and stops there
  // without an end of its own; that step is compared as a prefix: Review Focus 3)
  const lastStep = traced.reduce((m, e) => Math.max(m, 'step' in e ? e.step : 0), 0);
  const cap = !end ? Infinity : end.reason === 'cap' ? end.step : end.step + 1000;
  let nextInput = 0;
  let first = true;
  for (;;) {
    // the harness's checks, then the inputs due (harness.inc `fight`)
    let reason: 'leave' | 'won' | 'cap' | null = null;
    if (left !== null) reason = 'leave';
    else if (combatSim.liveShips(bs) < 2) reason = 'won';
    else if (bs.steps >= cap) reason = 'cap';
    if (reason) {
      // (a leave took its own snapshot)
      if (bs.steps % combatSim.SNAPSHOT_STEPS !== 0 && left === null) events.push(combatSim.snapshot(bs));
      events.push({ ev: 'combatEnd', step: bs.steps, reason });
      break;
    }
    while (nextInput < inputs.length && inputs[nextInput]!.step <= bs.steps) {
      const input = inputs[nextInput++]!;
      const read = combatSim.parseInputLine(input.line);
      if ('error' in read) {
        problems.push(`step ${bs.steps}: ${read.error}`);
        continue;
      }
      combatSim.applyCommand(ctx, bs, read.command);
      events.push({ ev: 'input', step: bs.steps, line: input.line });
    }
    // (an input that left, the Bridge button's, ended the battle at once: gotoShipScreen's endCombat clears _inCombat
    // (unity.cpp:286, tactical.cpp:345-347), so the frame's drawScene and update do nothing (tactical.cpp:1293-1294,
    // 456-457, unity.cpp:1759-1766), and the next frame's check ends the fight: no draw and no step)
    if (left !== null) continue;
    // (the draw's radar asks the sensors, tactical.cpp:1111-1113: the step does, before it, while the radar shows: Plan 23 R10.
    // An unfinished trace stops before the next step, so its last step's draw is asked here, as the step would, gated
    // and at the last step's time: a run killed after that draw compares as a prefix, not a difference)
    if (!end && bs.steps >= lastStep) {
      bs.now = bs.lastStep;
      if (bs.console.radarShown && combatSim.alive(bs.ships[0])) combatSim.checkSensors(ctx, bs);
      break;
    }
    // TacticalScreen::update: on the first, the Enter object's USE and processHails (tactical.cpp:460-465)
    if (first) {
      first = false;
      takeHails(bs, site => !isHookSite(site));
    }
    const now = bs.lastStep + combatSim.STEP_TIME + pendingSkip;
    pendingSkip = 0;
    const r = combatSim.tacticalUpdate(ctx, bs, now);
    o.atStep?.(bs);
    if (r.leave !== null) {
      // (TacticalScreen::leave: the screen goes)
      events.push({ ev: 'leave', step: bs.steps, code: r.leave });
      events.push(combatSim.snapshot(bs));
      left = r.leave;
    }
    for (const site of r.standDowns) events.push({ ev: 'standDown', step: bs.steps, site });
  }
  for (const h of hails) problems.push(`step ${h.step}: ScummVM's processHails from ${h.site} had no call in the port`);
  return { events: end ? events : prefixOfLastStep(events, traced, lastStep), problems, finished: end !== undefined, battle: bs };
}

/**
 * An unfinished trace's last step is compared as a prefix: ScummVM's run may have stopped part way through it (killed
 * at the timeout inside a hook's conversation, or crashed), so of the port's events at that step only as many of
 * each kind as ScummVM logged there are kept, in order (its rolls, its snapshot if it has one, its other events).
 */
function prefixOfLastStep(events: CombatEvent[], traced: readonly CombatEvent[], lastStep: number): CombatEvent[] {
  const room = new Map<string, number>();
  for (const e of traced) if ('step' in e && e.step === lastStep) room.set(e.ev, (room.get(e.ev) ?? 0) + 1);
  return events.filter(e => {
    if (!('step' in e) || e.step !== lastStep) return true;
    const n = room.get(e.ev) ?? 0;
    room.set(e.ev, n - 1);
    return n > 0;
  });
}
