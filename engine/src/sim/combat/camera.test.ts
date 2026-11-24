// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { battleOutcome, miniBattle, miniBattleContext, miniTacticsCombat } from '../../testing/combat';
import { toInternal } from './aim';
import { step, updateBattle, VIEW } from './battle';
import { CAMERA_SEAMS, CHASE_ELEVATION, lookAt, updateCamera } from './camera';
import { applyCommand } from './commands';
import { sub } from './math';
import { SIM_SEAMS } from './seams';
import { STEP_TIME } from './time';
import type { BattleContext, BattleState, CameraPose, CombatSeams } from './types';

/** sin and cos of kChaseElevation (0x170 of 16384 to a turn, 8.09 degrees), as float32: 0.14065824, 0.99005818. */
const S = 0.14065824449062347, C = 0.990058183670044;

/** The battle with the Enterprise at the origin facing forward (radius 200: miniCombat's size [100, 50, 200]), viewing `view`. */
function at(view: number, o: { viewFrame?: number; ship?: number } = {}): { ctx: BattleContext; b: BattleState; cam: CameraPose } {
  const { ctx, b } = miniBattle({ ctx: miniBattleContext({ ...CAMERA_SEAMS }) });
  for (const s of b.ships) s.angles = [0, 0, 0];
  b.ships[0]!.pos = { x: 0, y: 0, z: 0 };
  b.view.view = view;
  b.view.viewShip = o.ship ?? 0;
  b.view.viewFrame = o.viewFrame ?? 1;
  return { ctx, b, cam: b.view.camera };
}
/** A pose's numbers, to 3 places. */
const near = (cam: CameraPose, pos: [number, number, number], axes: number[]) => {
  [cam.pos.x, cam.pos.y, cam.pos.z].forEach((v, i) => expect(v).toBeCloseTo(pos[i]!, 3));
  cam.axes.forEach((v, i) => expect(v).toBeCloseTo(axes[i]!, 5));
};

describe('updateCamera (Combat::updateCamera, combat.cpp:848-948)', () => {
  it('chases from 8.1 degrees above and zoom x radius behind (chaseView, combat.cpp:789-793)', () => {
    const { ctx, b, cam } = at(VIEW.chase);
    updateCamera(ctx, b);
    // (fromAngles(0, -0x170, 0) applied to (0, 0, -600): up is -y inside, so y = -600 sin, z = -600 cos)
    near(cam, [0, -600 * S, -600 * C], [1, 0, 0, 0, C, -S, 0, S, C]);
    expect(CHASE_ELEVATION).toBe(0x170);
  });

  it('turns with the ship, and keeps the step before as stepCamera', () => {
    const { ctx, b, cam } = at(VIEW.chase);
    updateCamera(ctx, b);
    const before = structuredClone(cam);
    // (a quarter turn to starboard: forward is +x inside, so the camera is 600 cos off to port, -x)
    b.ships[0]!.angles = [0x1000, 0, 0];
    updateCamera(ctx, b);
    near(b.view.camera, [-600 * C, -600 * S, 0], [0, 0, -1, -S, C, 0, C, S, 0]);
    expect(b.view.stepCamera).toEqual(before);
  });

  it('looks down from above in the top view, the ship\'s nose to the right (axisView, lookAlong: combat.cpp:795-799, 810-814)', () => {
    const { ctx, b, cam } = at(VIEW.top);
    updateCamera(ctx, b);
    // (forward (0, 1, 0), down (1, 0, 0), right = down x forward = (0, 0, 1))
    near(cam, [0, -600, 0], [0, 0, 1, 1, 0, 0, 0, 1, 0]);
  });

  it('rolls a quarter for the side view, and flips right for the other side', () => {
    const side = at(VIEW.side);
    updateCamera(side.ctx, side.b);
    // (fromAngles(0, 0, 0x1000)'s rows (0, 1, 0), (-1, 0, 0), (0, 0, 1): the camera 600 to starboard, +x, looking to port
    // with the ship's down as its down, so the nose (+z) is to the right)
    near(side.cam, [600, 0, 0], [0, 0, 1, 0, 1, 0, -1, 0, 0]);
    const other = at(VIEW.otherSide);
    updateCamera(other.ctx, other.b);
    // (0x3000: from port, looking to starboard, the nose to the left)
    near(other.cam, [-600, 0, 0], [0, 0, -1, 0, 1, 0, 1, 0, 0]);
  });

  it('looks from the nose in the forward view and from the trail\'s oldest pose in the close chase', () => {
    const fwd = at(VIEW.forward);
    updateCamera(fwd.ctx, fwd.b);
    // (chaseView at -2r: 400 ahead, 400 sin below)
    near(fwd.cam, [0, 400 * S, 400 * C], [1, 0, 0, 0, C, -S, 0, S, C]);
    const close = at(VIEW.chaseClose);
    close.b.ships[0]!.trail[30] = { pos: { x: 0, y: -1000, z: 0 }, angles: [0, 0, 0] };
    updateCamera(close.ctx, close.b);
    // (the pose at y -1000, battle's forward: z -1000 inside; 2r = 400 behind it)
    near(close.cam, [0, -400 * S, -1000 - 400 * C], [1, 0, 0, 0, C, -S, 0, S, C]);
  });

  it('looks over the ship\'s shoulder at its target, and freezes when the target is gone (combat.cpp:914-926)', () => {
    const { ctx, b, cam } = at(VIEW.target);
    const e = b.ships[0]!;
    e.target = 1;
    // (the target dead ahead: yaw 0, pitch 0; as the chase view)
    b.ships[1]!.pos = { x: 0, y: 5000, z: 0 };
    updateCamera(ctx, b);
    near(cam, [0, -600 * S, -600 * C], [1, 0, 0, 0, C, -S, 0, S, C]);
    const was = structuredClone(cam);
    b.ships[1]!.destroyed = true;
    e.angles = [0x1000, 0, 0];
    updateCamera(ctx, b);
    expect(b.view.camera).toEqual(was);
  });

  it('orbits by the orbit angle, and spins by 0x100 a frame (combat.cpp:908-913, 927-929)', () => {
    const orbit = at(VIEW.orbit);
    orbit.b.view.orbitAngle = 0x1000;
    updateCamera(orbit.ctx, orbit.b);
    near(orbit.cam, [-600 * C, -600 * S, 0], [0, 0, -1, -S, C, 0, C, S, 0]);
    const spin = at(VIEW.spinYaw, { viewFrame: 63 + 0x10 });
    updateCamera(spin.ctx, spin.b);
    near(spin.cam, [-600 * C, -600 * S, 0], [0, 0, -1, -S, C, 0, C, S, 0]);
  });

  it('flies in from above the battle, an eighth of the way a frame, and cuts to tracking once no nearer (combat.cpp:888-906)', () => {
    const { ctx, b, cam } = at(VIEW.flyIn, { viewFrame: 0 });
    // (two ships: the Enterprise at the origin, the chodak at x 4000: above them by 3 x 2000, at the middle; z up is -y inside)
    b.ships[1]!.pos = { x: 4000, y: 0, z: 0 };
    updateCamera(ctx, b);
    // (from (2000, -6000, 0) towards the origin, 6324.6 away: an eighth of the way in)
    const d = Math.hypot(2000, 6000);
    expect(b.view.viewDistance).toBeCloseTo(d, 2);
    [cam.pos.x, cam.pos.y, cam.pos.z].forEach((v, i) => expect(v).toBeCloseTo([2000 - 2000 / 8, -6000 + 6000 / 8, 0][i]!, 2));
    // (looking along the way in: its forward row is (-2000, 6000, 0) / d)
    expect([cam.axes[6], cam.axes[7], cam.axes[8]].map(n => Math.round(n! * 1e4) / 1e4)).toEqual([-0.3162, 0.9487, 0]);
    // (the ship moves away: no nearer than last time, so the view cuts to tracking, the camera left where it was)
    b.view.viewFrame = 1;
    b.ships[0]!.pos = { x: -9000, y: 0, z: 0 };
    const was = structuredClone(cam);
    updateCamera(ctx, b);
    expect([b.view.view, b.view.viewShip, b.view.viewFrame, b.view.camera]).toEqual([VIEW.tracking, 0, 0, was]);
  });

  it('places the drop camera once at 2r, then tracks the ship from there (combat.cpp:933-939)', () => {
    const { ctx, b, cam } = at(VIEW.drop);
    b.view.viewExpiry = b.now + 5000;
    // (the step: updateView turns the drop into tracking, keeping the expiry, and the seam places the chase at 2r once)
    step(ctx, b);
    expect([b.view.view, b.view.viewExpiry, b.view.dropped]).toEqual([VIEW.tracking, b.now + 5000, false]);
    const ship = b.ships[0]!;
    const [x, y, z] = [cam.pos.x - ship.pos.x, cam.pos.y + ship.pos.z, cam.pos.z - ship.pos.y];
    expect([x, y, z].map(n => Math.round(n * 1000) / 1000)).toEqual([0, Math.round(-400 * S * 1000) / 1000, Math.round(-400 * C * 1000) / 1000]);
    // (then tracking: the ship moves away, and the camera stays where it was placed and turns to the ship)
    const pos = { ...cam.pos };
    ship.pos = { x: ship.pos.x + 1000, y: ship.pos.y + 3000, z: ship.pos.z - 500 };
    step(ctx, b);
    const expected = { pos: { ...pos }, axes: [...cam.axes] };
    lookAt(expected, sub(toInternal(ship.pos), pos));
    expect(b.view.camera).toEqual(expected);
  });

  it('keeps the camera where it is for the frozen views (0xb, 0xd, 0xf)', () => {
    for (const view of [VIEW.frozen, 0xd, 0xf]) {
      const { ctx, b, cam } = at(view);
      const was = structuredClone(cam);
      b.ships[0]!.angles = [0x1000, 0x200, 0];
      updateCamera(ctx, b);
      expect(b.view.camera).toEqual(was);
    }
  });
});

describe('the camera seam in whole battles', () => {
  /**
   * miniTacticsCombat's battle under Delegate against two chodaks (aiBattle.test.ts's), with `seams`, and every roll it
   * made, and every view the camera seam placed (the drop as VIEW.drop: updateView has turned it into tracking by then).
   */
  function fight(seams: Partial<CombatSeams>): { b: BattleState; rolls: string[]; views: Set<number> } {
    const views = new Set<number>();
    const placed = seams.updateCamera;
    if (placed) seams = { ...seams, updateCamera: (ctx, b) => { views.add(b.view.dropped ? VIEW.drop : b.view.view); placed(ctx, b); } };
    const combat = miniTacticsCombat();
    const ships = combat.battles[3]!.ships;
    ships[1] = { ...ships[1]!, position: [2000, 9000, 0] };
    ships[2] = { ...ships[1]!, object: 'space.zap2', position: [-3000, 12000, 500] };
    const rolls: string[] = [];
    const ctx: BattleContext = { ...miniBattleContext(seams, combat), onDraw: (site, n, value) => { rolls.push(`${site} ${n} ${value}`); } };
    const { b } = miniBattle({ ctx, difficulty: 0 });
    for (let i = 0; i < 3000 && battleOutcome(b) === 'fighting'; i++) {
      if (i === 1) applyCommand(ctx, b, { type: 'delegate', on: true });
      // (and every view in turn, each for 20 steps: the seam's every case, all 19 before the battle ends)
      if (i % 20 === 0) applyCommand(ctx, b, { type: 'view', view: (i / 20) % VIEW.count, ship: 'enterprise' });
      updateBattle(ctx, b, b.lastStep + STEP_TIME);
      b.cues.length = 0;
      b.sounds.length = 0;
    }
    return { b, rolls, views };
  }

  it('never draws a random number: the same battle with and without it rolls the same and ends the same', () => {
    const { updateCamera: _, ...without } = SIM_SEAMS;
    const a = fight({ ...SIM_SEAMS });
    const c = fight({ ...without });
    expect([...a.views].sort((x, y) => x - y)).toEqual(Array.from({ length: VIEW.count }, (_, i) => i));
    expect(a.rolls.length).toBeGreaterThan(100);
    expect(a.rolls).toEqual(c.rolls);
    expect([a.b.steps, a.b.random, a.b.ships]).toEqual([c.b.steps, c.b.random, c.b.ships]);
    expect(a.b.view.camera).not.toEqual(c.b.view.camera);
  });
});
