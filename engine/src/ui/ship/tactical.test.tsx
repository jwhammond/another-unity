// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment happy-dom
import { render, type ComponentChildren } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { miniBattle, miniCombat, miniEnterpriseUnits } from '../../testing/combat';
import { newRadarMemory } from '../../view/combat/files';
import type { BattlePort } from '../../web/battlePort';
import type { SpaceSceneModule } from '../../web/combatView';
import type { CombatView, ShipPort } from '../../web/shipPort';
import { TacticalPanel } from './tactical';

describe('TacticalPanel', () => {
  let root: HTMLElement;
  afterEach(() => {
    render(null, root);
    root.remove();
  });
  const view = (over: Partial<CombatView> = {}): CombatView => ({
    ships: [
      { id: 'a', label: '-Ent-', friendly: false, destroyed: false },
      { id: 'b', label: '-Friend-', friendly: true, destroyed: false },
      { id: 'c', label: '-Foe-', friendly: false, destroyed: true },
    ],
    redAlert: false, hailWaiting: false, ...over,
  });
  /** Where the console says the space view goes (BattlePort.viewBox), as the session would read it. */
  let box: ((wide: boolean) => DOMRect | null) | null = null;
  /** A made-up battle port over miniCombat's battle 3, whose chunk's console is a stand-in. */
  const battlePort = (o: { fighting?: boolean; chunk?: boolean } = {}): BattlePort => {
    const { b } = miniBattle();
    const chunk = { CombatConsole: () => <p aria-label="Console stand-in">-Console-</p> } as unknown as SpaceSceneModule;
    return {
      battle: () => (o.fighting === false ? null : { b, combat: miniCombat(), enterpriseUnits: miniEnterpriseUnits(), paused: false, redFlash: false, resolved: null, resolving: false, page: 'conn', warp: false, queued: [], overlay: null }),
      command: () => {}, pause: () => {}, autoResolve: async () => {}, finish: async () => {}, assists: () => ({ difficulty: 'game', speed: 1 }), setAssists: () => {},
      page: () => {}, consoleArt: () => null, flash: () => 0, viewBox: f => { box = f; }, hudBoxes: () => {}, logShown: () => {}, beep: () => {}, radar: newRadarMemory,
      chunk: () => (o.chunk === false ? null : chunk), pick: () => null,
    };
  };
  const show = (v: CombatView | null, dev?: ComponentChildren, battle?: BattlePort) => {
    const calls: string[] = [];
    box = null;
    const port = {
      combat: () => v,
      resolve: async (o: string) => { calls.push(o); },
      answerHail: async () => { calls.push('answer'); },
      subscribe: () => () => {},
    } as unknown as ShipPort;
    root = document.body.appendChild(document.createElement('div'));
    act(() => { render(<TacticalPanel port={port} battle={battle} dev={dev} devLabel="Dev tools" />, root); });
    return calls;
  };
  const button = (name: string) => [...root.querySelectorAll('button')].find(b => b.textContent === name)!;

  it('lists the ships, with friendly and destroyed marks', () => {
    show(view({ redAlert: true }));
    expect([...root.querySelectorAll('[data-ship]')].map(li => li.textContent)).toEqual(['-Ent-', '-Friend- (friendly)', '-Foe- (destroyed)']);
    expect(root.querySelector('h2')?.textContent).toContain('red alert');
  });

  it('calls resolve for Win, Flee and Lose', async () => {
    const calls = show(view());
    for (const name of ['Win', 'Flee', 'Lose']) await act(async () => { button(name).click(); });
    expect(calls).toEqual(['win', 'flee', 'lose']);
  });

  it('shows "Answer hail" only while a hail waits', async () => {
    show(view());
    expect(button('Answer hail')).toBeUndefined();
    render(null, root);
    root.remove();
    const calls = show(view({ hailWaiting: true }));
    await act(async () => { button('Answer hail').click(); });
    expect(calls).toEqual(['answer']);
  });

  it('is the console with the combat sim\'s battle: the chunk\'s, in its box, the dev view and the three ways out folded over it (Plan 27)', async () => {
    const calls = show(view(), <p aria-label="Battle view">-View-</p>, battlePort());
    const console = root.querySelector('[role="group"][aria-label="Console"]');
    expect(console?.querySelector('[aria-label="Console stand-in"]')?.textContent).toBe('-Console-');
    const dev = root.querySelector<HTMLDetailsElement>('details.au-console-dev')!;
    expect([dev.open, dev.querySelector('[aria-label="Battle view"]')?.textContent, root.querySelector('[data-ship]')?.closest('details')]).toEqual([false, '-View-', dev]);
    expect(dev.querySelector('summary')?.textContent).toBe('Dev tools');
    await act(async () => { button('Win').click(); });
    expect(calls).toEqual(['win']);
    // (no dev view: no dev tools; the chunk not in yet: the box, empty)
    render(null, root);
    root.remove();
    show(view(), undefined, battlePort({ chunk: false }));
    expect([root.querySelector('details'), root.querySelector('[aria-label="Console"]')?.childElementCount]).toEqual([null, 0]);
  });

  it('says where the space view goes: the console\'s box, the game frame when wide; nothing with the dialog or once gone (Plan 27 R3)', () => {
    show(view(), undefined, battlePort());
    const at = (left: number) => ({ left, top: 0, width: 1, height: 1, right: left + 1, bottom: 1, x: left, y: 0 }) as DOMRect;
    root.querySelector<HTMLElement>('.au-console-screen')!.getBoundingClientRect = () => at(1);
    root.querySelector<HTMLElement>('.au-console-wide')!.getBoundingClientRect = () => at(2);
    expect([box?.(false)?.left, box?.(true)?.left]).toEqual([1, 2]);
    render(null, root);
    expect(box).toBeNull();
    root.remove();
    show(view(), <p>-View-</p>, battlePort({ fighting: false }));
    expect([root.querySelector('.au-console-screen'), box, root.querySelector('h2')?.textContent]).toEqual([null, null, 'Tactical']);
  });

  it('shows nothing without a battle', () => {
    show(null);
    expect(root.innerHTML).toBe('');
  });
});
