// SPDX-License-Identifier: GPL-3.0-or-later
export * from './content/types';
export * from './content/projection';
export * from './sim/result';
export * from './sim/geometry';
export * from './sim/rng';
export * from './content/parse';
export * from './content/refs';
export * from './content/tactics';
export * from './sim/state';
export * from './sim/save';
export * from './sim/clock';
export * from './sim/stop';
export * from './sim/events';
export * from './sim/hooks';
export * from './sim/presenter';
export * from './sim/world';
export * from './sim/settle';
export * from './sim/actions';
export * from './sim/conditions';
export * from './sim/effects';
export * from './sim/alter';
export * from './sim/rules';
export * from './sim/timers';
export * from './testing/fixture';
export * from './testing/greybox';
export * from './testing/media';
export * from './testing/tactics';
export * from './testing/combat';
export * from './content/talkString';
export * from './sim/conversation';
export * from './sim/talk';
export * from './sim/talkLog';
export * from './sim/shipSystems';
export * from './sim/advice';
export * from './sim/failures';
export * from './sim/ending';
export * from './sim/phaser';
export * from './sim/items';
export * from './sim/react';
// (not applyScreenChange: World.applyScreenChange also drops the queued walks)
export { adviceEffect, applyStartup, awayFlagsEffect, entranceSlot, GATHER_TICKS, requestScreen, setAwayFlags, startupEffect } from './sim/screens';
export * from './sim/general';
export * from './sim/ship';
export * from './sim/shipFx';
export * from './sim/computer';
export * from './sim/astro';
export * from './sim/stations';
export * from './sim/combat';
export * from './sim/combatData';
/**
 * Combat's sim core (Plan 19) as one namespace: its step, stop, add and scale would clash with the flat exports, and
 * './sim/combat' is the M4 placeholder's file. A battle's Enterprise `systems` is the world's own object
 * (world.state.ship.systems), so a structuredClone of a battle cuts that link: the clone no longer writes the ship.
 */
export * as combatSim from './sim/combat/index';
/** The world's battle (Plan 23): TacticalScreen's world half, and the assists' driver. */
export { autoResolve, AUTO_RESOLVE_CAP, battleCommand, finishResolved, pauseBattle, type BattleResult, type WorldBattle } from './sim/tacticalScreen';
export * from './sim/transporter';
export * from './testing/ship';
export { battleContent } from './testing/battle';
export { miniBattleDef, miniCombat } from './testing/combat';
