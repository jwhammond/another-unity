// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment happy-dom
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { MissionSelect, type MissionSelectPort } from './missionSelect';

function fakePort() {
  const listeners = new Set<() => void>();
  return {
    beamed: 0,
    restarted: 0,
    movie: undefined as string | undefined,
    ship: null as { gameOver: number | null } | null,
    missions() { return [{ world: 'horst3', screen: 'horst3.s01', entrance: 'entrance_0' }, { world: 'unity', screen: 'unity.s01', entrance: 'entrance_0', beamEffect: false as const }]; },
    chosen: [] as string[],
    effects: [] as boolean[],
    async choose(world: string) { this.chosen.push(world); },
    arrivalMovie() { return this.movie; },
    beamDown(effect: boolean) { this.beamed++; this.effects.push(effect); },
    onShip() { return this.ship; },
    restart() { this.restarted++; this.ship = null; },
    ending(reason: number) { return reason === 3 ? { won: true as const } : { won: false as const, ...(reason === 2 ? { text: '-Lost-' } : {}) }; },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    changed() { for (const l of listeners) l(); },
  };
}

describe('MissionSelect', () => {
  let root: HTMLElement;
  afterEach(() => {
    render(null, root);
    root.remove();
  });

  function show(port: MissionSelectPort) {
    root = document.body.appendChild(document.createElement('div'));
    act(() => { render(<MissionSelect text={{ missions: { horst3: 'Horst III' } }} port={port} />, root); });
  }
  const mission = (world: string) => root.querySelector<HTMLButtonElement>(`button[data-world="${world}"]`);
  const button = (name: string) => [...root.querySelectorAll('button')].find(b => b.textContent === name);

  it('holds the game until the team beams down', async () => {
    const port = fakePort();
    show(port);
    expect(root.textContent).toContain('Choose a mission.');
    expect(port.beamed).toBe(0);
    await act(async () => { mission('horst3')!.click(); });
    expect(port.beamed).toBe(1);
    expect(root.querySelector('[role="dialog"]')).toBeNull();
  });

  it('lists the missions, starts the chosen one, and beams down with its effect', async () => {
    const port = fakePort();
    show(port);
    expect(mission('horst3')?.textContent).toBe('Horst III');
    // (a mission without a name shows its world)
    expect(mission('unity')?.textContent).toBe('unity');
    await act(async () => { mission('unity')!.click(); });
    expect(port.chosen).toEqual(['unity']);
    expect(port.effects).toEqual([false]);
    expect(root.querySelector('[role="dialog"]')).toBeNull();
  });

  it('says the mission is complete once the team is back on the ship, and can beam down again', async () => {
    const port = fakePort();
    show(port);
    await act(async () => { mission('horst3')!.click(); });
    port.ship = { gameOver: null };
    act(() => port.changed());
    expect(root.textContent).toContain('Mission complete');
    await act(async () => { button('Beam down again')!.click(); });
    expect(port.restarted).toBe(1);
    act(() => port.changed());
    // (back through the bridge: the briefing again, and the next beam-down starts the game again)
    expect(root.textContent).toContain('Choose a mission.');
    await act(async () => { mission('horst3')!.click(); });
    expect(port.beamed).toBe(2);
    expect(root.querySelector('[role="dialog"]')).toBeNull();
  });

  it('plays the arrival movie first, and beams down when it is skipped or ends', async () => {
    const port = fakePort();
    port.movie = 'movies/ho3arriv.webm';
    show(port);
    await act(async () => { mission('horst3')!.click(); });
    expect(root.querySelector('video')?.getAttribute('src')).toBe('movies/ho3arriv.webm');
    expect(port.beamed).toBe(0);
    act(() => button('Skip')!.click());
    expect(port.beamed).toBe(1);
    expect(root.querySelector('video')).toBeNull();
    const ends = fakePort();
    ends.movie = 'movies/ho3arriv.webm';
    act(() => render(null, root));
    show(ends);
    await act(async () => { mission('horst3')!.click(); });
    act(() => { root.querySelector('video')!.dispatchEvent(new Event('ended')); });
    expect(ends.beamed).toBe(1);
  });

  it('ends the game with the reason\'s line, or as won, and a new game goes back to the briefing', async () => {
    for (const [reason, says] of [[2, '-Lost-'], [9, 'Game over (9).'], [3, 'The end.']] as const) {
      const port = fakePort();
      show(port);
      await act(async () => { mission('horst3')!.click(); });
      port.ship = { gameOver: reason };
      act(() => port.changed());
      expect(root.textContent).toContain(says);
      await act(async () => { button('Start a new game')!.click(); });
      expect(port.restarted).toBe(1);
      act(() => port.changed());
      expect(root.textContent).toContain('Choose a mission.');
      act(() => render(null, root));
    }
  });

  it('disables the missions while one loads, so a double click starts one mission', async () => {
    const port = fakePort();
    let finish = () => {};
    port.choose = function (this: typeof port, world: string) {
      this.chosen.push(world);
      return new Promise<void>(resolve => { finish = resolve; });
    };
    show(port);
    await act(async () => { mission('horst3')!.click(); });
    expect(mission('horst3')!.disabled).toBe(true);
    expect(mission('unity')!.disabled).toBe(true);
    await act(async () => { mission('horst3')!.click(); mission('unity')!.click(); });
    expect(port.chosen).toEqual(['horst3']);
    await act(async () => { finish(); });
    expect(port.beamed).toBe(1);
  });

  it('stays on the game-over dialog, saying so, when the restart is refused', async () => {
    const port = fakePort();
    port.restart = function (this: typeof port) { this.restarted++; return Promise.reject(new Error('busy')); } as never;
    show(port);
    await act(async () => { mission('horst3')!.click(); });
    port.ship = { gameOver: 2 };
    act(() => port.changed());
    await act(async () => { button('Start a new game')!.click(); });
    expect(port.restarted).toBe(1);
    expect(root.querySelector('[aria-label="Game over"]')).not.toBeNull();
    expect(button('Start a new game')).toBeDefined();
    expect(root.textContent).toContain('Wait until nothing is happening, then try again.');
    expect(root.textContent).not.toContain('Choose a mission.');
  });

  it('stays on the briefing, saying so, when a mission is refused', async () => {
    const port = fakePort();
    port.choose = function (this: typeof port) { return Promise.reject(new Error('CHANGE_REFUSED')); } as never;
    show(port);
    await act(async () => { mission('horst3')!.click(); });
    expect(root.textContent).toContain('Choose a mission.');
    expect(root.textContent).toContain('Wait until nothing is happening, then try again.');
    expect(mission('horst3')!.disabled).toBe(false);
    expect(mission('unity')!.disabled).toBe(false);
    expect(port.beamed).toBe(0);
  });
});
