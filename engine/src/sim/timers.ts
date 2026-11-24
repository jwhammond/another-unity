// SPDX-License-Identifier: GPL-3.0-or-later
import { perform } from './actions';
import { TICKS_PER_SECOND } from './clock';
import { proximityFires, SHIP_TRIGGER_TICKS } from './shipTick';
import type { World } from './world';

/** Only the active objects on the current screen have running timers. */
export function startTimer(world: World, id: string): void {
  const o = world.obj(id);
  o.timerDue = 0;
  if (!o.timer || !o.active || o.screen !== world.state.screen) return;
  o.timerDue = world.clock.now + Math.round(o.timer * TICKS_PER_SECOND);
}

export function startScreenTimers(world: World): void {
  for (const id of Object.keys(world.state.objects)) startTimer(world, id);
}

export function processTimers(world: World): void {
  const now = world.clock.now;
  const screenChanges = world.screenChanges;
  for (const [id, o] of Object.entries(world.state.objects)) {
    if (!o.timerDue || now < o.timerDue) continue;
    if (!o.active) {
      o.timerDue = 0;
      continue;
    }
    // timers repeat
    o.timerDue = now + Math.round(o.timer * TICKS_PER_SECOND);
    void world.enqueue(async () => {
      // (a timer that ran first may have changed the screen, even to the same one again)
      if (world.screenChanges !== screenChanges) return;
      world.bus.emit({ type: 'timerFired', object: id });
      await perform(world, { verb: 'timer', target: id, who: world.state.currentActor, other: null, walked: false });
    });
  }
}

/** The ship's triggers are checked on the bridge and in astrogation, every SHIP_TRIGGER_TICKS (unity.cpp:787-818). */
export function checkTriggers(world: World, context: 'away' | 'ship'): void {
  const now = world.clock.now;
  if (context === 'ship') {
    // (the other stations stop the clock)
    const station = world.state.ship.station;
    if (station !== 'bridge' && station !== 'astrogation') return;
    // (the computer screen is neither: it leaves the station as it was)
    if (world.computer !== null) return;
    // (a script's warp pending comes first, unity.cpp:792-793; phenomena on the way are after M4, R10)
    if (world.state.ship.warpPending) return;
    // (0 reads as never, as the original's last time starts at 0 long after the program began)
    const last = world.state.ship.lastTriggerCheck;
    if (last !== 0 && now - last < SHIP_TRIGGER_TICKS) return;
    world.state.ship.lastTriggerCheck = now || 1;
  }
  for (const t of world.content.triggers) {
    if (t.context !== context) continue;
    const ts = world.state.triggers[t.id];
    if (!ts.enabled) continue;

    let fire = t.type === 'normal';
    if (t.type === 'timer') {
      if (ts.due && now >= ts.due) {
        ts.due = 0;
        fire = true;
      }
      if (!ts.due) ts.due = now + Math.round((t.seconds ?? 0) * TICKS_PER_SECOND);
    } else if (t.type === 'proximity') {
      fire = t.proximity !== undefined && proximityFires(world, t.proximity);
    }
    if (!fire) continue;

    // only one trigger fires at a time
    void world.enqueue(async () => {
      world.bus.emit({ type: 'triggerFired', id: t.id, target: t.target });
      await perform(world, { verb: 'use', target: t.target, who: world.content.start.leader, other: null, walked: false });
    });
    break;
  }
}
