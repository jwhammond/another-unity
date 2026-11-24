// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { YAML_HEADER } from './lift';
import { applyOutput, carryArt, planOutput } from './write';

const header = `${YAML_HEADER} test. Edit overrides/ instead.\n`;
const lifted = `${header}music:\n  w: a\n`;
const previous = `${header}music:\n  w: old\nart:\n  rooms:\n    w.s01:\n      plate: art/rooms/w/s01/plate.png\n`;

describe('carryArt', () => {
  it('keeps the previous file\'s art key in the new text, and the header', () => {
    const out = carryArt(previous, lifted);
    expect(out).toContain('music:\n  w: a\n');
    expect(out).toContain('plate: art/rooms/w/s01/plate.png');
    expect(out.startsWith(YAML_HEADER)).toBe(true);
  });

  it('adds nothing when there was no art, or no previous file', () => {
    expect(carryArt(`${header}music:\n  w: old\n`, lifted)).toBe(lifted);
    expect(carryArt(undefined, lifted)).toBe(lifted);
  });
});

describe('carryArt and the ship sets', () => {
  it('keeps art.ship when it rewrites presentation.yaml', () => {
    const withShip = `${header}music:\n  w: old\nart:\n  ship:\n    bridge:\n      gltf: art/ship/bridge.glb\n      camera: camera:main\n`;
    const out = carryArt(withShip, lifted);
    expect(out).toContain('music:\n  w: a\n');
    expect(out).toContain('gltf: art/ship/bridge.glb');
    expect(out).toContain('camera: camera:main');
  });
});

describe('a re-lift', () => {
  let dir = '';
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('keeps the art key, and a file without one gains none', async () => {
    dir = await mkdtemp(join(tmpdir(), 'lift-art-'));
    await writeFile(join(dir, 'presentation.yaml'), previous);
    const files = new Map([['presentation.yaml', lifted]]);
    await applyOutput(dir, files, await planOutput(dir, files));
    const text = await readFile(join(dir, 'presentation.yaml'), 'utf8');
    expect(text).toContain('w: a');
    expect(text).toContain('plate: art/rooms/w/s01/plate.png');

    await writeFile(join(dir, 'presentation.yaml'), `${header}music:\n  w: old\n`);
    const again = new Map([['presentation.yaml', lifted]]);
    await applyOutput(dir, again, await planOutput(dir, again));
    expect(await readFile(join(dir, 'presentation.yaml'), 'utf8')).toBe(lifted);
  });
});
