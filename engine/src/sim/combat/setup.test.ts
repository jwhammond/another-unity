// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { CombatData, CombatShipDef } from '../../content/types';
import { miniBattle, miniBattleContext, miniCombat, miniEnterpriseSystems, miniEnterpriseUnits, recordingSeams } from '../../testing/combat';
import { setupBattle, type BattleInput } from './setup';
import { KIND, NO_EXIT, NO_SEAMS, type BattleContext } from './types';

const ship = (object: string, type: number, o: Partial<CombatShipDef> = {}): CombatShipDef => ({
  object, type, position: [0, 0, 0], heading: null, decloak: 0, strength: 100, hullLow: 50, tactics: null, ...o,
});
/** miniCombat with battle 5: these ships, in this order. */
function withBattle(ships: CombatShipDef[], quietContacts = false): CombatData {
  const combat = miniCombat();
  combat.battles[5] = { screen: 'space.s05', enter: 'b.enter', exit: 'b.exit', warp: null, quietContacts, ships };
  return combat;
}
function setup(ctx: BattleContext, o: Partial<BattleInput> = {}) {
  return setupBattle(ctx, { scenario: 5, seed: 1, now: 10000, difficulty: 1, active: () => true, enterprise: miniEnterpriseSystems(), ...o });
}

describe('setupBattle (Combat::setup, combat.cpp:157-279)', () => {
  it('puts the Enterprise at index 0 and numbers the rest 1.. in the screen\'s order, wherever the Enterprise is listed', () => {
    const ctx = miniBattleContext({}, withBattle([ship('s.a', KIND.romulan), ship('s.ent', KIND.enterprise), ship('s.b', KIND.klingon), ship('s.c', KIND.chodak)]));
    const b = setup(ctx).battle!;
    expect(b.ships.map(s => [s.index, s.object])).toEqual([[0, 's.ent'], [1, 's.a'], [2, 's.b'], [3, 's.c']]);
    expect([b.enter, b.exit, b.warp, b.exitCode]).toEqual(['b.enter', 'b.exit', null, NO_EXIT]);
  });

  it('skips inactive ships without using up an index, and makes the last ship made the target', () => {
    const ctx = miniBattleContext({}, withBattle([ship('s.ent', KIND.enterprise), ship('s.a', KIND.romulan), ship('s.off', KIND.romulan), ship('s.b', KIND.ferengi)]));
    const b = setup(ctx, { active: id => id !== 's.off' }).battle!;
    expect(b.ships.map(s => [s.index, s.object])).toEqual([[0, 's.ent'], [1, 's.a'], [2, 's.b']]);
    expect(b.target).toBe(2);
    expect(b.ships.map(s => s.target)).toEqual([2, 0, 0]);
  });

  it('skips a second Enterprise and a ship past 8, with warnings; the Enterprise counts toward the 8 once it is in (combat.cpp:229)', () => {
    const others = Array.from({ length: 9 }, (_, i) => ship(`s.${i}`, KIND.romulan));
    const first = setup(miniBattleContext({}, withBattle([ship('s.ent', KIND.enterprise), ship('s.ent2', KIND.enterprise), ...others])));
    expect(first.battle!.ships.map(s => s.object)).toEqual(['s.ent', 's.0', 's.1', 's.2', 's.3', 's.4', 's.5', 's.6']);
    expect(first.warnings).toEqual(['battle screen 5 contains more than one Enterprise', 'too many ships in battle screen 5', 'too many ships in battle screen 5']);
    // (listed last, the Enterprise joins 8 others: 9 ships)
    const last = setup(miniBattleContext({}, withBattle([...others, ship('s.ent', KIND.enterprise)])));
    expect(last.battle!.ships).toHaveLength(9);
    expect(last.warnings).toEqual(['too many ships in battle screen 5']);
  });

  it('is no battle without an active Enterprise, or for a screen with no battle', () => {
    const ctx = miniBattleContext({}, withBattle([ship('s.ent', KIND.enterprise), ship('s.a', KIND.romulan)]));
    expect(setup(ctx, { active: id => id !== 's.ent' })).toEqual({ battle: null, warnings: ['battle screen 5 has no Enterprise'] });
    expect(setup(ctx, { scenario: 0x77 })).toEqual({ battle: null, warnings: ['battle screen 77 has no Enterprise'] });
  });

  it('refuses an Enterprise without its 35 units', () => {
    const ctx = { ...miniBattleContext(), enterpriseUnits: miniEnterpriseUnits().slice(0, 6) };
    expect(() => setupBattle(ctx, { scenario: 3, seed: 1, now: 0, difficulty: 1, active: () => true, enterprise: miniEnterpriseSystems() })).toThrow(/has 6 units: combat needs 35/);
    // (and its systems' units too short)
    const short = miniEnterpriseSystems(miniEnterpriseUnits().slice(0, 34));
    expect(() => setupBattle(miniBattleContext(), { scenario: 3, seed: 1, now: 0, difficulty: 1, active: () => true, enterprise: short })).toThrow(/has 34 units: combat needs 35/);
  });

  it('places a ship from its object: position, heading in degrees as 16384 to a turn, size, speed and condition time', () => {
    const { b } = miniBattle();
    const [e, chodak] = b.ships;
    expect([e!.pos, e!.angles, e!.radius, e!.maxSpeed]).toEqual([{ x: 0, y: 0, z: 0 }, [0, 0, 0], 200, 300]);
    expect([chodak!.pos, chodak!.angles]).toEqual([{ x: 1000, y: 0, z: 5000 }, [8192, 0, 0]]);
    expect(chodak!.trail).toHaveLength(31);
    // (the def's tactics file, for loadScript)
    expect([e!.tactics, chodak!.tactics]).toEqual(['mini.bin', 'mini.bin']);
    expect(chodak!.trail[30]).toEqual({ pos: { x: 1000, y: 0, z: 5000 }, angles: [8192, 0, 0] });
    expect([e!.conditionTime, chodak!.conditionTime]).toEqual([15000, 15000]);
    // ((int16)sprite_id: -90 degrees is 12288)
    const west = setup(miniBattleContext({}, withBattle([ship('s.ent', KIND.enterprise), ship('s.a', KIND.romulan, { heading: -90, position: [12.5, -7, 3] })]))).battle!;
    expect([west.ships[1]!.angles[0], west.ships[1]!.pos]).toEqual([12288, { x: 12.5, y: -7, z: 3 }]);
  });

  it('shares the Enterprise\'s own systems, and gives the others the enemy template, full, scaled by strength and difficulty', () => {
    const enterprise = miniEnterpriseSystems();
    const ctx = miniBattleContext({}, withBattle([ship('s.ent', KIND.enterprise), ship('s.a', KIND.romulan, { strength: 80 })]));
    const lieutenant = setup(ctx, { enterprise }).battle!;
    expect(lieutenant.ships[0]!.systems).toBe(enterprise);
    expect(lieutenant.ships[1]!.systems.units[0]).toMatchObject({ current: 80, max: 80, target: 100, damage: 0 });
    expect([lieutenant.ships[1]!.systems.pool, lieutenant.ships[1]!.systems.torpedoes]).toEqual([2400, 275]);
    // (Ensign halves the strength, Captain doubles it; the target stays the template's max, combat.cpp:362, 370-377:
    // an Ensign's enemy charges toward 100 with a max of 40. A quirk, kept)
    expect(setup(ctx, { difficulty: 0 }).battle!.ships[1]!.systems.units[0]).toMatchObject({ current: 40, max: 40, target: 100 });
    expect(setup(ctx, { difficulty: 2 }).battle!.ships[1]!.systems.units[0]).toMatchObject({ current: 160, max: 160, target: 100 });
  });

  it('cloaks a ship for its seconds, with Data\'s cue a second in when it is under 2 (combat.cpp:321-325)', () => {
    const ctx = miniBattleContext({}, withBattle([ship('s.ent', KIND.enterprise), ship('s.a', KIND.romulan, { decloak: 1 }), ship('s.b', KIND.romulan, { decloak: 4 })]));
    const b = setup(ctx).battle!;
    expect(b.ships.map(s => s.decloakTime)).toEqual([0, 11000, 14000]);
    expect(b.cues).toEqual([{ cue: 0x3f, delay: 1000, interrupt: false }]);
  });

  it('has Worf name each contact by its kind\'s cue, but not battle 0x34\'s surprise chodaks and probes', () => {
    const combat = withBattle([ship('s.ent', KIND.enterprise), ship('s.c', KIND.chodak), ship('s.r', KIND.romulan), ship('s.p', KIND.probe)]);
    combat.kinds[KIND.chodak]!.contactCue = 0x39;
    combat.kinds[KIND.romulan]!.contactCue = 0x3d;
    combat.kinds[KIND.probe]!.contactCue = 0x38;
    expect(setup(miniBattleContext({}, combat)).battle!.cues.map(c => c.cue)).toEqual([0x39, 0x3d, 0x38]);
    combat.battles[5]!.quietContacts = true;
    const quiet = setup(miniBattleContext({}, combat)).battle!;
    expect(quiet.contactCues).toBe(false);
    expect(quiet.cues.map(c => c.cue)).toEqual([0x3d]);
  });

  it('calls the weapons and tactics seams for each ship, then locks the menu, lights the lamps and places the camera', () => {
    const log: string[] = [];
    miniBattle({ ctx: miniBattleContext(recordingSeams(log)) });
    expect(log).toEqual(['setupWeapons:0', 'loadScript:0', 'setupWeapons:1', 'loadScript:1', 'engage', 'updateLamps', 'updateCamera']);
  });

  it('holds the Enterprise\'s fire 3 s, loads the salvos from the tubes, seeds the rolls and views the Enterprise', () => {
    const { b } = miniBattle({ seed: 1 });
    expect(b.ships[0]!.fireTime).toBe(13000);
    expect(b.console.salvo).toEqual([{ loaded: 10, setting: 10 }, { loaded: 10, setting: 10 }]);
    expect(b.random).toEqual({ state: 1, draws: 0 });
    expect(b.torpedoes).toHaveLength(99);
    expect(b.torpedoes.every(t => !t.active)).toBe(true);
    expect([b.view.view, b.view.viewShip, b.view.viewExpiry, b.view.zoom, b.view.zoomLevel]).toEqual([0, 0, 30000, 3, 0]);
  });

  it('keeps what ScummVM\'s Combat keeps from the last battle (shields, spread, Delegate, the controls\' release times) and resets the rest', () => {
    const { b: first } = miniBattle();
    Object.assign(first.console, {
      shieldsRaised: true, spread: 455, spreadDegrees: 10, delegate: true, redAlert: true, weaponsLock: true, powerLevel: 3,
      lamps: [0, 1, 2, 0, 1, 2, 0, 1], targetFacing: 2, connPage: true, menuSelected: 4, sensorQuality: 20, warped: true,
      radarOpen: false, radarSeen: false,
    });
    Object.assign(first.view, { orbitAngle: 700, lastOrbit: 9000, lastOrbitStep: 9100, cycleShip: 1, cycleView: 3, lastCycle: 9200, zoomLevel: 2 });
    Object.assign(first.input, { releaseStart: [0, 0, 12000], lastPhaserKey: 9300, lastTorpedoKey: 9400 });
    const { b } = miniBattle({ previous: first, now: 50000 });
    expect(b.console).toMatchObject({
      shieldsRaised: true, spread: 455, spreadDegrees: 10, delegate: true, redAlert: true, weaponsLock: true, powerLevel: 3,
      lamps: [0, 1, 2, 0, 1, 2, 0, 1], targetFacing: 2, connPage: true,
    });
    expect(b.view).toMatchObject({ orbitAngle: 700, lastOrbit: 9000, lastOrbitStep: 9100, cycleShip: 1, cycleView: 3, lastCycle: 9200 });
    expect(b.input).toMatchObject({ releaseStart: [0, 0, 12000], lastPhaserKey: 9300, lastTorpedoKey: 9400 });
    // (copies, not the last battle's arrays)
    expect(b.console.lamps).not.toBe(first.console.lamps);
    expect([b.console.menuSelected, b.console.sensorQuality, b.console.warped, b.view.zoomLevel, b.input.held]).toEqual([-1, 100, false, 0, 0]);
    // (the sensors start reliable, so the radar's answer does too: Plan 27 R5)
    expect(b.console.radarSeen).toBe(true);
    // (the radar stays as the player left it, M8's drawer; the view starts narrow, so it shows if open: Plan 23 R10)
    expect([b.console.radarOpen, b.console.radarShown, b.view.wide]).toEqual([false, false, false]);
    expect(miniBattle({ previous: Object.assign(first, { console: { ...first.console, radarOpen: true } }) }).b.console.radarShown).toBe(true);
  });

  it('moves the times it keeps back with a battle clock that went back, keeping 0 as "not yet"', () => {
    const { b: first } = miniBattle({ now: 300000 });
    Object.assign(first.view, { lastOrbit: 299950, lastCycle: 299900 });
    Object.assign(first.input, { releaseStart: [0, 299000, 0], lastPhaserKey: 299800, lastTorpedoKey: 0 });
    const { b } = miniBattle({ previous: first, now: 10000 });
    expect([b.view.lastOrbit, b.view.lastCycle]).toEqual([9950, 9900]);
    expect(b.input).toMatchObject({ releaseStart: [0, 9000, 0], lastPhaserKey: 9800, lastTorpedoKey: 0 });
  });

  it('has a frozen NO_SEAMS: contexts take copies', () => {
    expect(Object.isFrozen(NO_SEAMS)).toBe(true);
    expect(miniBattleContext().seams).not.toBe(NO_SEAMS);
  });
});
