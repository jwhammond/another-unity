// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { logMessage } from '../../sim/combat/battle';
import { applyCommand } from '../../sim/combat/commands';
import { v3 } from '../../sim/combat/math';
import { KIND } from '../../sim/combat/types';
import { miniBattle, miniEnterpriseUnits, MINI_SHIELD_NAMES } from '../../testing/combat';
import { MINI_CONSOLE_TEXT } from '../../testing/console';
import { hudModel } from './hud';

function battle() {
  const { ctx, b } = miniBattle();
  return { ctx, b, s: { b, combat: ctx.combat, enterpriseUnits: miniEnterpriseUnits() } };
}

describe('the wide view\'s HUD (M8 spec §5.2; Plan 27 R10)', () => {
  it('reads the Enterprise\'s hull, its shields by facing, its speed, the pace, the lamps and the log\'s last three lines', () => {
    const { b, s } = battle();
    const e = b.ships[0]!;
    e.condition = 87;
    e.systems.units[2]!.current = e.systems.units[2]!.max / 2;
    e.speed = 281.5;
    for (let i = 0; i < 5; i++) logMessage(e, `-L${i}-`);
    b.console.lamps = [0, 1, 2, 0, 1, 2, 0, 1];
    const m = hudModel(s, null, 4);
    expect([m.hull, m.shields.map(x => x.name), m.shields[2]!.level, m.shields[0]!.level, m.speed, m.pace]).toEqual([87, [...MINI_SHIELD_NAMES], 0.5, 1, '0.28', 4]);
    expect([m.log, m.lamps, m.selfDestruct]).toEqual([['-L2-', '-L3-', '-L4-'], [0, 1, 2, 0, 1, 2, 0, 1], null]);
    expect(hudModel(s, null, 'paused').pace).toBe('paused');
  });

  it('shows the target\'s class, its range as the scanner reads it, and the shield it turns to us; an unknown chodak by the console\'s word', () => {
    const { ctx, b, s } = battle();
    applyCommand(ctx, b, { type: 'target', ship: 1 });
    const t = b.ships[1]!;
    t.pos = v3(0, 1000, 0);
    b.ships[0]!.pos = v3();
    const m = hudModel(s, { text: MINI_CONSOLE_TEXT }, 1);
    expect(m.target).toMatchObject({ name: '-Zap-', range: 27000 });
    expect(m.target!.shield!.power).toMatch(/^\d+\.\d\d$/);
    b.contactCues = false;
    t.type = KIND.chodak;
    expect(hudModel(s, { text: MINI_CONSOLE_TEXT }, 1).target!.name).toBe('-Oddity-');
    t.decloakTime = b.now + 1;
    expect(hudModel(s, null, 1).target).toBeNull();
    t.decloakTime = 0;
    t.destroyed = true;
    expect(hudModel(s, null, 1).target).toBeNull();
  });

  it('counts the self-destruct down as CONN\'s digits do, while it is armed', () => {
    const { b, s } = battle();
    b.console.selfDestructTime = b.now + 12000;
    expect(hudModel(s, null, 1).selfDestruct).toBe('12.00000');
  });

  it('shows nothing of the target while the sensors read nothing, as drawScanner blanks the sensors page (tactical.cpp:1166-1167)', () => {
    const { ctx, b, s } = battle();
    applyCommand(ctx, b, { type: 'target', ship: 1 });
    expect(hudModel(s, { text: MINI_CONSOLE_TEXT }, 1).target).not.toBeNull();
    b.console.sensorsBlank = true;
    expect(hudModel(s, { text: MINI_CONSOLE_TEXT }, 1).target).toBeNull();
    // (and says the sensors are blank, where the target goes, while there is one: Plan 29 R13)
    expect(hudModel(s, null, 1).sensorsBlank).toBe(true);
    applyCommand(ctx, b, { type: 'target', ship: null });
    expect(hudModel(s, null, 1).sensorsBlank).toBe(false);
  });
});
