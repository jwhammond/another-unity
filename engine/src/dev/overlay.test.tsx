// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment happy-dom
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { makeWorld } from '../testing/fixture';
import type { DebugView } from '../view/stage';
import { DevOverlay, type DevPort } from './overlay';
import { RuleTrace } from './trace';

function setup() {
  const world = makeWorld([{ id: 'panel', name: 'Panel', screen: 'room', at: 'panel' }]);
  const debugCalls: Partial<DebugView>[] = [];
  const jumps: string[] = [];
  let debug: DebugView = { hotspots: false, markers: false, navmesh: false, art: true };
  const trace = new RuleTrace();
  const dev: DevPort = {
    world: () => world,
    stage: {
      setDebug: d => { debugCalls.push(d); debug = { ...debug, ...d }; },
      get debugView() { return debug; },
    },
    trace,
    jump: (screen, entrance) => { jumps.push(`${screen}/${entrance}`); },
    problems: () => ['objects/panel.yaml: oops'],
    restart: () => {},
  };
  const root = document.body.appendChild(document.createElement('div'));
  act(() => render(<DevOverlay dev={dev} />, root));
  act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '`' })); });
  return { root, trace, debugCalls, jumps };
}

const tab = (root: HTMLElement, name: string) => act(() => {
  [...root.querySelectorAll('button')].find(b => b.textContent === name)!.click();
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('DevOverlay', () => {
  it('opens on the backquote key, with the content problems and the rule trace', () => {
    const { root, trace } = setup();
    expect(root.querySelector('.au-dev')).not.toBeNull();
    expect(root.textContent).toContain('objects/panel.yaml: oops');
    act(() => trace.push({ tick: 5, kind: 'rule', text: 'use panel: panel/use/0 ran' }));
    expect(root.textContent).toContain('use panel: panel/use/0 ran');
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '`' })); });
    expect(root.querySelector('.au-dev')).toBeNull();
  });

  it('shows the state, and objects filtered by id', () => {
    const { root } = setup();
    tab(root, 'state');
    expect(root.querySelector('pre')?.textContent).toContain('"screen": "room"');
    const filter = root.querySelector<HTMLInputElement>('input[aria-label="Filter objects"]')!;
    act(() => {
      filter.value = 'pan';
      filter.dispatchEvent(new Event('input'));
    });
    expect(root.querySelector('pre')?.textContent).toContain('"panel"');
    expect(root.querySelector('pre')?.textContent).not.toContain('"picard"');
  });

  it('the View panel has an art checkbox that calls setDebug({ art })', () => {
    const { root, debugCalls } = setup();
    tab(root, 'view');
    const art = root.querySelector<HTMLInputElement>('input[aria-label="art"]')!;
    expect(art.checked).toBe(true);
    act(() => {
      art.checked = false;
      art.dispatchEvent(new Event('change'));
    });
    expect(debugCalls).toEqual([{ art: false }]);
  });

  it('switches the debug views and jumps to a screen', () => {
    const { root, debugCalls, jumps } = setup();
    tab(root, 'view');
    const navmesh = root.querySelector<HTMLInputElement>('input[aria-label="navmesh"]')!;
    act(() => {
      navmesh.checked = true;
      navmesh.dispatchEvent(new Event('change'));
    });
    expect(debugCalls).toEqual([{ navmesh: true }]);
    const screen = root.querySelector<HTMLSelectElement>('select[aria-label="Screen"]')!;
    act(() => {
      screen.value = 'hall';
      screen.dispatchEvent(new Event('change'));
    });
    tab(root, 'Jump');
    expect(jumps).toEqual(['hall/entry']);
  });

  it('has a combat tab, which says when the game has no combat data', () => {
    const { root } = setup();
    tab(root, 'combat');
    expect(root.textContent).toContain('This game has no combat.yaml.');
  });
});
