// SPDX-License-Identifier: GPL-3.0-or-later
import { combatSim, Rng } from '@another-unity/engine';
import { z } from 'zod';
import { ConversationId, ObjectId, zodProblems } from './manifest';

const int = z.number().int();
const nat = int.min(0);
const Verb = z.enum(['use', 'get', 'look', 'timer', 'walk', 'talk']);
/** Where a list is in the raw IR: "<file id>#/<JSON pointer>". */
const ListPath = z.string().regex(/^(o_[0-9a-f]{6}|w[0-9a-f]{3}c\d{3})#\/.+$/);
const Value = z.union([int, z.string(), z.boolean()]);
export const OBJECT_FIELDS = [
  'curr_screen', 'flags', 'state', 'x', 'y', 'z', 'timer', 'name', 'talk_string',
  'voice_id', 'voice_group', 'voice_subgroup', 'health', 'inventory',
  'stunned', 'destroyed', 'cursor_id', 'cursor_flag', 'y_adjust',
  'universe_x', 'universe_y', 'universe_z', 'anim_index', 'sprite_id', 'use_verb', 'use_preposition',
] as const;
export const GLOBAL_KEYS = [
  'adviceId', 'adviceInterval', 'combadge', 'inputBlocked', 'closeup', 'member', 'team', 'phaserIndex',
  'beam', 'pendingHail', 'newWarpMovie',
] as const;
const EntryPath = z.string().regex(/^(o_[0-9a-f]{6}|w[0-9a-f]{3}c\d{3})#\/.+\/\d+\/\d+$/);

function ev<L extends string, S extends z.ZodRawShape>(name: L, shape: S) {
  return z.object({ seq: nat, ev: z.literal(name), ...shape }).strict();
}

/** Space combat's (docs/trace-format.md, "Space combat"): a float32 as nine digits, a vector, an angle triple, a site as "file.cpp:line". */
const float = z.number().finite();
const Vec = z.tuple([float, float, float]);
const Angles = z.tuple([int, int, int]);
const Site = z.string().regex(/^[a-z_0-9]+\.(?:cpp|h):\d+$/);
const Step = nat;
const ShipIndex = int.min(-1);
/** A ship's systems: each unit as [current, target, max, damage, repair], plus [nextStep, nextRepair] in `combat`'s Enterprise. */
const Unit = z.tuple([int, int, int, int, int]);
const TimedUnit = z.tuple([int, int, int, int, int, nat, nat]);
const Systems = { units: z.array(Unit), pool: int, torpedoes: int };
const ShipSnap = z.object({
  index: nat, pos: Vec, velocity: Vec, angles: Angles, speed: float, condition: int, flags: nat, destroyed: z.boolean(), removed: z.boolean(),
  target: ShipIndex, engaged: z.boolean(), removeTime: nat, ...Systems,
}).strict();
const TorpedoSnap = z.object({ slot: nat, pos: Vec, angles: Angles, shooter: ShipIndex, target: ShipIndex, expiry: nat }).strict();
/** The camera updateCamera placed (Plan 25): its position, its axes' rows (right, down, forward) and the view. */
const CameraSnap = z.object({ pos: Vec, axes: z.array(float).length(9), view: nat }).strict();

export const TraceEvent = z.discriminatedUnion('ev', [
  ev('begin', { version: z.literal(1), engine: z.literal('scummvm'), seed: nat }),
  ev('end', {}),
  ev('seed', { seed: nat }),
  ev('load', {}),
  ev('action', { verb: Verb, target: ObjectId.nullable(), who: ObjectId, other: ObjectId, x: nat, y: nat, depth: int.min(1) }),
  ev('actionEnd', { verb: Verb, target: ObjectId.nullable(), flags: nat, depth: int.min(1) }),
  ev('group', { list: ListPath, index: nat, passed: z.boolean(), flags: nat }),
  ev('entry', { list: ListPath, group: nat, index: nat, class: z.string(), flags: nat }),
  ev('obj', { id: ObjectId, field: z.enum(OBJECT_FIELDS), from: Value, to: Value, walking: z.boolean().optional() }),
  ev('response', { conv: ConversationId, index: nat, id: nat, state: nat, from: int.min(1).max(4), to: int.min(1).max(4) }),
  ev('triggerState', { id: nat, enabled: z.boolean() }),
  ev('region', { world: nat, screen: nat, region: nat, type: nat }),
  ev('counter', { entry: EntryPath, from: nat, to: nat }),
  ev('startup', { world: nat, screen: nat, field: z.string(), from: int, to: int }),
  ev('global', { key: z.enum(GLOBAL_KEYS), from: Value, to: Value }),
  ev('shipUnit', { index: nat, name: z.string(), field: z.literal('damage'), from: int, to: int }),
  ev('trigger', { id: nat, target: ObjectId }),
  ev('timer', { object: ObjectId }),
  ev('screen', { world: nat, screen: nat, entrance: nat }),
  ev('ship', { code: nat }),
  ev('rng', { site: z.string(), max: nat, value: nat }),
  ev('say', { who: ObjectId, text: z.string(), voice: z.string() }),
  ev('choice', { kind: z.enum(['menu', 'box']), question: z.string(), options: z.array(z.string()), picked: int, scripted: z.boolean() }),
  ev('movie', { id: nat.nullable(), file: z.string() }),
  ev('step', { line: nat, text: z.string() }),
  ev('refused', { who: ObjectId }),
  ev('error', { what: z.string() }),
  ev('combat', {
    scenario: nat, difficulty: int.min(0).max(2), delegate: z.boolean(), lastDifficulty: nat, astrogation: Angles,
    enterprise: z.object({ ...Systems, units: z.array(TimedUnit), matterAntimatterOutput: int, fusionOutput: int, lastReactorTick: nat, lastTick: nat }).strict(),
    objects: z.array(z.object({ id: ObjectId, active: z.boolean(), state: nat }).strict()),
  }),
  ev('ships', { now: nat, ships: z.array(z.object({ index: nat, type: nat, id: ObjectId }).strict()) }),
  ev('roll', { step: Step, site: Site, n: int.min(-1), value: nat }),
  ev('snap', {
    step: Step, now: nat, exit: nat, target: ShipIndex, redAlert: z.boolean(), delegate: z.boolean(), weaponsLock: z.boolean(),
    shieldsRaised: z.boolean(), powerLevel: int, kernelReady: z.boolean(), random: nat, camera: CameraSnap, ships: z.array(ShipSnap), torpedoes: z.array(TorpedoSnap),
  }),
  ev('hails', { step: Step, site: Site, type: nat }),
  ev('hailsEnd', { step: Step, result: z.boolean(), type: nat, exit: nat, redAlert: z.boolean(), removeTimes: z.array(nat) }),
  ev('standDown', { step: Step, site: Site }),
  ev('leave', { step: Step, code: nat }),
  ev('warp', { step: Step, wait: nat }),
  ev('input', { step: Step, line: z.string() }),
  ev('atan2', { step: Step, site: Site, s: float, c: float, angle: nat, rounded: nat }),
  ev('combatEnd', { step: Step, reason: z.enum(['leave', 'won', 'cap']) }),
]);
export type TraceEventT = z.infer<typeof TraceEvent>;

/** One event per line; problems name the line. */
export function parseTrace(text: string): { events: TraceEventT[]; problems: string[] } {
  const events: TraceEventT[] = [];
  const problems: string[] = [];
  text.split('\n').forEach((line, i) => {
    if (line === '') return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      problems.push(`line ${i + 1}: not JSON`);
      return;
    }
    const result = TraceEvent.safeParse(value);
    if (!result.success) {
      problems.push(...zodProblems(result).map(p => `line ${i + 1}: ${p}`));
      return;
    }
    events.push(result.data);
  });
  return { events, problems };
}

export function checkTrace(events: TraceEventT[]): string[] {
  const problems: string[] = [];
  events.forEach((e, i) => {
    if (e.seq !== i) problems.push(`event ${i}: seq ${e.seq}`);
  });
  if (events[0]?.ev !== 'begin') problems.push("the first event isn't begin");
  if (events.at(-1)?.ev !== 'end') problems.push("the last event isn't end");
  for (const e of events) {
    if (e.ev === 'obj' && e.from === e.to) problems.push(`seq ${e.seq}: ${e.id}.${e.field} didn't change`);
    else if ('from' in e && 'to' in e && e.from === e.to) problems.push(`seq ${e.seq}: ${e.ev} didn't change`);
    if (e.ev === 'error') problems.push(`seq ${e.seq}: error: ${e.what}`);
  }
  return problems;
}

/** Every rng event, replayed through Plan 1's Rng from the trace's seed. */
export function checkRng(events: TraceEventT[]): string[] {
  const problems: string[] = [];
  let rng: Rng | null = null;
  for (const e of events) {
    if (e.ev === 'begin' || e.ev === 'seed') rng = new Rng({ rngSeed: e.seed });
    if (e.ev !== 'rng') continue;
    if (!rng) {
      problems.push(`seq ${e.seq}: a draw before begin`);
      continue;
    }
    const expected = rng.next(e.max);
    if (e.value !== expected) problems.push(`seq ${e.seq}: ${e.site} drew ${e.value}, the TypeScript Rng ${expected}`);
  }
  return problems;
}

/**
 * Every battle's AstroRandom draws (`roll`), replayed from its seed (the `combatSeed` draw after its `combat` event)
 * through the port's random.ts: each value is rnd(n), or next() for n -1, and each snapshot's `random` is the state
 * after the draws before it. A draw the trace missed shows as the next value or state being wrong.
 */
export function checkCombatRolls(events: TraceEventT[]): string[] {
  const problems: string[] = [];
  let random: ReturnType<typeof combatSim.newRandom> | null = null;
  let seeded = false;
  for (const e of events) {
    if (e.ev === 'combat') {
      random = null;
      seeded = true;
    } else if (e.ev === 'rng' && e.site === 'combatSeed' && seeded) {
      random = combatSim.newRandom(e.value);
      seeded = false;
    } else if (e.ev === 'roll' || e.ev === 'snap') {
      if (!random) {
        problems.push(`seq ${e.seq}: a ${e.ev} before the battle's seed`);
        continue;
      }
      if (e.ev === 'snap') {
        if (e.random !== random.state) problems.push(`seq ${e.seq}: step ${e.step}'s state is ${e.random}, the draws give ${random.state}`);
        continue;
      }
      const value = e.n === -1 ? combatSim.nextRandom(random) : combatSim.rnd(random, e.n);
      if (value !== e.value) problems.push(`seq ${e.seq}: ${e.site} drew ${e.value}, random.ts ${value}`);
    }
  }
  return problems;
}
