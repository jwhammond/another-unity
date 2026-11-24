// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment happy-dom
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import type { CombatAssists } from '../sim/combat/assists';
import { GAME_OVER_EXIT } from '../sim/combat/types';
import type { BattleResult } from '../sim/tacticalScreen';
import { miniBattle, miniCombat, miniEnterpriseUnits } from '../testing/combat';
import { newRadarMemory } from '../view/combat/files';
import type { BattlePort, BattleView } from '../web/battlePort';
import { AUTO_RESOLVE_NOTE, AssistsPanel, DIFFICULTY_NOTE, STORY_NOTE } from './assists';

/** A made-up port over miniCombat's battle 3 (`battle: false`, none at tactical), recording what the panel asks. */
function fakePort(o: { battle?: boolean; over?: Partial<BattleView> } = {}) {
  const { b } = miniBattle();
  const calls: string[] = [];
  let assists: CombatAssists = { difficulty: 'game', speed: 1 };
  const view: BattleView = { b, combat: miniCombat(), enterpriseUnits: miniEnterpriseUnits(), paused: false, redFlash: false, resolved: null, resolving: false, page: 'conn', warp: false, queued: [], overlay: null, ...o.over };
  const port: BattlePort = {
    battle: () => (o.battle === false ? null : view),
    command: () => {}, pause: on => { calls.push(`pause ${on}`); }, autoResolve: async () => { calls.push('autoResolve'); }, finish: async () => { calls.push('finish'); },
    assists: () => assists, setAssists: a => { assists = a; calls.push(`assists ${a.difficulty} ${a.speed}`); },
    page: () => {}, consoleArt: () => null, flash: () => 0, viewBox: () => {}, hudBoxes: () => {}, logShown: () => {}, beep: () => {}, radar: newRadarMemory, chunk: () => null, pick: () => null,
  };
  return { port, view, calls };
}
let root: HTMLElement;
function show(port: BattlePort, onClose?: () => void) {
  root = document.body.appendChild(document.createElement('div'));
  act(() => render(<AssistsPanel port={port} onClose={onClose} />, root));
}
const button = (name: string) => [...root.querySelectorAll('button')].find(b => b.textContent === name);
afterEach(() => {
  render(null, root);
  root.remove();
});

describe('the assists panel (M8 spec §6.2; Plan 29)', () => {
  it('sets the combat difficulty, Story\'s note describing it, and the speed, in the settings with no battle: no pause or auto-resolve there', () => {
    const { port, calls } = fakePort({ battle: false });
    show(port);
    const select = root.querySelector<HTMLSelectElement>('select[aria-label="Combat difficulty"]')!;
    act(() => { select.value = 'story'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    act(() => button('8×')!.click());
    expect(calls).toEqual(['assists story 1', 'assists story 8']);
    expect(document.getElementById(select.getAttribute('aria-describedby')!)?.textContent).toBe(`${STORY_NOTE} ${DIFFICULTY_NOTE}`);
    expect([...select.options].map(op => op.textContent)).toEqual(['As the game', 'Ensign', 'Lieutenant', 'Captain', 'Story']);
    expect([button('Pause'), button('Auto-resolve'), root.querySelector('[data-keys="page"]') !== null]).toEqual([undefined, undefined, true]);
  });

  it('pauses a battle at tactical, and auto-resolves it only once confirmed (Plan 29 R10)', async () => {
    const { port, calls } = fakePort();
    show(port);
    await act(async () => { button('Pause')!.click(); await new Promise(r => setTimeout(r, 0)); });
    await act(async () => { button('Auto-resolve')!.click(); });
    expect([calls, root.querySelector('[aria-label="Auto-resolve this battle?"] p')?.textContent, button('Auto-resolve')!.disabled]).toEqual([['pause true'], AUTO_RESOLVE_NOTE, true]);
    await act(async () => { button('Cancel')!.click(); });
    expect(root.querySelector('[aria-label="Auto-resolve this battle?"]')).toBeNull();
    await act(async () => { button('Auto-resolve')!.click(); });
    await act(async () => { button('Resolve it')!.click(); await new Promise(r => setTimeout(r, 0)); });
    expect(calls).toEqual(['pause true', 'autoResolve']);
    // (not under the warp overlay)
    render(null, root);
    root.remove();
    show(fakePort({ over: { warp: true } }).port);
    expect(button('Auto-resolve')!.disabled).toBe(true);
  });

  it('says it is resolving, then shows the result and the Enterprise\'s log until Continue, with no Close meanwhile', async () => {
    const resolving = fakePort({ over: { resolving: true } });
    show(resolving.port, () => {});
    expect([root.querySelector('[role="status"]')?.textContent, button('Pause')!.disabled, button('Close')]).toEqual(['Resolving the battle…', true, undefined]);
    render(null, root);
    root.remove();
    const resolved: BattleResult = { outcome: 'left', leave: GAME_OVER_EXIT, steps: 2889, log: ['-Line 1-', '-Line 2-'] };
    const done = fakePort({ over: { resolved } });
    show(done.port, () => {});
    expect(root.querySelector('[aria-label="Result"] p')?.textContent).toBe('The Enterprise was lost after 2889 steps.');
    expect([...root.querySelectorAll('[aria-label="Enterprise log"] li')].map(li => li.textContent)).toEqual(['-Line 1-', '-Line 2-']);
    await act(async () => { button('Continue')!.click(); await new Promise(r => setTimeout(r, 0)); });
    expect([done.calls, button('Close')]).toEqual([['finish'], undefined]);
  });

  it('keeps focus in the panel through the question and the result, and Escape withdraws the question without closing it', async () => {
    let closed = 0;
    const { port, view, calls } = fakePort();
    show(port, () => closed++);
    const active = () => (document.activeElement as HTMLElement | null)?.textContent;
    const escape = () => act(() => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await act(async () => { button('Auto-resolve')!.click(); });
    expect(active()).toBe('Resolve it');
    escape();
    expect([closed, root.querySelector('[aria-label="Auto-resolve this battle?"]'), active()]).toEqual([0, null, 'Auto-resolve']);
    await act(async () => { button('Auto-resolve')!.click(); });
    await act(async () => { button('Cancel')!.click(); });
    expect(active()).toBe('Auto-resolve');
    await act(async () => { button('Auto-resolve')!.click(); });
    await act(async () => { button('Resolve it')!.click(); await new Promise(r => setTimeout(r, 0)); });
    expect(document.activeElement).toBe(root.querySelector('[aria-label="Assists"]'));
    view.resolved = { outcome: 'left', leave: GAME_OVER_EXIT, steps: 5, log: ['-L-'] };
    act(() => render(<AssistsPanel port={port} onClose={() => closed++} />, root));
    expect(active()).toBe('Continue');
    await act(async () => { button('Continue')!.click(); await new Promise(r => setTimeout(r, 0)); });
    view.resolved = null;
    act(() => render(<AssistsPanel port={port} onClose={() => closed++} />, root));
    expect([calls, document.activeElement]).toEqual([['autoResolve', 'finish'], root.querySelector('[aria-label="Assists"]')]);
    escape();
    expect(closed).toBe(1);
  });

  it('keeps one status region, only its text changing, and says why auto-resolve waits under the warp', () => {
    const { port, view } = fakePort();
    show(port);
    const status = root.querySelector('[role="status"]');
    expect(status?.textContent).toBe('');
    view.resolving = true;
    act(() => render(<AssistsPanel port={port} />, root));
    view.resolving = false;
    view.resolved = { outcome: 'stoodDown', leave: null, steps: 3, log: [] };
    act(() => render(<AssistsPanel port={port} />, root));
    expect([root.querySelector('[role="status"]') === status, status?.textContent]).toEqual([true, 'Stood down after 3 steps: nothing left to fight in range.']);
    view.resolved = null;
    view.warp = true;
    act(() => render(<AssistsPanel port={port} />, root));
    const auto = button('Auto-resolve')!;
    expect([auto.disabled, document.getElementById(auto.getAttribute('aria-describedby')!)?.textContent]).toEqual([true, 'Auto-resolve waits until the warp ends.']);
  });

  it('closes by Escape or its Close button, and says so when the battle has gone under a click', async () => {
    let closed = 0;
    const { port } = fakePort();
    port.pause = () => { throw new Error('-No battle-'); };
    show(port, () => closed++);
    root.querySelector('[aria-label="Assists"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await act(async () => { button('Close')!.click(); });
    await act(async () => { button('Pause')!.click(); await new Promise(r => setTimeout(r, 0)); });
    expect([closed, root.querySelector('[role="alert"]')?.textContent]).toEqual([2, '-No battle-']);
  });
});
