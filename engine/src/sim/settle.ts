// SPDX-License-Identifier: GPL-3.0-or-later
import { TICKS_PER_SECOND } from './clock';
import type { World } from './world';

/** Lets every pending promise continuation run. Headless (Node) only. */
export function flush(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

/** Runs simulated time until no action is running. Timers don't fire while busy, so the clock can jump. */
export async function settle(world: World, maxTicks = 60 * 60 * TICKS_PER_SECOND): Promise<void> {
  await flush();
  let elapsed = 0;
  while (world.busy) {
    const next = world.clock.nextDue();
    if (next === undefined) {
      await flush();
      if (world.busy && world.clock.nextDue() === undefined) {
        throw new Error('world is stuck: an action is waiting on something that is not the clock');
      }
      continue;
    }
    elapsed += next - world.clock.now;
    if (elapsed > maxTicks) throw new Error(`world did not settle within ${maxTicks} ticks`);
    world.clock.advanceTo(next);
    await flush();
  }
}

/** Lets game time pass tick by tick (so timers and triggers fire), then settles. */
export async function advance(world: World, seconds: number): Promise<void> {
  const ticks = Math.round(seconds * TICKS_PER_SECOND);
  for (let i = 0; i < ticks; i++) {
    world.tick();
    await flush();
  }
  await settle(world);
}
