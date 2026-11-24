// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment happy-dom
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { v3 } from '../sim/combat/math';
import type { BattleState, CombatSeams } from '../sim/combat/types';
import { miniCombat, miniEnterpriseUnits, miniTacticsCombat, recordingSeams } from '../testing/combat';
import { stringify } from 'yaml';
import { HeadlessPresenter } from '../sim/presenter';
import { createInitialState } from '../sim/state';
import { World } from '../sim/world';
import { makeGame, makeWorld } from '../testing/fixture';
import { miniShipData } from '../testing/ship';
import { CombatPanel } from './combatPanel';

function setup(enterpriseActive = true, seams?: Partial<CombatSeams>, combat = miniCombat()) {
  const ship = miniShipData();
  ship.data.units = miniEnterpriseUnits();
  ship.combat = combat;
  const world = makeWorld(
    [{ id: 'space.enterprise', name: 'Enterprise', screen: null, active: enterpriseActive }, { id: 'space.chodak', name: 'Chodak', screen: null }],
    { ship },
  );
  const root = document.body.appendChild(document.createElement('div'));
  act(() => render(<CombatPanel world={world} {...(seams ? { seams } : {})} />, root));
  return { world, root };
}
const button = (root: HTMLElement, name: string) => [...root.querySelectorAll('button')].find(b => b.textContent === name)!;
const press = (root: HTMLElement, name: string) => act(() => { button(root, name).click(); });
const text = (root: HTMLElement, label: string) => root.querySelector(`[aria-label="${label}"]`)?.textContent ?? null;
const pointer = (root: HTMLElement, name: string, type: 'pointerdown' | 'pointerup') => act(() => { button(root, name).dispatchEvent(new Event(type, { bubbles: true })); });
function slide(root: HTMLElement, label: string, value: number) {
  const input = root.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  act(() => {
    input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('CombatPanel (the ?dev combat view, spec §4.8)', () => {
  it('starts a lifted battle, falling back to the first when the default battle is not there, and steps it 66 ms at a time', () => {
    const { root } = setup();
    expect((root.querySelector('select[aria-label="Battle"]') as HTMLSelectElement).value).toBe('3');
    press(root, 'Start');
    expect(text(root, 'Battle status')).toBe('step 0 · 0 ms · exit none · target 1');
    expect(root.querySelector('canvas')).not.toBeNull();
    press(root, 'Step');
    press(root, 'Step');
    expect(text(root, 'Battle status')).toBe('step 2 · 132 ms · exit none · target 1');
    expect([...root.querySelectorAll('[aria-label="Ships"] tr')].map(r => r.children[1]!.textContent)).toEqual(['space.enterprise', 'space.chodak']);
  });

  it('flies the Enterprise while a flight button is held, through the steer command', () => {
    const { root } = setup();
    press(root, 'Start');
    act(() => { button(root, 'Faster').dispatchEvent(new Event('pointerdown', { bubbles: true })); });
    press(root, 'Step');
    press(root, 'Step');
    press(root, 'Step');
    act(() => { button(root, 'Faster').dispatchEvent(new Event('pointerup', { bubbles: true })); });
    press(root, 'Step');
    expect(text(root, 'Enterprise')).toContain('throttle 6.6');
    press(root, 'Target ▶');
    press(root, 'All stop');
    expect(text(root, 'Battle status')).toContain('target 1');
  });

  it('fights on a copy: the game\'s own ship is untouched', () => {
    const { world, root } = setup();
    const before = JSON.stringify(world.state.ship.systems);
    press(root, 'Start');
    // (with weapons and damage fighting: Plan 20)
    press(root, 'Phasers');
    press(root, 'Torpedoes');
    for (let i = 0; i < 12; i++) press(root, 'Step');
    expect(JSON.stringify(world.state.ship.systems)).toBe(before);
  });

  it('drops the cues and sounds each update asks for: the dev view plays nothing, so they never pile up', () => {
    const seen: { b: BattleState | null } = { b: null };
    let asked = 0;
    // (updateCamera runs at the end of each step, after weapons and damage have asked for theirs)
    const { root } = setup(true, { updateCamera: (_c, b) => { seen.b = b; asked += b.cues.length + b.sounds.length; } });
    press(root, 'Start');
    press(root, 'Phasers');
    press(root, 'Torpedoes');
    for (let i = 0; i < 12; i++) press(root, 'Step');
    // (the fight asked for some, and none is left after the update)
    expect(asked).toBeGreaterThan(0);
    expect([seen.b!.cues.length, seen.b!.sounds.length]).toEqual([0, 0]);
  });

  it('picks a target again after none, and runs the throttle down after All stop', () => {
    const { root } = setup();
    // (without the AI and tactics: miniCombat's script never makes its kernel ready, so they'd keep flying the Enterprise)
    press(root, 'AI');
    press(root, 'Start');
    pointer(root, 'Faster', 'pointerdown');
    press(root, 'Step');
    press(root, 'Step');
    press(root, 'Step');
    pointer(root, 'Faster', 'pointerup');
    press(root, 'No target');
    expect(text(root, 'Battle status')).toContain('target none');
    press(root, 'Target ▶');
    expect(text(root, 'Battle status')).toContain('target 1');
    // (the throttle holds at 6.6 once Faster is let go; stopping takes throttle * dt off it a step, 6.6 - 6.6 * 0.066 = 6.16: combat.cpp:606)
    expect(text(root, 'Enterprise')).toContain('throttle 6.6');
    press(root, 'All stop');
    press(root, 'Step');
    expect(text(root, 'Enterprise')).toContain('throttle 6.2');
  });

  it('has a plain control for each console command (spec §4.5, §4.8), which reaches its seam with its arguments', () => {
    const log: string[] = [];
    const args: unknown[][] = [];
    const spy = (name: string) => (...a: unknown[]) => { args.push([name, ...a.slice(2)]); };
    const names = ['setSpread', 'setPowerLevel', 'clickManeuver', 'scrollManeuvers', 'fireTorpedoes', 'raiseShields', 'setWeaponsLock', 'setDelegate'];
    const { root } = setup(true, recordingSeams(log, Object.fromEntries(names.map(n => [n, spy(n)]))));
    press(root, 'Start');
    log.length = 0;
    args.length = 0;
    for (const name of [
      'Phasers', 'Torpedoes', 'Both', 'Spread 4', 'Shields', 'Lock', 'Delegate', 'Self-destruct', 'Power 3',
      'Maneuver 6', 'Maneuvers ▲', 'Maneuvers ▼', 'Engage', 'Hail', 'Bridge', 'Engineering',
    ]) press(root, name);
    expect(log).toEqual([
      'firePhasers:0', 'fireTorpedoes:0', 'firePhasers:0', 'fireTorpedoes:0', 'setSpread', 'raiseShields', 'setWeaponsLock', 'setDelegate',
      'armSelfDestruct', 'setPowerLevel', 'clickManeuver', 'scrollManeuvers', 'scrollManeuvers', 'engageManeuver', 'hail', 'bridge', 'engineering',
    ]);
    expect(args.map(a => a.map(x => (typeof x === 'object' && x !== null && 'index' in x ? `ship ${(x as { index: number }).index}` : x)))).toEqual([
      ['fireTorpedoes', 'ship 0', 0], ['fireTorpedoes', 'ship 0', 0], ['setSpread', 4], ['raiseShields', true], ['setWeaponsLock', true],
      ['setDelegate', true, true], ['setPowerLevel', 3, false], ['clickManeuver', 6], ['scrollManeuvers', -1], ['scrollManeuvers', 1],
    ]);
    expect(button(root, 'Spread 9')).toBeDefined();
    expect(button(root, 'Maneuver 0')).toBeDefined();
  });

  it('sets the phaser banks and salvoes, and the camera: views, zoom, cycle, orbit and wide', () => {
    // (setupWeapons is Plan 20's: here it gives the Enterprise two banks, so the page has sliders)
    const bank = () => ({ unit: 13, offset: v3(), active: false, miss: false, missOffset: v3(), endTime: 0, lastUpdate: 0, beam: { frames: null, frame: 0, frameTime: 0, lastFrame: 0 }, charge: 0, setting: 100, savedSetting: 0, tip: v3() });
    const { root } = setup(true, { setupWeapons: (_ctx, _b, ship) => { if (ship.index === 0) ship.banks = [bank(), bank()]; } });
    expect(root.querySelector('input[aria-label="Bank 0"]')).toBeNull();
    press(root, 'Start');
    expect(text(root, 'Console')).toBe('banks 100,100 · salvo 10/10 · view 0x0 of 0 · zoom 0 · held 0x0 · wide off');
    slide(root, 'Bank 1', 40);
    expect(text(root, 'Console')).toContain('banks 100,40 ·');
    press(root, 'No banks');
    expect(text(root, 'Console')).toContain('banks 0,0 ·');
    press(root, 'All banks');
    expect(text(root, 'Console')).toContain('banks 100,100 ·');
    slide(root, 'Fore salvo', 7);
    slide(root, 'Aft salvo', 3);
    expect(text(root, 'Console')).toContain('salvo 7/3 ·');
    // (View 3 looks at the target, tactical.cpp:795-797; View 2 chases the Enterprise, 792-794)
    press(root, 'View 3');
    expect(text(root, 'Console')).toContain('view 0xc of 1 ·');
    press(root, 'View 2');
    expect(text(root, 'Console')).toContain('view 0x0 of 0 ·');
    press(root, 'Zoom in');
    press(root, 'Zoom in');
    press(root, 'Zoom out');
    expect(text(root, 'Console')).toContain('zoom 1 ·');
    // (cycling waits kCycleDelay, 247 ms, from the last cycle: combat.cpp:690)
    press(root, 'Cycle view');
    expect(text(root, 'Console')).toContain('view 0x0 of 0 ·');
    for (let i = 0; i < 4; i++) press(root, 'Step');
    press(root, 'Cycle view');
    expect(text(root, 'Console')).toContain('view 0x0 of 1 ·');
    pointer(root, 'Orbit ←', 'pointerdown');
    expect(text(root, 'Console')).toContain('held 0x100');
    pointer(root, 'Orbit ←', 'pointerup');
    pointer(root, 'Orbit →', 'pointerdown');
    expect(text(root, 'Console')).toContain('held 0x200');
    pointer(root, 'Orbit →', 'pointerup');
    press(root, 'Wide');
    expect(text(root, 'Console')).toContain('wide on');
    expect(button(root, 'Wide').getAttribute('aria-pressed')).toBe('true');
  });

  it('holds a flight or orbit button from the keyboard: Space or Enter presses (not its repeats), key up or blur lets go', () => {
    const { root } = setup();
    press(root, 'Start');
    const key = (name: string, type: 'keydown' | 'keyup', k: string, repeat = false) =>
      act(() => { button(root, name).dispatchEvent(new KeyboardEvent(type, { key: k, repeat, bubbles: true })); });
    const held = () => /held (0x[0-9a-f]+)/.exec(text(root, 'Console')!)![1];
    key('Faster', 'keydown', ' ');
    expect(held()).toBe('0x40');
    key('Faster', 'keydown', ' ', true);
    key('Faster', 'keyup', ' ');
    expect(held()).toBe('0x0');
    key('Orbit →', 'keydown', 'Enter');
    expect(held()).toBe('0x200');
    act(() => { button(root, 'Orbit →').dispatchEvent(new FocusEvent('blur')); });
    expect(held()).toBe('0x0');
    key('Yaw ←', 'keydown', 'Enter');
    expect(held()).toBe('0x10');
    key('Yaw ←', 'keydown', 'a');
    key('Yaw ←', 'keyup', 'a');
    expect(held()).toBe('0x10');
    act(() => { button(root, 'Yaw ←').dispatchEvent(new Event('pointercancel', { bubbles: true })); });
    expect(held()).toBe('0x0');
  });

  it('lets go of every held button for a new battle', () => {
    const { root } = setup();
    press(root, 'Start');
    pointer(root, 'Faster', 'pointerdown');
    pointer(root, 'Orbit ←', 'pointerdown');
    press(root, 'Start');
    expect(text(root, 'Console')).toContain('held 0x0 ·');
    pointer(root, 'Yaw ←', 'pointerdown');
    expect(text(root, 'Console')).toContain('held 0x10 ·');
  });

  it('shows the picked ship\'s log, chosen with each row\'s Log button', () => {
    const { root } = setup();
    press(root, 'Start');
    const log = (i: number) => root.querySelector<HTMLButtonElement>(`button[aria-label="Log of ship ${i}"]`)!;
    expect([log(0).getAttribute('aria-pressed'), log(1).getAttribute('aria-pressed')]).toEqual(['true', 'false']);
    act(() => { log(1).click(); });
    expect([log(0).getAttribute('aria-pressed'), log(1).getAttribute('aria-pressed')]).toEqual(['false', 'true']);
    expect(root.querySelector('tr[aria-selected]')).toBeNull();
    expect(button(root, 'Play').hasAttribute('aria-pressed')).toBe(false);
  });

  it('fights with weapons and damage: a phaser volley shows as a beam, rolls, and a hit in the target\'s log', () => {
    const { root } = setup();
    press(root, 'Start');
    // (the chodak is above and ahead: facing 4, so bank 5 bears (kBearing, weapons.cpp:738-740))
    press(root, 'Phasers');
    expect(text(root, 'Effects')).toBe('beams 1 · torpedoes 0 · debris 0 · rolls 1');
    for (let i = 0; i < 12; i++) press(root, 'Step');
    act(() => { root.querySelector<HTMLButtonElement>('button[aria-label="Log of ship 1"]')!.click(); });
    // (from the fourth frame it hits shield 4: 7 of energy at 5099 (k = (int)(6151 / 714 + 6.75f) = 14, raw 10), leaving 93)
    expect(text(root, 'Ship log')).toBe('Shield -Unit 4- holding at 69.72');
    press(root, 'Torpedoes');
    expect(text(root, 'Effects')).toContain('torpedoes 10');
  });

  it('breaks a ship up into debris that rolls its booms and is cleared away: the damage seams are on', () => {
    const { root } = setup();
    // (a target that sits still: no AI or tactics)
    press(root, 'AI');
    press(root, 'Start');
    // (this port's values, measured: the self-destruct goes off at 0x16bc ticks, step 304 of 66 ms (weapons.cpp:698-706,
    // armSelfDestruct); destroy rolls 44 times; the booms roll 6 more (updateDebris); the debris is removed after step 455)
    press(root, 'Self-destruct');
    for (let i = 0; i < 303; i++) press(root, 'Step');
    expect(text(root, 'Effects')).toBe('beams 0 · torpedoes 0 · debris 0 · rolls 0');
    press(root, 'Step');
    expect(text(root, 'Effects')).toBe('beams 0 · torpedoes 0 · debris 1 · rolls 44');
    for (let i = 0; i < 151; i++) press(root, 'Step');
    expect(text(root, 'Effects')).toBe('beams 0 · torpedoes 0 · debris 1 · rolls 50');
    press(root, 'Step');
    expect(text(root, 'Effects')).toBe('beams 0 · torpedoes 0 · debris 0 · rolls 50');
  });

  it('refuses a battle the lifted data can\'t fight, and says why', () => {
    const ship = miniShipData();
    ship.data.units = miniEnterpriseUnits();
    ship.combat = miniCombat();
    delete ship.combat.animations;
    const world = makeWorld([{ id: 'space.enterprise', name: 'Enterprise', screen: null }, { id: 'space.chodak', name: 'Chodak', screen: null }], { ship });
    const root = document.body.appendChild(document.createElement('div'));
    act(() => render(<CombatPanel world={world} />, root));
    press(root, 'Start');
    expect(root.querySelector('.au-dev-error')!.textContent).toBe("the combat data can't fight a battle: combat.yaml has no animations (lift with --images)");
  });

  it('says why a battle cannot start', () => {
    const { root } = setup(false);
    press(root, 'Start');
    expect(root.querySelector('.au-dev-error')!.textContent).toBe('battle screen 3 has no Enterprise');
    expect(text(root, 'Battle status')).toBeNull();
  });

  it('runs the AI and tactics: the Enterprise\'s script builds the maneuver menu in its first step, which opens, and Delegate engages', () => {
    const { root } = setup(true, undefined, miniTacticsCombat());
    const rows = () => [...root.querySelectorAll('[aria-label="Maneuvers"] li')].map(li => `${li.getAttribute('aria-current') ? '>' : ''}${li.textContent}`);
    const scripts = () => [...root.querySelectorAll('[aria-label="Scripts"] li')].map(li => li.textContent);
    press(root, 'Start');
    expect(text(root, 'Tactics')).toBe('no delegate · no kernel ready · no script lock · engage lock · no engage button · menu 0 headings, 0 rows');
    press(root, 'Step');
    expect(text(root, 'Tactics')).toBe('no delegate · kernel ready · no script lock · no engage lock · no engage button · menu 1 headings, 1 rows');
    expect(rows()).toEqual(['▸ -Menu-', '', '', '', '', '', '']);
    press(root, 'Maneuver 0');
    expect(rows()).toEqual(['>▾ -Menu-', '  -Close-', '  -Weave-', '', '', '', '']);
    press(root, 'Delegate');
    press(root, 'Step');
    expect(text(root, 'Tactics')).toMatch(/^delegate · kernel ready · /);
    expect(scripts()[0]).toMatch(/^0 · engaged · worf\.bin [A-Z]+ pc 0x[0-9a-f]+ /);
    expect(scripts()[1]).toMatch(/^1 · engaged · zap\.bin [A-Z]+ pc 0x[0-9a-f]+ .* target 0 at 5099 · fire /);
  });

  it('shows Engage pressed while the button holds the engage', () => {
    const { root } = setup(true, undefined, miniTacticsCombat());
    press(root, 'Start');
    press(root, 'Step');
    // (Engage runs the selected maneuver: the heading opens, then its first button is picked)
    press(root, 'Maneuver 0');
    press(root, 'Maneuver 1');
    expect(button(root, 'Engage').getAttribute('aria-pressed')).toBe('false');
    press(root, 'Engage');
    expect(button(root, 'Engage').getAttribute('aria-pressed')).toBe('true');
  });

  it('leaves the AI and tactics out of the next battle with the AI button: no script loads', () => {
    const { root } = setup(true, undefined, miniTacticsCombat());
    press(root, 'AI');
    expect(button(root, 'AI').getAttribute('aria-pressed')).toBe('false');
    press(root, 'Start');
    press(root, 'Step');
    expect([...root.querySelectorAll('[aria-label="Scripts"] li')].map(li => li.textContent!.split(' · ').slice(0, 3))).toEqual([
      ['0', 'no engaged', 'no script'], ['1', 'no engaged', 'no script'],
    ]);
  });

  it('shows the tactics\' warnings, each once: miniCombat\'s script has an IDLE as a DO, which isn\'t a verb', () => {
    const { root } = setup();
    press(root, 'Start');
    expect(root.querySelector('[aria-label="Warnings"]')).toBeNull();
    for (let i = 0; i < 3; i++) press(root, 'Step');
    expect([...root.querySelectorAll('[aria-label="Warnings"] li')].map(li => li.textContent)).toEqual(['tactic: unknown verb 2b']);
  });

  it('reads combat.yaml when it opens in a game parsed without it, says why a read failed, and tries again (Plan 24 Task 4)', async () => {
    const ship = miniShipData();
    ship.data.units = miniEnterpriseUnits();
    const combat = miniCombat();
    const content = makeGame([{ id: 'space.enterprise', name: 'Enterprise', screen: null, active: true }, { id: 'space.chodak', name: 'Chodak', screen: null }], { ship });
    for (const b of Object.values(combat.battles)) b.screen = content.start.screen;
    let calls = 0;
    const world = new World(content, createInitialState(content), w => new HeadlessPresenter(w.clock), {
      combatSource: () => (++calls === 1 ? Promise.reject(new Error('offline')) : Promise.resolve(stringify(combat))),
    });
    world.start();
    const root = document.body.appendChild(document.createElement('div'));
    act(() => render(<CombatPanel world={world} />, root));
    expect(root.textContent).toBe('Reading combat.yaml…');
    await act(async () => { await new Promise(r => setImmediate(r)); });
    expect(root.querySelector('[role="alert"]')?.textContent).toBe('combat.yaml could not be read: offline Try again');
    press(root, 'Try again');
    await act(async () => { await new Promise(r => setImmediate(r)); });
    expect(calls).toBe(2);
    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect((root.querySelector('select[aria-label="Battle"]') as HTMLSelectElement).value).toBe('3');
  });
});
