// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { battleContent, miniTacticsCombat, type World } from '@another-unity/engine';
import { afterAll, describe, expect, it } from 'vitest';
import { flyBattle, scriptedEnd } from './fly';

describe('flyBattle (Plan 31 R6)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fly-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const onWorld = (w: World) => { w.hooks.register('rec', () => 0); };

  it('plays to the battle, flies the inputs, and reports the end', async () => {
    const walk = join(dir, 'to-battle.walk');
    // (the walk would go on with the battle; fly stops before its first line once the battle is on)
    writeFileSync(walk, 'seed 1\nstart ship\nstation tactical\ncombat wait\ncombat dance\nend\n');
    const combat = miniTacticsCombat();
    combat.battles[3]!.ships[1] = { ...combat.battles[3]!.ships[1]!, position: [2000, 9000, 0], strength: 10 };
    const opts = { content: battleContent({ combat }), ids: { objects: {}, screens: {} }, gameDir: dir, onWorld };
    // (the fixture's battle 3, Lieutenant: Delegate loses it at step 2888; flown with the shields up and one volley, sooner)
    const r = await flyBattle(walk, 8, 'at 0 set shields on\nat 10 fire both\n', opts);
    expect(r).toMatchObject({ outcome: 'lost', step: 2116, enemies: '0 of 1', note: null });
    expect(r.hull).toBeGreaterThanOrEqual(0);
    expect(r.destroyed).toContain('shield 0');
    // (an order past the battle's end is reported, not given)
    expect((await flyBattle(walk, 8, 'at 0 set shields on\nat 10 fire both\nat 5000 stop\n', opts)).note).toBe('the battle ended before step 5000');
    // (a walk that never reaches the battle fails as the walk does)
    await expect(flyBattle(walk, 9, '', opts)).rejects.toThrow('the walk: line 5 (combat dance)');
    await expect(flyBattle(walk, 8, 'at 1 jump\n', opts)).rejects.toThrow('the inputs: line 1: not a combat input: "jump"');
  }, 60_000);

  it('counts the ships a battle\'s scripts wait on (a kill list) as its end, as battle 52\'s stand-down has it', () => {
    const world = { content: { objects: { a: { phaser: { on: { kill: [{ do: [] }] } } }, b: {} } } } as unknown as World;
    const ship = (object: string, destroyed: boolean) => ({ object, destroyed }) as never;
    const battle = (...ships: never[]) => ({ ships: [ship('e', false), ...ships] }) as never;
    expect(scriptedEnd(world, battle(ship('a', true), ship('b', false)))).toBe(true);
    expect(scriptedEnd(world, battle(ship('a', false), ship('b', true)))).toBe(false);
    // (a battle with no kill list ends only with every enemy destroyed)
    expect(scriptedEnd(world, battle(ship('b', true)))).toBe(false);
  });
});
