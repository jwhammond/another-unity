// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { miniBattle } from '../../testing/combat';
import { miniConsoleArt } from '../../testing/console';
import { BUTTON, BUTTONS, DOWN_ARROW, ENGAGE_BUTTON, maneuverRow, PAGE, PHASER_SLIDER_X, phaserSliderY, powerCell, SALVO_X, SALVO_Y, tabRect, type ConsoleUi } from './console';
import { BUTTON_DELAY, buttonAt, buttonDue, consoleClick, dragCommand, KEY_REPEAT_DELAY, NO_AXES, pendingSwitches, pressArrow, pressButton, sliderAt, TacticalKeys } from './consoleInput';

const images = miniConsoleArt({ sizes: { 41: [121, 34], 39: [84, 45], 102: [13, 110], 7: [143, 28] } }).images;
const ui = (o: Partial<ConsoleUi> = {}): ConsoleUi => ({ page: PAGE.conn, pressed: -1, buttonTime: 0, arrow: -1, wall: 50000, ...o });
const click = (x: number, y: number, o: { page?: number; wide?: boolean; pressed?: number } = {}) =>
  consoleClick(x, y, { page: o.page ?? PAGE.conn, wide: o.wide ?? false, pressed: o.pressed ?? -1, blips: [{ ship: 0, x: 141, y: 146 }, { ship: 1, x: 200, y: 100 }], images });

describe('the console\'s clicks (mouseClick, tactical.cpp:646-700)', () => {
  it('finds a button by its up picture\'s size, on its page, and no zoom while wide (tactical.cpp:585-601)', () => {
    const bridge = BUTTONS[BUTTON.bridge]!;
    expect([buttonAt(bridge.x, bridge.y, PAGE.conn, false, images), buttonAt(bridge.x + 120, bridge.y + 33, PAGE.tactics, false, images), buttonAt(bridge.x + 121, bridge.y, PAGE.conn, false, images)])
      .toEqual([BUTTON.bridge, BUTTON.bridge, -1]);
    const zoom = BUTTONS[BUTTON.zoomIn]!;
    expect([buttonAt(zoom.x, zoom.y, PAGE.conn, false, images), buttonAt(zoom.x, zoom.y, PAGE.conn, true, images)]).toEqual([BUTTON.zoomIn, -1]);
    const shields = BUTTONS[BUTTON.shields]!;
    expect([buttonAt(shields.x, shields.y, PAGE.conn, false, images), buttonAt(shields.x, shields.y, PAGE.tactics, false, images)]).toEqual([BUTTON.shields, -1]);
  });

  it('takes a tab first, then CONN\'s power cells or TACTICS\' rows, arrows and Engage, then a button, then a ship on the radar', () => {
    expect(click(5, tabRect(4)[1] + 1)).toEqual({ kind: 'page', page: 'tactics' });
    // (the cells overlap by a pixel or two, the lower level first: x 393 is level 2's and 3's, tactical.cpp:160-163)
    expect([click(powerCell(3)[0], 340), click(396, 340)]).toEqual([2, 3].map(level => ({ kind: 'command', command: { type: 'powerLevel', level }, beep: false })));
    expect(click(200, 340, { page: PAGE.tactics })).toEqual({ kind: 'command', command: { type: 'maneuver', row: 1 }, beep: false });
    // (the rows overlap by a pixel too: a row's top line is the one above's)
    expect([5, 6].map(row => click(maneuverRow(6)[0], maneuverRow(6)[1] + row - 5, { page: PAGE.tactics }))).toEqual([5, 6].map(row => ({ kind: 'command', command: { type: 'maneuver', row }, beep: false })));
    expect(click(DOWN_ARROW[0], DOWN_ARROW[1] + 1, { page: PAGE.tactics })).toEqual({ kind: 'command', command: { type: 'scrollManeuvers', direction: 1 }, arrow: 1, beep: true });
    expect(click(ENGAGE_BUTTON[0], ENGAGE_BUTTON[1], { page: PAGE.tactics })).toEqual({ kind: 'command', command: { type: 'engage' }, beep: true });
    expect(click(BUTTONS[BUTTON.bridge]!.x, BUTTONS[BUTTON.bridge]!.y)).toEqual({ kind: 'button', button: BUTTON.bridge });
    expect([click(207, 107), click(141, 146), click(400, 200)]).toEqual([{ kind: 'command', command: { type: 'target', ship: 1 }, beep: false }, null, null]);
  });

  it('takes no click while a button is down (tactical.cpp:652-653)', () => {
    expect(click(5, tabRect(4)[1] + 1, { pressed: BUTTON.view })).toBeNull();
  });
});

describe('the sliders (sliderAt and dragSlider, tactical.cpp:603-632)', () => {
  it('finds a bank\'s slider on the phasers page and a tube\'s on the torpedoes\'', () => {
    expect([sliderAt(PHASER_SLIDER_X, phaserSliderY(2), PAGE.phasers), sliderAt(PHASER_SLIDER_X + 122, phaserSliderY(2), PAGE.phasers), sliderAt(SALVO_X, SALVO_Y[1], PAGE.torpedoes), sliderAt(SALVO_X, SALVO_Y[1], PAGE.conn)])
      .toEqual([2, -1, 7, -1]);
  });

  it('sets a bank 0 to 100 along 113 pixels, and a salvo 1 near its start, else in tenths, at most 10', () => {
    expect([PHASER_SLIDER_X, PHASER_SLIDER_X + 56, PHASER_SLIDER_X + 113].map(x => dragCommand(3, x))).toEqual([0, 49, 100].map(setting => ({ type: 'bank', bank: 3, setting })));
    expect([SALVO_X, SALVO_X + 3, SALVO_X + 57, SALVO_X + 200].map(x => dragCommand(6, x))).toEqual([0, 1, 5, 10].map(setting => ({ type: 'salvo', tube: 0, setting })));
    expect(dragCommand(-1, 200)).toBeNull();
  });
});

describe('the buttons (pressButton, update and buttonAction, tactical.cpp:495-574)', () => {
  it('acts at once for most, each toggle the other way; down for 498 ms, then up', () => {
    const { b } = miniBattle();
    const u = ui();
    expect([BUTTON_DELAY, pressButton(u, BUTTON.shields, b), u.pressed, u.buttonTime]).toEqual([498, [{ type: 'shields', on: true }], BUTTON.shields, 50498]);
    b.view.wide = true;
    expect([pressButton(ui(), BUTTON.full, b), pressButton(ui(), BUTTON.spread + 4, b), pressButton(ui(), BUTTON.bridge, b)]).toEqual([[{ type: 'wide', on: false }], [{ type: 'spread', cell: 4 }], []]);
    u.wall = 50497;
    expect([buttonDue(u), u.pressed]).toEqual([null, BUTTON.shields]);
    u.wall = 50498;
    expect([buttonDue(u), u.pressed]).toEqual([null, -1]);
  });

  it('acts for Bridge and Engineering once the delay is up, Bridge the hail\'s at red alert by the seam (tactical.cpp:503-521)', () => {
    const { b } = miniBattle();
    const u = ui();
    pressButton(u, BUTTON.engineering, b);
    u.wall += BUTTON_DELAY;
    expect(buttonDue(u)).toEqual({ type: 'engineering' });
    pressButton(u, BUTTON.bridge, b);
    u.wall += BUTTON_DELAY;
    expect([buttonDue(u), buttonDue(u)]).toEqual([{ type: 'bridge' }, null]);
  });

  it('turns a toggle the other way from where the orders waiting leave it, the last of them last, so two presses while paused are on and off (Plan 29 R3)', () => {
    const { b } = miniBattle();
    b.console.weaponsLock = true;
    expect(pendingSwitches(b)).toEqual({ shieldsRaised: false, weaponsLock: true, delegate: false, wide: false });
    const queued = [{ type: 'shields', on: true }, { type: 'wide', on: true }, { type: 'fire', weapon: 'both' }, { type: 'shields', on: false }, { type: 'delegate', on: true }] as const;
    expect(pendingSwitches(b, queued)).toEqual({ shieldsRaised: false, weaponsLock: true, delegate: true, wide: true });
    expect([pressButton(ui(), BUTTON.shields, b, [{ type: 'shields', on: true }]), pressButton(ui(), BUTTON.full, b, queued), pressButton(ui(), BUTTON.delegate, b, queued)])
      .toEqual([[{ type: 'shields', on: false }], [{ type: 'wide', on: false }], [{ type: 'delegate', on: false }]]);
  });

  it('shows an arrow pressed for the delay, and no button down (tactical.cpp:676-678)', () => {
    const u = ui();
    pressArrow(u, 0);
    expect([u.arrow, u.buttonTime, u.pressed]).toEqual([0, 50498, -1]);
  });
});

describe('the key actions (actionStart and actionEnd, tactical.cpp:731-816, 862-866)', () => {
  it('holds the flight keys as steer and orbit commands, the later of a pair held both ways', () => {
    const { b } = miniBattle();
    const keys = new TacticalKeys();
    expect(keys.start('yawLeft', 0, b)).toEqual([{ type: 'steer', yaw: -1, pitch: 0, roll: 0, throttle: 0 }]);
    expect(keys.start('accelerate', 0, b)).toEqual([{ type: 'steer', yaw: -1, pitch: 0, roll: 0, throttle: 1 }]);
    expect(keys.start('yawRight', 0, b)).toEqual([{ type: 'steer', yaw: 1, pitch: 0, roll: 0, throttle: 1 }]);
    expect(keys.end('yawRight')).toEqual([{ type: 'steer', yaw: -1, pitch: 0, roll: 0, throttle: 1 }]);
    expect([keys.end('yawRight'), keys.start('orbitRight', 0, b), keys.end('orbitRight')]).toEqual([[], [{ type: 'orbit', direction: 1 }], [{ type: 'orbit', direction: 0 }]]);
    keys.release();
    expect(keys.end('yawLeft')).toEqual([]);
  });

  it('fires, toggles wide and zooms at most once a second of the wall clock, each its own (zoom in and out one), the rest each time', () => {
    const { b } = miniBattle();
    const keys = new TacticalKeys();
    // (the last times start at 0: a key at 500 ms of the clock is too soon after it)
    expect(keys.start('phasers', 500, b)).toEqual([]);
    expect(keys.start('phasers', KEY_REPEAT_DELAY, b)).toEqual([{ type: 'fire', weapon: 'phasers' }]);
    expect([keys.start('phasers', 1999, b), keys.start('torpedoes', 1999, b), keys.start('phasers', 2000, b)])
      .toEqual([[], [{ type: 'fire', weapon: 'torpedoes' }], [{ type: 'fire', weapon: 'phasers' }]]);
    expect([keys.start('zoomIn', 5000, b), keys.start('zoomOut', 5500, b), keys.start('toggleView', 5500, b)]).toEqual([[{ type: 'zoom', direction: 'in' }], [], [{ type: 'wide', on: true }]]);
    expect([keys.start('cycleCamera', 5500, b), keys.start('cycleCamera', 5501, b), keys.start('nextTarget', 5501, b)]).toEqual([[{ type: 'cycleView' }], [{ type: 'cycleView' }], [{ type: 'target', which: 'next' }]]);
    expect([keys.start('view3', 0, b), keys.start('view7', 0, b), keys.start('stop', 0, b)])
      .toEqual([[{ type: 'view', view: 0xc, ship: 'target' }], [{ type: 'view', view: 0x11, ship: 'enterprise' }], [{ type: 'allStop' }]]);
  });

  it('takes no key while the warp overlay shows, not even its time, as actionStart returns first (tactical.cpp:732-733; Plan 29 R4)', () => {
    const { b } = miniBattle();
    const keys = new TacticalKeys();
    expect([keys.start('yawLeft', 5000, b, { warp: true }), keys.start('phasers', 5000, b, { warp: true }), keys.end('yawLeft')]).toEqual([[], [], []]);
    // (the phaser key's last time is still 0: the next press fires)
    expect(keys.start('phasers', 5001, b)).toEqual([{ type: 'fire', weapon: 'phasers' }]);
  });

  it('toggles wide the other way from where the orders waiting leave it (Plan 29 R3)', () => {
    const { b } = miniBattle();
    expect(new TacticalKeys().start('toggleView', 5000, b, { queued: [{ type: 'wide', on: true }] })).toEqual([{ type: 'wide', on: false }]);
  });

  it('toggles wide twice while paused: on, then off, the second reading the first still waiting (carried from Task 2\'s review)', () => {
    const { b } = miniBattle();
    const keys = new TacticalKeys();
    const first = keys.start('toggleView', 5000, b, { queued: [] });
    const second = keys.start('toggleView', 6000, b, { queued: first });
    expect([first, second]).toEqual([[{ type: 'wide', on: !b.view.wide }], [{ type: 'wide', on: b.view.wide }]]);
  });

  it('fires both with Space, each weapon under its own key\'s delay: both when both are due, else the one that is (Decision 18)', () => {
    const { b } = miniBattle();
    const keys = new TacticalKeys();
    expect(keys.fireBoth(5000, b)).toEqual([{ type: 'fire', weapon: 'both' }]);
    expect(keys.fireBoth(5999, b)).toEqual([]);
    expect(keys.start('torpedoes', 6000, b)).toEqual([{ type: 'fire', weapon: 'torpedoes' }]);
    expect([keys.fireBoth(6500, b), keys.fireBoth(7000, b), keys.fireBoth(7000, b, { warp: true })]).toEqual([[{ type: 'fire', weapon: 'phasers' }], [{ type: 'fire', weapon: 'torpedoes' }], []]);
  });

  it('holds a drag\'s and a pad\'s axes under the keys held, giving an order only when what is held changes (Plan 29 R7, R8)', () => {
    const { b } = miniBattle();
    const keys = new TacticalKeys();
    // (nothing held at first: a pad at rest gives nothing)
    expect(keys.hold('pad', NO_AXES)).toEqual([]);
    expect(keys.hold('drag', { ...NO_AXES, yaw: 1, pitch: -1 })).toEqual([{ type: 'steer', yaw: 1, pitch: -1, roll: 0, throttle: 0 }]);
    expect(keys.hold('drag', { ...NO_AXES, yaw: 1, pitch: -1 })).toEqual([]);
    // (a key on the same axis wins; the pad under the drag; the pad's orbit its own order)
    expect(keys.start('yawLeft', 0, b)).toEqual([{ type: 'steer', yaw: -1, pitch: -1, roll: 0, throttle: 0 }]);
    expect(keys.hold('pad', { ...NO_AXES, pitch: 1, throttle: 1, orbit: -1 })).toEqual([{ type: 'steer', yaw: -1, pitch: -1, roll: 0, throttle: 1 }, { type: 'orbit', direction: -1 }]);
    expect(keys.end('yawLeft')).toEqual([{ type: 'steer', yaw: 1, pitch: -1, roll: 0, throttle: 1 }]);
    expect(keys.hold('drag', NO_AXES)).toEqual([{ type: 'steer', yaw: 0, pitch: 1, roll: 0, throttle: 1 }]);
    // (a release lets go of them all, as releaseKeys' setHeld(0): the pad at rest after it gives nothing)
    keys.release();
    expect(keys.hold('pad', NO_AXES)).toEqual([]);
  });
});
