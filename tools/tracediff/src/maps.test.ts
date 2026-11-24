// SPDX-License-Identifier: GPL-3.0-or-later
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { GameMaps } from './maps';
import { testMaps } from './testing/maps';

describe('GameMaps.unliftedTriggerExpected', () => {
  it('forgives the ship\'s triggers and unused ones, not an away trigger the lift ought to have named', () => {
    const maps = testMaps();
    expect(maps.unliftedTriggerExpected(64)).toBe(true); // (context 0: the ship's)
    expect(maps.unliftedTriggerExpected(70)).toBe(true); // (type 3: unused)
    expect(maps.unliftedTriggerExpected(99)).toBe(false); // (an away trigger, context 1)
    expect(maps.unliftedTriggerExpected(1234)).toBe(false); // (not in triggers.json)
  });

  it('expects nothing without triggers.json', () => {
    const m = testMaps();
    const maps = new GameMaps(m.ids, m.coords, m.voices, m.content);
    expect(maps.unliftedTriggerExpected(64)).toBe(false);
    expect(maps.unliftedTriggerExpected(70)).toBe(false);
  });
});

describe('GameMaps.load', () => {
  const demo = fileURLToPath(new URL('../../play/fixtures/demo', import.meta.url));
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  /** Tools/play's demo game, with the ids.yaml and coords.yaml a lift would add, in a temp dir. */
  async function gameDir(): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), 'tracediff-'));
    const game = join(dir, 'game');
    await cp(demo, game, { recursive: true });
    await writeFile(join(game, 'ids.yaml'), [
      'worlds: { "01": demo }',
      'screens: { s_0101: corridor }',
      'objects: { "000001": data, "010101": panel }',
      'conversations: {}',
      'triggers: { "5": t5 }',
      'advice: {}',
      'lists: {}',
    ].join('\n'));
    await writeFile(join(game, 'coords.yaml'), [
      'metersPerPixel: 0.0125',
      'screens:',
      '  corridor:',
      '    projection: { kind: flat, slope: 0, horizonY: 0, meanScale: 256, topY: 0, metersPerPixel: 0.0125, samples: 0, rms: 0 }',
      '    markers: {}',
    ].join('\n'));
    return game;
  }

  it('reads ids.yaml, coords.yaml, voices.yaml and the content', async () => {
    const maps = await GameMaps.load(await gameDir());
    expect(maps.object('010101')).toBe('panel');
    expect(maps.trigger(5)).toBe('t5');
    expect(maps.screen(1, 1)).toBe('corridor');
    expect(maps.pos('corridor', 400, 439)).toBe('1,1');
    expect(maps.voice('d@01', 'data')).toBe('d0201');
    expect(Object.keys(maps.content.objects)).toContain('panel');
    expect(maps.rawTriggers).toEqual([]);
  });

  it('reads triggers.json from the raw dir when given one', async () => {
    const game = await gameDir();
    const raw = join(dir!, 'raw');
    await mkdir(raw);
    await writeFile(join(raw, 'triggers.json'), JSON.stringify([{ id: 64, type: 2, context: 0, target: '5f0340' }]));
    const maps = await GameMaps.load(game, raw);
    expect(maps.rawTriggers).toEqual([{ id: 64, type: 2, context: 0, target: '5f0340' }]);
    expect(maps.unliftedTriggerExpected(64)).toBe(true);
  });
});
