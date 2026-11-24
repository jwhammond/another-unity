// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { liftShip } from './ship';
import { IGNORED } from './ignored';
import { liftGame } from './lift';
import { alter, miniRaw, obj, type J } from './testing/mini';
import { rawFromMini, testCtx } from './testing/ctx';

const unit = (f: object = {}) => ({
  name: '-Zap-', type: 7, depth: -3, paletteIndex: 4, current: 1, target: 2, max: 3, chargeTicks: 4, dischargeTicks: 5, damage: 6, repair: 7,
  baseDamage: 8, maxDamage: 9, efficiency: 95, hitWeight: 10, ...f,
});

function setup(edit: (e: ReturnType<typeof rawFromMini>['executable']) => object) {
  const r = rawFromMini();
  const raw = { ...r, executable: { ...r.executable, ...edit(r.executable) } };
  const ctx = testCtx(raw);
  return { ctx, ship: liftShip(raw, ctx) };
}

describe('liftShip', () => {
  it('keeps the bridge items in order, with the mini world\'s slugs and descriptions', () => {
    const { ctx, ship } = setup(() => ({
      _bridgeItems: [
        { id: '000001', x: 1, y: 2, width: 3, height: 4, action: 5, depth: 6, description: '-Zap-' },
        { id: '000000', x: 7, y: 8, width: 9, height: 10, action: 11, depth: 12, description: '' },
      ],
      _bridgeObjects: [{ id: '000002', x: 5, y: 6, depth: -10, filename: '-Zip-' }],
      _bridgeScreenEntries: [{ code: 1, text: '-Lift-' }],
    }));
    expect(ship.bridge.items.map(i => i.object)).toEqual([ctx.ids.object('000001', 't'), ctx.ids.object('000000', 't')]);
    expect(ship.bridge.items[0]).toMatchObject({ x: 1, y: 2, width: 3, height: 4, action: 5, depth: 6, description: '-Zap-' });
    expect(ship.bridge.objects).toEqual([{ object: ctx.ids.object('000002', 't'), x: 5, y: 6, depth: -10, file: '-Zip-' }]);
    expect(ship.bridge.turbolift).toEqual([{ code: 1, text: '-Lift-' }]);
    expect(ctx.problems.errors).toEqual([]);
  });

  it('numbers the team rows from world 1 (the C++ reads row world - 1), world 8 unchanged and silent', () => {
    const team = (n: number) => ({ defaultMembers: ['000000'], inventoryItems: n === 7 ? [] : ['000001'] });
    const { ctx, ship } = setup(() => ({ _awayTeamScreenData: Array.from({ length: 8 }, (_, n) => team(n)) }));
    expect(ship.transporter.teams.map(t => t.world)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(ship.transporter.teams[7]).toEqual({ world: 8, members: [ctx.ids.object('000000', 't')], items: [] });
    expect(ctx.problems.warnings).toEqual([]);
  });

  it('lifts a bridge item\'s depth as the signed int the export wrote as a u32', () => {
    const { ship } = setup(() => ({
      _bridgeItems: [{ id: '000001', x: 0, y: 0, width: 1, height: 1, action: 0, depth: 4294967196, description: '' }],
    }));
    expect(ship.bridge.items[0].depth).toBe(-100);
  });

  it('keeps the units\' hit depth (damage.cpp:102) and drops the engineering panel\'s palette', () => {
    const { ship } = setup(() => ({ _shipUnits: [unit()] }));
    expect(ship.units).toEqual([{
      name: '-Zap-', type: 7, current: 1, target: 2, max: 3, chargeTicks: 4, dischargeTicks: 5, damage: 6, repair: 7, baseDamage: 8, maxDamage: 9, efficiency: 95, hitWeight: 10, depth: -3,
    }]);
  });

  it('warns about and drops an away-team member that isn\'t in the export', () => {
    const { ctx, ship } = setup(() => ({ _awayTeamScreenData: [{ defaultMembers: ['000000', '0000ee'], inventoryItems: ['0aaaaa'] }] }));
    expect(ship.transporter.teams[0].members).toEqual([ctx.ids.object('000000', 't')]);
    expect(ship.transporter.teams[0].items).toEqual([]);
    expect(ctx.problems.warnings).toHaveLength(2);
    expect(ctx.problems.warnings[0]).toMatch(/0000ee/);
  });

  it('writes transporter.pads with rect, stand and scale, and no longer ignores _transporterPads', () => {
    const { ship } = setup(() => ({
      _transporterPads: [{ rect: { left: 225, top: 85, right: 276, bottom: 231 }, stand: { x: 250, y: 231 }, scale: 240 }],
    }));
    expect(ship.transporter.pads).toEqual([{ rect: [225, 85, 276, 231], stand: [250, 231], scale: 240 }]);
    expect(Object.keys(IGNORED)).not.toContain('executable._transporterPads');
  });

  it('writes the crew\'s walk on and off, and no longer ignores them', () => {
    const { ship } = setup(() => ({
      _transporterWalkOn: [{ x: 38, y: 289, direction: 0, scale: 256 }, { x: 0, y: 0, direction: 0, scale: 244 }],
      _transporterWalkOff: [{ x: 0, y: 0, direction: 0, scale: 0 }, { x: 326, y: 248, direction: 9, scale: 244 }],
    }));
    expect(ship.transporter.walkOn).toEqual([{ x: 38, y: 289, direction: 0, scale: 256 }, { x: 0, y: 0, direction: 0, scale: 244 }]);
    expect(ship.transporter.walkOff?.[1]).toEqual({ x: 326, y: 248, direction: 9, scale: 244 });
    expect(Object.keys(IGNORED)).not.toContain('executable._transporterWalkOn');
  });

  it('carries the leaders\' order, the voices, the targets and the speeds', () => {
    const { ctx, ship } = setup(() => ({
      _leaderOrder: [1, 0, 99], _crewVoices: [10, 20], _transporterTargets: [{ x: 1, y: 2 }], _warpSpeeds: [100], _impulseSpeeds: [5, 6],
    }));
    expect(ship.crew).toEqual({
      leaderOrder: [ctx.crew.get(1), ctx.crew.get(0)], voices: [10, 20],
      // (each crew member's voice, by their crew number: only the numbers the voices list has)
      voiceOf: { [ctx.crew.get(0)!]: 10, [ctx.crew.get(1)!]: 20 },
    });
    expect(ctx.problems.warnings).toHaveLength(1);
    expect(ship.transporter.targets).toEqual([{ x: 1, y: 2 }]);
    expect(ship.speeds).toEqual({ warp: [100], impulse: [5, 6] });
  });
});

/** The mini export plus the space world's screen 3 and the ship's screens 1 and 4, with their objects. */
function withSpace(edit: (files: Record<string, unknown>) => void = () => {}) {
  return rawFromMini(miniRaw(files => {
    const add = (o: J) => { files[`objects/o_${o.id as string}.json`] = o; };
    const screen = (world: number, n: number, objects: string[]) => {
      const key = `s_${world.toString(16)}${n.toString(16).padStart(2, '0')}`;
      files[`screens/${key}.json`] = { id: key, world, screen: n, objects, location: null, polygons: [] };
    };
    const active = 0x20;
    add(obj('100301', { name: 'Enter', flags: 0x22 }));
    add(obj('100302', { name: 'Exit', flags: 0x22 }));
    add(obj('100303', { name: 'Warp', flags: 0x22 }));
    add(obj('100304', { name: 'Klingon', flags: active }));
    add(obj('100305', {
      name: 'Romulan', flags: active,
      phaser_data: {
        max_health: 10, threshold: 2, damage_setting: 1, gtp_setting: -1, gtp_min_setting: 4, stun_entries: [], gtp_entries: [],
        kill_entries: [[alter({ target: '100304', alter_state: 2 })]],
      },
    }));
    add(obj('100306', { name: 'Enterprise-1', flags: active }));
    add(obj('100307', { name: 'Zap', flags: active }));
    screen(0x10, 3, ['100301', '100302', '100303', '100304', '100305', '100306', '100307']);
    add(obj('5f0102', { name: 'Beacon', curr_screen: 1, sprite_id: 12 }));
    add(obj('5f0103', { name: 'Buoy', curr_screen: 1 }));
    add(obj('5f0402', { name: 'Guest' }));
    add(obj('5f0401', { name: 'Starfleet' }));
    screen(0x5f, 1, ['5f0100', '5f0102', '5f0103']);
    screen(0x5f, 4, ['5f0402', '5f0401']);
    edit(files);
  }));
}

describe('the space world\'s battles (R2), in combat.yaml only since Plan 23', () => {
  it('lifts a scenario as a battle: its Enter, Exit and Warp objects, and its ships by kind; ship.yaml has none', () => {
    const result = liftGame(withSpace(), { worlds: [7] });
    expect(result.problems.errors).toEqual([]);
    const battle = result.lifted.combat!.battles[3]!;
    expect(battle).toMatchObject({ screen: 'space.s03', enter: 'space.enter', exit: 'space.exit', warp: 'space.warp' });
    // (the name's first ten letters must be a kind's name, as Combat::setup compares them; "Zap" is none. Kinds by
    // combat.h's numbers: klingon 3, romulan 1, enterprise 2)
    expect(battle.ships.map(s => [s.object, s.type])).toEqual([['space.klingon', 3], ['space.romulan', 1], ['space.enterprise_1', 2]]);
    expect(Object.keys(result.lifted.combat!.battles)).toEqual(['3']);
    expect('battles' in result.lifted.ship).toBe(false);
  });

  it('lifts the ships\' kill lists, and the screen as a stub with no room', () => {
    const result = liftGame(withSpace(), { worlds: [7] });
    const c = result.content!;
    expect(c.objects['space.romulan'].phaser?.on?.kill).toBeDefined();
    expect(c.screens['space.s03']).toBeDefined();
    expect(result.files.has('rooms/space/s03.json')).toBe(false);
    expect(result.problems.errors).toEqual([]);
  });

  it('has no Warp object when the screen has none', () => {
    const raw = withSpace(files => {
      (files['screens/s_1003.json'] as { objects: string[] }).objects = ['100301', '100302', '100304'];
    });
    expect(liftGame(raw, { worlds: [7] }).lifted.combat!.battles[3]).toMatchObject({ enter: 'space.enter', exit: 'space.exit', warp: null });
  });
});

describe('liftShip: the bridge\'s contacts', () => {
  it('lists Comms\' objects in screen order, saying which have a sprite, and the lounge\'s with Starfleet first', () => {
    const names = (files: Record<string, unknown>): void => {
      (files['maps/sprite.json'] as { _spriteFilenames: string[] })._spriteFilenames = [...Array.from({ length: 12 }, () => 'X'), 'VIEWADMR'];
    };
    const { ship } = liftGame(withSpace(names), { worlds: [7] }).lifted;
    // (a sprite's file is the one the viewscreen shows for it, lower case without the extension)
    expect(ship.contacts.comms).toEqual([
      { object: 'ship.enterprise', sprite: false }, { object: 'ship.beacon', sprite: true, file: 'viewadmr' }, { object: 'ship.buoy', sprite: false },
    ]);
    expect(ship.contacts.lounge).toEqual(['ship.starfleet', 'ship.guest']);
  });

  it('names the default battle', () => {
    expect(liftGame(withSpace(), { worlds: [7] }).lifted.ship.astro.defaultBattle).toBe(8);
  });
});

describe('liftShip: the Enterprise\'s own views', () => {
  it('names the sprite of every animation an alter plays on the Enterprise (unity.cpp:604-610), and no other object\'s', () => {
    const views = (files: Record<string, unknown>): void => {
      const names = Array.from({ length: 13 }, () => 'X');
      [names[3], names[5], names[7]] = ['VWSTTRAC', 'VWSTUNIT', 'OTHER'];
      (files['maps/sprite.json'] as { _spriteFilenames: string[] })._spriteFilenames = names;
      const buoy = files['objects/o_5f0103.json'] as { use_entries: unknown[] };
      buoy.use_entries = [
        [alter({ target: '5f0100', alter_anim: 3 })],
        // (30000 + n plays n and waits; 31000 + n is a new sprite and 29999 a stop, neither of them a view)
        [alter({ target: '5f0100', alter_anim: 30005 }), alter({ target: '5f0100', alter_anim: 31007 }), alter({ target: '5f0100', alter_anim: 29999 })],
        [alter({ target: '5f0102', alter_anim: 7 })],
        // (an id sprite.lst has no name for is left out, with a warning)
        [alter({ target: '5f0100', alter_anim: 40 })],
      ];
    };
    const result = liftGame(withSpace(views), { worlds: [7] });
    expect(result.lifted.ship.viewscreenSprites).toEqual({ 3: 'vwsttrac', 5: 'vwstunit' });
    expect(result.problems.warnings.filter(w => w.includes('sprite 40'))).toHaveLength(1);
    expect(result.problems.errors).toEqual([]);
  });
});
