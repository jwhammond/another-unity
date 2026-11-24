// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { portFor, skipReason } from './astroShot';

function game(plate: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'astro-shot-'));
  writeFileSync(join(dir, 'game.yaml'), 'id: x\n');
  writeFileSync(join(dir, 'presentation.yaml'), 'art:\n  ship:\n    astrogation:\n      plate: art/p.webp\n');
  if (plate) { mkdirSync(join(dir, 'art')); writeFileSync(join(dir, 'art/p.webp'), 'x'); }
  return dir;
}

describe('when the astrogation capture runs', () => {
  it('runs for the real game with its plate', () => {
    expect(skipReason({}, game(true))).toBeNull();
  });
  it('says why it skips: switched off, a GAMES_DIR override, no game, no plate', () => {
    expect(skipReason({ SITE_MEDIA_BROWSER: '0' }, game(true))).toMatch(/SITE_MEDIA_BROWSER/);
    expect(skipReason({ GAMES_DIR: '/x' }, game(true))).toMatch(/GAMES_DIR/);
    expect(skipReason({}, '/nonexistent-dir')).toMatch(/game\.yaml/);
    expect(skipReason({}, game(false))).toMatch(/plate/);
  });
});

describe('the capture\'s port', () => {
  it('is 5293 unless SITE_MEDIA_PORT names one of 5290-5293', () => {
    expect(portFor({})).toBe(5293);
    expect(portFor({ SITE_MEDIA_PORT: '5291' })).toBe(5291);
    expect(portFor({ SITE_MEDIA_PORT: '5173' })).toBe(5293);
    expect(portFor({ SITE_MEDIA_PORT: 'x' })).toBe(5293);
  });
});
