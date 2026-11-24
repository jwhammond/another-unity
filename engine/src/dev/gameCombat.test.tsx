// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment happy-dom
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import type { CombatAssists } from '../sim/combat/assists';
import type { CombatCommand } from '../sim/combat/commands';
import { GAME_OVER_EXIT } from '../sim/combat/types';
import type { BattleResult } from '../sim/tacticalScreen';
import { miniBattle, miniCombat, miniEnterpriseUnits } from '../testing/combat';
import { newRadarMemory } from '../view/combat/files';
import type { BattlePort, BattleView } from '../web/battlePort';
import { DIFFICULTY_NOTE, GameCombat, resultLine, STORY_NOTE } from './gameCombat';

/** A made-up port over miniCombat's battle 3, recording what the view asks. */
function fakePort(over: Partial<BattleView> = {}) {
  const { b } = miniBattle();
  const calls: string[] = [];
  const orders: CombatCommand[] = [];
  let assists: CombatAssists = { difficulty: 'game', speed: 1 };
  let view: BattleView | null = { b, combat: miniCombat(), enterpriseUnits: miniEnterpriseUnits(), paused: false, redFlash: false, resolved: null, resolving: false, page: 'conn', warp: false, queued: [], overlay: null, ...over };
  const port: BattlePort = {
    battle: () => view,
    command: cmd => { orders.push(cmd); },
    pause: on => { calls.push(`pause ${on}`); },
    autoResolve: async () => { calls.push('autoResolve'); },
    finish: async () => { calls.push('finish'); },
    assists: () => assists,
    setAssists: a => { assists = a; calls.push(`assists ${a.difficulty} ${a.speed}`); },
    page: () => {}, consoleArt: () => null, flash: () => 0, viewBox: () => {}, hudBoxes: () => {}, logShown: () => {}, beep: () => {}, radar: newRadarMemory, chunk: () => null, pick: () => null,
  };
  return { port, calls, orders, hide: () => { view = null; } };
}
function show(port: BattlePort) {
  const root = document.body.appendChild(document.createElement('div'));
  act(() => render(<GameCombat port={port} />, root));
  return root;
}
const button = (root: HTMLElement, name: string) => [...root.querySelectorAll('button')].find(b => b.textContent === name)!;

afterEach(() => {
  document.body.innerHTML = '';
});

describe('GameCombat (the world\'s battle behind ?dev, Plan 23)', () => {
  it('shows the battle with the debug view\'s controls, each order given to the world', () => {
    const { port, orders } = fakePort();
    const root = show(port);
    expect(root.querySelector('[aria-label="Battle status"]')?.textContent).toBe('step 0 · 10000 ms · exit none · target 1');
    act(() => button(root, 'Phasers').click());
    act(() => button(root, 'Bridge').click());
    expect(orders).toEqual([{ type: 'fire', weapon: 'phasers' }, { type: 'bridge' }]);
  });

  it('pauses and resumes, sets the speed, and chooses the combat difficulty, Story\'s note describing it', async () => {
    const { port, calls } = fakePort();
    const root = show(port);
    await act(async () => button(root, 'Pause').click());
    act(() => button(root, '4×').click());
    const speeds = root.querySelector('[role="group"][aria-label="Speed"]')!;
    expect([...speeds.querySelectorAll('button')].map(b => b.textContent)).toEqual(['1×', '2×', '4×', '8×']);
    const select = root.querySelector<HTMLSelectElement>('select[aria-label="Combat difficulty"]')!;
    act(() => { select.value = 'story'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(calls).toEqual(['pause true', 'assists game 4', 'assists story 4']);
    expect(document.getElementById(select.getAttribute('aria-describedby')!)?.textContent).toBe(`${STORY_NOTE} ${DIFFICULTY_NOTE}`);
    expect([...select.options].map(o => o.textContent)).toEqual(['As the game', 'Ensign', 'Lieutenant', 'Captain', 'Story']);
  });

  it('says so when Pause finds the battle over, as the other controls do', async () => {
    const { port } = fakePort();
    port.pause = () => { throw new Error('-No battle-'); };
    const root = show(port);
    // (the refusal comes back a few microtasks on: a macrotask lets it)
    await act(async () => { button(root, 'Pause').click(); await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(root.querySelector('[role="alert"]')?.textContent).toBe('-No battle-');
  });

  it('auto-resolves, then shows the result and the Enterprise\'s log until Continue ends the battle', async () => {
    const resolved: BattleResult = { outcome: 'left', leave: GAME_OVER_EXIT, steps: 2889, log: ['-Line 1-', '-Line 2-'] };
    const idle = fakePort();
    const root = show(idle.port);
    await act(async () => button(root, 'Auto-resolve').click());
    expect(idle.calls).toEqual(['autoResolve']);
    const done = fakePort({ resolved, paused: true });
    const shown = show(done.port);
    expect(shown.querySelector('[aria-label="Result"] p')?.textContent).toBe('The Enterprise was lost after 2889 steps.');
    expect([...shown.querySelectorAll('[aria-label="Enterprise log"] li')].map(li => li.textContent)).toEqual(['-Line 1-', '-Line 2-']);
    expect(button(shown, 'Auto-resolve').disabled).toBe(true);
    await act(async () => button(shown, 'Continue').click());
    expect(done.calls).toEqual(['finish']);
    expect(button(shown, 'Resume')).toBeDefined();
  });

  it('says how each end came out, and shows nothing without a battle', () => {
    const r = (outcome: BattleResult['outcome'], leave: number | null): string => resultLine({ outcome, leave, steps: 9, log: [] });
    expect([r('stoodDown', null), r('undecided', null), r('left', 0), r('left', 4), r('left', 0x105)]).toEqual([
      'Stood down after 9 steps: nothing left to fight in range.', 'Still fighting after 9 steps.',
      'The battle ended after 9 steps: back to the bridge.', 'Retreated to astrogation after 9 steps.', 'Left for ship screen 0x105 after 9 steps.',
    ]);
    const { port, hide } = fakePort();
    hide();
    expect(show(port).innerHTML).toBe('');
  });
});
