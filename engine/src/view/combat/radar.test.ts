// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { applyCommand } from '../../sim/combat/commands';
import { v3 } from '../../sim/combat/math';
import { miniBattle } from '../../testing/combat';
import { IndexedScreen } from '../indexed';
import { blipAt, BLINK_TIME, drawRadar, newRadarMemory, RADAR_COLOUR } from './radar';

const px = (s: IndexedScreen, x: number, y: number) => s.pixels[y * 640 + x];
/** miniCombat's battle 3, the Enterprise at the origin and the chodak `d` from it (world units), and a blank screen. */
function radar(d = v3(10 * 208.34, 0, 0)) {
  const { ctx, b } = miniBattle();
  b.ships[0]!.pos = v3();
  b.ships[1]!.pos = d;
  return { ctx, b, s: new IndexedScreen(), memory: newRadarMemory() };
}

describe('drawRadar (tactical.cpp:1059-1159)', () => {
  it('draws the box, the grid and the floor\'s lines, and nothing at all without a living Enterprise (tactical.cpp:1062-1063, 1085-1109)', () => {
    const { ctx, b, s, memory } = radar();
    drawRadar(s, b, ctx.combat, memory, 0);
    expect([px(s, 81, 28), px(s, 273, 220), px(s, 82, 30), px(s, 80, 221), px(s, 5, 74)]).toEqual([RADAR_COLOUR.grid, RADAR_COLOUR.grid, RADAR_COLOUR.background, RADAR_COLOUR.grid, RADAR_COLOUR.grid]);
    const gone = radar();
    gone.b.ships[0]!.destroyed = true;
    expect(drawRadar(gone.s, gone.b, gone.ctx.combat, gone.memory, 0)).toEqual([]);
    expect(gone.s.pixels.every(v => v === 0)).toBe(true);
  });

  it('scrolls the grid as the Enterprise moves, by the grid\'s step, and keeps where it has got to (tactical.cpp:1072-1084)', () => {
    const { ctx, b, s, memory } = radar();
    drawRadar(s, b, ctx.combat, memory, 0);
    expect(memory.scroll).toEqual([0, 0, 0]);
    // (64 units right at zoom 0, a grid of 8: 8 x 64 / 512 = 1 back, so 7 on; 96 down in z: 1.5 back, 6.5 on)
    b.ships[0]!.pos = v3(64, 0, 96);
    drawRadar(s, b, ctx.combat, memory, 0);
    expect([memory.scroll, memory.centre]).toEqual([[7, 6.5, 0], { x: 64, y: 0, z: 96 }]);
    // (a jump of the range or more, as the starbase's, moves the grid not at all)
    b.ships[0]!.pos = v3(64 + 40000, 0, 96);
    drawRadar(s, b, ctx.combat, memory, 0);
    expect(memory.scroll).toEqual([7, 6.5, 0]);
  });

  it('draws a ship on its stem in its kind\'s colour, the target filled and blinking every 247 ms by the wall clock (tactical.cpp:1115-1148)', () => {
    const { ctx, b, s, memory } = radar();
    applyCommand(ctx, b, { type: 'target', ship: null });
    // (ten sx right: x 141 + 10; its top 242 - round(20000 / 208.34) = 146; size 2 at zoom 0)
    const blips = drawRadar(s, b, ctx.combat, memory, 0);
    expect(blips).toEqual([{ ship: 0, x: 141, y: 146 }, { ship: 1, x: 151, y: 146 }]);
    const colour = ctx.combat.kinds[0]!.radarColour;
    expect([px(s, 149, 144), px(s, 151, 146), px(s, 151, 148), px(s, 151, 242)]).toEqual([colour, RADAR_COLOUR.background, colour, colour]);
    applyCommand(ctx, b, { type: 'target', ship: 1 });
    drawRadar(s, b, ctx.combat, memory, 0);
    expect(px(s, 151, 146)).toBe(RADAR_COLOUR.blink);
    drawRadar(s, b, ctx.combat, memory, BLINK_TIME);
    expect(px(s, 151, 146)).toBe(colour);
  });

  it('shows no ship when the step\'s sensors said no, nor one cloaked or beyond the range, and torpedoes as points (Plan 27 R5)', () => {
    const { ctx, b, s, memory } = radar();
    applyCommand(ctx, b, { type: 'target', ship: null });
    b.console.radarSeen = false;
    expect(drawRadar(s, b, ctx.combat, memory, 0)).toEqual([]);
    b.console.radarSeen = true;
    b.ships[1]!.decloakTime = b.now + 1000;
    expect(drawRadar(s, b, ctx.combat, memory, 0).map(x => x.ship)).toEqual([0]);
    b.ships[1]!.decloakTime = 0;
    b.ships[1]!.pos = v3(0, 0, 20001);
    expect(drawRadar(s, b, ctx.combat, memory, 0).map(x => x.ship)).toEqual([0]);
    b.torpedoes[0] = { ...b.torpedoes[0]!, active: true, pos: v3(10 * 208.34, 0, 0) };
    drawRadar(s, b, ctx.combat, memory, 0);
    expect(px(s, 151, 146)).toBe(RADAR_COLOUR.torpedo);
  });

  it('halves the range with each zoom in: a ship at half the range is at the box\'s edge (tactical.cpp:1064-1070)', () => {
    const { ctx, b, s, memory } = radar(v3(5 * 208.34, 0, 0));
    applyCommand(ctx, b, { type: 'zoom', direction: 'in' });
    expect(drawRadar(s, b, ctx.combat, memory, 0).find(x => x.ship === 1)).toEqual({ ship: 1, x: 151, y: 146 });
  });

  it('takes a click within 8 pixels either way of another ship\'s blip as that ship, never the Enterprise\'s (tactical.cpp:693-699)', () => {
    const blips = [{ ship: 0, x: 141, y: 146 }, { ship: 2, x: 151, y: 146 }, { ship: 1, x: 152, y: 146 }];
    expect([blipAt(blips, 141, 146), blipAt(blips, 158, 153), blipAt(blips, 159, 146), blipAt(blips, 144, 146)]).toEqual([null, 2, 1, 2]);
  });
});
