// SPDX-License-Identifier: GPL-3.0-or-later
import { parseCombatFor } from '../content/parse';
import type { CombatData, ShipContent } from '../content/types';
import type { World } from './world';

/** The reads of combat.yaml going on, one per game's ship content (every world of a session shares it). */
const reads = new WeakMap<ShipContent, Promise<CombatData | undefined>>();
/** Why the last read of a game's combat.yaml failed, until a read succeeds (the ?dev combat tab shows it). */
const failures = new WeakMap<ShipContent, string>();

/**
 * How long a read of combat.yaml may take before it counts as failed. startCombat awaits the read inside the world's queue,
 * so a chunk request that stalls (a weak connection, the service worker's plain fetch, which never times out) would leave the
 * world busy for good, with load, restart and save refused. 20 s is far longer than the half-megabyte chunk takes on a slow
 * phone connection; past it the battle refuses to the bridge, as a failed read does, and the next battle tries again.
 */
export const COMBAT_READ_TIMEOUT_MS = 20_000;

/** `read`, or a rejection once COMBAT_READ_TIMEOUT_MS has passed, whichever comes first. */
function withTimeout<T>(read: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${COMBAT_READ_TIMEOUT_MS / 1000} s`)), COMBAT_READ_TIMEOUT_MS);
  });
  return Promise.race([read, timeout]).finally(() => clearTimeout(timer));
}

/**
 * combat.yaml, read when a battle needs it (M8 spec §8). A game parsed with it (the tools, the tests, the walks) has it already;
 * the web app leaves it out of the content it parses at the start and gives the world `combatSource`, its lazy chunk's text, which
 * this parses and checks against the game once (parseCombatFor) and keeps on the game's ship content, for every world after.
 * Undefined, with a warning, for a game without one or a read that fails: the battle then refuses as a game without combat.yaml
 * does (tactical.cpp:314-318), and the next battle tries again.
 */
export function ensureCombat(world: World): Promise<CombatData | undefined> {
  const ship = world.content.ship;
  if (!ship) return Promise.resolve(undefined);
  if (ship.combat) return Promise.resolve(ship.combat);
  const source = world.combatSource;
  if (!source) return Promise.resolve(undefined);
  let read = reads.get(ship);
  if (!read) {
    // (asked at once, as the scenario is set; a source that throws at once takes the same path as one that rejects)
    let started: Promise<string>;
    try {
      started = source();
    } catch (err) {
      started = Promise.reject(err);
    }
    read = withTimeout(started)
      .then(text => {
        failures.delete(ship);
        return (ship.combat ??= parseCombatFor(world.content, text));
      })
      .catch((err: unknown) => {
        reads.delete(ship);
        const message = `combat.yaml could not be read: ${err instanceof Error ? err.message : String(err)}`;
        failures.set(ship, message);
        world.bus.emit({ type: 'warning', message });
        return undefined;
      });
    reads.set(ship, read);
  }
  return read;
}

/** Why the game's last read of combat.yaml failed (the warning's message), or undefined if none has or a later one succeeded. */
export function combatReadError(world: World): string | undefined {
  const ship = world.content.ship;
  return ship ? failures.get(ship) : undefined;
}

/** Starts reading combat.yaml now (a battle scenario was set: a hail's, astrogation's starbase battle, a load), so it is ready when tactical opens. */
export function prefetchCombat(world: World): void {
  void ensureCombat(world);
}
