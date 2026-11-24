// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { areaStyle } from './areas';

describe('areaStyle', () => {
  it('areaStyle([64, 48, 320, 240]) is left 10%, top 10%, width 50%, height 50%', () => {
    expect(areaStyle([64, 48, 320, 240])).toEqual({ position: 'absolute', left: '10%', top: '10%', width: '50%', height: '50%' });
  });
});
