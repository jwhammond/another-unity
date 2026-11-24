// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment happy-dom
import { existsSync, readFileSync } from 'node:fs';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import type { CombatCommand, ConsolePage } from '../../sim/combat/commands';
import { SIM_SEAMS } from '../../sim/combat/seams';
import { miniBattle, miniBattleContext, miniEnterpriseUnits } from '../../testing/combat';
import { BUTTON } from '../../view/combat/console';
import type { BattleView } from '../../web/battlePort';
import { Drawer } from './drawer';

let root: HTMLElement;
afterEach(() => {
  render(null, root);
  root.remove();
});
/** The drawer over miniCombat's battle 3 (its weapons set up) on `page`, recording what it asks of the console. */
function show(page: ConsolePage, open = true) {
  const { ctx, b } = miniBattle({ ctx: miniBattleContext({ ...SIM_SEAMS }) });
  const view: BattleView = { b, combat: ctx.combat, enterpriseUnits: miniEnterpriseUnits(), paused: false, redFlash: false, resolved: null, resolving: false, page, warp: false, queued: [], overlay: null };
  const asked: (string | CombatCommand)[] = [];
  let toggled = 0;
  root = document.body.appendChild(document.createElement('div'));
  act(() => {
    render(<Drawer view={view} open={open} onToggle={() => toggled++} scanner={{ current: null }}
      act={{ page: p => asked.push(`page ${p}`), press: n => asked.push(`press ${n}`), drag: cmd => asked.push(cmd), send: (cmd, beep) => asked.push(beep ? { ...cmd, beep } as unknown as CombatCommand : cmd) }} />, root);
  });
  return { view, b, asked, toggled: () => toggled };
}
const button = (name: string) => [...root.querySelectorAll('button')].find(b => b.textContent === name || b.getAttribute('aria-label') === name)!;

describe('the console as a drawer over the wide view (M8 spec §5.2, Decision 16; Plan 27 R10)', () => {
  it('shows a switch as the orders waiting leave it (Plan 29 R3)', () => {
    const { view } = show('conn');
    view.queued = [{ type: 'shields', on: true }, { type: 'delegate', on: true }, { type: 'delegate', on: false }];
    act(() => {
      render(<Drawer view={{ ...view }} open onToggle={() => {}} scanner={{ current: null }} act={{ page: () => {}, press: () => {}, drag: () => {}, send: () => {} }} />, root);
    });
    expect(['Shields', 'Delegate', 'Weapons lock'].map(n => button(n).getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false']);
  });

  it('is a handle closed, and opens to the six pages\' tabs, the page, and Bridge and Engineering', async () => {
    const closed = show('conn', false);
    expect([root.querySelectorAll('button').length, button('Console').getAttribute('aria-expanded')]).toEqual([1, 'false']);
    await act(async () => { button('Console').click(); });
    expect(closed.toggled()).toBe(1);
    render(null, root);
    root.remove();
    const { asked } = show('conn');
    expect([...root.querySelectorAll('[role="tab"]')].map(t => t.textContent)).toEqual(['Phaser banks', 'Torpedoes', 'Own damage', 'Helm', 'Maneuvers', 'Target sensors']);
    await act(async () => { button('Maneuvers').click(); button('Bridge').click(); button('Engineering').click(); });
    expect(asked).toEqual(['page tactics', `press ${BUTTON.bridge}`, `press ${BUTTON.engineering}`]);
  });

  it('gives CONN\'s toggles as the console\'s buttons and its power levels as orders', async () => {
    const { asked, b } = show('conn');
    b.console.shieldsRaised = true;
    await act(async () => { button('Shields').click(); button('Delegate').click(); button('Power 3').click(); });
    expect(asked).toEqual([`press ${BUTTON.shields}`, `press ${BUTTON.delegate}`, { type: 'powerLevel', level: 3 }]);
  });

  it('sets the banks by sliders and All and None, the salvos and the spread, and the maneuvers with their beeps', async () => {
    const phasers = show('phasers');
    const bank = root.querySelector<HTMLInputElement>('[aria-label="Phaser bank 2"]')!;
    bank.value = '35';
    await act(async () => { bank.dispatchEvent(new Event('input', { bubbles: true })); button('All banks').click(); });
    expect(phasers.asked).toEqual([{ type: 'bank', bank: 1, setting: 35 }, `press ${BUTTON.allPhasers}`]);
    render(null, root);
    root.remove();
    const torpedoes = show('torpedoes');
    await act(async () => { button('20°').click(); });
    expect(torpedoes.asked).toEqual([`press ${BUTTON.spread + 4}`]);
    render(null, root);
    root.remove();
    const tactics = show('tactics');
    await act(async () => { button('Maneuvers down').click(); button('Engage').click(); });
    expect(tactics.asked).toEqual([{ type: 'scrollManeuvers', direction: 1, beep: true }, { type: 'engage', beep: true }]);
  });

  it('shows the console\'s scanner on the scanner pages', () => {
    show('sensors');
    expect(root.querySelector('canvas.au-drawer-scanner')).not.toBeNull();
  });

  it('sizes its body from the game frame, the console\'s container, not the browser\'s window (Plan 29 R12)', () => {
    const css = readFileSync([`${process.cwd()}/engine/src/ui/ship/ship.css`, `${process.cwd()}/src/ui/ship/ship.css`].find(existsSync)!, 'utf8');
    const rule = /\.au-drawer-body \{([^}]*)\}/.exec(css)![1]!;
    expect([rule.includes('width: min(92cqw, 600px)'), rule.includes('max-height: max(120px, calc(100cqh - 140px))'), /\dv[wh]\b/.test(rule)]).toEqual([true, true, false]);
    // (in Wide, from the left to 8 px short of the fire buttons, which start at most 50% + 56 px in)
    expect(/\.au-combat-hud > \.au-drawer \{[^}]*left: 8px;[^}]*width: calc\(50% \+ 40px\)/.test(css)).toBe(true);
    expect(/\.au-combat-hud-fire \{[^}]*right: 8px;[^}]*max-width: calc\(50% - 64px\)/.test(css)).toBe(true);
    // (and the short Split's drawer layer is the container, sized as the screen it sits on, not the panel)
    expect(/\.au-console-phone \{[^}]*container-type: size/.test(css)).toBe(true);
  });
});
