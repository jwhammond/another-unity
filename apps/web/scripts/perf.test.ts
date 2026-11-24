// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { PROFILES } from './perf';

describe('the perf runner\'s profiles (Plan 31 R4)', () => {
  it('runs the Pixel 7 at its own device pixel ratio, 2.625, in landscape on a touch phone (Plan 34 Task 8)', () => {
    const pixel = PROFILES.find(p => p.name === 'Pixel 7 landscape')!;
    expect(pixel.context).toMatchObject({ deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, viewport: { width: 863, height: 360 } });
    expect(pixel.context).not.toHaveProperty('defaultBrowserType');
    expect(PROFILES.find(p => p.name === 'desktop')!.context.deviceScaleFactor).toBe(1);
  });
});
