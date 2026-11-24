// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { installedTarget, legacyTarget } from './legacy';

describe('legacyTarget', () => {
  it('sends an old game link to /play/afu/ with the same query', () => {
    expect(legacyTarget('?game=unity&dev&start=lab.s01', '/')).toBe('/play/afu/?game=unity&dev&start=lab.s01');
  });
  it('keeps the demo game', () => {
    expect(legacyTarget('?game=demo&mute', '/')).toBe('/play/afu/?game=demo&mute');
  });
  it('leaves the home page alone', () => {
    expect(legacyTarget('', '/')).toBeNull();
    expect(legacyTarget('?utm=x', '/')).toBeNull();
  });
  it('only redirects from the root', () => {
    expect(legacyTarget('?game=unity', '/engineering/')).toBeNull();
  });
});

describe('installedTarget', () => {
  it('sends an installed app on the home page to the game', () => {
    expect(installedTarget(true, '/')).toBe('/play/afu/');
  });
  it('leaves a browser tab, and every other page, alone', () => {
    expect(installedTarget(false, '/')).toBeNull();
    expect(installedTarget(true, '/engineering/')).toBeNull();
  });
});
