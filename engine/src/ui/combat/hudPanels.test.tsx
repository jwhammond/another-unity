// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment happy-dom
import { render } from 'preact';
import { describe, expect, it } from 'vitest';
import type { HudModel } from '../../view/combat/hud';
import { miniBattle, miniEnterpriseUnits } from '../../testing/combat';
import type { BattleView } from '../../web/battlePort';
import { Drawer } from './drawer';
import { Hud } from './hud';
import { hudPanelRects } from './hudPanels';

const MODEL: HudModel = { hull: 100, shields: [], speed: '0.00', pace: 1, target: null, sensorsBlank: false, log: [], lamps: [], selfDestruct: null };

/** Lays an element out at a rectangle (happy-dom has no layout). */
function at(e: Element, left: number, top: number, right: number, bottom: number): void {
  (e as HTMLElement).getBoundingClientRect = () => ({ left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON: () => ({}) });
}

describe('hudPanelRects (Plan 32 Task 9 review)', () => {
  it('reads the HUD\'s four panels over the view (the strip, the target, the log, the fire buttons), and the band under the HUD', () => {
    const frame = document.createElement('div');
    render(<Hud model={MODEL} press={() => {}} />, frame);
    const root = frame.querySelector('.au-combat-hud')!;
    at(frame, 0, 0, 1280, 720);
    at(root, 0, 0, 1280, 664);
    const panels = ['.au-combat-hud-top', '.au-combat-hud-target', '.au-combat-hud-log', '.au-combat-hud-fire'].map(c => frame.querySelector(c)!);
    panels.forEach((p, i) => at(p, i * 10, 0, i * 10 + 5, 5));
    expect(hudPanelRects(frame).map(r => [r.left, r.top, r.right, r.bottom])).toEqual([[0, 0, 5, 5], [10, 0, 15, 5], [20, 0, 25, 5], [30, 0, 35, 5], [0, 664, 1280, 720]]);
    expect(hudPanelRects(document.createElement('div'))).toEqual([]);
  });

  it('reads the console drawer\'s handle too, and its body when open (Task 9 review)', () => {
    const { ctx, b } = miniBattle();
    const view: BattleView = { b, combat: ctx.combat, enterpriseUnits: miniEnterpriseUnits(), paused: false, redFlash: false, resolved: null, resolving: false, page: 'conn', warp: false, queued: [], overlay: null };
    const act = { page: () => {}, press: () => {}, drag: () => {}, send: () => {} };
    const frame = document.createElement('div');
    const drawer = (open: boolean) => <Drawer view={view} open={open} onToggle={() => {}} scanner={{ current: null }} act={act} />;
    render(<Hud model={MODEL} press={() => {}} drawer={drawer(false)} />, frame);
    at(frame.querySelector('.au-drawer-handle')!, 600, 600, 700, 640);
    expect(hudPanelRects(frame).map(r => [r.left, r.top, r.right, r.bottom])).toContainEqual([600, 600, 700, 640]);
    render(<Hud model={MODEL} press={() => {}} drawer={drawer(true)} />, frame);
    at(frame.querySelector('.au-drawer-body')!, 400, 300, 900, 600);
    expect(hudPanelRects(frame).map(r => [r.left, r.top, r.right, r.bottom])).toContainEqual([400, 300, 900, 600]);
  });
});
