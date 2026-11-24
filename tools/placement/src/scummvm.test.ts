// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { harnessScript, parseLog } from './scummvm';

const LOG = `HARNESS> screen 4 3
HARNESS> objects
Screen 4/3 has 3 object(s):
  0: 040307 big cable                      flags 36 state 0 at (550, 310)
  1: 040308 big cable                      flags 1e state 1 at (390, 260)
  2: 04030b -mask for ramp-                flags 20 state 255 at (0, 0)
HARNESS> object 040307
big cable (040307)
  screen 3, position (550, 310, -1), size 150x45
  universe (-1, -1, -1), region 0
  flags 36: use talk look active
  state 0, skills 0, timer 65535, walk type 0
  sprite 716, animation 1
  playing animation 1, stopped
  9 description(s)
`;

describe('parseLog', () => {
  it('reads the screen\'s object list and each object asked after, by the screen the log says it is on', () => {
    const rooms = parseLog(LOG);
    expect([...rooms.keys()]).toEqual(['4/3']);
    const [cable, whole, mask] = rooms.get('4/3')!;
    // (the list's row, then what `object` adds)
    expect(cable).toMatchObject({ id: '040307', active: true, state: 0, x: 550, y: 310, sprite: 716, anim: 1, player: true, playing: 1, stopped: true, nothingShown: false, width: 150, height: 45 });
    // (flags 1e: not active, so the whole cable is off)
    expect(whole).toMatchObject({ id: '040308', active: false, state: 1, sprite: 0xffff });
    expect(mask).toMatchObject({ name: '-mask for ramp-', x: 0, y: 0, active: true });
  });
});

describe('harnessScript', () => {
  it('turns the ship\'s triggers off, starts each screen, lists it and asks after the objects given', () => {
    const lines = harnessScript([{ world: 4, screen: 3, objects: ['040307'] }]).split('\n');
    expect(lines.slice(0, 2)).toEqual(['trigger 0x10 off', 'trigger 3 off']);
    expect(lines.slice(7, 12)).toEqual(['screen 4 3', 'wait 2500', 'objects', 'object 040307', 'wait 500']);
    expect(lines).toContain('quit');
  });
});
