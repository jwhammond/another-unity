// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { gameModuleStubs } from './gamePlugin';

describe('the unity module a build leaves out', () => {
  it('a plain build stubs the sealed module, sealed files or not', () => {
    expect(gameModuleStubs(false, false)).toEqual(['./unitySealed']);
    expect(gameModuleStubs(false, true)).toEqual(['./unitySealed']);
  });
  it('a deploy build stubs the plain module, and the sealed one too when gate:seal has not written it', () => {
    expect(gameModuleStubs(true, true)).toEqual(['./unity']);
    expect(gameModuleStubs(true, false)).toEqual(['./unity', './unitySealed']);
  });
});
