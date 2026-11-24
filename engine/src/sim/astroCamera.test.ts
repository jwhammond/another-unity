// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  cursorPoint, cursorSectorIndex, cursorTo, displayOn, moveCursor, newMapCamera, padClick, spin, startSpin, toggleDisplay, turnBy, TICKS_PER_DEGREE,
} from './astroCamera';

describe('the astrogation map camera', () => {
  it('turns by three degrees a click and wraps', () => {
    const c = newMapCamera();
    c.azimuth = 1; c.elevation = 358;
    padClick(c, 3, 1000);
    expect(c.azimuth).toBe(358);
    padClick(c, 0, 5000);
    expect(c.elevation).toBe(1);
    expect(c.spinning).toBe(false);
  });
  it('starts at 6 degrees azimuth and 3 elevation, spinning backwards in azimuth a degree every 0x13 ticks', () => {
    const c = newMapCamera();
    expect([c.azimuth, c.elevation, c.spinning]).toEqual([6, 3, true]);
    startSpin(c, 5000);
    expect([c.azimuthSpin, c.elevationSpin]).toEqual([-3, 0]);
    spin(c, 5000 + 4 * TICKS_PER_DEGREE);
    expect([c.azimuth, c.elevation]).toEqual([2, 3]);
    spin(c, 5000 + 10 * TICKS_PER_DEGREE);
    expect(c.azimuth).toBe(0 + 360 - 4);
  });
  it('stops the opening spin at a touch of the pad, and a later visit starts from where the map is but stays still', () => {
    const c = newMapCamera();
    startSpin(c, 100);
    padClick(c, 2, 100 + 7 * TICKS_PER_DEGREE);
    expect(c.spinning).toBe(false);
    const stopped = c.azimuth;
    startSpin(c, 90000);
    spin(c, 90000 + 30 * TICKS_PER_DEGREE);
    expect(c.azimuth).toBe(stopped);
    expect(c.spinAzimuth).toBe(stopped);
  });
  it('spins after a second click soon after, and stops with the middle button', () => {
    const c = newMapCamera();
    c.azimuth = 10;
    padClick(c, 2, 1000);
    padClick(c, 2, 1010);
    expect(c.spinning).toBe(true);
    expect(c.azimuthSpin).toBe(3);
    spin(c, 1010 + 20 * TICKS_PER_DEGREE);
    expect(c.azimuth).toBe(c.spinAzimuth + 20);
    padClick(c, 4, 9000);
    expect(c.spinning).toBe(false);
    expect(c.azimuthSpin).toBe(0);
    padClick(c, 4, 20000);
    expect([c.elevation, c.azimuth]).toEqual([6, 3]);
  });
  it('does not spin the system view', () => {
    const c = newMapCamera();
    padClick(c, 2, 1000); padClick(c, 2, 1001);
    const before = c.azimuth;
    c.view = 'system';
    spin(c, 1001 + 50 * TICKS_PER_DEGREE);
    expect(c.azimuth).toBe(before);
  });
  it('moves the sector in the galaxy view and the place in the sector view, wrapping, and not in the system view', () => {
    const c = newMapCamera();
    expect(moveCursor(c, 0, -1)).toBe(true);
    expect(c.cursorSector[0]).toBe(7);
    c.view = 'sector';
    moveCursor(c, 1, -1);
    expect(c.cursor[1]).toBe(19);
    moveCursor(c, 1, 1);
    expect(c.cursor[1]).toBe(0);
    expect(cursorPoint(c)).toEqual({ x: 140, y: 0, z: 0 });
    c.view = 'system';
    expect(moveCursor(c, 2, 1)).toBe(false);
    expect(c.cursor[2]).toBe(0);
  });
  it('puts the cursor on a chosen thing', () => {
    const c = newMapCamera();
    cursorTo(c, 1 + 2 * 8 + 3 * 64, { x: 21, y: 55, z: 82 });
    expect(c.cursorSector).toEqual([1, 2, 3]);
    expect(c.cursor).toEqual([1, 15, 2]);
    expect(cursorSectorIndex(c)).toBe(1 + 2 * 8 + 3 * 64);
  });
  it('toggles the nine display switches', () => {
    const c = newMapCamera();
    expect([0, 1, 2, 3, 4, 5, 6].map(i => displayOn(c, i))).toEqual([true, true, true, true, true, true, true]);
    expect(toggleDisplay(c, 0)).toBe(false);
    expect(toggleDisplay(c, 3)).toBe(false);
    expect(c.regions).toBe(0x1f & ~2);
    expect(toggleDisplay(c, 7)).toBe(true);
    expect(toggleDisplay(c, 8)).toBe(true);
    expect(toggleDisplay(c, 8)).toBe(false);
  });
  it('a drag stops a spin', () => {
    const c = newMapCamera();
    padClick(c, 2, 1000); padClick(c, 2, 1001);
    turnBy(c, -50, 4);
    expect(c.spinning).toBe(false);
    expect(c.azimuth).toBe(9 - 50 + 360);
  });
});
